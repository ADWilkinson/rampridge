/**
 * Read-only subscriptions to one world's `worlds/{id}/*` (players, chat and
 * world news). The Firebase SDK is the primary transport; the REST event
 * stream (Server-Sent Events) is the fallback when the SDK cannot initialise.
 * Both report child-level changes to a sink. A hop to another world stops
 * one transport and starts another.
 */

import { getApps, initializeApp } from "firebase/app";
import type { FirebaseOptions } from "firebase/app";
import {
  connectDatabaseEmulator,
  getDatabase,
  goOffline,
  goOnline,
  limitToLast,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onValue,
  orderByChild,
  query,
  ref,
} from "firebase/database";
import type { Database, Unsubscribe } from "firebase/database";
import { chatPath, eventsPath, playersPath } from "@shared/worlds";
import type { ConnectionStatus } from "./store";

export type WorldStream = "players" | "chat" | "events";
export type ChildOp = "added" | "changed" | "removed";

export const CHAT_HISTORY = 50;
export const EVENT_HISTORY = 20;

export interface TransportSink {
  child(stream: WorldStream, op: ChildOp, key: string, value: unknown, live: boolean): void;
  status(status: ConnectionStatus): void;
  /** Server clock minus local clock, when the transport knows it. */
  offset(offsetMs: number): void;
}

export interface WorldTransport {
  readonly kind: "firebase" | "sse";
  start(sink: TransportSink): void;
  stop(): void;
}

export interface FirebaseWorldConfig {
  databaseURL: string;
  projectId?: string;
  apiKey?: string;
  appId?: string;
  /** Development only: "127.0.0.1:9600" reads the local database emulator instead (VITE_RTDB_EMULATOR_HOST). */
  emulatorHost?: string;
}

const APP_NAME = "rampridge-world";
/** Databases already pointed at the emulator: the SDK allows it once, before first use. */
const onEmulator = new WeakSet<Database>();
/**
 * A stopped transport takes the connection offline one task later, so a hop
 * (stop this world's view, start the next one's straight away) keeps the
 * socket open instead of reporting a lost connection.
 */
const goingOffline = new WeakMap<Database, ReturnType<typeof setTimeout>>();

/** Throws if the SDK cannot be initialised with this configuration. */
export function createFirebaseTransport(config: FirebaseWorldConfig, world: number): WorldTransport {
  // Public reads need only the database URL; empty optional fields would be rejected, so omit them.
  const options: FirebaseOptions = { databaseURL: config.databaseURL };
  if (config.projectId) options.projectId = config.projectId;
  if (config.apiKey) options.apiKey = config.apiKey;
  if (config.appId) options.appId = config.appId;
  const app = getApps().find((a) => a.name === APP_NAME) ?? initializeApp(options, APP_NAME);
  const db: Database = getDatabase(app, config.databaseURL);
  if (config.emulatorHost && !onEmulator.has(db)) {
    const [host, port] = config.emulatorHost.split(":");
    connectDatabaseEmulator(db, host!, Number(port));
    onEmulator.add(db);
  }
  let unsubscribes: Unsubscribe[] = [];

  return {
    kind: "firebase",
    start(sink) {
      clearTimeout(goingOffline.get(db));
      goingOffline.delete(db);
      goOnline(db);
      sink.status("connecting");
      const onError = (err: Error) => {
        console.warn("[world] realtime listener cancelled:", err.message);
        sink.status("error");
      };
      let wasOnline = false;
      unsubscribes.push(
        onValue(ref(db, ".info/connected"), (snap) => {
          const connected = snap.val() === true;
          if (connected) wasOnline = true;
          sink.status(connected ? "online" : wasOnline ? "offline" : "connecting");
        }),
        onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
          const value: unknown = snap.val();
          if (typeof value === "number") sink.offset(value);
        }),
      );

      const players = ref(db, playersPath(world));
      unsubscribes.push(
        onChildAdded(players, (snap) => sink.child("players", "added", snap.key!, snap.val(), true), onError),
        onChildChanged(players, (snap) => sink.child("players", "changed", snap.key!, snap.val(), true), onError),
        onChildRemoved(players, (snap) => sink.child("players", "removed", snap.key!, null, true), onError),
      );

      // History arrives as child_added before the first value event; only later children are live.
      // child_removed fires both when the window slides and when a line is deleted; the
      // WorldClient tells the two apart. The removed value is the line that left.
      for (const [stream, path, limit] of [
        ["chat", chatPath(world), CHAT_HISTORY],
        ["events", eventsPath(world), EVENT_HISTORY],
      ] as const) {
        const recent = query(ref(db, path), orderByChild("t"), limitToLast(limit));
        let live = false;
        unsubscribes.push(
          onChildAdded(recent, (snap) => sink.child(stream, "added", snap.key!, snap.val(), live), onError),
          onChildRemoved(recent, (snap) => sink.child(stream, "removed", snap.key!, snap.val(), live), onError),
          onValue(
            recent,
            () => {
              live = true;
            },
            onError,
            { onlyOnce: true },
          ),
        );
      }
    },
    stop() {
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes = [];
      clearTimeout(goingOffline.get(db));
      goingOffline.set(
        db,
        setTimeout(() => {
          goingOffline.delete(db);
          goOffline(db);
        }, 0),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// REST event stream fallback

export interface ChildChange {
  op: ChildOp;
  key: string;
  value: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drops nulls and empty objects, as the database does. */
function prune(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      if (p !== null) out[k] = p;
    }
    return Object.keys(out).length ? out : null;
  }
  return value;
}

function setIn(target: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string, ...string[]];
  const base: Record<string, unknown> = isObject(target) ? { ...target } : Array.isArray(target) ? { ...target } : {};
  base[head] = setIn(base[head], rest, value);
  return base;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Applies one `put` or `patch` stream event to the children of a location and
 * returns the child-level changes, mirroring child_added/changed/removed.
 * A patch reports each child it touched once, with its final value: a move
 * patches a player's path, start time and run flag together, and a reader
 * must never see the new path with the old start time.
 */
export function applyStreamEvent(
  children: Map<string, unknown>,
  event: "put" | "patch",
  path: string,
  data: unknown,
): ChildChange[] {
  const segments = path.split("/").filter(Boolean);
  if (event === "patch") {
    if (!isObject(data)) return [];
    const before = new Map<string, unknown>();
    for (const [rel, value] of Object.entries(data)) {
      const target = [...segments, ...rel.split("/")].filter(Boolean);
      const key = target[0];
      if (key === undefined) continue;
      if (!before.has(key)) before.set(key, children.get(key));
      applyStreamEvent(children, "put", target.join("/"), value);
    }
    const changes: ChildChange[] = [];
    for (const [key, previous] of before) {
      const value = children.get(key);
      if (value === undefined) {
        if (previous !== undefined) changes.push({ op: "removed", key, value: null });
      } else if (previous === undefined) {
        changes.push({ op: "added", key, value });
      } else if (!sameValue(previous, value)) {
        changes.push({ op: "changed", key, value });
      }
    }
    return changes;
  }

  if (segments.length === 0) {
    const next = isObject(data) ? data : {};
    const changes: ChildChange[] = [];
    for (const key of children.keys()) {
      if (!(key in next) || prune(next[key]) === null) {
        children.delete(key);
        changes.push({ op: "removed", key, value: null });
      }
    }
    for (const [key, raw] of Object.entries(next)) {
      const value = prune(raw);
      if (value === null) continue;
      const before = children.get(key);
      if (before === undefined) changes.push({ op: "added", key, value });
      else if (!sameValue(before, value)) changes.push({ op: "changed", key, value });
      else continue;
      children.set(key, value);
    }
    return changes;
  }

  const [key, ...rest] = segments as [string, ...string[]];
  const before = children.get(key);
  const value = prune(setIn(before, rest, data));
  if (value === null) {
    if (before === undefined) return [];
    children.delete(key);
    return [{ op: "removed", key, value: null }];
  }
  children.set(key, value);
  if (before === undefined) return [{ op: "added", key, value }];
  return sameValue(before, value) ? [] : [{ op: "changed", key, value }];
}

/** Firebase's REST streaming endpoint for a location, with an optional ordered window. */
export function streamUrl(databaseURL: string, path: string, limit?: number): string {
  const base = `${databaseURL.replace(/\/+$/, "")}/${path}.json`;
  if (limit === undefined) return base;
  const params = new URLSearchParams({ orderBy: '"t"', limitToLast: String(limit) });
  return `${base}?${params.toString()}`;
}

const RECONNECT_MS = 3_000;

export function createSseTransport(databaseURL: string, world: number): WorldTransport {
  if (typeof EventSource === "undefined") throw new Error("EventSource is not available");
  const streams: Array<{ stream: WorldStream; url: string }> = [
    { stream: "players", url: streamUrl(databaseURL, playersPath(world)) },
    { stream: "chat", url: streamUrl(databaseURL, chatPath(world), CHAT_HISTORY) },
    { stream: "events", url: streamUrl(databaseURL, eventsPath(world), EVENT_HISTORY) },
  ];
  let sources: EventSource[] = [];
  let timers: Array<ReturnType<typeof setTimeout>> = [];
  let stopped = true;

  return {
    kind: "sse",
    start(sink) {
      stopped = false;
      const ready = new Set<WorldStream>();
      // Kept across reconnects so the resync snapshot diffs against what the client already has.
      const known = new Map<WorldStream, Map<string, unknown>>(streams.map(({ stream }) => [stream, new Map()]));
      sink.status("connecting");
      const report = () => sink.status(ready.size === streams.length ? "online" : "connecting");

      const open = ({ stream, url }: (typeof streams)[number]) => {
        if (stopped) return;
        const children = known.get(stream)!;
        const source = new EventSource(url);
        sources.push(source);
        const handle = (kind: "put" | "patch") => (event: MessageEvent<string>) => {
          let payload: { path?: unknown; data?: unknown };
          try {
            payload = JSON.parse(event.data) as { path?: unknown; data?: unknown };
          } catch {
            return;
          }
          const path = typeof payload.path === "string" ? payload.path : "/";
          // A root put is the initial snapshot (or a resync after reconnecting): history, not live.
          const live = !(kind === "put" && path === "/");
          for (const change of applyStreamEvent(children, kind, path, payload.data)) {
            sink.child(stream, change.op, change.key, change.value, live);
          }
          if (!live && !ready.has(stream)) {
            ready.add(stream);
            report();
          }
        };
        source.addEventListener("put", handle("put"));
        source.addEventListener("patch", handle("patch"));
        const restart = () => {
          source.close();
          sources = sources.filter((s) => s !== source);
          ready.delete(stream);
          sink.status("offline");
          if (!stopped) timers.push(setTimeout(() => open({ stream, url }), RECONNECT_MS));
        };
        // The server cancels a stream when read rules change; reopen it.
        source.addEventListener("cancel", restart);
        source.addEventListener("auth_revoked", restart);
        source.onerror = () => {
          if (source.readyState === EventSource.CLOSED) restart();
          else if (ready.delete(stream)) sink.status("offline");
        };
      };
      for (const entry of streams) open(entry);
    },
    stop() {
      stopped = true;
      for (const source of sources) source.close();
      for (const timer of timers) clearTimeout(timer);
      sources = [];
      timers = [];
    },
  };
}
