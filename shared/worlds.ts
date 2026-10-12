/**
 * Worlds: identical copies of the bank, numbered like the original game's
 * (301, 302, ...). Every player downloads every other player's updates, so a
 * room's realtime traffic grows with the square of its size; splitting the
 * players across worlds keeps each one lively without that bill. Everything
 * that fans out to clients (players, chat, world news) lives under
 * `worlds/{id}/`, the only part of the database browsers can read.
 * Dependency-free, like protocol.ts: imported by the browser and the API.
 */

/** The first world's number, as in the original game. */
export const FIRST_WORLD = 301;
/** World numbers run FIRST_WORLD .. FIRST_WORLD + MAX_WORLDS - 1; `meta/worlds` can open at most this many. */
export const MAX_WORLDS = 20;
export const LAST_WORLD = FIRST_WORLD + MAX_WORLDS - 1;
/** Open worlds and players per world when the operator has set nothing (`meta/worlds`, `meta/worldCap`). */
export const DEFAULT_OPEN_WORLDS = 3;
export const DEFAULT_WORLD_CAP = 200;
/**
 * New arrivals fill the busiest world below this share of its cap before the
 * next one gets anyone, so a quiet evening has one lively bank rather than
 * three empty ones. Once every open world is past it, arrivals go to the
 * quietest world that still has room.
 */
export const SOFT_FILL = 0.7;

/** The query parameter that asks for a world: `/?world=302`. */
export const WORLD_PARAM = "world";

export function isWorldId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= FIRST_WORLD && value <= LAST_WORLD;
}

/** The first `count` world numbers (clamped to 1..MAX_WORLDS). */
export function worldIds(count: number = MAX_WORLDS): number[] {
  const n = Math.max(1, Math.min(MAX_WORLDS, Math.floor(count)));
  return Array.from({ length: n }, (_, i) => FIRST_WORLD + i);
}

/** `302` from "302" (a query parameter or a share record); null for anything else. */
export function parseWorldId(value: unknown): number | null {
  const n = typeof value === "string" && /^\d{3}$/.test(value.trim()) ? Number(value.trim()) : value;
  return isWorldId(n) ? n : null;
}

/** How many players a world holds before arrivals spill to the next (at least 1). */
export function softTarget(cap: number): number {
  return Math.max(1, Math.floor(cap * SOFT_FILL));
}

export const worldRoot = (world: number) => `worlds/${world}`;
export const playersPath = (world: number) => `worlds/${world}/players`;
export const chatPath = (world: number) => `worlds/${world}/chat`;
export const eventsPath = (world: number) => `worlds/${world}/events`;

/** One row of the World Switcher (`GET /api/worlds`). */
export interface WorldListEntry {
  id: number;
  /** Players in the world at the server's last count (a soft count, refreshed about every 30 s). */
  players: number;
  /** At or over the per-world cap: hopping there is refused. */
  full: boolean;
}

/** `GET /api/worlds`: the open worlds, for the World Switcher. */
export interface WorldListResponse {
  ok: boolean;
  error?: string;
  worlds: WorldListEntry[];
  /** Players per world. */
  cap: number;
  now: number;
}
