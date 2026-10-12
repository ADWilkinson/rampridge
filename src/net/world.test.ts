import type { ChatRecord } from "@shared/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorldStore } from "./store";
import { CHAT_HISTORY } from "./transport";
import type { TransportSink, WorldTransport } from "./transport";
import { connectWorldStore, WorldClient } from "./world";
import type { WorldClientEvent } from "./world";

/** Chat key `k007` for line 7: keys and times both sort in line order, ten seconds apart. */
const key = (i: number) => `k${String(i).padStart(3, "0")}`;
const line = (i: number, pid = "talker"): ChatRecord => ({ pid, n: pid, m: `line ${i}`, t: 1_000_000 + i * 10_000 });

let sink: TransportSink;
let client: WorldClient;
let disconnect: () => void;
let events: WorldClientEvent[];

/** Lets the client settle a batch of removals (it decides on a microtask). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ids = () => useWorldStore.getState().chat.map((l) => l.id);
const chatAdded = (id: string) => events.filter((e) => e.type === "chat" && e.id === id);

function added(i: number, live: boolean, pid?: string): void {
  sink.child("chat", "added", key(i), line(i, pid), live);
}

function removed(i: number, pid?: string): void {
  // The SDK hands over the removed value; the event stream hands over null.
  sink.child("chat", "removed", key(i), i % 2 === 0 ? line(i, pid) : null, true);
}

/** History for lines `from`..`to`, as a page load receives it. */
function history(from: number, to: number, pidOf: (i: number) => string = () => "talker"): void {
  for (let i = from; i <= to; i++) added(i, false, pidOf(i));
}

beforeEach(() => {
  useWorldStore.getState().resetWorld();
  const transport: WorldTransport = {
    kind: "sse",
    start: (s) => {
      sink = s;
    },
    stop: () => {},
  };
  client = new WorldClient({ world: 301, transport: () => transport });
  events = [];
  client.on((event) => events.push(event));
  disconnect = connectWorldStore(client);
});

afterEach(() => disconnect());

describe("chat removals", () => {
  it("keeps lines that slide out of a full window, whichever order the slide arrives in", async () => {
    history(0, CHAT_HISTORY - 1);
    // A new line pushes the oldest out: the SDK raises the removal first.
    removed(0);
    added(CHAT_HISTORY, true);
    await settle();
    // The event stream may report the new line first.
    added(CHAT_HISTORY + 1, true);
    removed(1);
    await settle();
    expect(ids()).toHaveLength(CHAT_HISTORY + 2);
    expect(ids()).toContain(key(0));
    expect(events.some((e) => e.type === "chatPurged")).toBe(false);
    expect(chatAdded(key(CHAT_HISTORY))[0]).toMatchObject({ live: true });
  });

  it("keeps the oldest lines when the age prune trims a full window", async () => {
    history(0, CHAT_HISTORY - 1);
    for (let i = 0; i < 5; i++) removed(i);
    await settle();
    expect(ids()).toHaveLength(CHAT_HISTORY);
    expect(events.some((e) => e.type === "chatPurged")).toBe(false);
  });

  it("drops a purged line and does not repeat or replay the older line that slides back in", async () => {
    // Line 0 has already slid out of the window; the store still shows it.
    history(0, CHAT_HISTORY - 1);
    removed(0);
    added(CHAT_HISTORY, true);
    await settle();
    // Moderation deletes line 30; the window reaches back for line 0 in the same update.
    removed(30);
    added(0, true);
    await settle();
    expect(ids()).not.toContain(key(30));
    expect(ids().filter((id) => id === key(0))).toHaveLength(1);
    expect(ids()).toHaveLength(CHAT_HISTORY);
    // The returning line is history, so it never pops up as overhead chat.
    expect(chatAdded(key(0)).at(-1)).toMatchObject({ live: false });
    expect(events.filter((e) => e.type === "chatPurged")).toEqual([
      { type: "chatPurged", ids: [key(30)], pids: ["talker"], before: line(0).t },
    ]);
  });

  it("never replays backfill as live, even when it arrives oldest first", async () => {
    history(5, CHAT_HISTORY + 4);
    for (const i of [10, 20]) removed(i);
    for (const i of [3, 4]) added(i, true);
    await settle();
    expect(chatAdded(key(3))[0]).toMatchObject({ live: false });
    expect(chatAdded(key(4))[0]).toMatchObject({ live: false });
    // A line committed a moment after a newer one is still live.
    sink.child("chat", "added", "late", { ...line(CHAT_HISTORY + 4), t: line(CHAT_HISTORY + 4).t - 1_000 }, true);
    expect(chatAdded("late")[0]).toMatchObject({ live: true });
  });

  it("purges a line at the oldest end when an older line slides back in with it", async () => {
    history(1, CHAT_HISTORY, (i) => (i === 1 ? "spammer" : "talker"));
    removed(1, "spammer");
    added(0, true);
    await settle();
    expect(ids()).not.toContain(key(1));
    expect(ids()).toContain(key(0));
  });

  it("drops the author's lines that already left the window, keeping everyone else's", async () => {
    const pidOf = (i: number) => (i % 10 === 0 ? "spammer" : "talker");
    history(0, CHAT_HISTORY + 4, pidOf);
    // The window holds lines 5..54 after five slides.
    for (let i = 0; i < 5; i++) removed(i, pidOf(i));
    await settle();
    expect(ids()).toContain(key(0));
    // A purge deletes every line by the spammer: 10, 20, 30, 40 and 50 from the window.
    for (const i of [10, 20, 30, 40, 50]) removed(i, "spammer");
    for (const i of [4, 3, 2, 1]) added(i, true, pidOf(i));
    await settle();
    const left = ids();
    for (const i of [0, 10, 20, 30, 40, 50]) expect(left).not.toContain(key(i));
    for (const i of [1, 2, 3, 4, 5, 11, 54]) expect(left).toContain(key(i));
  });

  it("tracks the window itself when slides go unreported, as on the event stream", async () => {
    const pidOf = (i: number) => (i % 10 === 0 ? "spammer" : "talker");
    history(0, CHAT_HISTORY - 1, pidOf);
    // Eleven new lines and no removals: the stream's window is now lines 11..60.
    for (let i = CHAT_HISTORY; i <= CHAT_HISTORY + 10; i++) added(i, true, pidOf(i));
    // The purge's deletions inside that window arrive; no older lines come back.
    for (const i of [20, 30, 40, 50, 60]) removed(i, "spammer");
    await settle();
    expect(events.filter((e) => e.type === "chatPurged")).toEqual([
      { type: "chatPurged", ids: [20, 30, 40, 50, 60].map(key), pids: ["spammer"], before: line(11).t },
    ]);
    const left = ids();
    for (const i of [0, 10, 20, 60]) expect(left).not.toContain(key(i));
    for (const i of [1, 9, 11, 59]) expect(left).toContain(key(i));
  });

  it("treats a removal from a window that is not full as moderation", async () => {
    history(0, 4, (i) => (i < 2 ? "spammer" : "talker"));
    removed(0, "spammer");
    removed(1, "spammer");
    await settle();
    expect(ids()).toEqual([key(2), key(3), key(4)]);
  });

  it("ignores removals of lines it never held and forgets the window on stop", async () => {
    history(0, 2);
    removed(99);
    await settle();
    expect(ids()).toHaveLength(3);
    removed(1);
    client.stop();
    await settle();
    expect(events.some((e) => e.type === "chatPurged")).toBe(false);
  });

  it("keeps world events when their window slides", async () => {
    const event = { kind: "sold", pid: "p", n: "Lynx", usdc: "10", fiat: null, currency: null, platform: "wise", tx: "0x1", t: 5 };
    sink.child("events", "added", "e1", event, true);
    sink.child("events", "removed", "e1", event, true);
    await settle();
    expect(useWorldStore.getState().events.map((e) => e.id)).toEqual(["e1"]);
  });
});

describe("store.purgeChat", () => {
  it("drops the given lines and the authors' public lines before the cut-off only", () => {
    const store = useWorldStore.getState();
    store.addChat("a1", { pid: "a", n: "A", m: "old", t: 1 }, false);
    store.addChat("b1", { pid: "b", n: "B", m: "old", t: 2 }, false);
    store.addChat("a2", { pid: "a", n: "A", m: "kept", t: 5 }, false);
    store.addChat("a3", { pid: "a", n: "A", m: "purged", t: 6 }, false);
    store.addGameMessage("Welcome to RampRidge.");
    const before = useWorldStore.getState().chat;
    store.purgeChat(["a3"], ["a"], 4);
    expect(useWorldStore.getState().chat.map((l) => l.id)).toEqual(before.map((l) => l.id).filter((id) => id !== "a1" && id !== "a3"));
    // Nothing to drop leaves the state untouched.
    const unchanged = useWorldStore.getState().chat;
    store.purgeChat(["zz"], ["nobody"], 100);
    expect(useWorldStore.getState().chat).toBe(unchanged);
  });
});
