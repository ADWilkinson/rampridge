import type { ChatLine as WorldChatLine, WorldEventEntry } from "@/net/store";
import { fromWorldEvent, type ChatLine } from "@/ui/frame/chat";

/** Backlog news (events from before the player arrived) below this many USDC stays out of the chatbox. */
export const BACKLOG_NEWS_MIN_USDC = 10;
/** Backlog news older than this stays out of the chatbox. */
export const BACKLOG_NEWS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a world event gets a "News:" line. Events that happen while the
 * player is in the bank always do. The backlog loaded on arrival only shows
 * recent trades of a real size, so a newcomer's first news isn't a stale
 * 3 USDC test sale.
 */
export function showsNews(event: Pick<WorldEventEntry, "live" | "usdc" | "t">, now: number): boolean {
  if (event.live) return true;
  const usdc = Number(event.usdc);
  return usdc >= BACKLOG_NEWS_MIN_USDC && now - event.t <= BACKLOG_NEWS_MAX_AGE_MS;
}

/**
 * Bridges the realtime store's chat log (public chat and local game
 * messages) and its verified world events into the chatbox line model.
 * News lines are rebuilt from the events so amounts read to exactly two
 * decimals ("News: Alice bought 125.40 USDC for 101.50 GBP on Revolut.").
 * `now` (server ms) dates the backlog for showsNews.
 */
export function toChatboxLines(
  chat: readonly WorldChatLine[],
  events: readonly WorldEventEntry[],
  platformName: (platform: string) => string,
  now: number,
): ChatLine[] {
  const lines: ChatLine[] = [];
  for (const line of chat) {
    if (line.kind === "public") {
      lines.push({ id: line.id, kind: "public", name: line.name ?? "", text: line.text, fx: line.fx, time: line.t });
    } else if (line.kind === "game") {
      lines.push({ id: line.id, kind: "game", text: line.text, time: line.t });
    }
    // "news" lines are drawn from `events` below.
  }
  for (const event of events) if (showsNews(event, now)) lines.push(fromWorldEvent(`news-${event.id}`, event, platformName));
  // Stable time order: history, live chat and local messages interleave by timestamp.
  return lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => a.line.time - b.line.time || a.i - b.i)
    .map((x) => x.line);
}
