/**
 * GET /api/health: is the bank open? Checks, in parallel and each within
 * PROBE_TIMEOUT_MS:
 *
 * - rtdb: the world database answers (and how long ago heartbeats last ran
 *   the presence sweep, and how old the shared market book is).
 * - curator: Peer's API answers the cheapest orderbook read the market uses.
 * - base: the RPC answers and its latest block is fresh.
 *
 * 200 when every check passes, 503 otherwise, always `no-store`. Results are
 * shared for MEMO_MS per instance so a public endpoint cannot multiply load
 * on Curator, the RPC or the database. Errors are reported as categories
 * only: RPC URLs carry API keys, so upstream messages are never echoed.
 */

import { getDb } from "./db.js";
import type { Db } from "./db.js";
import { baseRpcUrl, ConfigError } from "./env.js";
import { isTelemetryOff } from "./log.js";

/** Same values as chain.ts; duplicated so this function does not bundle the Peer SDK (a test keeps them equal). */
export const HEALTH_PEER_API_URL = "https://api.zkp2p.xyz";
export const HEALTH_CHAIN_ID = 8453;
export const HEALTH_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export const PROBE_TIMEOUT_MS = 4_000;
export const MEMO_MS = 10_000;
/** Base makes a block every 2 s; a head older than this means the RPC is behind or stuck. */
export const MAX_BLOCK_AGE_S = 60;

export type ProbeError = "timeout" | "unreachable" | "bad_response" | "stale" | "misconfigured" | `http_${number}`;

export interface CheckResult {
  ok: boolean;
  /** Probe latency. */
  ms: number;
  error?: ProbeError;
}

export interface RtdbCheck extends CheckResult {
  /** Seconds since a heartbeat last ran the presence sweep (null: never). Grows when nobody is online. */
  sweepAgeS?: number | null;
  /** Seconds since the shared market book was rebuilt (null: never). */
  marketAgeS?: number | null;
}

export interface BaseCheck extends CheckResult {
  block?: number;
  /** Seconds between the latest block's timestamp and now. */
  blockAgeS?: number;
}

export interface HealthResponse {
  ok: boolean;
  checks: { rtdb: RtdbCheck; curator: CheckResult; base: BaseCheck };
  deployment: { id: string | null; env: string | null; region: string | null; commit: string | null };
  telemetry: "on" | "off";
  /** Server variables that are missing (names only). */
  missingConfig: string[];
  checkedAt: number;
  now: number;
}

export interface HealthProbes {
  now: () => number;
  db: () => Db;
  /** Resolves when Curator answers a minimal orderbook read. */
  curator: (signal: AbortSignal) => Promise<void>;
  /** Latest Base block number and timestamp (unix seconds). */
  baseHead: (signal: AbortSignal) => Promise<{ number: number; timestamp: number }>;
  env: () => Readonly<Record<string, string | undefined>>;
}

/** An upstream answered with this status. */
export class ProbeHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "ProbeHttpError";
    this.status = status;
  }
}

/** An upstream answered, but not with what we expected. */
export class ProbeResponseError extends Error {
  constructor() {
    super("Unexpected response");
    this.name = "ProbeResponseError";
  }
}

class ProbeTimeout extends Error {
  constructor() {
    super("timeout");
    this.name = "ProbeTimeout";
  }
}

export function classify(err: unknown): ProbeError {
  if (err instanceof ProbeTimeout) return "timeout";
  if (err instanceof ConfigError) return "misconfigured";
  if (err instanceof ProbeHttpError) return `http_${err.status}`;
  if (err instanceof ProbeResponseError) return "bad_response";
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  return "unreachable";
}

/** Runs a probe with a deadline. The signal aborts fetches; the race also bounds probes that ignore it. */
async function timed<T>(now: () => number, probe: (signal: AbortSignal) => Promise<T>): Promise<{ value?: T; ms: number; error?: ProbeError }> {
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProbeTimeout());
    }, PROBE_TIMEOUT_MS);
  });
  try {
    const value = await Promise.race([probe(controller.signal), deadline]);
    return { value, ms: now() - started };
  } catch (err) {
    return { ms: now() - started, error: classify(err) };
  } finally {
    clearTimeout(timer);
  }
}

const ageSeconds = (now: number, at: unknown): number | null =>
  typeof at === "number" && Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;

const SERVER_CONFIG = ["FIREBASE_SERVICE_ACCOUNT", "SESSION_SECRET", "BASE_RPC_URL", "CRON_SECRET"] as const;

export async function runHealthChecks(probes: HealthProbes): Promise<HealthResponse> {
  const env = probes.env();
  const [rtdb, curator, base] = await Promise.all([
    timed(probes.now, async () => {
      const db = probes.db();
      const [sweep, marketAt] = await Promise.all([db.get<{ p?: unknown }>("meta/sweep"), db.get<unknown>("meta/market/at")]);
      return { sweep, marketAt };
    }),
    timed(probes.now, probes.curator),
    timed(probes.now, probes.baseHead),
  ]);
  const now = probes.now();

  const rtdbCheck: RtdbCheck = { ok: !rtdb.error, ms: rtdb.ms };
  if (rtdb.error) rtdbCheck.error = rtdb.error;
  else {
    rtdbCheck.sweepAgeS = ageSeconds(now, rtdb.value?.sweep?.p);
    rtdbCheck.marketAgeS = ageSeconds(now, rtdb.value?.marketAt);
  }

  const curatorCheck: CheckResult = { ok: !curator.error, ms: curator.ms };
  if (curator.error) curatorCheck.error = curator.error;

  const baseCheck: BaseCheck = { ok: false, ms: base.ms };
  if (base.error || !base.value) baseCheck.error = base.error ?? "bad_response";
  else {
    baseCheck.block = base.value.number;
    baseCheck.blockAgeS = Math.max(0, Math.round(now / 1000 - base.value.timestamp));
    baseCheck.ok = baseCheck.blockAgeS <= MAX_BLOCK_AGE_S;
    if (!baseCheck.ok) baseCheck.error = "stale";
  }

  const emulator = Boolean(env.FIREBASE_DATABASE_EMULATOR_HOST?.trim());
  const missingConfig = SERVER_CONFIG.filter(
    (name) => !env[name]?.trim() && !(name === "FIREBASE_SERVICE_ACCOUNT" && emulator),
  );
  const clean = (value: string | undefined) => (value?.trim() ? value.trim() : null);
  return {
    ok: rtdbCheck.ok && curatorCheck.ok && baseCheck.ok,
    checks: { rtdb: rtdbCheck, curator: curatorCheck, base: baseCheck },
    deployment: {
      id: clean(env.VERCEL_DEPLOYMENT_ID),
      env: clean(env.VERCEL_ENV),
      region: clean(env.VERCEL_REGION),
      commit: clean(env.VERCEL_GIT_COMMIT_SHA)?.slice(0, 12) ?? null,
    },
    telemetry: isTelemetryOff(env) ? "off" : "on",
    missingConfig,
    checkedAt: now,
    now,
  };
}

export function createHealthHandler(probes: HealthProbes): () => Promise<Response> {
  let memo: { at: number; result: HealthResponse } | null = null;
  let inflight: Promise<HealthResponse> | null = null;

  const respond = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });

  return async () => {
    try {
      const now = probes.now();
      let result: HealthResponse;
      if (memo && now - memo.at < MEMO_MS) {
        result = memo.result;
      } else {
        inflight ??= runHealthChecks(probes).finally(() => {
          inflight = null;
        });
        result = await inflight;
        memo = { at: result.checkedAt, result };
      }
      const body: HealthResponse = { ...result, now: probes.now() };
      return respond(body, body.ok ? 200 : 503);
    } catch (err) {
      console.error("Health check failed:", err instanceof Error ? err.name : "unknown");
      return respond({ ok: false, error: "health_check_failed", now: Date.now() }, 503);
    }
  };
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) throw new ProbeHttpError(response.status);
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ProbeResponseError();
  }
}

export const curatorProbeUrl = (): string => {
  const query = new URLSearchParams({
    currency: "USD",
    chainId: String(HEALTH_CHAIN_ID),
    token: HEALTH_USDC_ADDRESS,
    mode: "eligible",
    limit: "1",
  });
  return `${HEALTH_PEER_API_URL}/v3/orderbook/table?${query.toString()}`;
};

export function productionHealthProbes(): HealthProbes {
  return {
    now: () => Date.now(),
    db: getDb,
    async curator(signal) {
      const body = await fetchJson(curatorProbeUrl(), { signal, headers: { Accept: "application/json" } });
      const object = body as { success?: unknown; responseObject?: { rows?: unknown } } | null;
      if (!object || object.success === false || !Array.isArray(object.responseObject?.rows)) throw new ProbeResponseError();
    },
    async baseHead(signal) {
      const body = await fetchJson(baseRpcUrl(), {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
      });
      const block = (body as { result?: { number?: unknown; timestamp?: unknown } } | null)?.result;
      if (typeof block?.number !== "string" || typeof block.timestamp !== "string") throw new ProbeResponseError();
      const number = Number.parseInt(block.number, 16);
      const timestamp = Number.parseInt(block.timestamp, 16);
      if (!Number.isFinite(number) || !Number.isFinite(timestamp)) throw new ProbeResponseError();
      return { number, timestamp };
    },
    env: () => process.env,
  };
}
