import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAIN_ID, PEER_API_URL, USDC_ADDRESS } from "./chain";
import {
  createHealthHandler,
  curatorProbeUrl,
  HEALTH_CHAIN_ID,
  HEALTH_PEER_API_URL,
  HEALTH_USDC_ADDRESS,
  MAX_BLOCK_AGE_S,
  MEMO_MS,
  PROBE_TIMEOUT_MS,
  ProbeHttpError,
  productionHealthProbes,
} from "./logHealth";
import type { HealthProbes, HealthResponse } from "./logHealth";
import { MemoryDb } from "./memoryDb";

const NOW = 1_800_000_000_000;
const FULL_ENV = {
  FIREBASE_SERVICE_ACCOUNT: "{}",
  SESSION_SECRET: "s",
  BASE_RPC_URL: "https://base-mainnet.g.alchemy.com/v2/SECRET",
  CRON_SECRET: "c",
  VERCEL_DEPLOYMENT_ID: "dpl_abc",
  VERCEL_ENV: "production",
  VERCEL_REGION: "iad1",
};

function probes(overrides: Partial<HealthProbes> = {}): HealthProbes & { clock: { now: number } } {
  const clock = { now: NOW };
  const memory = new MemoryDb({ meta: { sweep: { p: NOW - 12_000 }, market: { at: NOW - 40_000, body: "{}" } } });
  return {
    clock,
    now: () => clock.now,
    db: () => memory,
    curator: async () => undefined,
    baseHead: async () => ({ number: 36_000_000, timestamp: Math.floor(clock.now / 1000) - 3 }),
    env: () => FULL_ENV,
    ...overrides,
  };
}

async function read(response: Response): Promise<HealthResponse> {
  return (await response.json()) as HealthResponse;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GET /api/health", () => {
  it("reports every check and the serving deployment", async () => {
    const response = await createHealthHandler(probes())();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await read(response);
    expect(body).toMatchObject({
      ok: true,
      revision: null,
      checks: {
        rtdb: { ok: true, sweepAgeS: 12, marketAgeS: 40 },
        curator: { ok: true },
        base: { ok: true, block: 36_000_000, blockAgeS: 3 },
      },
      deployment: { id: "dpl_abc", env: "production", region: "iad1", commit: null },
      telemetry: "on",
      missingConfig: [],
    });
  });

  it("reports the exact archive release stamp independently of Vercel git metadata", async () => {
    const revision = "a".repeat(40);
    const body = await read(await createHealthHandler(probes({ env: () => ({ ...FULL_ENV, RAMPRIDGE_RELEASE_SHA: revision, VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }) }))());
    expect(body.revision).toBe(revision);
    expect(body.deployment.commit).toBe("b".repeat(12));
  });

  it.each(["abc123", "a".repeat(39), "g".repeat(40), "a".repeat(41)])("rejects an incomplete or invalid serving stamp %s", async revision => {
    const body = await read(await createHealthHandler(probes({ env: () => ({ ...FULL_ENV, RAMPRIDGE_RELEASE_SHA: revision }) }))());
    expect(body.revision).toBeNull();
  });

  it("accepts complete native Vercel provenance when no archive stamp is present", async () => {
    const body = await read(await createHealthHandler(probes({ env: () => ({ ...FULL_ENV, VERCEL_GIT_COMMIT_SHA: "C".repeat(40) }) }))());
    expect(body.revision).toBe("c".repeat(40));
  });

  it("answers 503 naming the failing dependency, never echoing upstream errors", async () => {
    const failing = probes({
      curator: async () => {
        throw new ProbeHttpError(502);
      },
      baseHead: async () => {
        throw new Error("HTTP request failed. URL: https://base-mainnet.g.alchemy.com/v2/SECRET");
      },
    });
    (failing.db() as MemoryDb).failWith = new Error("permission denied for https://rampridge-world.firebaseio.com");
    const response = await createHealthHandler(failing)();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("permission denied");
    const body = JSON.parse(text) as HealthResponse;
    expect(body.ok).toBe(false);
    expect(body.checks.rtdb).toMatchObject({ ok: false, error: "unreachable" });
    expect(body.checks.curator).toMatchObject({ ok: false, error: "http_502" });
    expect(body.checks.base).toMatchObject({ ok: false, error: "unreachable" });
  });

  it("flags a stale Base head", async () => {
    const stale = probes({ baseHead: async () => ({ number: 1, timestamp: Math.floor(NOW / 1000) - MAX_BLOCK_AGE_S - 5 }) });
    const body = await read(await createHealthHandler(stale)());
    expect(body.ok).toBe(false);
    expect(body.checks.base).toMatchObject({ ok: false, error: "stale", blockAgeS: MAX_BLOCK_AGE_S + 5 });
  });

  it("times out a hung probe", async () => {
    vi.useFakeTimers();
    const hung = probes({ curator: () => new Promise<void>(() => undefined) });
    const pending = createHealthHandler(hung)();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    const body = await read(await pending);
    expect(body.checks.curator).toMatchObject({ ok: false, error: "timeout" });
    expect(body.checks.rtdb.ok).toBe(true);
  });

  it("names missing configuration without values, and the telemetry switch", async () => {
    const env = { SESSION_SECRET: "s", RAMPRIDGE_TELEMETRY: "off" };
    const body = await read(await createHealthHandler(probes({ env: () => env }))());
    expect(body.missingConfig).toEqual(["FIREBASE_SERVICE_ACCOUNT", "BASE_RPC_URL", "CRON_SECRET"]);
    expect(body.telemetry).toBe("off");
    expect(body.deployment.id).toBeNull();
  });

  it("shares one run between callers for MEMO_MS", async () => {
    let runs = 0;
    const counted = probes({
      curator: async () => {
        runs += 1;
      },
    });
    const handler = createHealthHandler(counted);
    await Promise.all([handler(), handler(), handler()]);
    expect(runs).toBe(1);
    counted.clock.now += MEMO_MS - 1;
    await handler();
    expect(runs).toBe(1);
    counted.clock.now += 2;
    await handler();
    expect(runs).toBe(2);
  });

  it("uses the same Peer constants as the chain gateway", () => {
    expect(HEALTH_PEER_API_URL).toBe(PEER_API_URL);
    expect(HEALTH_CHAIN_ID).toBe(CHAIN_ID);
    expect(HEALTH_USDC_ADDRESS).toBe(USDC_ADDRESS);
    expect(curatorProbeUrl()).toContain("/v3/orderbook/table?");
    expect(curatorProbeUrl()).toContain("limit=1");
  });
});

describe("production probes", () => {
  it("reads the Base head over JSON-RPC", async () => {
    vi.stubEnv("BASE_RPC_URL", "https://rpc.example/v2/KEY");
    const fetchMock = vi.fn(async () => Response.json({ jsonrpc: "2.0", id: 1, result: { number: "0x2255100", timestamp: "0x6a000000" } }));
    vi.stubGlobal("fetch", fetchMock);
    const head = await productionHealthProbes().baseHead(new AbortController().signal);
    expect(head).toEqual({ number: 0x2255100, timestamp: 0x6a000000 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rpc.example/v2/KEY");
    expect(JSON.parse(String(init.body))).toMatchObject({ method: "eth_getBlockByNumber", params: ["latest", false] });
    vi.unstubAllEnvs();
  });

  it("classifies upstream failures", async () => {
    vi.stubEnv("BASE_RPC_URL", "");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 429 })));
    const live = productionHealthProbes();
    const handler = createHealthHandler({ ...live, db: () => new MemoryDb(), env: () => ({}) });
    const body = await read(await handler());
    expect(body.checks.curator).toMatchObject({ ok: false, error: "http_429" });
    expect(body.checks.base).toMatchObject({ ok: false, error: "misconfigured" });
    vi.unstubAllEnvs();
  });

  it("refuses a Curator answer without rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: false })));
    await expect(productionHealthProbes().curator(new AbortController().signal)).rejects.toThrow("Unexpected response");
  });
});
