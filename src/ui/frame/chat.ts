/**
 * Chatbox line model and helpers. Pure: no DOM, no React.
 */

import type { ChatRecord, WorldEventRecord } from "@shared/protocol";
import { formatDecimal } from "@/ui/kit/format";

export type ChatKind = "game" | "public" | "trade" | "news" | "private";

export interface ChatLine {
  /** Stable id (a realtime push id, or generated for local messages). */
  id: string;
  kind: ChatKind;
  /** Speaker for public, private and trade lines. */
  name?: string;
  text: string;
  /** Chat effect prefix ("red:wave"); only drawn overhead, kept for the record. */
  fx?: string | null;
  /** Epoch ms. */
  time: number;
}

export type ChatTab = "all" | "game" | "public" | "trade";

export const CHAT_TABS: readonly { id: ChatTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "game", label: "Game" },
  { id: "public", label: "Public" },
  { id: "trade", label: "Trade" },
];

/** Most lines kept in memory; the client keeps a similar backlog. */
export const CHAT_BACKLOG = 200;

/** The filter tab a line belongs to (private messages only show under All). */
export function tabOf(kind: ChatKind): ChatTab | null {
  switch (kind) {
    case "game":
    case "news":
      return "game";
    case "public":
      return "public";
    case "trade":
      return "trade";
    case "private":
      return null;
  }
}

export function linesForTab(lines: readonly ChatLine[], tab: ChatTab): ChatLine[] {
  if (tab === "all") return lines.slice();
  return lines.filter((l) => tabOf(l.kind) === tab);
}

let counter = 0;

/** A locally generated line (game messages, your own sends before the echo). */
export function chatLine(kind: ChatKind, text: string, opts: { name?: string; fx?: string | null; time?: number; id?: string } = {}): ChatLine {
  counter = (counter + 1) % 1_000_000;
  const time = opts.time ?? Date.now();
  return {
    id: opts.id ?? `local-${time.toString(36)}-${counter}`,
    kind,
    text,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.fx !== undefined ? { fx: opts.fx } : {}),
    time,
  };
}

/** "Welcome to RampRidge." */
export function gameMessage(text: string, time?: number): ChatLine {
  return chatLine("game", text, { time });
}

/** A public chat record from `world/chat/{pushId}`. */
export function fromChatRecord(id: string, record: ChatRecord): ChatLine {
  return { id, kind: "public", name: record.n, text: record.m, fx: record.fx ?? null, time: record.t };
}

function defaultPlatformName(platform: string): string {
  if (!platform) return platform;
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

/** The broadcast sentence for a verified world event, without the "News:" prefix. */
export function worldEventText(event: WorldEventRecord, platformName: (id: string) => string = defaultPlatformName): string {
  const usdc = `${formatDecimal(event.usdc, 2)} USDC`;
  const on = event.platform ? ` on ${platformName(event.platform)}` : "";
  switch (event.kind) {
    case "bought":
      return `${event.n} bought ${usdc}${event.fiat && event.currency ? ` for ${formatDecimal(event.fiat, 2)} ${event.currency}` : ""}${on}.`;
    case "listed":
      return `${event.n} is selling ${usdc}${event.currency ? ` for ${event.currency}` : ""}${on}.`;
    case "sold":
      return `${event.n} sold ${usdc}${event.fiat && event.currency ? ` for ${formatDecimal(event.fiat, 2)} ${event.currency}` : ""}${on}.`;
  }
}

/** A `world/events/{pushId}` record as a News line. */
export function fromWorldEvent(id: string, event: WorldEventRecord, platformName?: (id: string) => string): ChatLine {
  return { id, kind: "news", name: event.n, text: worldEventText(event, platformName), time: event.t };
}

/**
 * Merges new lines into the backlog: drops duplicates by id, keeps time
 * order (stable for equal times) and trims to `max` newest lines.
 */
export function appendLines(prev: readonly ChatLine[], incoming: readonly ChatLine[], max = CHAT_BACKLOG): ChatLine[] {
  if (incoming.length === 0) return prev.slice(-max);
  const seen = new Set(prev.map((l) => l.id));
  const fresh = incoming.filter((l) => {
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return true;
  });
  if (fresh.length === 0) return prev.slice(-max);
  const merged = [...prev, ...fresh];
  const ordered = merged.every((l, i) => i === 0 || merged[i - 1]!.time <= l.time)
    ? merged
    : merged.map((l, i) => ({ l, i })).sort((a, b) => a.l.time - b.l.time || a.i - b.i).map((x) => x.l);
  return ordered.slice(-max);
}

/**
 * Tabs that have lines newer than the reader has seen. Viewing "All" counts
 * as seeing every tab; `seen` maps tabs to the newest time viewed there.
 */
export function unreadTabs(lines: readonly ChatLine[], selected: ChatTab, seen: Partial<Record<ChatTab, number>>): Set<ChatTab> {
  const out = new Set<ChatTab>();
  const allSeen = seen.all ?? 0;
  for (const l of lines) {
    const tab = tabOf(l.kind);
    if (!tab || tab === selected || selected === "all") continue;
    if (l.time > Math.max(seen[tab] ?? 0, allSeen)) out.add(tab);
  }
  return out;
}

/** Newest line time, or 0. */
export function latestTime(lines: readonly ChatLine[]): number {
  let t = 0;
  for (const l of lines) if (l.time > t) t = l.time;
  return t;
}

/** Plain-text rendering of a line as the chatbox shows it (for logs and accessibility). */
export function lineText(line: ChatLine): string {
  switch (line.kind) {
    case "public":
      return `${line.name ?? ""}: ${line.text}`;
    case "private":
      return `From ${line.name ?? ""}: ${line.text}`;
    case "trade":
      return line.name ? `${line.name} ${line.text}` : line.text;
    case "news":
      return `News: ${line.text}`;
    case "game":
      return line.text;
  }
}

/** The message a chat draft sends: whitespace runs collapsed, trimmed, capped at `maxLength`. */
export function chatMessageOf(draft: string, maxLength: number): string {
  return draft.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * The draft after a send failed (e.g. rate limited): the sent text comes
 * back unless the player has started typing something new.
 */
export function draftAfterFailedSend(current: string, sent: string): string {
  return current === "" ? sent : current;
}
