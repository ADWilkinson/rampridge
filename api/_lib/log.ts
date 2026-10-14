/**
 * POST /api/log: launch telemetry from the browser (src/lib/telemetry.ts),
 * usually a sendBeacon with a text/plain JSON body.
 *
 * - Funnel counters: `ops/metrics/{yyyy-mm-dd}/{event}` += n, atomically with
 *   ServerValue.increment, plus `client_error` for every error received.
 *   Page views also count the coarse browser family under
 *   `ops/agents/{yyyy-mm-dd}/{uaClass}` and where the visit came from under
 *   `ops/referrers/{yyyy-mm-dd}/{class}` (shared/referrer.ts). No per-player
 *   data is kept.
 * - Client errors: scrubbed (logScrub.ts), printed with console.error so they
 *   show in Vercel logs (`[client-error]`), and stored under
 *   `ops/errors/{yyyy-mm-dd}/{key}` up to ERRORS_PER_DAY a day.
 *
 * Same-site browser requests only, rate-limited per IP hash. The bucket lives
 * at `ratelimits/ip/log-{hash}` so the cron's idle-bucket prune reclaims it.
 * Days are UTC. Setting RAMPRIDGE_TELEMETRY=off makes the endpoint accept and
 * drop everything without touching the database.
 */

import { createHash } from "node:crypto";
import { ServerValue } from "firebase-admin/database";
import { isReferrerClass, type ReferrerClass } from "../../shared/referrer.js";
import type { Db } from "./db.js";
import type { ApiDeps } from "./deps.js";
import { assertSameSite, badRequest, clientIp, rateLimited, readJson, withErrors } from "./http.js";
import { scrubStack, scrubText, uaClass } from "./logScrub.js";
import { hashIp, takeToken } from "./ratelimit.js";
import type { BucketSpec, TokenBucket } from "./ratelimit.js";

/** Funnel steps the client may count. Mirrors FUNNEL_EVENTS in src/lib/telemetry.ts (a test keeps them equal). */
export const FUNNEL_EVENTS = [
  "page_view",
  "play",
  "design_done",
  "login",
  "quote",
  "signal_ok",
  "signal_fail",
  "verify_start",
  "fulfil_ok",
  "fulfil_fail",
  "sell_start",
  "deposit_ok",
  "deposit_fail",
  "share_click",
  "gas_fail",
  "send_ok",
  "send_fail",
  "send_unconfirmed",
  "practice_start",
  "practice_done",
] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];
const FUNNEL_SET: ReadonlySet<string> = new Set(FUNNEL_EVENTS);

/** Counted by the server for every error report; not sendable as an event. */
export const CLIENT_ERROR_METRIC = "client_error";

export const ERROR_KINDS = ["error", "rejection", "report"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** One batch from a page. Short keys keep beacons small. */
export interface LogBatch {
  v: 1;
  /** Build id: the entry chunk's name, e.g. "index-B3x9aQ1z". */
  b?: string;
  /** Funnel counts since the last batch. */
  e?: Partial<Record<FunnelEvent, number>>;
  /** Where the visit came from, with the page view. */
  r?: ReferrerClass;
  /** Client errors since the last batch. */
  x?: ClientErrorReport[];
}

export interface ClientErrorReport {
  k: ErrorKind;
  /** Message. */
  m: string;
  /** Stack. */
  s?: string;
  /** location.pathname. */
  p?: string;
  /** Code-supplied context for report() calls, e.g. "fulfil". */
  c?: string;
}

/** `ops/errors/{day}/{key}`. */
export interface StoredClientError {
  /** Received at, server ms. */
  t: number;
  k: ErrorKind;
  m: string;
  s?: string;
  p: string;
  b: string;
  ua: string;
  c?: string;
  /** Fingerprint of kind, message and top frame, for grouping repeats. */
  fp: string;
}

/** A page flushes at most every few seconds; this leaves room for carrier NAT and offices sharing an IP. */
export const LOG_BUCKET: BucketSpec = { capacity: 30, refillPerSecond: 0.5 };
export const LOG_MAX_BYTES = 16_384;
export const MAX_ERRORS_PER_BATCH = 5;
/** Per event per batch: a page coalesces repeats, so more than this is not a real client. */
export const MAX_EVENT_COUNT = 20;
/** Stored error records per UTC day; counting continues past it. */
export const ERRORS_PER_DAY = 500;
/** One instance stores a given fingerprint at most this often; repeats are still counted. */
export const ERROR_DEDUPE_MS = 10 * 60 * 1000;
const MESSAGE_MAX = 300;
const STACK_MAX = 1_500;
const STACK_FRAMES = 10;
const PATH_MAX = 120;

export const logBucketPath = (ipHash: string) => `ratelimits/ip/log-${ipHash}`;
export const metricsPath = (day: string) => `ops/metrics/${day}`;
export const agentsPath = (day: string) => `ops/agents/${day}`;
export const referrersPath = (day: string) => `ops/referrers/${day}`;
export const errorsPath = (day: string) => `ops/errors/${day}`;
export const errorCountPath = (day: string) => `ops/errorCount/${day}`;

/** UTC calendar day, yyyy-mm-dd. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isTelemetryOff(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.RAMPRIDGE_TELEMETRY?.trim().toLowerCase() === "off";
}

export interface ParsedBatch {
  build: string;
  /** Null when the batch names none or an unknown class. */
  referrer: ReferrerClass | null;
  events: Array<[FunnelEvent, number]>;
  errors: ClientErrorReport[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a batch. The envelope must be right (400 otherwise); individual
 * events or errors that are malformed or unknown (a newer client) are
 * dropped, so one bad item never costs the rest.
 */
export function parseLogBatch(value: unknown): ParsedBatch {
  if (!isRecord(value) || value.v !== 1) throw badRequest("Unsupported telemetry batch.");
  const build = typeof value.b === "string" && /^[\w.-]{1,64}$/.test(value.b) ? value.b : "unknown";
  const referrer = isReferrerClass(value.r) ? value.r : null;

  const events: Array<[FunnelEvent, number]> = [];
  if (value.e !== undefined) {
    if (!isRecord(value.e)) throw badRequest("Unsupported telemetry batch.");
    for (const [name, count] of Object.entries(value.e)) {
      if (!FUNNEL_SET.has(name)) continue;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1) continue;
      events.push([name as FunnelEvent, Math.min(count, MAX_EVENT_COUNT)]);
    }
  }

  const errors: ClientErrorReport[] = [];
  if (value.x !== undefined) {
    if (!Array.isArray(value.x)) throw badRequest("Unsupported telemetry batch.");
    for (const item of value.x.slice(0, MAX_ERRORS_PER_BATCH)) {
      if (!isRecord(item)) continue;
      const { k, m, s, p, c } = item;
      if (typeof k !== "string" || !(ERROR_KINDS as readonly string[]).includes(k)) continue;
      if (typeof m !== "string" || !m.trim()) continue;
      const report: ClientErrorReport = { k: k as ErrorKind, m: m.slice(0, 2_000) };
      if (typeof s === "string" && s) report.s = s.slice(0, 8_000);
      if (typeof p === "string" && p.startsWith("/")) report.p = p;
      if (typeof c === "string" && /^[\w.:-]{1,40}$/.test(c)) report.c = c;
      errors.push(report);
    }
  }
  return { build, referrer, events, errors };
}

/** Only the pathname, length-capped; anything that is not a plain path becomes "/". */
function cleanPath(path: string | undefined): string {
  if (!path) return "/";
  const bare = path.split(/[?#]/)[0] ?? "/";
  // Share pages carry public ids only; anything odd (encoded data, very long paths) is dropped.
  if (!/^\/[\w./-]*$/.test(bare)) return "/";
  return bare.slice(0, PATH_MAX);
}

export function fingerprint(kind: ErrorKind, message: string, stack: string | undefined): string {
  const topFrame = stack?.split("\n")[0] ?? "";
  return createHash("sha256").update(`${kind}|${message}|${topFrame}`).digest("hex").slice(0, 12);
}

/** Scrubs a report into the record that is stored and logged. */
export function toStoredError(report: ClientErrorReport, build: string, ua: string, now: number): StoredClientError {
  const m = scrubText(report.m, MESSAGE_MAX) || "(empty message)";
  const s = report.s ? scrubStack(report.s, STACK_FRAMES, STACK_MAX) : "";
  const record: StoredClientError = { t: now, k: report.k, m, p: cleanPath(report.p), b: build, ua, fp: fingerprint(report.k, m, s) };
  if (s) record.s = s;
  if (report.c) record.c = report.c;
  return record;
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Chronological key: time first so keys sort by arrival, then random so concurrent writes never collide. */
export function errorKey(now: number, random: (length: number) => Uint8Array): string {
  let suffix = "";
  for (const byte of random(8)) suffix += BASE36[byte % 36];
  return `${now.toString(36).padStart(9, "0")}${suffix}`;
}

async function limitLog(db: Db, ipHash: string, now: number): Promise<void> {
  let retryAfterMs = 0;
  const outcome = await db.transaction<TokenBucket>(logBucketPath(ipHash), (current) => {
    const decision = takeToken(current, now, LOG_BUCKET);
    if (decision.ok) return decision.next;
    retryAfterMs = decision.retryAfterMs;
    return undefined;
  });
  if (!outcome.committed) throw rateLimited(retryAfterMs);
}

const increment = (n: number) => ServerValue.increment(n);

export interface LogHandlerOptions {
  /** Defaults to reading RAMPRIDGE_TELEMETRY on every request. */
  telemetryOff?: () => boolean;
  /** Where client errors are printed; defaults to console.error (Vercel logs). */
  logError?: (line: string) => void;
}

export function createLogHandler(deps: ApiDeps, options: LogHandlerOptions = {}): (request: Request) => Promise<Response> {
  const telemetryOff = options.telemetryOff ?? (() => isTelemetryOff());
  const logError = options.logError ?? ((line: string) => console.error(line));
  /** Fingerprints this instance stored recently. */
  const recent = new Map<string, number>();
  /** The day this instance last saw the stored-error cap reached. */
  let fullDay: string | null = null;

  const accepted = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

  const freshFingerprint = (fp: string, now: number): boolean => {
    const last = recent.get(fp);
    if (last !== undefined && now - last < ERROR_DEDUPE_MS) return false;
    if (recent.size >= 1_000) recent.clear();
    recent.set(fp, now);
    return true;
  };

  return withErrors(deps.now, async (request) => {
    if (telemetryOff()) return accepted();
    assertSameSite(request);
    const batch = parseLogBatch(await readJson(request, LOG_MAX_BYTES));
    if (batch.events.length === 0 && batch.errors.length === 0) return accepted();

    const db = deps.db();
    const now = deps.now();
    await limitLog(db, hashIp(clientIp(request) ?? "unknown", deps.sessionSecret()), now);

    const ua = uaClass(request.headers.get("user-agent"));
    const day = dayKey(now);
    const updates: Record<string, unknown> = {};

    // Automation (headless browsers, link previews) is counted by family only, never in the funnel.
    if (ua === "bot") {
      updates[`${agentsPath(day)}/bot`] = increment(1);
      await db.update(updates);
      return accepted();
    }

    for (const [event, count] of batch.events) {
      updates[`${metricsPath(day)}/${event}`] = increment(count);
      if (event === "page_view") {
        updates[`${agentsPath(day)}/${ua}`] = increment(count);
        if (batch.referrer) updates[`${referrersPath(day)}/${batch.referrer}`] = increment(count);
      }
    }

    if (batch.errors.length > 0) {
      updates[`${metricsPath(day)}/${CLIENT_ERROR_METRIC}`] = increment(batch.errors.length);
      const records = batch.errors.map((report) => toStoredError(report, batch.build, ua, now));
      const fresh = records.filter((record) => freshFingerprint(record.fp, now));
      let room = 0;
      if (fresh.length > 0 && fullDay !== day) {
        const stored = (await db.get<number>(errorCountPath(day))) ?? 0;
        room = Math.max(0, ERRORS_PER_DAY - (typeof stored === "number" ? stored : 0));
        if (room === 0) fullDay = day;
      }
      const keep = fresh.slice(0, room);
      for (const record of keep) updates[`${errorsPath(day)}/${errorKey(now, deps.randomBytes)}`] = record;
      if (keep.length > 0) updates[errorCountPath(day)] = increment(keep.length);
      for (const record of records) {
        const storedNow = keep.includes(record);
        const top = record.s?.split("\n")[0];
        logError(
          `[client-error] ${JSON.stringify({ k: record.k, m: record.m, top, p: record.p, b: record.b, ua: record.ua, c: record.c, fp: record.fp, stored: storedNow })}`,
        );
      }
    }

    await db.update(updates);
    return accepted();
  });
}
