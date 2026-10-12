/**
 * Heartbeats double as the presence and stall sweeps so neither depends on
 * the cron. One transaction on `meta/sweep` ({ p: last light prune, s: last
 * stall re-check }) decides, across every instance, which part is due; a
 * heartbeat only pays for it when this instance has not tried recently.
 */

import type { ChainGateway } from "./chain.js";
import type { Db } from "./db.js";
import { LIGHT_PRUNE_INTERVAL_MS, pruneLight } from "./prune.js";
import { recheckDueStalls, STALL_SWEEP_INTERVAL_MS } from "./stallSweep.js";

export const SWEEP_PATH = "meta/sweep";
/** One instance asks for the sweep at most this often (the shortest sweep interval). */
export const SWEEP_CHECK_INTERVAL_MS = Math.min(LIGHT_PRUNE_INTERVAL_MS, STALL_SWEEP_INTERVAL_MS);

export interface SweepClaims {
  /** Last light prune, server ms. */
  p?: number;
  /** Last stall re-check, server ms. */
  s?: number;
}

export interface SweepDue {
  prune: boolean;
  stalls: boolean;
}

export function dueSweeps(current: SweepClaims | null, now: number): SweepDue {
  const p = typeof current?.p === "number" ? current.p : null;
  const s = typeof current?.s === "number" ? current.s : null;
  return {
    prune: p === null || now - p >= LIGHT_PRUNE_INTERVAL_MS,
    stalls: s === null || now - s >= STALL_SWEEP_INTERVAL_MS,
  };
}

/** Claims whichever sweeps are due; the claim is what stops concurrent heartbeats all doing them. */
export async function claimSweeps(db: Db, now: number): Promise<SweepDue> {
  let due: SweepDue = { prune: false, stalls: false };
  await db.transaction<SweepClaims>(SWEEP_PATH, (current) => {
    due = dueSweeps(current, now);
    if (!due.prune && !due.stalls) return undefined;
    const next: SweepClaims = { ...current };
    if (due.prune) next.p = now;
    if (due.stalls) next.s = now;
    return next;
  });
  return due;
}

function logFailure(what: string): (err: unknown) => void {
  return (err) => {
    console.error(`${what} failed:`, err instanceof Error ? err.message : String(err));
  };
}

/**
 * Per-instance gate in front of the shared claim. `maybeSweep` never throws:
 * a failed sweep must not fail the heartbeat that ran it.
 */
export function createSweeper(): { maybeSweep(db: Db, chain: () => ChainGateway, now: number): Promise<SweepDue> } {
  let nextCheckAt = 0;
  return {
    async maybeSweep(db, chain, now) {
      const none: SweepDue = { prune: false, stalls: false };
      if (now < nextCheckAt) return none;
      nextCheckAt = now + SWEEP_CHECK_INTERVAL_MS;
      let due: SweepDue;
      try {
        due = await claimSweeps(db, now);
      } catch (err) {
        logFailure("Sweep claim")(err);
        return none;
      }
      await Promise.all([
        due.prune ? pruneLight(db, now).catch(logFailure("World prune")) : null,
        due.stalls ? recheckDueStalls(db, chain, now).catch(logFailure("Stall sweep")) : null,
      ]);
      return due;
    },
  };
}
