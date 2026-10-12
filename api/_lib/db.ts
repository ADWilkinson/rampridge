/**
 * The slice of the Realtime Database the API uses, behind an interface so
 * handlers run against an in-memory fake in tests. Paths are relative to the
 * root of the `rampridge-world` instance.
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import type { AppOptions, ServiceAccount } from "firebase-admin/app";
import { getDatabase, ServerValue } from "firebase-admin/database";
import type { Database, Query } from "firebase-admin/database";
import { serviceAccount } from "./env.js";

export const DATABASE_URL = "https://rampridge-world.firebaseio.com";
const APP_NAME = "rampridge-world";
/** Firebase project that owns `rampridge-world`; the emulator only uses it as a label. */
const EMULATOR_PROJECT_ID = "peerlyticsapp";

export interface QueryOptions {
  /** Order by this numeric child; otherwise by key. */
  orderByChild?: string;
  startAt?: number;
  endAt?: number;
  limitToFirst?: number;
  limitToLast?: number;
}

export interface TransactionOutcome<T> {
  committed: boolean;
  /** The value at the path after the transaction (or the current value when aborted). */
  value: T | null;
}

export interface Db {
  get<T = unknown>(path: string): Promise<T | null>;
  set(path: string, value: unknown): Promise<void>;
  /** Atomic multi-path update from the root; a null value deletes the path. */
  update(updates: Record<string, unknown>): Promise<void>;
  remove(path: string): Promise<void>;
  /**
   * Adds `delta` to the number at `path` on the server, with no read and no
   * retry (a missing value counts as 0), so concurrent increments never
   * conflict or get lost the way read-modify-write transactions on one hot
   * path can.
   */
  increment(path: string, delta: number): Promise<void>;
  /** Appends under `path` with a chronological push key and returns the key. */
  push(path: string, value: unknown): Promise<string>;
  /** A new chronological push key, without writing (for one record written under several paths). */
  key(): string;
  /**
   * Atomic read-modify-write. `update` must be pure and synchronous: it may run
   * several times. Return the new value, null to delete, or undefined to abort.
   */
  transaction<T>(path: string, update: (current: T | null) => T | null | undefined): Promise<TransactionOutcome<T>>;
  /** Children of `path` in ascending order as [key, value] pairs. */
  query<T = unknown>(path: string, options: QueryOptions): Promise<Array<[string, T]>>;
}

export function adminDb(database: Database): Db {
  return {
    async get<T>(path: string) {
      const snap = await database.ref(path).get();
      return snap.exists() ? (snap.val() as T) : null;
    },
    async set(path, value) {
      await database.ref(path).set(value);
    },
    async update(updates) {
      if (Object.keys(updates).length === 0) return;
      await database.ref().update(updates);
    },
    async remove(path) {
      await database.ref(path).remove();
    },
    async increment(path, delta) {
      await database.ref().update({ [path]: ServerValue.increment(delta) });
    },
    async push(path, value) {
      const ref = database.ref(path).push();
      await ref.set(value);
      return ref.key!;
    },
    key() {
      return database.ref().push().key!;
    },
    async transaction<T>(path: string, update: (current: T | null) => T | null | undefined) {
      // The SDK first calls the update with its local cache, which can be
      // empty, stale, or partial: only the child another in-flight
      // transaction in this instance is writing (a heartbeat's `ls` while a
      // move runs on the whole player). Aborting on that first guess would
      // never consult the server, so the first run proposes its input
      // unchanged instead: the server rejects it unless the cache was exactly
      // right and reruns the update with the real value; when it was right,
      // the write changes nothing and listeners hear nothing. Reruns see the
      // server's data and may abort. The last verdict decides the outcome.
      let aborted = false;
      let runs = 0;
      const result = await database.ref(path).transaction(
        (current: T | null) => {
          runs++;
          const next = update(current ?? null);
          aborted = next === undefined;
          if (next === undefined) return runs === 1 ? (current ?? null) : undefined;
          return next;
        },
        undefined,
        false,
      );
      const value = result.snapshot.exists() ? (result.snapshot.val() as T) : null;
      return { committed: result.committed && !aborted, value };
    },
    async query<T>(path: string, options: QueryOptions) {
      let query: Query = database.ref(path);
      query = options.orderByChild ? query.orderByChild(options.orderByChild) : query.orderByKey();
      if (options.startAt !== undefined) query = query.startAt(options.startAt);
      if (options.endAt !== undefined) query = query.endAt(options.endAt);
      if (options.limitToFirst !== undefined) query = query.limitToFirst(options.limitToFirst);
      if (options.limitToLast !== undefined) query = query.limitToLast(options.limitToLast);
      const snap = await query.get();
      const out: Array<[string, T]> = [];
      snap.forEach((child) => {
        if (child.key) out.push([child.key, child.val() as T]);
      });
      return out;
    },
  };
}

let cached: Db | null = null;

/**
 * The database, initialised on first use from FIREBASE_SERVICE_ACCOUNT. When
 * FIREBASE_DATABASE_EMULATOR_HOST is set (local development) the Admin SDK
 * talks to the emulator with its owner token and needs no credentials.
 */
export function getDb(): Db {
  if (cached) return cached;
  const app = getApps().find((a) => a.name === APP_NAME) ?? initializeApp(appOptions(), APP_NAME);
  cached = adminDb(getDatabase(app));
  return cached;
}

function appOptions(): AppOptions {
  if (process.env.FIREBASE_DATABASE_EMULATOR_HOST?.trim()) {
    return { databaseURL: DATABASE_URL, projectId: EMULATOR_PROJECT_ID };
  }
  const sa = serviceAccount();
  return {
    credential: cert({
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      privateKey: sa.private_key,
    } satisfies ServiceAccount),
    databaseURL: DATABASE_URL,
  };
}
