import { describe, expect, it } from "vitest";
import type { WorldEventRecord } from "@shared/protocol";
import { appendLines, chatLine, chatMessageOf, draftAfterFailedSend, fromChatRecord, fromWorldEvent, gameMessage, latestTime, lineText, linesForTab, tabOf, unreadTabs, type ChatLine } from "./chat";

const line = (id: string, kind: ChatLine["kind"], time: number, name?: string): ChatLine => ({ id, kind, text: id, time, ...(name ? { name } : {}) });

describe("chat tabs", () => {
  it("routes kinds to filter tabs", () => {
    expect(tabOf("game")).toBe("game");
    expect(tabOf("news")).toBe("game");
    expect(tabOf("public")).toBe("public");
    expect(tabOf("trade")).toBe("trade");
    expect(tabOf("private")).toBeNull();
  });
  it("filters lines per tab and keeps everything under All", () => {
    const lines = [line("a", "game", 1), line("b", "public", 2), line("c", "trade", 3), line("d", "private", 4), line("e", "news", 5)];
    expect(linesForTab(lines, "all").map((l) => l.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(linesForTab(lines, "game").map((l) => l.id)).toEqual(["a", "e"]);
    expect(linesForTab(lines, "public").map((l) => l.id)).toEqual(["b"]);
    expect(linesForTab(lines, "trade").map((l) => l.id)).toEqual(["c"]);
  });
});

describe("appendLines", () => {
  it("dedupes by id, keeps time order and trims the backlog", () => {
    const a = [line("1", "game", 10), line("2", "game", 20)];
    expect(appendLines(a, [line("2", "game", 20), line("3", "game", 30)]).map((l) => l.id)).toEqual(["1", "2", "3"]);
    expect(appendLines(a, [line("0", "game", 5)]).map((l) => l.id)).toEqual(["0", "1", "2"]);
    expect(appendLines(a, [line("3", "game", 30), line("4", "game", 40)], 3).map((l) => l.id)).toEqual(["2", "3", "4"]);
    expect(appendLines(a, [line("x", "game", 20)]).map((l) => l.id)).toEqual(["1", "2", "x"]);
    expect(appendLines(a, [])).toEqual(a);
  });
});

describe("unreadTabs", () => {
  const lines = [line("g", "game", 100), line("p", "public", 200), line("t", "trade", 300)];
  it("flags tabs with lines newer than last seen", () => {
    expect([...unreadTabs(lines, "game", { game: 100, public: 150, trade: 400 })]).toEqual(["public"]);
  });
  it("never flags the selected tab, and All means everything is seen", () => {
    expect(unreadTabs(lines, "all", {}).size).toBe(0);
    expect([...unreadTabs(lines, "public", { all: 250 })]).toEqual(["trade"]);
  });
});

describe("line builders", () => {
  it("builds local and realtime lines", () => {
    const g = gameMessage("Welcome to RampRidge.", 1000);
    expect(g).toMatchObject({ kind: "game", text: "Welcome to RampRidge.", time: 1000 });
    expect(g.id).toMatch(/^local-/);
    expect(chatLine("game", "x").id).not.toBe(chatLine("game", "x").id);
    expect(fromChatRecord("push1", { pid: "p", n: "Zezima", m: "hello", fx: "red:wave", t: 5 })).toEqual({
      id: "push1",
      kind: "public",
      name: "Zezima",
      text: "hello",
      fx: "red:wave",
      time: 5,
    });
    expect(latestTime([line("a", "game", 3), line("b", "game", 9), line("c", "game", 4)])).toBe(9);
  });

  it("phrases world events as News lines", () => {
    const base: WorldEventRecord = { kind: "bought", pid: "p", n: "Alice", usdc: "125.4", fiat: "101.5", currency: "GBP", platform: "revolut", tx: "0x", t: 7 };
    expect(lineText(fromWorldEvent("e1", base))).toBe("News: Alice bought 125.40 USDC for 101.50 GBP on Revolut.");
    expect(fromWorldEvent("e2", { ...base, kind: "listed", fiat: null }, (p) => p.toUpperCase()).text).toBe("Alice is selling 125.40 USDC for GBP on REVOLUT.");
    expect(fromWorldEvent("e3", { ...base, kind: "sold", fiat: null, currency: null }).text).toBe("Alice sold 125.40 USDC on Revolut.");
  });

  it("renders plain text like the chatbox", () => {
    expect(lineText({ id: "1", kind: "public", name: "Bob", text: "hi", time: 0 })).toBe("Bob: hi");
    expect(lineText({ id: "2", kind: "private", name: "Bob", text: "hi", time: 0 })).toBe("From Bob: hi");
    expect(lineText({ id: "3", kind: "trade", name: "Bob", text: "wishes to trade with you.", time: 0 })).toBe("Bob wishes to trade with you.");
  });
});

describe("chat sending", () => {
  it("collapses whitespace, trims and caps the message", () => {
    expect(chatMessageOf("  hello \n  there  ", 80)).toBe("hello there");
    expect(chatMessageOf("   ", 80)).toBe("");
    expect(chatMessageOf("abcdef", 3)).toBe("abc");
  });

  it("restores a message that failed to send unless the player typed something new", () => {
    expect(draftAfterFailedSend("", "selling usdc")).toBe("selling usdc");
    expect(draftAfterFailedSend("new", "selling usdc")).toBe("new");
  });
});
