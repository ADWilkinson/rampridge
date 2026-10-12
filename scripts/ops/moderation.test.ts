/**
 * The moderation script works without a server change by writing rate-limit
 * buckets the existing /api/act limiter refuses. These tests pin that
 * contract to the real limiter and cron prune, so a change to either fails
 * here instead of silently un-muting someone on launch day.
 */

import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../api/_lib/memoryDb";
import { BUCKET_IDLE_MS, pruneWorld } from "../../api/_lib/prune";
import { ACTION_BUCKET, actionBucketPath, CHAT_LIMIT, takeAction } from "../../api/_lib/ratelimit";
import type { ActionBucket } from "../../api/_lib/ratelimit";
// @ts-expect-error -- plain ESM helper without type declarations
import { ACTION_CAPACITY, bannedBucket, mutedBucket } from "./_lib.mjs";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
/** setTimeout fires at once above this, which would turn a client's back-off into a hot loop. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const muted = mutedBucket as (current: ActionBucket | null, until: number, now: number) => ActionBucket;
const banned = bannedBucket as (until: number) => ActionBucket;

describe("mute", () => {
  it("refuses chat until it ends and nothing else", () => {
    const until = NOW + 30 * MINUTE;
    const bucket = muted(null, until, NOW);
    const chat = takeAction(bucket, NOW + MINUTE, true);
    expect(chat.ok).toBe(false);
    if (!chat.ok) {
      expect(chat.retryAfterMs).toBe(until - (NOW + MINUTE) + CHAT_LIMIT.minIntervalMs);
      expect(chat.retryAfterMs).toBeLessThan(MAX_TIMER_MS);
    }
    const move = takeAction(bucket, NOW + MINUTE, false);
    expect(move.ok).toBe(true);
    // The chat clock survives ordinary actions.
    if (move.ok) expect(takeAction(move.next, NOW + 2 * MINUTE, true).ok).toBe(false);
    expect(takeAction(bucket, until + CHAT_LIMIT.minIntervalMs, true).ok).toBe(true);
  });

  it("keeps a recent bucket's tokens and never lifts a ban", () => {
    expect(muted({ b: 4, u: NOW - 1_000 }, NOW + MINUTE, NOW)).toMatchObject({ b: 4, u: NOW - 1_000, cl: NOW + MINUTE });
    expect(muted({ b: 1, u: NOW - 60 * MINUTE }, NOW + MINUTE, NOW)).toMatchObject({ b: ACTION_CAPACITY, u: NOW });
    const ban = banned(NOW + 60 * MINUTE);
    expect(muted(ban, NOW + MINUTE, NOW)).toMatchObject({ b: ban.b, u: ban.u });
  });

  it("matches the server's bucket capacity", () => {
    expect(ACTION_CAPACITY).toBe(ACTION_BUCKET.capacity);
  });
});

describe("ban", () => {
  const until = NOW + 7 * 24 * 60 * MINUTE;

  it("refuses every action with a back-off the client can schedule", () => {
    for (const chat of [false, true]) {
      const decision = takeAction(banned(until), NOW, chat);
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.retryAfterMs).toBeGreaterThan(24 * 60 * MINUTE);
        expect(decision.retryAfterMs).toBeLessThan(MAX_TIMER_MS);
      }
    }
  });

  it("survives the cron's idle-bucket prune until it ends", async () => {
    const pid = "abcdefghijklmnop";
    const db = new MemoryDb();
    await db.set(actionBucketPath(pid), banned(until));
    await pruneWorld(db, NOW + 3 * 24 * 60 * MINUTE);
    expect(db.read(actionBucketPath(pid))).not.toBeNull();
    expect(takeAction(db.read(actionBucketPath(pid)) as ActionBucket, until - MINUTE, false).ok).toBe(false);
    await pruneWorld(db, until + BUCKET_IDLE_MS + 1);
    expect(db.read(actionBucketPath(pid))).toBeNull();
  });
});
