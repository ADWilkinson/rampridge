/**
 * Player identities. `profiles/{pid}` is the authoritative name and wallet;
 * the session token's claims are only a convenience for the client.
 */

import type { Db } from "./db.js";
import { cryptoRandomBytes } from "./random.js";
import type { RandomBytes } from "./random.js";

export interface Profile {
  /** Display name. */
  n: string;
  /** nameKey(n), the key this player holds under names/. */
  k: string;
  /** Verified wallet, lowercase. */
  w?: string | null;
  /** Created and updated, server ms. */
  c: number;
  u: number;
}

export const profilePath = (pid: string) => `profiles/${pid}`;

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 16 random base36 characters (about 82 bits). */
export function newPid(random: RandomBytes = cryptoRandomBytes): string {
  // 252 is the largest multiple of 36 below 256, so rejecting bytes above it keeps the draw uniform.
  let out = "";
  while (out.length < 16) {
    for (const byte of random(24)) {
      if (byte < 252 && out.length < 16) out += BASE36[byte % 36];
    }
  }
  return out;
}

export async function getProfile(db: Db, pid: string): Promise<Profile | null> {
  const raw = await db.get<Partial<Profile>>(profilePath(pid));
  if (!raw || typeof raw.n !== "string" || typeof raw.k !== "string") return null;
  return {
    n: raw.n,
    k: raw.k,
    w: typeof raw.w === "string" ? raw.w : null,
    c: typeof raw.c === "number" ? raw.c : 0,
    u: typeof raw.u === "number" ? raw.u : 0,
  };
}
