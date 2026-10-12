/**
 * Durable share records (`shares/{id}`): one per accepted announcement, read
 * by the share page and card functions. The cron never prunes them. Each is
 * a few hundred bytes and holds no wallet address.
 */

import type { WorldEventRecord } from "../../shared/protocol.js";
import { isShareId, shareIdFor, sharePath, storedShareRecord, toShareRecord } from "../../shared/share.js";
import type { ShareKind, ShareRecord } from "../../shared/share.js";
import type { Db } from "./db.js";

/**
 * Saves the share record for a verified world event and returns its id. The
 * announcer's world goes with it, so the link brings people to that world.
 * The first record for an id wins (a player announcing two payouts in one
 * transaction keeps the first). Null when the event can't be shaped into a
 * record; a database failure is the caller's to handle.
 */
export async function saveShare(db: Db, event: WorldEventRecord, pid: string, world: number | null = null): Promise<string | null> {
  if (event.kind !== "bought" && event.kind !== "listed") return null;
  const record = toShareRecord({ ...event, world });
  if (!record) return null;
  const id = shareIdFor(event.kind satisfies ShareKind, event.tx, pid);
  const stored = storedShareRecord(record);
  const outcome = await db.transaction<Record<string, unknown>>(sharePath(id), (current) => (current === null ? stored : undefined));
  // Aborted means a record is already there, which the link should still point at.
  return outcome.committed || outcome.value !== null ? id : null;
}

/** The record for `id`, or null for a malformed id, a missing record or one that fails validation. */
export async function loadShare(db: Db, id: string): Promise<ShareRecord | null> {
  if (!isShareId(id)) return null;
  return toShareRecord(await db.get<unknown>(sharePath(id)));
}
