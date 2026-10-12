/** Reads and writes of `worlds/{id}/players/{pid}`. */

import type { PlayerRecord } from "../../shared/protocol.js";
import { playersPath } from "../../shared/worlds.js";
import type { Db } from "./db.js";
import { HttpError, notJoined } from "./http.js";

export const playerPath = (world: number, pid: string) => `${playersPath(world)}/${pid}`;

/**
 * Heartbeats rewrite `ls` only once it is this old. Every write reaches every
 * connected client, so with 15 s heartbeats this halves the presence traffic
 * (a write every 30 s). Clients built before this treat a player as gone 45 s
 * after `ls`, so it must stay well under that: a live player's `ls` is at most
 * ~30 s old, or ~45 s after one lost heartbeat (a brief flicker there only).
 */
export const PRESENCE_REFRESH_MS = 20_000;

/** A whole player record: what join writes. Fragments (a write that raced a leave) are not players. */
export function isPlayerRecord(value: unknown): value is PlayerRecord {
  if (value === null || typeof value !== "object") return false;
  const { n, a, p, t, ls } = value as Record<string, unknown>;
  return typeof n === "string" && typeof p === "string" && typeof t === "number" && typeof ls === "number" && typeof a === "object" && a !== null;
}

/**
 * Applies `change` to the player's record atomically. Throws 409 not_joined
 * when the player is not in the world, so a late heartbeat can never
 * resurrect a pruned player as a partial record. `change` may throw an
 * HttpError to reject the action; it is rethrown unchanged.
 */
export async function mutatePlayer(
  db: Db,
  world: number,
  pid: string,
  change: (record: PlayerRecord) => PlayerRecord,
): Promise<PlayerRecord> {
  let rejection: HttpError | null = null;
  let partial = false;
  const outcome = await db.transaction<PlayerRecord>(playerPath(world, pid), (current) => {
    rejection = null;
    partial = false;
    if (current === null) return undefined;
    if (!isPlayerRecord(current)) {
      // Only part of the record is known locally: another write in flight in
      // this instance touches one child (a heartbeat's `ls`), so the SDK
      // offers just that child. Aborting here would report a present player
      // as gone. Propose it unchanged so the server reruns this with the real
      // record; if the stored record really is this fragment, the write
      // changes nothing and the player counts as not joined.
      partial = true;
      return current;
    }
    try {
      return change(current);
    } catch (err) {
      if (err instanceof HttpError) {
        rejection = err;
        return undefined;
      }
      throw err;
    }
  });
  if (rejection) throw rejection;
  if (partial || !outcome.committed || !outcome.value) throw notJoined();
  return outcome.value;
}

/**
 * Heartbeat: moves only `ls`, so the realtime update every client downloads is
 * one number instead of the whole record, and only when it is
 * PRESENCE_REFRESH_MS old. Aborts when `ls` is gone (the player was pruned or
 * left), which keeps a late heartbeat from creating a partial record. Only a
 * join writes `ls` into a new record, so a record with `ls` is complete.
 */
export async function touchPlayer(db: Db, world: number, pid: string, now: number): Promise<void> {
  const outcome = await db.transaction<number>(`${playerPath(world, pid)}/ls`, (current) => {
    if (typeof current !== "number") return undefined;
    return now - current < PRESENCE_REFRESH_MS ? undefined : Math.max(current, now);
  });
  // Not written but still there: the player is present and `ls` is fresh enough.
  if (!outcome.committed && typeof outcome.value !== "number") throw notJoined();
}
