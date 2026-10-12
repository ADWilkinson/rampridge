/**
 * Keeps advertised stalls honest. A stall is checked on-chain when it opens,
 * but the seller can later withdraw, pause, drain or re-price the deposit or
 * switch its payment method off. Heartbeats therefore re-run buildStall for
 * each open stall about once a minute: a stall that no longer passes is
 * cleared, and one whose rate, amount or method changed is rewritten.
 *
 * `stalls/{pid}` is a server-only index ({ d: depositId, c: checkedAt }) so a
 * sweep does not have to read every player in every world. It is written
 * before the stall itself. A sweep finds the player through the server's
 * presence index (presence.ts), wherever they have hopped, and re-checks the
 * stall their record shows; entries whose player left or closed the stall are
 * dropped when they come due.
 */

import type { PlayerRecord, StallSummary } from "../../shared/protocol.js";
import type { ChainGateway } from "./chain.js";
import type { Db } from "./db.js";
import { HttpError } from "./http.js";
import { playerPath } from "./players.js";
import { presenceOf } from "./presence.js";
import { buildStall } from "./stall.js";

/** How stale an open stall may get before it is re-checked. */
export const STALL_RECHECK_MS = 60_000;
/** At most one sweep per interval across all instances. */
export const STALL_SWEEP_INTERVAL_MS = 15_000;
/** Stalls re-checked per sweep, which bounds the RPC work one heartbeat waits on. */
export const STALL_RECHECK_BATCH = 6;
/** Index entries untouched this long belong to nobody (sweeps touch live ones every minute). */
export const STALL_INDEX_IDLE_MS = 60 * 60 * 1000;

export const STALL_INDEX = "stalls";
export const stallIndexPath = (pid: string) => `${STALL_INDEX}/${pid}`;

export interface StallIndexRecord {
  /** Composite deposit id the stall advertises. */
  d: string;
  /** Last on-chain check, server ms. */
  c: number;
}

export type StallRecheck = "kept" | "updated" | "cleared" | "dropped" | "deferred";

function asIndexRecord(value: unknown): StallIndexRecord | null {
  if (value === null || typeof value !== "object") return null;
  const { d, c } = value as Record<string, unknown>;
  return typeof d === "string" && typeof c === "number" ? { d, c } : null;
}

function sameStall(a: StallSummary, b: StallSummary): boolean {
  return (
    a.depositId === b.depositId &&
    a.escrow === b.escrow &&
    a.platform === b.platform &&
    a.currency === b.currency &&
    a.available === b.available &&
    a.rate === b.rate
  );
}

/** Records that `pid` now advertises `depositId`, checked at `now`. */
export function indexStall(db: Db, pid: string, depositId: string, now: number): Promise<void> {
  const record: StallIndexRecord = { d: depositId, c: now };
  return db.set(stallIndexPath(pid), record);
}

/**
 * After a re-check of the entry that named `seen`: marks it checked at
 * `checkedAt` for `depositId` (the stall the record showed), or drops it for
 * null. Leaves it alone if the stall action replaced it meanwhile.
 */
async function updateIndex(db: Db, pid: string, seen: string, depositId: string, checkedAt: number | null): Promise<void> {
  await db.transaction<unknown>(stallIndexPath(pid), (current) => {
    const entry = asIndexRecord(current);
    if (entry?.d !== seen) return undefined;
    return checkedAt === null ? null : { d: depositId, c: checkedAt };
  });
}

/**
 * Re-validates the stall the player's record shows, in whichever world the
 * server has them now. That is normally the indexed deposit; if a stall
 * action with an old token re-pointed the index, the record's stall is the
 * one that is advertised, so that is the one checked. Chain outages leave the
 * stall as it is and retry next interval, so a flaky RPC does not make stalls
 * flicker.
 */
export async function recheckStall(
  db: Db,
  chain: ChainGateway,
  pid: string,
  entry: StallIndexRecord,
  now: number,
): Promise<StallRecheck> {
  const world = await presenceOf(db, pid);
  const path = world === null ? null : playerPath(world, pid);
  const player = path === null ? null : await db.get<PlayerRecord>(path);
  const wallet = player?.w;
  const depositId = player?.s?.depositId;
  if (path === null || !player || !wallet || !depositId) {
    await updateIndex(db, pid, entry.d, entry.d, null);
    return "dropped";
  }

  let summary: StallSummary | null;
  try {
    summary = await buildStall(chain, depositId, wallet);
  } catch (err) {
    if (!(err instanceof HttpError) || err.status >= 500) {
      await updateIndex(db, pid, entry.d, depositId, now);
      return "deferred";
    }
    summary = null;
  }

  let outcome: StallRecheck = "kept";
  await db.transaction<PlayerRecord>(path, (current) => {
    outcome = "kept";
    if (current === null || typeof current !== "object" || current.s?.depositId !== depositId) return undefined;
    if (current.w !== wallet) return undefined;
    if (summary === null) {
      outcome = "cleared";
      return { ...current, s: null };
    }
    if (sameStall(current.s, summary)) return undefined;
    outcome = "updated";
    return { ...current, s: summary };
  });
  await updateIndex(db, pid, entry.d, depositId, summary === null ? null : now);
  return outcome;
}

/**
 * Re-checks the stalls most overdue for it, at most STALL_RECHECK_BATCH.
 * sweep.ts runs this at most every STALL_SWEEP_INTERVAL_MS across instances.
 * `chain` is only created when there is work. Returns how many stalls were
 * looked at.
 */
export async function recheckDueStalls(db: Db, chain: () => ChainGateway, now: number): Promise<number> {
  const index = (await db.get<Record<string, unknown>>(STALL_INDEX)) ?? {};
  const malformed: Record<string, null> = {};
  const due: Array<[string, StallIndexRecord]> = [];
  for (const [pid, value] of Object.entries(index)) {
    const entry = asIndexRecord(value);
    if (!entry) malformed[stallIndexPath(pid)] = null;
    else if (now - entry.c >= STALL_RECHECK_MS) due.push([pid, entry]);
  }
  await db.update(malformed);
  if (due.length === 0) return 0;

  due.sort((a, b) => a[1].c - b[1].c);
  const batch = due.slice(0, STALL_RECHECK_BATCH);
  const gateway = chain();
  const results = await Promise.allSettled(batch.map(([pid, entry]) => recheckStall(db, gateway, pid, entry, now)));
  for (const result of results) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      console.error("Stall re-check failed:", reason instanceof Error ? reason.message : String(reason));
    }
  }
  return batch.length;
}
