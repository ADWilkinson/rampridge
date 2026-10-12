/**
 * WorldClient: the live, read-only view of one world's `worlds/{id}/*`. It
 * validates every record it receives, keeps the current player map,
 * estimates server time, and emits typed events. `connectWorldStore` wires
 * one into the zustand store; a hop disconnects it and connects a client for
 * the new world.
 */

import { FIREBASE_CONFIG } from "@/config";
import type { ChatRecord, PlayerRecord, WorldEventRecord } from "@shared/protocol";
import { parseChatRecord, parsePlayerRecord, parseWorldEventRecord } from "@shared/validate";
import type { ConnectionStatus } from "./store";
import { serverNow as storeServerNow, useWorldStore } from "./store";
import { CHAT_HISTORY, createFirebaseTransport, createSseTransport } from "./transport";
import type { ChildOp, TransportSink, WorldStream, WorldTransport } from "./transport";

export type WorldClientEvent =
  | { type: "status"; status: ConnectionStatus }
  | { type: "player"; op: "added" | "changed"; pid: string; record: PlayerRecord }
  | { type: "player"; op: "removed"; pid: string }
  | { type: "chat"; id: string; record: ChatRecord; live: boolean }
  /**
   * Moderation deleted chat lines (`ids`) from the subscribed window. A purge
   * deletes every line by its author, so lines by `pids` older than `before`
   * (they left the window already, so no removal reaches the client) go too.
   */
  | { type: "chatPurged"; ids: string[]; pids: string[]; before: number }
  | { type: "event"; id: string; record: WorldEventRecord; live: boolean }
  | { type: "offset"; offsetMs: number };

export type WorldClientListener = (event: WorldClientEvent) => void;

export interface WorldClientOptions {
  /** The world to watch (shared/worlds.ts). */
  world: number;
  databaseURL?: string;
  /**
   * "auto" (default) tries the Firebase SDK and falls back to the REST event
   * stream. A function supplies the transport itself (tests).
   */
  transport?: "auto" | "firebase" | "sse" | (() => WorldTransport);
}

/**
 * When a purge empties part of the chat window, older lines slide back in,
 * oldest first. A line this much older than the newest line held is such
 * history (the store already has it, or it was never shown live), not
 * something said just now. The margin covers lines that concurrent requests
 * committed slightly out of order.
 */
const BACKFILL_MARGIN_MS = 5_000;

/** A line in the subscribed chat window: enough to tell a purge from the window sliding. */
interface WindowLine {
  t: number;
  pid: string;
}

function byTimeThenKey([ka, a]: [string, WindowLine], [kb, b]: [string, WindowLine]): number {
  return a.t - b.t || (ka < kb ? -1 : ka > kb ? 1 : 0);
}

export class WorldClient {
  private readonly options: Required<WorldClientOptions>;
  private readonly listeners = new Set<WorldClientListener>();
  private readonly playerMap = new Map<string, PlayerRecord>();
  private transport: WorldTransport | null = null;
  private currentStatus: ConnectionStatus = "idle";
  private transportOffsetMs: number | null = null;
  /** The chat lines the transport's last-CHAT_HISTORY window currently holds. */
  private readonly chatWindow = new Map<string, WindowLine>();
  /** Chat removals waiting for the rest of their batch (see flushChatRemovals). */
  private readonly chatRemovals = new Set<string>();
  private chatFlushQueued = false;

  constructor(options: WorldClientOptions) {
    this.options = {
      world: options.world,
      databaseURL: options.databaseURL ?? FIREBASE_CONFIG.databaseURL,
      transport: options.transport ?? "auto",
    };
  }

  /** The world this client watches. */
  get world(): number {
    return this.options.world;
  }

  /** Players currently in the world, keyed by pid. */
  get players(): ReadonlyMap<string, PlayerRecord> {
    return this.playerMap;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  /** Which transport is running, once started. */
  get transportKind(): "firebase" | "sse" | null {
    return this.transport?.kind ?? null;
  }

  /** Server time estimate, ms: Firebase's offset when known, else API response samples. */
  serverNow(): number {
    return this.transportOffsetMs === null ? storeServerNow() : Date.now() + this.transportOffsetMs;
  }

  on(listener: WorldClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.transport) return;
    this.transport = this.createTransport();
    this.transport.start(this.sink());
  }

  stop(): void {
    this.transport?.stop();
    this.transport = null;
    this.playerMap.clear();
    this.chatWindow.clear();
    this.chatRemovals.clear();
    this.setStatus("idle");
  }

  private createTransport(): WorldTransport {
    const { world, databaseURL, transport } = this.options;
    if (typeof transport === "function") return transport();
    if (transport === "sse") return createSseTransport(databaseURL, world);
    const config = { ...FIREBASE_CONFIG, databaseURL };
    if (transport === "firebase") return createFirebaseTransport(config, world);
    try {
      return createFirebaseTransport(config, world);
    } catch (err) {
      console.warn("Realtime SDK unavailable, using the event stream:", err instanceof Error ? err.message : err);
      return createSseTransport(databaseURL, world);
    }
  }

  private emit(event: WorldClientEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("World listener failed:", err);
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.emit({ type: "status", status });
  }

  private sink(): TransportSink {
    return {
      status: (status) => this.setStatus(status),
      offset: (offsetMs) => {
        this.transportOffsetMs = offsetMs;
        this.emit({ type: "offset", offsetMs });
      },
      child: (stream, op, key, value, live) => this.onChild(stream, op, key, value, live),
    };
  }

  private onChild(stream: WorldStream, op: ChildOp, key: string, value: unknown, live: boolean): void {
    if (stream === "players") {
      const record = op === "removed" ? null : parsePlayerRecord(value);
      if (!record) {
        // A record we cannot render is treated as gone.
        if (this.playerMap.delete(key)) this.emit({ type: "player", op: "removed", pid: key });
        return;
      }
      const known = this.playerMap.has(key);
      this.playerMap.set(key, record);
      this.emit({ type: "player", op: known ? "changed" : "added", pid: key, record });
      return;
    }
    if (stream === "chat") {
      this.onChat(op, key, value, live);
      return;
    }
    // Events are an append-only window; a removal is the window sliding or the prune.
    if (op === "removed") return;
    const record = parseWorldEventRecord(value);
    if (record) this.emit({ type: "event", id: key, record, live });
  }

  private onChat(op: ChildOp, key: string, value: unknown, live: boolean): void {
    if (op === "removed") {
      if (!this.chatWindow.has(key)) return;
      this.chatRemovals.add(key);
      if (!this.chatFlushQueued) {
        this.chatFlushQueued = true;
        queueMicrotask(() => this.flushChatRemovals());
      }
      return;
    }
    const record = parseChatRecord(value);
    if (!record) return;
    let newest = -Infinity;
    for (const line of this.chatWindow.values()) newest = Math.max(newest, line.t);
    const backfill = record.t < newest - BACKFILL_MARGIN_MS;
    this.chatRemovals.delete(key);
    this.chatWindow.set(key, { t: record.t, pid: record.pid });
    this.trimChatWindow();
    this.emit({ type: "chat", id: key, record, live: live && !backfill });
  }

  /**
   * The event stream reports neither lines sliding out of its window nor the
   * older lines a purge brings back in, only additions and deletions, so the
   * window is kept to its real size here: past CHAT_HISTORY lines (not
   * counting ones already being removed), the oldest have slid out.
   */
  private trimChatWindow(): void {
    const excess = this.chatWindow.size - this.chatRemovals.size - CHAT_HISTORY;
    if (excess <= 0) return;
    const held = [...this.chatWindow].filter(([key]) => !this.chatRemovals.has(key)).sort(byTimeThenKey);
    for (const [key] of held.slice(0, excess)) this.chatWindow.delete(key);
  }

  /**
   * Decides what a batch of chat removals was. Each transport reports one
   * database update synchronously (the SDK raises its removals, then the
   * older lines that slide back into the window), so by this microtask the
   * batch is complete. The window sliding, and the age prune, take lines from
   * the oldest end of a full window; anything else (a line behind a surviving
   * line, or a removal from a window that is not full) is moderation deleting
   * lines, and leaves the chatbox. Checked against the emulator with both
   * transports.
   */
  private flushChatRemovals(): void {
    this.chatFlushQueued = false;
    if (this.chatRemovals.size === 0) return;
    const full = this.chatWindow.size >= CHAT_HISTORY;
    const ordered = [...this.chatWindow].sort(byTimeThenKey);
    const ids: string[] = [];
    const pids = new Set<string>();
    let oldestEnd = true;
    for (const [key, line] of ordered) {
      if (!this.chatRemovals.has(key)) {
        oldestEnd = false;
        continue;
      }
      this.chatWindow.delete(key);
      if (oldestEnd && full) continue;
      ids.push(key);
      pids.add(line.pid);
    }
    this.chatRemovals.clear();
    if (ids.length === 0) return;
    const before = ordered.find(([key]) => this.chatWindow.has(key))?.[1].t ?? Infinity;
    this.emit({ type: "chatPurged", ids, pids: [...pids], before });
  }
}

const SWEEP_MS = 5_000;

/**
 * Starts a WorldClient for `world` (or uses the one given) and mirrors it
 * into useWorldStore. Returns a function that disconnects and clears world
 * state (players, chat and news: a hop starts the chatbox afresh, as a
 * login does).
 */
export function connectWorldStore(world: number | WorldClient): () => void {
  const client = typeof world === "number" ? new WorldClient({ world }) : world;
  const store = useWorldStore.getState();
  const unsubscribe = client.on((event) => {
    switch (event.type) {
      case "status":
        store.setStatus(event.status);
        break;
      case "offset":
        store.setServerOffset(event.offsetMs, "firebase");
        break;
      case "player":
        if (event.op === "removed") store.removePlayer(event.pid);
        else store.upsertPlayer(event.pid, event.record);
        break;
      case "chat":
        store.addChat(event.id, event.record, event.live);
        break;
      case "chatPurged":
        store.purgeChat(event.ids, event.pids, event.before);
        break;
      case "event":
        store.addEvent(event.id, event.record, event.live);
        break;
    }
  });
  // The server prunes silent players on a schedule; hide them as soon as they time out.
  const sweep = setInterval(() => useWorldStore.getState().sweepPlayers(client.serverNow()), SWEEP_MS);
  try {
    client.start();
  } catch (err) {
    store.setStatus("error");
    console.error("Could not connect to the world:", err instanceof Error ? err.message : err);
  }
  return () => {
    clearInterval(sweep);
    unsubscribe();
    client.stop();
    useWorldStore.getState().resetWorld();
  };
}
