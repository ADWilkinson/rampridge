import type { CelebrationKind } from "../types";
import { hashString, mix } from "../util/hash";

/**
 * What the merchants nearest a verified world event say overhead: a
 * settled trade gets the classic congratulations, a new sell order (a stall
 * going live) a line about the stall. Local to each client; nothing is sent.
 */
export const CHEER_LINES: Readonly<Record<CelebrationKind, readonly string[]>> = {
  trade: ["gz!", "Nice trade!"],
  listing: ["New stall!", "gl with the sale!"],
};

/**
 * The line the merchant with `merchantSeed` says to the player `pid` for a
 * `kind` of celebration: chosen from the merchant and the player, so it
 * varies between merchants and players and every client picks the same one.
 */
export function cheerLine(kind: CelebrationKind, merchantSeed: string, pid: string): string {
  const lines = CHEER_LINES[kind];
  return lines[mix(hashString(merchantSeed), hashString(pid)) % lines.length]!;
}
