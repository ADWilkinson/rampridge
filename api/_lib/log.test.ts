import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentsPath,
  createLogHandler,
  dayKey,
  ERROR_DEDUPE_MS,
  errorCountPath,
  errorsPath,
  ERRORS_PER_DAY,
  FUNNEL_EVENTS,
  LOG_BUCKET,
  LOG_MAX_BYTES,
  logBucketPath,
  MAX_ERRORS_PER_BATCH,
  MAX_EVENT_COUNT,
  metricsPath,
  parseLogBatch,
} from "./log";
import type { StoredClientError } from "./log";
import { MemoryDb } from "./memoryDb";
import { BUCKET_IDLE_MS, pruneWorld } from "./prune";
import { hashIp } from "./ratelimit";
import { TEST_SECRET, testDeps } from "./testing";
import type { TestDeps } from "./testing";

/** MemoryDb that applies ServerValue.increment placeholders the way the database does. */
class IncrementingMemoryDb extends MemoryDb {
  writes = 0;
  override async update(updates: Record<string, unknown>): Promise<void> {
    this.writes += 1;
    const resolved: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(updates)) {
      const inc = (value as { ".sv"?: { increment?: unknown } } | null)?.[".sv"]?.increment;
      if (typeof inc === "number") {
        const current = this.read(path);
        resolved[path] = (typeof current === "number" ? current : 0) + inc;
      } else {
        resolved[path] = value;
      }
    }
    return super.update(resolved);
  }
}

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const X_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/11.10";

let deps: TestDeps;
let db: IncrementingMemoryDb;
let logged: string[];
let telemetryOff: boolean;
let handler: (request: Request) => Promise<Response>;

function beacon(
  body: unknown,
  init: { ip?: string; ua?: string; origin?: string | null; site?: string; raw?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain;charset=UTF-8",
    "User-Agent": init.ua ?? CHROME_MAC,
    "x-vercel-forwarded-for": init.ip ?? "203.0.113.7",
    "sec-fetch-site": init.site ?? "same-origin",
  };
  if (init.origin !== null) headers.Origin = init.origin ?? "https://www.rampridge.xyz";
  return new Request("https://www.rampridge.xyz/api/log", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  deps = testDeps();
  db = new IncrementingMemoryDb();
  deps.db = () => db;
  logged = [];
  telemetryOff = false;
  handler = createLogHandler(deps, { logError: (line) => logged.push(line), telemetryOff: () => telemetryOff });
});

const today = () => dayKey(deps.clock.now);
const metrics = () => db.read(metricsPath(today())) as Record<string, number> | null;
const storedErrors = () => Object.values((db.read(errorsPath(today())) as Record<string, StoredClientError> | null) ?? {});

describe("funnel counters", () => {
  it("increments each event atomically under ops/metrics/{day}", async () => {
    const response = await handler(beacon({ v: 1, b: "index-abc123", e: { page_view: 1, play: 1 } }));
    expect(response.status).toBe(204);
    await handler(beacon({ v: 1, e: { play: 2, quote: 1 } }));
    expect(metrics()).toEqual({ page_view: 1, play: 3, quote: 1 });
  });

  it("counts page views by browser family, never by player", async () => {
    await handler(beacon({ v: 1, e: { page_view: 1 } }, { ua: X_IPHONE }));
    await handler(beacon({ v: 1, e: { page_view: 1 } }, { ua: CHROME_MAC, ip: "198.51.100.2" }));
    expect(db.read(agentsPath(today()))).toEqual({ "ios-inapp": 1, "mac-chrome": 1 });
    // Nothing keyed by IP, pid or address anywhere under ops/.
    expect(JSON.stringify(db.read("ops"))).not.toMatch(/203\.0\.113|198\.51/);
  });

  it("drops unknown events and bad counts, and caps counts", async () => {
    await handler(beacon({ v: 1, e: { play: 500, hack: 3, quote: -1, login: 1.5, signal_ok: "2" } }));
    expect(metrics()).toEqual({ play: MAX_EVENT_COUNT });
  });

  it("uses UTC days", async () => {
    deps.clock.now = Date.UTC(2026, 9, 12, 23, 59, 59);
    await handler(beacon({ v: 1, e: { play: 1 } }));
    deps.clock.now = Date.UTC(2026, 9, 13, 0, 0, 1);
    await handler(beacon({ v: 1, e: { play: 1 } }));
    expect(db.read("ops/metrics")).toEqual({ "2026-10-12": { play: 1 }, "2026-10-13": { play: 1 } });
  });

  it("keeps automation out of the funnel", async () => {
    const headless = CHROME_MAC.replace("Chrome/", "HeadlessChrome/");
    await handler(beacon({ v: 1, e: { page_view: 1, play: 1 }, x: [{ k: "error", m: "boom" }] }, { ua: headless }));
    expect(metrics()).toBeNull();
    expect(storedErrors()).toEqual([]);
    expect(db.read(agentsPath(today()))).toEqual({ bot: 1 });
  });

  it("lists the same events as the client", () => {
    // Read as text: the browser module is typed for the DOM, which the server's tsconfig does not load.
    const source = readFileSync(new URL("../../src/lib/telemetry.ts", import.meta.url), "utf8");
    const list = /export const FUNNEL_EVENTS = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    expect([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...FUNNEL_EVENTS]);
  });
});

describe("request validation", () => {
  it("accepts sendBeacon's text/plain body", async () => {
    expect((await handler(beacon({ v: 1, e: { play: 1 } }))).status).toBe(204);
  });

  it("refuses other sites", async () => {
    expect((await handler(beacon({ v: 1, e: { play: 1 } }, { site: "cross-site" }))).status).toBe(403);
    expect((await handler(beacon({ v: 1, e: { play: 1 } }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(metrics()).toBeNull();
  });

  it("rejects a malformed envelope", async () => {
    for (const body of [{ e: { play: 1 } }, { v: 2 }, [1], "x", { v: 1, e: [] }, { v: 1, x: {} }]) {
      expect((await handler(beacon(body))).status).toBe(400);
    }
    expect((await handler(beacon(null, { raw: "{not json" }))).status).toBe(400);
  });

  it("rejects oversized bodies", async () => {
    const response = await handler(beacon(null, { raw: JSON.stringify({ v: 1, pad: "x".repeat(LOG_MAX_BYTES) }) }));
    expect(response.status).toBe(413);
  });

  it("answers an empty batch without touching the database", async () => {
    expect((await handler(beacon({ v: 1 }))).status).toBe(204);
    expect(db.writes).toBe(0);
    expect(db.read("ratelimits")).toBeNull();
  });

  it("does nothing while telemetry is switched off", async () => {
    telemetryOff = true;
    expect((await handler(beacon({ v: 1, e: { play: 1 }, x: [{ k: "error", m: "boom" }] }))).status).toBe(204);
    expect(db.root).toEqual({});
    expect(logged).toEqual([]);
  });

  it("ignores malformed error items but keeps the rest", () => {
    const parsed = parseLogBatch({
      v: 1,
      b: "bad build id with spaces",
      x: [{ k: "error", m: "" }, { k: "nope", m: "x" }, "x", { k: "report", m: "real", c: "fulfil", p: "/t/abc" }],
    });
    expect(parsed.build).toBe("unknown");
    expect(parsed.errors).toEqual([{ k: "report", m: "real", c: "fulfil", p: "/t/abc" }]);
  });
});

describe("rate limit", () => {
  it("limits each IP, keeping the bucket where the cron prunes idle buckets", async () => {
    for (let i = 0; i < LOG_BUCKET.capacity; i++) {
      expect((await handler(beacon({ v: 1, e: { play: 1 } }))).status).toBe(204);
    }
    const limited = await handler(beacon({ v: 1, e: { play: 1 } }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect((await handler(beacon({ v: 1, e: { play: 1 } }, { ip: "198.51.100.9" }))).status).toBe(204);
    expect(metrics()).toEqual({ play: LOG_BUCKET.capacity + 1 });

    const path = logBucketPath(hashIp("203.0.113.7", TEST_SECRET));
    expect(db.read(path)).not.toBeNull();
    // The cron's existing idle-bucket sweep of ratelimits/ip reclaims it.
    await pruneWorld(db, deps.clock.now + BUCKET_IDLE_MS + 1);
    expect(db.read(path)).toBeNull();
  });
});

describe("client errors", () => {
  const address = "0x1234567890abcdef1234567890ABCDEF12345678";
  const txHash = `0x${"ab".repeat(32)}`;
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJwaWQiOiJhYmMifQ.c2lnbmF0dXJlLWJ5dGVz";

  it("stores a scrubbed record, counts it and logs it for Vercel", async () => {
    const message = `Transfer to ${address} failed for @venmo-user and $cashtag (tx ${txHash}, token ${jwt}, mail bob@example.com, phone +1 (415) 555-0123)`;
    const stack = [
      `Error: ${message}`,
      "    at fulfil (https://www.rampridge.xyz/assets/AppRoot-DxYz1234.js:12:345)",
      "    at send (https://base-mainnet.g.alchemy.com/v2/SECRETKEY123456789abcdef:1:2)",
    ].join("\n");
    await handler(beacon({ v: 1, b: "index-abc123", x: [{ k: "error", m: message, s: stack, p: "/t/AbCdEf1234?x=1" }] }));

    const [record] = storedErrors();
    expect(record).toMatchObject({
      k: "error",
      p: "/t/AbCdEf1234",
      b: "index-abc123",
      ua: "mac-chrome",
      t: deps.clock.now,
    });
    const everything = JSON.stringify({ record, logged, db: db.root });
    for (const secret of [address, txHash, jwt, "venmo-user", "cashtag", "bob@example.com", "555-0123", "SECRETKEY"]) {
      expect(everything).not.toContain(secret);
    }
    expect(record?.m).toContain("0x[address]");
    expect(record?.s).toContain("https://www.rampridge.xyz/assets/AppRoot-DxYz1234.js:12:345");
    expect(record?.s).toContain("https://base-mainnet.g.alchemy.com/…");
    expect(db.read(errorCountPath(today()))).toBe(1);
    expect(metrics()).toEqual({ client_error: 1 });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\[client-error\] \{/);
    expect(logged[0]).toContain('"stored":true');
  });

  it("caps stored records per day but keeps counting", async () => {
    await db.set(errorCountPath(today()), ERRORS_PER_DAY - 1);
    const batch = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ k: "error", m: `distinct failure ${i} ${Math.random()}` }));
    await handler(beacon({ v: 1, x: batch(3) }));
    expect(storedErrors()).toHaveLength(1);
    expect(db.read(errorCountPath(today()))).toBe(ERRORS_PER_DAY);
    await handler(beacon({ v: 1, x: batch(2) }));
    expect(storedErrors()).toHaveLength(1);
    expect(metrics()).toEqual({ client_error: 5 });
    expect(logged).toHaveLength(5);
  });

  it("stores a repeated error once per instance and window, counting every one", async () => {
    const report = { k: "rejection", m: "Network request failed" };
    await handler(beacon({ v: 1, x: [report, report] }));
    await handler(beacon({ v: 1, x: [report] }));
    expect(storedErrors()).toHaveLength(1);
    expect(metrics()).toEqual({ client_error: 3 });
    deps.clock.now += ERROR_DEDUPE_MS + 1;
    await handler(beacon({ v: 1, x: [report] }));
    expect(storedErrors()).toHaveLength(2);
  });

  it("takes at most MAX_ERRORS_PER_BATCH from one batch", async () => {
    const many = Array.from({ length: MAX_ERRORS_PER_BATCH + 4 }, (_, i) => ({ k: "error", m: `e${i}` }));
    await handler(beacon({ v: 1, x: many }));
    expect(storedErrors()).toHaveLength(MAX_ERRORS_PER_BATCH);
  });

  it("writes metrics and errors in one update", async () => {
    await handler(beacon({ v: 1, e: { play: 1 }, x: [{ k: "error", m: "boom" }] }));
    expect(db.writes).toBe(1);
  });
});
