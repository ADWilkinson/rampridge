/**
 * Housekeeping: drops silent players, trims chat and events, recounts each
 * world, and expires nonces, rate-limit buckets, announcement dedupe keys and
 * orphaned stall index entries. Heartbeats run the world part (pruneLight) at
 * most every LIGHT_PRUNE_INTERVAL_MS through sweep.ts, so presence, chat,
 * events and the world counts never depend on the cron. Everything the cron
 * alone removes also expires on read (nonces) or by timestamp (rate-limit
 * buckets), so a daily cron only reclaims space.
 *
 * A world that has been closed (`meta/worlds` lowered) and has nobody left in
 * it is retired: its chat, events, count and chat window are deleted.
 */

import { PLAYER_TIMEOUT_MS } from "../../shared/protocol.js";
import { chatPath, eventsPath, playersPath, worldIds, worldRoot } from "../../shared/worlds.js";
import type { Db } from "./db.js";
import { pruneIpJoins } from "./ipPlayers.js";
import { forgetPresence } from "./presence.js";
import { roomChatPath } from "./ratelimit.js";
import { STALL_INDEX, STALL_INDEX_IDLE_MS } from "./stallSweep.js";
import { populations, worldConfig, worldPopPath } from "./worlds.js";
import type { WorldCount } from "./worlds.js";

export const CHAT_KEEP = 150;
export const CHAT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const EVENTS_KEEP = 50;
/** Every token bucket is full again after this long idle, so dropping it changes nothing. */
export const BUCKET_IDLE_MS = 10 * 60 * 1000;
export const ANNOUNCED_KEEP_MS = 24 * 60 * 60 * 1000;
export const LIGHT_PRUNE_INTERVAL_MS = 30_000;
/** Deletes go out in batches to keep each update request small. */
const BATCH = 500;

/** What the light prune did in one world. */
export interface WorldPruneReport {
  players: number;
  chat: number;
  events: number;
  /** Players still heartbeating, written to `meta/worldPop/{id}`. */
  live: number;
  /** The world was closed and empty, and its data was deleted. */
  retired: boolean;
}

export interface LightPruneReport {
  players: number;
  chat: number;
  events: number;
  /** Players still heartbeating, per world pruned. */
  worlds: Record<string, number>;
  /** Closed, empty worlds whose data was deleted. */
  retired: number[];
}

export interface PruneReport extends LightPruneReport {
  nonces: number;
  rateLimits: number;
  announced: number;
  /** Stall index entries nobody has re-checked in STALL_INDEX_IDLE_MS. */
  stalls: number;
  /** Per-address join records older than a day (ipPlayers.ts). */
  ipJoins: number;
}

async function removeAll(db: Db, paths: string[]): Promise<number> {
  for (let i = 0; i < paths.length; i += BATCH) {
    const updates: Record<string, null> = {};
    for (const path of paths.slice(i, i + BATCH)) updates[path] = null;
    await db.update(updates);
  }
  return paths.length;
}

function numberField(value: unknown, field: string): number | null {
  if (value === null || typeof value !== "object") return null;
  const n = (value as Record<string, unknown>)[field];
  return typeof n === "number" ? n : null;
}

/**
 * Removes the world's silent players (and fragments without a heartbeat) and
 * returns how many were removed and how many are still live. One query reads
 * the whole world's players, which also gives the recount.
 */
export async function prunePlayers(db: Db, world: number, now: number): Promise<{ removed: number; live: number }> {
  const cutoff = now - PLAYER_TIMEOUT_MS;
  const all = await db.query(playersPath(world), { orderByChild: "ls" });
  const stale = all.filter(([, value]) => {
    const ls = numberField(value, "ls");
    return ls === null || ls <= cutoff;
  });
  // Each removal re-checks the heartbeat so a player who checked in after the
  // query is not dropped. Their presence goes after the record (presence.ts).
  const removed = await Promise.all(
    stale.map(async ([pid]) => {
      const outcome = await db.transaction<unknown>(`${playersPath(world)}/${pid}`, (current) => {
        const ls = numberField(current, "ls");
        return current !== null && (ls === null || ls <= cutoff) ? null : undefined;
      });
      if (outcome.committed) await forgetPresence(db, pid, world, now);
      return outcome.committed;
    }),
  );
  const count = removed.filter(Boolean).length;
  return { removed: count, live: all.length - count };
}

export async function pruneChat(db: Db, world: number, now: number): Promise<number> {
  const all = await db.query(chatPath(world), { orderByChild: "t" });
  const cutoff = now - CHAT_MAX_AGE_MS;
  const keepFrom = Math.max(0, all.length - CHAT_KEEP);
  const doomed = all.filter(([, value], i) => i < keepFrom || (numberField(value, "t") ?? 0) < cutoff);
  return removeAll(
    db,
    doomed.map(([key]) => `${chatPath(world)}/${key}`),
  );
}

export async function pruneEvents(db: Db, world: number): Promise<number> {
  const all = await db.query(eventsPath(world), { orderByChild: "t" });
  const doomed = all.slice(0, Math.max(0, all.length - EVENTS_KEEP));
  return removeAll(
    db,
    doomed.map(([key]) => `${eventsPath(world)}/${key}`),
  );
}

/**
 * The light prune for one world: silent players, then either the recount
 * (`meta/worldPop/{id}`) and the chat and events trim, or, for a closed world
 * nobody is left in, deleting everything it had.
 */
export async function pruneOneWorld(db: Db, world: number, open: boolean, counted: boolean, now: number): Promise<WorldPruneReport> {
  const { removed, live } = await prunePlayers(db, world, now);
  if (!open && live === 0) {
    const leftovers = removed > 0 || counted || (await db.query(chatPath(world), { limitToFirst: 1 })).length > 0;
    if (leftovers) {
      await db.update({ [worldRoot(world)]: null, [worldPopPath(world)]: null, [roomChatPath(world)]: null });
    }
    return { players: removed, chat: 0, events: 0, live: 0, retired: leftovers };
  }
  const [chat, events] = await Promise.all([pruneChat(db, world, now), pruneEvents(db, world)]);
  const count: WorldCount = { n: live, at: now };
  await db.set(worldPopPath(world), count);
  return { players: removed, chat, events, live, retired: false };
}

/**
 * The part of the sweep presence, chat, events and the world counts depend on.
 * Visits every open world and every world with a count (a closed world
 * players are still leaving); the cron passes every possible world.
 */
export async function pruneLight(db: Db, now: number, all = false): Promise<LightPruneReport> {
  const [config, pops] = await Promise.all([worldConfig(db), populations(db)]);
  const visit = all ? worldIds() : [...new Set([...config.open, ...pops.keys()])].sort((a, b) => a - b);
  const reports = await Promise.all(visit.map((world) => pruneOneWorld(db, world, config.open.includes(world), pops.has(world), now)));
  const out: LightPruneReport = { players: 0, chat: 0, events: 0, worlds: {}, retired: [] };
  visit.forEach((world, i) => {
    const report = reports[i]!;
    out.players += report.players;
    out.chat += report.chat;
    out.events += report.events;
    if (report.retired) out.retired.push(world);
    else if (config.open.includes(world) || report.live > 0) out.worlds[world] = report.live;
  });
  return out;
}

async function pruneByField(db: Db, path: string, field: string, olderThan: number): Promise<number> {
  const node = await db.get<Record<string, unknown>>(path);
  if (!node) return 0;
  const doomed = Object.entries(node)
    .filter(([, value]) => (numberField(value, field) ?? 0) < olderThan)
    .map(([key]) => `${path}/${key}`);
  return removeAll(db, doomed);
}

export async function pruneWorld(db: Db, now: number): Promise<PruneReport> {
  const light = await pruneLight(db, now, true);
  const idle = now - BUCKET_IDLE_MS;
  const [nonces, actionBuckets, chainBuckets, ipBuckets, ipChatBuckets, announced, stalls, ipJoins] = await Promise.all([
    pruneByField(db, "nonces", "x", now),
    pruneByField(db, "ratelimits/act", "u", idle),
    pruneByField(db, "ratelimits/chain", "u", idle),
    pruneByField(db, "ratelimits/ip", "u", idle),
    pruneByField(db, "ratelimits/ipchat", "u", idle),
    pruneByField(db, "announced", "t", now - ANNOUNCED_KEEP_MS),
    pruneByField(db, STALL_INDEX, "c", now - STALL_INDEX_IDLE_MS),
    pruneIpJoins(db, now),
  ]);
  return {
    ...light,
    nonces,
    rateLimits: actionBuckets + chainBuckets + ipBuckets + ipChatBuckets,
    announced,
    stalls,
    ipJoins,
  };
}
