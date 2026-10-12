/**
 * How many players one address may have standing in the bank at once,
 * counted across every world.
 *
 * Sessions are cheap (a burst of 60 per IP, then one every 10 s), and each
 * joined player costs every viewer in their world its heartbeats, moves and a
 * character to render, so a script on one machine could otherwise fill a
 * world (or, one world at a time, all of them) with idle bots.
 * `ipjoins/{ipHash}/{pid}` is { t: join time, w: world } for the players who
 * joined from that address; a join counts those still in their world (their
 * record still has `ls`) and is refused past the cap. Entries for players who
 * left are dropped on the next join from the same address, and the cron drops
 * entries older than a day.
 */

import type { Db } from "./db.js";
import { rateLimited } from "./http.js";
import { playerPath } from "./players.js";
import { PID_PATTERN } from "./token.js";
import { isWorldId } from "../../shared/worlds.js";

/** Generous for a household, an office or a meetup on one network; a ceiling for a bot farm. */
export const IP_PLAYER_CAP = 20;
/** What a refused join is told to wait (the client shows the message rather than waiting). */
export const IP_PLAYER_RETRY_MS = 60_000;
/** Entries this old are dropped by the cron even if their player is still around. */
export const IP_JOIN_KEEP_MS = 24 * 60 * 60 * 1000;
export const IP_JOINS = "ipjoins";
export const ipJoinsPath = (ipHash: string) => `${IP_JOINS}/${ipHash}`;

/** One player who joined from an address. */
export interface IpJoin {
  /** Joined at, server ms. */
  t: number;
  /** The world they joined. */
  w: number;
}

type IpJoins = Record<string, IpJoin>;

function asJoin(value: unknown): IpJoin | null {
  if (value === null || typeof value !== "object") return null;
  const { t, w } = value as Record<string, unknown>;
  return typeof t === "number" && isWorldId(w) ? { t, w } : null;
}

/** Well-formed entries. Anything else (an entry from before worlds) counts as gone. */
function entries(value: unknown): Array<[string, IpJoin]> {
  if (value === null || typeof value !== "object") return [];
  const out: Array<[string, IpJoin]> = [];
  for (const [pid, raw] of Object.entries(value as Record<string, unknown>)) {
    const join = asJoin(raw);
    if (PID_PATTERN.test(pid) && join) out.push([pid, join]);
  }
  return out;
}

/**
 * Records `pid` as joining `world` from `ipHash`, or throws 429 when
 * IP_PLAYER_CAP other players from that address are already in a world. A
 * rejoin or hop by a player already counted always passes.
 */
export async function admitFromIp(db: Db, ipHash: string, pid: string, world: number, now: number): Promise<void> {
  const path = ipJoinsPath(ipHash);
  const known = entries(await db.get<IpJoins>(path)).filter(([p]) => p !== pid);
  // Liveness is checked before the transaction (it cannot read other paths); entries added meanwhile count as live.
  const gone = new Set<string>();
  await Promise.all(
    known.map(async ([p, join]) => {
      if (typeof (await db.get<unknown>(`${playerPath(join.w, p)}/ls`)) !== "number") gone.add(p);
    }),
  );
  let refused = false;
  const outcome = await db.transaction<IpJoins>(path, (current) => {
    refused = false;
    const others = entries(current).filter(([p]) => p !== pid && !gone.has(p));
    if (others.length >= IP_PLAYER_CAP) {
      refused = true;
      return undefined;
    }
    return Object.fromEntries([...others, [pid, { t: now, w: world }]]);
  });
  if (refused || !outcome.committed) {
    throw rateLimited(IP_PLAYER_RETRY_MS, "Too many players from your network are in the bank. Try again later.");
  }
}

/** Cron: drops entries older than IP_JOIN_KEEP_MS (and malformed ones). Returns how many were removed. */
export async function pruneIpJoins(db: Db, now: number): Promise<number> {
  const all = await db.get<Record<string, unknown>>(IP_JOINS);
  if (!all) return 0;
  const updates: Record<string, null> = {};
  for (const [ipHash, value] of Object.entries(all)) {
    if (value === null || typeof value !== "object") {
      updates[ipJoinsPath(ipHash)] = null;
      continue;
    }
    for (const [pid, raw] of Object.entries(value as Record<string, unknown>)) {
      const join = asJoin(raw);
      if (!join || now - join.t > IP_JOIN_KEEP_MS) updates[`${ipJoinsPath(ipHash)}/${pid}`] = null;
    }
  }
  const removed = Object.keys(updates).length;
  if (removed > 0) await db.update(updates);
  return removed;
}
