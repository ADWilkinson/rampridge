import type { Database } from "firebase-admin/database";
import { describe, expect, it } from "vitest";
import type { PlayerRecord } from "../../shared/protocol";
import { DEFAULT_APPEARANCE } from "../../shared/world";
import { adminDb } from "./db";
import { HttpError } from "./http";
import { mutatePlayer, playerPath } from "./players";

/** Key-order independent JSON, standing in for the SDK's data hash. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * The Admin SDK's transaction protocol, reduced to what matters here: the
 * first run sees whatever the instance has cached for the path (possibly
 * nothing, or only one child), an aborting update ends the transaction
 * locally, and a proposal is sent with the hash of its input, which the
 * server refuses unless it matches, rerunning the update on the server's data.
 * `cachedRuns` is how many runs see the cache before the server's data
 * arrives: the SDK also reruns a waiting transaction when a child's value
 * changes locally, still on the partial view.
 */
class FakeRtdb {
  readonly data = new Map<string, unknown>();
  readonly cache = new Map<string, unknown>();
  cachedRuns = 1;
  writes = 0;

  ref(path: string) {
    return {
      transaction: async (update: (current: unknown) => unknown) => {
        const cached = this.cache.has(path) ? this.cache.get(path) : null;
        let input = cached;
        for (let attempt = 1; attempt <= 25; attempt++) {
          const next = update(input);
          if (next === undefined) return { committed: false, snapshot: this.snapshot(input) };
          const server = this.data.get(path) ?? null;
          if (canonical(server) !== canonical(input)) {
            input = attempt < this.cachedRuns ? cached : server;
            continue;
          }
          this.writes++;
          if (next === null) this.data.delete(path);
          else this.data.set(path, structuredClone(next));
          return { committed: true, snapshot: this.snapshot(next) };
        }
        throw new Error("maxretry");
      },
    };
  }

  private snapshot(value: unknown) {
    return { exists: () => value !== null && value !== undefined, val: () => value };
  }
}

function record(): PlayerRecord {
  return { n: "Zezima", a: DEFAULT_APPEARANCE, p: "3185,3438", t: 1, r: false, e: null, et: null, ls: 5, j: 1 };
}

describe("adminDb transactions", () => {
  it("lets the server decide when the first guess aborts", async () => {
    const fake = new FakeRtdb();
    fake.data.set("ratelimits/act/p", { b: 10, u: 0 });
    // A stale cached bucket says empty; the server says full.
    fake.cache.set("ratelimits/act/p", { b: 0, u: 0 });
    const db = adminDb(fake as unknown as Database);
    const outcome = await db.transaction<{ b: number; u: number }>("ratelimits/act/p", (current) =>
      current && current.b >= 1 ? { b: current.b - 1, u: 1 } : undefined,
    );
    expect(outcome.committed).toBe(true);
    expect(fake.data.get("ratelimits/act/p")).toEqual({ b: 9, u: 1 });
  });

  it("reports an abort on the server's data as not committed and changes nothing", async () => {
    const fake = new FakeRtdb();
    fake.data.set("names/zezima", "someone-else");
    const db = adminDb(fake as unknown as Database);
    const outcome = await db.transaction<string>("names/zezima", (current) =>
      current === null || current === "me" ? "me" : undefined,
    );
    expect(outcome.committed).toBe(false);
    expect(fake.data.get("names/zezima")).toBe("someone-else");
  });
});

describe("mutatePlayer", () => {
  it("applies the change when the SDK first offers only the heartbeat's child", async () => {
    const fake = new FakeRtdb();
    fake.data.set(playerPath(301, "p"), record());
    // A heartbeat in flight in this instance: the SDK's view of the record is just `ls`, twice.
    fake.cache.set(playerPath(301, "p"), { ls: 6 });
    fake.cachedRuns = 2;
    const db = adminDb(fake as unknown as Database);
    const next = await mutatePlayer(db, 301, "p", (current) => ({ ...current, e: "wave", et: 7 }));
    expect(next.e).toBe("wave");
    expect((fake.data.get(playerPath(301, "p")) as PlayerRecord).e).toBe("wave");
  });

  it("treats a stored fragment as not joined and leaves it as it is", async () => {
    const fake = new FakeRtdb();
    fake.data.set(playerPath(301, "p"), { ls: 6 });
    const db = adminDb(fake as unknown as Database);
    const error = await mutatePlayer(db, 301, "p", (current) => ({ ...current, e: "wave" })).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).code).toBe("not_joined");
    expect(fake.data.get(playerPath(301, "p"))).toEqual({ ls: 6 });
  });

  it("reports a missing player as not joined", async () => {
    const fake = new FakeRtdb();
    const db = adminDb(fake as unknown as Database);
    const error = await mutatePlayer(db, 301, "p", (current) => current).catch((err: unknown) => err);
    expect((error as HttpError).code).toBe("not_joined");
    expect(fake.data.has(playerPath(301, "p"))).toBe(false);
  });
});
