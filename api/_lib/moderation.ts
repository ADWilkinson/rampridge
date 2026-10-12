/**
 * Mutes and bans set by scripts/ops/moderate.mjs. `moderation/{pid}` is
 * { m: muted until, b: banned until, r: reason, at }, server ms. The script
 * also squeezes the player's rate-limit bucket so a sanction bites on a
 * server that doesn't read this; reading the record here keeps a mute after
 * the cron drops an idle player's bucket, and a ban after the bucket refills.
 */

import type { Db } from "./db.js";

export const moderationPath = (pid: string) => `moderation/${pid}`;

export interface Sanctions {
  /** Chat is refused until this server ms (0: not muted). */
  mutedUntil: number;
  /** Joining is refused until this server ms (0: not banned). */
  bannedUntil: number;
}

function time(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function moderationOf(db: Db, pid: string): Promise<Sanctions> {
  const record = await db.get<Record<string, unknown>>(moderationPath(pid));
  if (record === null || typeof record !== "object") return { mutedUntil: 0, bannedUntil: 0 };
  // A ban silences too.
  return { mutedUntil: Math.max(time(record.m), time(record.b)), bannedUntil: time(record.b) };
}
