import { PLAYER_TIMEOUT_MS } from "@shared/protocol";
import type { ActRequest } from "@shared/protocol";
import { DEFAULT_APPEARANCE } from "@shared/world";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAYING_ELSEWHERE_MESSAGE, postAct, resetChatBackoff } from "./actions";
import { ApiError } from "./http";
import { PresenceLock, setPresenceLock } from "./presenceLock";
import { checkName, clearSession, getSession } from "./session";
import { noteServerTime, useWorldStore } from "./store";

type Reply = Response | Error;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const sessionReply = (token: string) =>
  json({ ok: true, token, pid: "abcdefghij012345", name: "Guest1234", wallet: null, now: Date.now() });

let replies: Record<string, Reply[]>;
let calls: Array<{ path: string; auth: string | null; body: unknown }>;

beforeEach(() => {
  clearSession();
  resetChatBackoff();
  setPresenceLock(null);
  replies = { "/api/session": [], "/api/act": [] };
  calls = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ path: input, auth: headers.get("authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
    const reply = replies[input]?.shift();
    if (!reply) throw new Error(`Unexpected request to ${input}`);
    if (reply instanceof Error) throw reply;
    return reply;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postAct", () => {
  it("creates a session on first use and sends the token", async () => {
    replies["/api/session"]!.push(sessionReply("t1"));
    replies["/api/act"]!.push(json({ ok: true, now: Date.now() }));
    await expect(postAct({ type: "heartbeat" })).resolves.toMatchObject({ ok: true });
    expect(calls.map((c) => c.path)).toEqual(["/api/session", "/api/act"]);
    expect(calls[1]!.auth).toBe("Bearer t1");
    expect(getSession()).toMatchObject({ token: "t1", name: "Guest1234" });
    expect(useWorldStore.getState().me).toEqual({ pid: "abcdefghij012345", name: "Guest1234", wallet: null, world: null });
  });

  it("retries network failures and 5xx, but not 4xx", async () => {
    replies["/api/session"]!.push(sessionReply("t1"));
    replies["/api/act"]!.push(new TypeError("offline"), json({ ok: false, error: "busy", code: "server", now: 0 }, 503));
    replies["/api/act"]!.push(json({ ok: true, now: 1 }));
    await expect(postAct({ type: "heartbeat" })).resolves.toMatchObject({ ok: true });
    expect(calls.filter((c) => c.path === "/api/act")).toHaveLength(3);

    replies["/api/act"]!.push(json({ ok: false, error: "You can't walk there.", code: "bad_request", now: 0 }, 400));
    const err = await postAct({ type: "move", path: [{ x: 1, y: 1 }], run: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "bad_request", message: "You can't walk there." });
    expect(calls.filter((c) => c.path === "/api/act")).toHaveLength(4);
  });

  it("does not retry chat after an ambiguous failure", async () => {
    replies["/api/session"]!.push(sessionReply("t1"));
    replies["/api/act"]!.push(new TypeError("offline"));
    await expect(postAct({ type: "chat", text: "hi" })).rejects.toMatchObject({ code: "network" });
    expect(calls.filter((c) => c.path === "/api/act")).toHaveLength(1);
  });

  it("backs off on a short 429 and surfaces a long one", async () => {
    replies["/api/session"]!.push(sessionReply("t1"));
    replies["/api/act"]!.push(json({ ok: false, error: "slow down", code: "rate_limited", retryAfterMs: 20, now: 0 }, 429));
    replies["/api/act"]!.push(json({ ok: true, now: 1 }));
    await expect(postAct({ type: "emote", emote: "wave" })).resolves.toMatchObject({ ok: true });

    replies["/api/act"]!.push(json({ ok: false, error: "slow down", code: "rate_limited", retryAfterMs: 60_000, now: 0 }, 429));
    await expect(postAct({ type: "emote", emote: "wave" })).rejects.toMatchObject({ status: 429, retryAfterMs: 60_000 });
  });

  it("waits out a short chat 429 and sends again, since nothing was posted", async () => {
    replies["/api/session"]!.push(sessionReply("t1"));
    replies["/api/act"]!.push(json({ ok: false, error: "The bank is busy.", code: "rate_limited", retryAfterMs: 20, now: 0 }, 429));
    replies["/api/act"]!.push(json({ ok: true, now: 1 }));
    await expect(postAct({ type: "chat", text: "hi" })).resolves.toMatchObject({ ok: true });
    expect(calls.filter((c) => c.path === "/api/act")).toHaveLength(2);
  });

  it("backs off chat after a long 429 without asking the server again", async () => {
    replies["/api/session"]!.push(sessionReply("t1"));
    const message = "You're sending messages too quickly.";
    replies["/api/act"]!.push(json({ ok: false, error: message, code: "rate_limited", retryAfterMs: 30_000, now: 0 }, 429));
    await expect(postAct({ type: "chat", text: "hi" })).rejects.toMatchObject({ status: 429, message });
    const sent = calls.filter((c) => c.path === "/api/act").length;
    await expect(postAct({ type: "chat", text: "again" })).rejects.toMatchObject({ status: 429, message });
    expect(calls.filter((c) => c.path === "/api/act")).toHaveLength(sent);
    // Other actions are not held back by the chat pause.
    replies["/api/act"]!.push(json({ ok: true, now: 1 }));
    await expect(postAct({ type: "emote", emote: "wave" })).resolves.toMatchObject({ ok: true });
  });

  it("refuses world actions while another tab holds the player's presence", async () => {
    const bus = { handlers: [] as Array<(m: never) => void>, post: () => undefined, listen(h: (m: never) => void) { this.handlers.push(h); return () => undefined; } };
    const lock = new PresenceLock(bus, "a", () => 1);
    setPresenceLock(lock);
    lock.acquire("abcdefghij012345");
    for (const handler of bus.handlers) handler({ type: "claim", pid: "abcdefghij012345", tab: "b", at: 2 } as never);
    expect(lock.state).toBe("lost");
    const actions: ActRequest[] = [{ type: "move", path: [{ x: 1, y: 1 }], run: false }, { type: "chat", text: "hi" }, { type: "heartbeat" }];
    for (const action of actions) {
      await expect(postAct(action)).rejects.toMatchObject({ status: 409, code: "conflict", message: PLAYING_ELSEWHERE_MESSAGE });
    }
    expect(calls).toHaveLength(0);
    // Trades are not presence: a stall can still be set from this tab.
    replies["/api/session"]!.push(sessionReply("t1"));
    replies["/api/act"]!.push(json({ ok: true, now: 1 }));
    await expect(postAct({ type: "stall", depositId: null })).resolves.toMatchObject({ ok: true });
  });

  it("refreshes an expired session once and retries", async () => {
    replies["/api/session"]!.push(sessionReply("old"), sessionReply("new"));
    replies["/api/act"]!.push(json({ ok: false, error: "expired", code: "unauthorized", now: 0 }, 401));
    replies["/api/act"]!.push(json({ ok: true, now: 1 }));
    await expect(postAct({ type: "heartbeat" })).resolves.toMatchObject({ ok: true });
    const acts = calls.filter((c) => c.path === "/api/act");
    expect(acts.map((c) => c.auth)).toEqual(["Bearer old", "Bearer new"]);
    expect(calls.filter((c) => c.path === "/api/session")[1]!.body).toEqual({ token: "old" });
  });
});

describe("checkName", () => {
  it("asks the server without claiming the name", async () => {
    replies["/api/session"]!.push(sessionReply("t1"));
    replies["/api/session"]!.push(json({ ok: true, available: true, name: "Titan", now: Date.now() }));
    await expect(checkName(" Titan ")).resolves.toEqual({ name: "Titan" });
    expect(calls.map((c) => c.body)).toEqual([{}, { token: "t1", name: " Titan ", check: true }]);
    expect(getSession()).toMatchObject({ token: "t1", name: "Guest1234" });
  });

  it("throws the server's reason for a taken or invalid name", async () => {
    replies["/api/session"]!.push(sessionReply("t1"));
    replies["/api/session"]!.push(json({ ok: false, error: "That name is already taken.", code: "name_taken", now: 0 }, 409));
    await expect(checkName("Zezima")).rejects.toMatchObject({ status: 409, code: "name_taken" });
    replies["/api/session"]!.push(json({ ok: false, error: "That name is reserved. Please choose another.", code: "bad_request", now: 0 }, 400));
    await expect(checkName("Banker")).rejects.toMatchObject({ status: 400, code: "bad_request", message: "That name is reserved. Please choose another." });
  });

  it("refreshes an expired session once and checks again", async () => {
    replies["/api/session"]!.push(sessionReply("old"));
    replies["/api/session"]!.push(json({ ok: false, error: "expired", code: "unauthorized", now: 0 }, 401));
    replies["/api/session"]!.push(sessionReply("new"));
    replies["/api/session"]!.push(json({ ok: true, available: true, name: "Titan", now: Date.now() }));
    await expect(checkName("Titan")).resolves.toEqual({ name: "Titan" });
    expect(calls.map((c) => (c.body as { token?: string }).token)).toEqual([undefined, "old", "old", "new"]);
  });
});

describe("store", () => {
  it("prefers Firebase's clock offset over API samples", () => {
    useWorldStore.setState({ serverOffsetMs: 0, serverOffsetSource: "none" });
    noteServerTime(10_500, 10_000, 10_000);
    expect(useWorldStore.getState().serverOffsetMs).toBe(500);
    useWorldStore.getState().setServerOffset(42, "firebase");
    noteServerTime(99_999, 0, 0);
    expect(useWorldStore.getState().serverOffsetMs).toBe(42);
  });

  it("adds a news line for each world event, once", () => {
    const store = useWorldStore.getState();
    store.resetWorld();
    const event = { kind: "bought", pid: "p", n: "Lynx", usdc: "125.4", fiat: "99.15", currency: "GBP", platform: "revolut", tx: "0x1", t: 5 } as const;
    store.addEvent("e1", event, true);
    store.addEvent("e1", event, true);
    const state = useWorldStore.getState();
    expect(state.events).toHaveLength(1);
    expect(state.chat).toEqual([
      expect.objectContaining({ kind: "news", text: "Lynx bought 125.4 USDC for 99.15 GBP with Revolut!", live: true }),
    ]);
  });

  it("sweeps players whose heartbeat has timed out", () => {
    const store = useWorldStore.getState();
    store.resetWorld();
    const base = { n: "A", a: DEFAULT_APPEARANCE, p: "1,1", t: 0, r: false, j: 0 };
    store.upsertPlayer("old", { ...base, ls: 0 });
    store.upsertPlayer("new", { ...base, ls: 50_000 });
    store.sweepPlayers(PLAYER_TIMEOUT_MS + 10_000);
    expect(Object.keys(useWorldStore.getState().players)).toEqual(["new"]);
  });
});
