/**
 * Client-side mirror of the shared world plus this player's identity. The
 * game engine reads it with `useWorldStore.getState()` / `subscribe`; React
 * components use the hooks.
 */

import { PLAYER_TIMEOUT_MS } from "@shared/protocol";
import type { ChatRecord, PlayerRecord, WorldEventRecord } from "@shared/protocol";
import { create } from "zustand";

export type ConnectionStatus = "idle" | "connecting" | "online" | "offline" | "error";

export interface Me {
  pid: string;
  name: string;
  /** Verified wallet, lowercase, or null. */
  wallet: string | null;
  /** The world the player last joined (301, 302, ...), or null before their first join. */
  world: number | null;
}

/** public: a player's chat. game: local system text. news: a verified world event. */
export type ChatLineKind = "public" | "game" | "news";

export interface ChatLine {
  id: string;
  kind: ChatLineKind;
  pid: string | null;
  name: string | null;
  text: string;
  /** Encoded chat effects (see shared/chat.ts decodeEffects). */
  fx: string | null;
  /** Server ms (local clock for game messages). */
  t: number;
  /** False for history loaded on connect; true for lines that arrived while playing. */
  live: boolean;
}

export interface WorldEventEntry extends WorldEventRecord {
  id: string;
  live: boolean;
}

export const CHAT_LOG_LIMIT = 200;
export const EVENT_LOG_LIMIT = 50;

export interface WorldStoreState {
  status: ConnectionStatus;
  players: Record<string, PlayerRecord>;
  chat: ChatLine[];
  events: WorldEventEntry[];
  me: Me | null;
  /** Estimated server clock minus local clock, ms. */
  serverOffsetMs: number;
  /** Firebase's own estimate wins over samples from API responses. */
  serverOffsetSource: "none" | "api" | "firebase";
  /**
   * Another tab of this browser took over the player's presence. This tab has
   * stopped heartbeating and refuses world actions until Presence.resume().
   */
  playingElsewhere: boolean;

  setStatus(status: ConnectionStatus): void;
  upsertPlayer(pid: string, record: PlayerRecord): void;
  removePlayer(pid: string): void;
  /** Removes players whose last heartbeat is older than the server timeout. */
  sweepPlayers(serverNow: number): void;
  addChat(id: string, record: ChatRecord, live: boolean): void;
  /**
   * Drops chat lines moderation deleted: `ids`, plus public lines by `pids`
   * older than `before` (lines that already left the realtime window).
   */
  purgeChat(ids: readonly string[], pids: readonly string[], before: number): void;
  addGameMessage(text: string): void;
  addEvent(id: string, record: WorldEventRecord, live: boolean): void;
  setMe(me: Me | null): void;
  setServerOffset(offsetMs: number, source: "api" | "firebase"): void;
  setPlayingElsewhere(value: boolean): void;
  /** Clears world state (players, chat, events); keeps `me`. */
  resetWorld(): void;
}

let localCounter = 0;

function insertSorted(lines: ChatLine[], line: ChatLine): ChatLine[] {
  if (lines.some((l) => l.id === line.id)) return lines;
  const next = [...lines, line];
  // History can arrive after local game messages; keep the log in time order.
  if (lines.length > 0 && lines[lines.length - 1]!.t > line.t) next.sort((a, b) => a.t - b.t);
  return next.length > CHAT_LOG_LIMIT ? next.slice(next.length - CHAT_LOG_LIMIT) : next;
}

const PLATFORM_NAMES: Record<string, string> = {
  venmo: "Venmo",
  revolut: "Revolut",
  cashapp: "Cash App",
  wise: "Wise",
  zelle: "Zelle",
  paypal: "PayPal",
  monzo: "Monzo",
  mercadopago: "Mercado Pago",
  chime: "Chime",
  n26: "N26",
  upi: "UPI",
  alipay: "Alipay",
};

export function platformLabel(platform: string): string {
  return PLATFORM_NAMES[platform.toLowerCase()] ?? (platform === "peer" ? "Peer" : platform);
}

/** The chatbox "News:" line for a world event. */
export function formatWorldEvent(event: WorldEventRecord): string {
  const via = platformLabel(event.platform);
  const fiat = event.fiat && event.currency ? ` for ${event.fiat} ${event.currency}` : "";
  switch (event.kind) {
    case "bought":
      return `${event.n} bought ${event.usdc} USDC${fiat} with ${via}!`;
    case "listed":
      return `${event.n} is selling ${event.usdc} USDC${event.currency ? ` for ${event.currency}` : ""} on ${via}!`;
    case "sold":
      return `${event.n} sold ${event.usdc} USDC${fiat} on ${via}!`;
  }
}

export const useWorldStore = create<WorldStoreState>()((set) => ({
  status: "idle",
  players: {},
  chat: [],
  events: [],
  me: null,
  serverOffsetMs: 0,
  serverOffsetSource: "none",
  playingElsewhere: false,

  setStatus: (status) => set({ status }),
  upsertPlayer: (pid, record) => set((s) => ({ players: { ...s.players, [pid]: record } })),
  removePlayer: (pid) =>
    set((s) => {
      if (!(pid in s.players)) return s;
      const players = { ...s.players };
      delete players[pid];
      return { players };
    }),
  sweepPlayers: (serverNow) =>
    set((s) => {
      const cutoff = serverNow - PLAYER_TIMEOUT_MS;
      const stale = Object.keys(s.players).filter((pid) => s.players[pid]!.ls < cutoff);
      if (stale.length === 0) return s;
      const players = { ...s.players };
      for (const pid of stale) delete players[pid];
      return { players };
    }),
  addChat: (id, record, live) =>
    set((s) => ({
      chat: insertSorted(s.chat, {
        id,
        kind: "public",
        pid: record.pid,
        name: record.n,
        text: record.m,
        fx: record.fx ?? null,
        t: record.t,
        live,
      }),
    })),
  purgeChat: (ids, pids, before) =>
    set((s) => {
      const gone = new Set(ids);
      const authors = new Set(pids);
      const chat = s.chat.filter(
        (line) => !gone.has(line.id) && !(line.kind === "public" && line.pid !== null && authors.has(line.pid) && line.t < before),
      );
      return chat.length === s.chat.length ? s : { chat };
    }),
  addGameMessage: (text) =>
    set((s) => ({
      chat: insertSorted(s.chat, {
        id: `game-${++localCounter}`,
        kind: "game",
        pid: null,
        name: null,
        text,
        fx: null,
        t: Date.now() + s.serverOffsetMs,
        live: true,
      }),
    })),
  addEvent: (id, record, live) =>
    set((s) => {
      if (s.events.some((e) => e.id === id)) return s;
      const events = [...s.events, { ...record, id, live }].sort((a, b) => a.t - b.t);
      return {
        events: events.length > EVENT_LOG_LIMIT ? events.slice(events.length - EVENT_LOG_LIMIT) : events,
        chat: insertSorted(s.chat, {
          id: `news-${id}`,
          kind: "news",
          pid: record.pid,
          name: null,
          text: formatWorldEvent(record),
          fx: null,
          t: record.t,
          live,
        }),
      };
    }),
  setMe: (me) => set({ me }),
  setServerOffset: (serverOffsetMs, source) =>
    set((s) => (source === "api" && s.serverOffsetSource === "firebase" ? s : { serverOffsetMs, serverOffsetSource: source })),
  setPlayingElsewhere: (playingElsewhere) => set({ playingElsewhere }),
  resetWorld: () => set({ players: {}, chat: [], events: [], status: "idle" }),
}));

export function useMe(): Me | null {
  return useWorldStore((s) => s.me);
}

/**
 * Records a server timestamp from an API response, assuming the server
 * stamped it halfway through the round trip.
 */
export function noteServerTime(serverMs: number, sentAt: number, receivedAt: number = Date.now()): void {
  if (!Number.isFinite(serverMs)) return;
  useWorldStore.getState().setServerOffset(Math.round(serverMs - (sentAt + receivedAt) / 2), "api");
}

/** Current server time estimate, ms. */
export function serverNow(): number {
  return Date.now() + useWorldStore.getState().serverOffsetMs;
}
