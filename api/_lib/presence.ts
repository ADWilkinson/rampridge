/**
 * `presence/{pid}`: which world the server has a player standing in. Tokens
 * name a world too, but an old token (from /api/session, or from before a
 * hop) can be replayed, so a join or a leave never trusts it for where the
 * player is.
 *
 * Invariant: a player has at most one record, in the world their presence
 * names. A join writes the new record, the presence and the removal of the
 * old record in one update; a leave removes the record and the presence in
 * one update. Both first take a short lock here, so two joins (or a join and
 * a leave) of the same player never interleave. The prune removes a silent
 * player's record first and their presence after it, so a presence may name a
 * world the player has left (a join then treats them as arriving), but a
 * record never outlives its presence.
 */

import type { Db } from "./db.js";
import { rateLimited } from "./http.js";
import { isWorldId } from "../../shared/worlds.js";

export const PRESENCE = "presence";
export const presencePath = (pid: string) => `${PRESENCE}/${pid}`;
/** How long a join or leave holds the player's lock at most (one that crashed frees it after this). */
export const PRESENCE_LOCK_MS = 10_000;
/** What a join that found another join or leave of the same player under way is told to wait (the client waits and resends). */
export const PRESENCE_BUSY_RETRY_MS = 1_000;
export const PRESENCE_BUSY_MESSAGE = "Please wait a moment and try again.";

export interface PresenceRecord {
  /** The world the player's record is in. */
  w?: number;
  /** A join or leave of this player is under way until this server time. */
  l?: number;
  /** Which join or leave holds the lock. */
  k?: string;
}

function asPresence(value: unknown): PresenceRecord | null {
  if (value === null || typeof value !== "object") return null;
  const { w, l, k } = value as Record<string, unknown>;
  return {
    ...(isWorldId(w) ? { w } : {}),
    ...(typeof l === "number" ? { l } : {}),
    ...(typeof k === "string" ? { k } : {}),
  };
}

/** The world the server has `pid` in, or null. */
export async function presenceOf(db: Db, pid: string): Promise<number | null> {
  return asPresence(await db.get<unknown>(presencePath(pid)))?.w ?? null;
}

/** A held lock: the world the player was in when it was taken (or null), and the key that releases it. */
export interface PresenceLock {
  pid: string;
  from: number | null;
  key: string;
}

/**
 * Takes the player's lock, keeping the world it names (so a lock left by a
 * crash still says where the player is). Throws 429 PRESENCE_BUSY_MESSAGE
 * while another join or leave of the same player holds it. With `only`,
 * takes it only when the player is in that world and returns null otherwise.
 */
export async function lockPresence(db: Db, pid: string, now: number): Promise<PresenceLock>;
export async function lockPresence(db: Db, pid: string, now: number, only: number): Promise<PresenceLock | null>;
export async function lockPresence(db: Db, pid: string, now: number, only?: number): Promise<PresenceLock | null> {
  const key = db.key();
  let busy = false;
  let elsewhere = false;
  let from: number | null = null;
  const outcome = await db.transaction<PresenceRecord>(presencePath(pid), (current) => {
    const entry = asPresence(current);
    busy = (entry?.l ?? 0) > now;
    from = entry?.w ?? null;
    elsewhere = only !== undefined && from !== only;
    if (busy || elsewhere) return undefined;
    return { ...(from !== null ? { w: from } : {}), l: now + PRESENCE_LOCK_MS, k: key };
  });
  if (elsewhere) return null;
  if (busy || !outcome.committed) throw rateLimited(PRESENCE_BUSY_RETRY_MS, PRESENCE_BUSY_MESSAGE);
  return { pid, from, key };
}

/** Gives a lock back unchanged (a join that was refused after taking it). Best effort: it expires anyway. */
export async function unlockPresence(db: Db, lock: PresenceLock): Promise<void> {
  try {
    await db.transaction<PresenceRecord>(presencePath(lock.pid), (current) => {
      if (asPresence(current)?.k !== lock.key) return undefined;
      return lock.from !== null ? { w: lock.from } : null;
    });
  } catch (err) {
    console.error("Presence unlock failed:", err instanceof Error ? err.message : String(err));
  }
}

/** The update entry that records the player in `world` (or nowhere, for null) and frees the lock. */
export function presenceEntry(pid: string, world: number | null): Record<string, PresenceRecord | null> {
  return { [presencePath(pid)]: world === null ? null : { w: world } };
}

/**
 * Prune: forgets the player's presence once their record in `world` is gone,
 * unless they have since moved or a join or leave of theirs is under way.
 */
export async function forgetPresence(db: Db, pid: string, world: number, now: number): Promise<void> {
  await db.transaction<PresenceRecord>(presencePath(pid), (current) => {
    const entry = asPresence(current);
    if (entry?.w !== world || (entry.l ?? 0) > now) return undefined;
    return null;
  });
}
