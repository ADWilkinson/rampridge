import { describe, expect, it } from "vitest";
import { HttpError } from "./http";
import { MemoryDb } from "./memoryDb";
import {
  ACTION_BUCKET,
  CHAIN_BUCKET,
  CHAT_LIMIT,
  hashIp,
  limitAction,
  limitChain,
  limitRoomChat,
  limitSessionCreation,
  ROOM_CHAT_LIMIT,
  SESSION_CREATE_BUCKET,
  takeAction,
  takeToken,
  takeWindow,
} from "./ratelimit";
import type { ActionBucket, TokenBucket } from "./ratelimit";

/** Time for one token to come back. */
const refillMs = (spec: { refillPerSecond: number }) => Math.ceil(1000 / spec.refillPerSecond);
import { TEST_SECRET } from "./testing";

describe("takeAction", () => {
  it("allows a burst then refills at the bucket rate", () => {
    let bucket: ActionBucket | null = null;
    const now = 1_000_000;
    for (let i = 0; i < ACTION_BUCKET.capacity; i++) {
      const decision = takeAction(bucket, now, false);
      expect(decision.ok).toBe(true);
      if (decision.ok) bucket = decision.next;
    }
    const limited = takeAction(bucket, now, false);
    expect(limited).toEqual({ ok: false, retryAfterMs: refillMs(ACTION_BUCKET) });
    expect(takeAction(bucket, now + refillMs(ACTION_BUCKET), false).ok).toBe(true);
    const refilled = takeAction(bucket, now + 60_000, false);
    expect(refilled.ok && refilled.next.b).toBe(ACTION_BUCKET.capacity - 1);
  });

  it("spaces chat messages by 1.2 s", () => {
    const first = takeAction(null, 0, true);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(takeAction(first.next, 500, true)).toEqual({ ok: false, retryAfterMs: 700 });
    expect(takeAction(first.next, CHAT_LIMIT.minIntervalMs, true).ok).toBe(true);
    // Non-chat actions are unaffected by the chat spacing.
    expect(takeAction(first.next, 500, false).ok).toBe(true);
  });

  it("caps chat at 30 per minute", () => {
    let bucket: ActionBucket | null = null;
    let t = 0;
    for (let i = 0; i < CHAT_LIMIT.perMinute; i++) {
      const decision = takeAction(bucket, t, true);
      expect(decision.ok).toBe(true);
      if (decision.ok) bucket = decision.next;
      t += CHAT_LIMIT.minIntervalMs;
    }
    const limited = takeAction(bucket, t, true);
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.retryAfterMs).toBe(CHAT_LIMIT.windowMs - t);
    expect(takeAction(bucket, CHAT_LIMIT.windowMs, true).ok).toBe(true);
  });
});

describe("takeToken", () => {
  it("lets three chain reads through, then one every 10 s", () => {
    let bucket: TokenBucket | null = null;
    for (let i = 0; i < CHAIN_BUCKET.capacity; i++) {
      const decision = takeToken(bucket, 0, CHAIN_BUCKET);
      expect(decision.ok).toBe(true);
      if (decision.ok) bucket = decision.next;
    }
    expect(takeToken(bucket, 0, CHAIN_BUCKET)).toEqual({ ok: false, retryAfterMs: 10_000 });
    expect(takeToken(bucket, 9_999, CHAIN_BUCKET).ok).toBe(false);
    expect(takeToken(bucket, 10_000, CHAIN_BUCKET).ok).toBe(true);
  });

  it("treats a malformed record as a full bucket", () => {
    expect(takeToken({ w: 1, c: 99 } as never, 0, CHAIN_BUCKET)).toEqual({ ok: true, next: { b: CHAIN_BUCKET.capacity - 1, u: 0 } });
  });
});

describe("takeWindow", () => {
  it("counts within a fixed window", () => {
    let counter = null;
    for (let i = 0; i < 3; i++) {
      const decision = takeWindow(counter, 10, 3, 1_000);
      expect(decision.ok).toBe(true);
      if (decision.ok) counter = decision.next;
    }
    expect(takeWindow(counter, 500, 3, 1_000)).toEqual({ ok: false, retryAfterMs: 510 });
    expect(takeWindow(counter, 1_010, 3, 1_000)).toEqual({ ok: true, next: { w: 1_010, c: 1 } });
  });
});

describe("database limits", () => {
  it("throws 429 with a retry hint once the bucket is empty", async () => {
    const db = new MemoryDb();
    for (let i = 0; i < ACTION_BUCKET.capacity; i++) await limitAction(db, "p", 5_000);
    const err = await limitAction(db, "p", 5_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).retryAfterMs).toBe(refillMs(ACTION_BUCKET));
    // Limits are per player.
    await expect(limitAction(db, "q", 5_000)).resolves.toBeUndefined();
  });

  it("limits new sessions per hashed IP with a burst-tolerant bucket", async () => {
    const db = new MemoryDb();
    const ip = hashIp("203.0.113.9", TEST_SECRET);
    expect(ip).toMatch(/^[0-9a-f]{32}$/);
    expect(ip).not.toContain("203");
    expect(SESSION_CREATE_BUCKET.capacity).toBeGreaterThanOrEqual(60);
    for (let i = 0; i < SESSION_CREATE_BUCKET.capacity; i++) await limitSessionCreation(db, ip, 0);
    await expect(limitSessionCreation(db, ip, 1)).rejects.toMatchObject({ status: 429 });
    // One more player is let in every 10 s rather than none for the rest of an hour.
    await expect(limitSessionCreation(db, ip, refillMs(SESSION_CREATE_BUCKET))).resolves.toBeUndefined();
    await expect(limitSessionCreation(db, ip, refillMs(SESSION_CREATE_BUCKET) + 1)).rejects.toMatchObject({ status: 429 });
  });

  it("limits chain reads per player", async () => {
    const db = new MemoryDb();
    for (let i = 0; i < CHAIN_BUCKET.capacity; i++) await limitChain(db, "p", 0);
    await expect(limitChain(db, "p", 0)).rejects.toMatchObject({ status: 429, retryAfterMs: 10_000 });
    await expect(limitChain(db, "q", 0)).resolves.toBeUndefined();
    expect(db.read("ratelimits/chain/p")).toMatchObject({ u: 0 });
  });

  it("caps chat across each world, separately", async () => {
    const db = new MemoryDb();
    for (let i = 0; i < ROOM_CHAT_LIMIT.perWindow; i++) await limitRoomChat(db, 301, 100);
    const err = (await limitRoomChat(db, 301, 400).catch((e: unknown) => e)) as HttpError;
    expect(err).toMatchObject({ status: 429, code: "rate_limited", retryAfterMs: ROOM_CHAT_LIMIT.windowMs - 300 });
    // Another world's chat is its own.
    await expect(limitRoomChat(db, 302, 400)).resolves.toBeUndefined();
    await expect(limitRoomChat(db, 301, 100 + ROOM_CHAT_LIMIT.windowMs)).resolves.toBeUndefined();
  });
});
