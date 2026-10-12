/**
 * Worlds (shared/worlds.ts): which are open, how many players each holds, and
 * which one a joining player goes to.
 *
 * Every player's moves and heartbeats are downloaded by every other player in
 * the same world, so a world's realtime traffic grows with the square of its
 * size (scripts/load/README.md). The operator sets, in the Firebase console
 * and with no deploy:
 *
 * - `meta/worlds`: how many worlds are open (301, 302, ...; default 3).
 * - `meta/worldCap`: players per world (default 200).
 * - `meta/roomCap`: optional ceiling on players across every world.
 *
 * Anything that is not a positive whole number reads as unset. A player who is
 * already standing in a world always gets back in (a reload, a second tab),
 * even when it is full or has since been closed; closing a world only stops
 * new arrivals, and it empties as its players leave.
 *
 * `meta/worldPop/{id}` ({ n, at }) is each world's count: the light prune
 * recounts it about every 30 s, and in between each admitted arrival adds one
 * and each leave or hop out takes one away, as server-side increments (no
 * transaction, so a burst of joins and leaves never contends on the count or
 * loses an update). It is a soft count: a join checks the cap against the
 * counts it read, so joins racing within one read can overshoot a cap by a
 * few, and the recount puts any drift right.
 */

import type { WorldRequest } from "../../shared/protocol.js";
import { DEFAULT_OPEN_WORLDS, DEFAULT_WORLD_CAP, isWorldId, MAX_WORLDS, softTarget, worldIds } from "../../shared/worlds.js";
import type { Db } from "./db.js";
import { conflict, rateLimited } from "./http.js";

export const OPEN_WORLDS_PATH = "meta/worlds";
export const WORLD_CAP_PATH = "meta/worldCap";
export const ROOM_CAP_PATH = "meta/roomCap";
export const WORLD_POP = "meta/worldPop";
export const worldPopPath = (world: number) => `${WORLD_POP}/${world}`;
/** What a refused join is told to wait; the client shows the message rather than waiting. */
export const ROOM_FULL_RETRY_MS = 60_000;
export const ROOM_FULL_MESSAGE = "The bank is full right now. Try again in a few minutes.";

export interface WorldConfig {
  /** Open world numbers, ascending. */
  open: number[];
  /** Players per world. */
  cap: number;
  /** Players across every world (`meta/roomCap`), or null for no overall ceiling. */
  roomCap: number | null;
}

/** `meta/worldPop/{id}`. */
export interface WorldCount {
  /** Players at the last recount, plus arrivals and minus departures since. */
  n: number;
  /** Last recount, server ms. */
  at: number;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function worldConfigFrom(raw: { worlds: unknown; cap: unknown; roomCap: unknown }): WorldConfig {
  const count = Math.min(positiveInt(raw.worlds) ?? DEFAULT_OPEN_WORLDS, MAX_WORLDS);
  return { open: worldIds(count), cap: positiveInt(raw.cap) ?? DEFAULT_WORLD_CAP, roomCap: positiveInt(raw.roomCap) };
}

/** The operator's settings, read on every join (three small reads). */
export async function worldConfig(db: Db): Promise<WorldConfig> {
  const [worlds, cap, roomCap] = await Promise.all([
    db.get<unknown>(OPEN_WORLDS_PATH),
    db.get<unknown>(WORLD_CAP_PATH),
    db.get<unknown>(ROOM_CAP_PATH),
  ]);
  return worldConfigFrom({ worlds, cap, roomCap });
}

/** Each counted world's players (worlds with no count are absent). */
export async function populations(db: Db): Promise<Map<number, number>> {
  const raw = await db.get<Record<string, unknown>>(WORLD_POP);
  const out = new Map<number, number>();
  if (raw === null || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(key);
    const n = value !== null && typeof value === "object" ? (value as Record<string, unknown>).n : undefined;
    if (isWorldId(id) && typeof n === "number" && Number.isFinite(n)) out.set(id, Math.max(0, n));
  }
  return out;
}

/**
 * The order to try worlds for a new arrival: first the worlds still below
 * their soft target (SOFT_FILL of the cap), busiest first, so players meet
 * each other instead of spreading thin; then the rest that have room,
 * quietest first, so no world reaches its cap while another has space.
 * Full worlds are never offered. Ties go to the lower world number.
 */
export function rankWorlds(open: readonly number[], pops: ReadonlyMap<number, number>, cap: number): number[] {
  const count = (id: number) => pops.get(id) ?? 0;
  const target = softTarget(cap);
  const withRoom = open.filter((id) => count(id) < cap);
  const filling = withRoom.filter((id) => count(id) < target).sort((a, b) => count(b) - count(a) || a - b);
  const spilling = withRoom.filter((id) => count(id) >= target).sort((a, b) => count(a) - count(b) || a - b);
  return [...filling, ...spilling];
}

/** Takes a place in `world`. The caller has checked the count against the cap. */
export async function claimSeat(db: Db, world: number): Promise<void> {
  await db.increment(`${worldPopPath(world)}/n`, 1);
}

/** Gives a place back (a leave, a hop out, a join refused after its seat was taken). Reads clamp the count at 0. */
export async function releaseSeat(db: Db, world: number): Promise<void> {
  await db.increment(`${worldPopPath(world)}/n`, -1);
}

/** Where a join lands: `world`, and whether it took a new seat there (false when the player was already inside). */
export interface Placement {
  world: number;
  seated: boolean;
}

export interface PlacementRequest {
  request: WorldRequest;
  /** World Switcher: exactly `request` or a refusal. */
  hop: boolean;
  /** The world the server has the player standing in right now (presence.ts, with a live record), or null. */
  inside: number | null;
}

function uniq(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

/**
 * Picks the world a join lands in and takes its seat. A player already inside
 * a world stays there unless they asked for another one; a numeric request
 * that is full or closed falls back to staying put (inside) or to the ranked
 * open worlds (arriving). A hop is strict. `meta/roomCap` holds for everyone
 * who is not already inside (a move between worlds leaves the total as it
 * is). Throws 429 "The bank is full" when nothing has room, and 409 for a hop
 * to a full or closed world.
 */
export async function placeJoin(db: Db, req: PlacementRequest, config: WorldConfig): Promise<Placement> {
  const { request, hop, inside } = req;
  if (inside !== null && (request === "auto" || request === inside)) return { world: inside, seated: false };

  const pops = await populations(db);
  const count = (id: number) => pops.get(id) ?? 0;
  if (inside === null && config.roomCap !== null) {
    let total = 0;
    for (const n of pops.values()) total += n;
    if (total >= config.roomCap) throw rateLimited(ROOM_FULL_RETRY_MS, ROOM_FULL_MESSAGE);
  }
  const hasRoom = (id: number) => config.open.includes(id) && count(id) < config.cap;

  if (hop) {
    if (typeof request !== "number" || !config.open.includes(request)) throw conflict(`World ${request} is not open.`);
    if (!hasRoom(request)) throw conflict(`World ${request} is full.`);
    await claimSeat(db, request);
    return { world: request, seated: true };
  }

  const preferred = typeof request === "number" && hasRoom(request) ? [request] : [];
  const world = inside !== null ? preferred[0] : uniq([...preferred, ...rankWorlds(config.open, pops, config.cap)])[0];
  if (world === undefined) {
    if (inside !== null) return { world: inside, seated: false };
    throw rateLimited(ROOM_FULL_RETRY_MS, ROOM_FULL_MESSAGE);
  }
  await claimSeat(db, world);
  return { world, seated: true };
}

/** Worlds that hear world news: every open world, and any closed one that still has players. */
export async function newsWorlds(db: Db): Promise<number[]> {
  const [config, pops] = await Promise.all([worldConfig(db), populations(db)]);
  const lingering = [...pops].filter(([id, n]) => n > 0 && !config.open.includes(id)).map(([id]) => id);
  return uniq([...config.open, ...lingering]).sort((a, b) => a - b);
}
