import { describe, expect, it } from "vitest";
import type { ChatLine as WorldChatLine, WorldEventEntry } from "@/net/store";
import { BACKLOG_NEWS_MAX_AGE_MS, showsNews, toChatboxLines } from "./chatLines";

const name = (p: string) => (p === "revolut" ? "Revolut" : p);
const NOW = 1_800_000_000_000;

function line(partial: Partial<WorldChatLine> & Pick<WorldChatLine, "id" | "kind" | "text" | "t">): WorldChatLine {
  return { pid: null, name: null, fx: null, live: true, ...partial };
}

function event(partial: Partial<WorldEventEntry> & Pick<WorldEventEntry, "id">): WorldEventEntry {
  return {
    kind: "listed",
    pid: "p2",
    n: "Lumby Larry",
    usdc: "3.00",
    fiat: null,
    currency: "GBP",
    platform: "monzo",
    tx: "0x1",
    t: NOW - 60_000,
    live: false,
    ...partial,
  };
}

describe("toChatboxLines", () => {
  it("maps public chat and game messages and orders everything by time", () => {
    const chat = [
      line({ id: "b", kind: "public", pid: "p1", name: "Zezima", text: "hello", fx: "red:wave", t: 2_000 }),
      line({ id: "a", kind: "game", text: "Welcome to RampRidge.", t: 1_000 }),
    ];
    const lines = toChatboxLines(chat, [], name, NOW);
    expect(lines.map((l) => l.id)).toEqual(["a", "b"]);
    expect(lines[1]).toEqual({ id: "b", kind: "public", name: "Zezima", text: "hello", fx: "red:wave", time: 2_000 });
    expect(lines[0]).toEqual({ id: "a", kind: "game", text: "Welcome to RampRidge.", time: 1_000 });
  });

  it("draws news from verified events with exact two-decimal amounts, not from the store's news lines", () => {
    const chat = [line({ id: "news-e1", kind: "news", text: "Alice bought 125.4 USDC!", t: 5_000 })];
    const events: WorldEventEntry[] = [
      { id: "e1", kind: "bought", pid: "p2", n: "Alice", usdc: "125.4", fiat: "101.5", currency: "GBP", platform: "revolut", tx: "0x1", t: 5_000, live: true },
    ];
    const lines = toChatboxLines(chat, events, name, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: "news-e1", kind: "news", text: "Alice bought 125.40 USDC for 101.50 GBP on Revolut." });
  });

  it("keeps arrival order for lines with the same timestamp", () => {
    const chat = [line({ id: "x", kind: "game", text: "one", t: 10 }), line({ id: "y", kind: "game", text: "two", t: 10 })];
    expect(toChatboxLines(chat, [], name, NOW).map((l) => l.text)).toEqual(["one", "two"]);
  });

  it("leaves small and stale backlog news out of an arrival's chatbox, but shows every live event", () => {
    const events = [
      event({ id: "test-sale", usdc: "3.00" }),
      event({ id: "old", usdc: "250", t: NOW - BACKLOG_NEWS_MAX_AGE_MS - 1 }),
      event({ id: "recent", usdc: "40", t: NOW - 3_600_000 }),
      event({ id: "live-small", usdc: "3.00", live: true, t: NOW - 1_000 }),
    ];
    expect(toChatboxLines([], events, name, NOW).map((l) => l.id)).toEqual(["news-recent", "news-live-small"]);
  });
});

describe("showsNews", () => {
  it("shows backlog trades of 10 USDC or more from the last 24 hours", () => {
    expect(showsNews({ live: false, usdc: "10", t: NOW }, NOW)).toBe(true);
    expect(showsNews({ live: false, usdc: "9.99", t: NOW }, NOW)).toBe(false);
    expect(showsNews({ live: false, usdc: "500", t: NOW - BACKLOG_NEWS_MAX_AGE_MS }, NOW)).toBe(true);
    expect(showsNews({ live: false, usdc: "500", t: NOW - BACKLOG_NEWS_MAX_AGE_MS - 1 }, NOW)).toBe(false);
  });

  it("treats an unreadable backlog amount as too small", () => {
    expect(showsNews({ live: false, usdc: "", t: NOW }, NOW)).toBe(false);
    expect(showsNews({ live: false, usdc: "lots", t: NOW }, NOW)).toBe(false);
  });

  it("always shows live events, whatever their size or age", () => {
    expect(showsNews({ live: true, usdc: "0.50", t: 0 }, NOW)).toBe(true);
  });
});
