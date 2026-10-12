/**
 * Unique display names: `names/{nameKey}` holds the pid that owns a name,
 * claimed in a transaction so two players can never hold the same name.
 * `nameSkeletons/{skeleton}` does the same for how a name reads in the game
 * font, so a chosen name cannot pose as another player's with a look-alike
 * letter (nameSkeleton). Guest names claim no skeleton.
 */

import { isReservedName, nameKey, normaliseName } from "../../shared/chat.js";
import type { Db } from "./db.js";
import { HttpError } from "./http.js";
import { cryptoRandomBytes } from "./random.js";
import type { RandomBytes } from "./random.js";

export const namePath = (key: string) => `names/${key}`;
export const skeletonPath = (skeleton: string) => `nameSkeletons/${skeleton}`;

/**
 * How a name key reads in the game font: capital I, lowercase l and 1 are a
 * single stroke, and O and 0 nearly so (keys are already lowercase, so "i"
 * stands for both I and i). "WiIkinson" and "Wi1kinson" read as "Wilkinson".
 */
export function nameSkeleton(key: string): string {
  return key.replace(/[i1]/g, "l").replace(/0/g, "o");
}

export function nameTaken(): HttpError {
  return new HttpError(409, "name_taken", "That name is already taken.");
}

export function nameLookAlike(): HttpError {
  return new HttpError(400, "bad_request", "That name looks too much like another player's. Please choose another.");
}

export function invalidName(requested = ""): HttpError {
  const trimmed = requested.replace(/\s+/g, " ").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9 _-]{0,11}$/.test(trimmed) && isReservedName(trimmed)) {
    return new HttpError(400, "bad_request", "That name is reserved. Please choose another.");
  }
  return new HttpError(
    400,
    "bad_request",
    "Names are 1-12 letters, numbers, spaces, hyphens or underscores, and must not be offensive.",
  );
}

/** Claims `key` for `pid`; true when the pid now owns it (including when it already did). */
export async function claimName(db: Db, key: string, pid: string): Promise<boolean> {
  const outcome = await db.transaction<string>(namePath(key), (current) =>
    current === null || current === pid ? pid : undefined,
  );
  return outcome.committed;
}

/** Releases `key` only if `pid` still holds it. */
export async function releaseName(db: Db, key: string, pid: string): Promise<void> {
  await db.transaction<string>(namePath(key), (current) => (current === pid ? null : undefined));
}

async function claimSkeleton(db: Db, skeleton: string, pid: string): Promise<boolean> {
  const outcome = await db.transaction<string>(skeletonPath(skeleton), (current) =>
    current === null || current === pid ? pid : undefined,
  );
  return outcome.committed;
}

async function releaseSkeleton(db: Db, skeleton: string, pid: string): Promise<void> {
  await db.transaction<string>(skeletonPath(skeleton), (current) => (current === pid ? null : undefined));
}

function randomDigits(random: RandomBytes, count: number): string {
  let out = "";
  while (out.length < count) {
    for (const byte of random(count * 2)) {
      if (byte < 250 && out.length < count) out += String(byte % 10);
    }
  }
  return out;
}

/**
 * Digits in a guest name by attempt: four while that space has room, then
 * five, then six. Guest names are never released while their player keeps
 * them, so a busy launch fills the 9,000-odd four-digit names; widening after
 * two collisions keeps new players from paying a database round trip for
 * each of many collisions.
 */
export function guestDigits(attempt: number): number {
  return attempt < 2 ? 4 : attempt < 4 ? 5 : 6;
}

/** Claims a free "Guest####" name, widening the number after repeated collisions. */
export async function claimGuestName(db: Db, pid: string, random: RandomBytes = cryptoRandomBytes): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const name = `Guest${randomDigits(random, guestDigits(attempt))}`;
    if (await claimName(db, nameKey(name), pid)) return name;
  }
  throw new HttpError(503, "server", "Could not find a free guest name. Please try again.");
}

/**
 * Whether `requested` would be accepted for `pid`, without writing anything:
 * the same rules as claimRequestedName. Throws the same 400 and 409 errors.
 */
export async function checkRequestedName(db: Db, pid: string, requested: string): Promise<{ name: string; key: string }> {
  const name = normaliseName(requested);
  if (!name) throw invalidName(requested);
  const key = nameKey(name);
  const [owner, lookAlikeOwner] = await Promise.all([
    db.get<unknown>(namePath(key)),
    db.get<unknown>(skeletonPath(nameSkeleton(key))),
  ]);
  if (owner !== null && owner !== pid) throw nameTaken();
  if (lookAlikeOwner !== null && lookAlikeOwner !== pid) throw nameLookAlike();
  return { name, key };
}

/**
 * Gives `pid` the requested name: validates, claims the new key, then
 * releases the old one. A change of case or separator keeps the same key.
 */
export async function claimRequestedName(
  db: Db,
  pid: string,
  requested: string,
  previousKey: string | null,
): Promise<{ name: string; key: string }> {
  const name = normaliseName(requested);
  if (!name) throw invalidName(requested);
  const key = nameKey(name);
  if (key !== previousKey) {
    if (!(await claimName(db, key, pid))) throw nameTaken();
    const skeleton = nameSkeleton(key);
    const previousSkeleton = previousKey ? nameSkeleton(previousKey) : null;
    // A change within the same look (Wilkinson -> WiIkinson) keeps the skeleton the player has.
    if (skeleton !== previousSkeleton && !(await claimSkeleton(db, skeleton, pid))) {
      await releaseName(db, key, pid);
      throw nameLookAlike();
    }
    if (previousKey) {
      await releaseName(db, previousKey, pid);
      if (previousSkeleton !== null && previousSkeleton !== skeleton) await releaseSkeleton(db, previousSkeleton, pid);
    }
  }
  return { name, key };
}
