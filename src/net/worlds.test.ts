/**
 * The client's side of worlds: a join's token and world replace the stored
 * session, actions that crossed a hop go to the new world, hops through the
 * presence, a refresh never moves the player, and each world's paths.
 */

import { DEFAULT_APPEARANCE } from "@shared/world";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postAct, resetChatBackoff, startPresence } from "./actions";
import { PresenceLock, setPresenceLock } from "./presenceLock";
import { adoptWorld, clearSession, ensureSession, getSession } from "./session";
import { useWorldStore } from "./store";
import { streamUrl } from "./transport";

const PID = "abcdefghij012345";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sessionReply = (token: string, world: number | null = null) => json({ ok: true, token, pid: PID, name: "Guest1234", wallet: null, world, now: Date.now() });

type Reply = Response | (() => Response | Promise<Response>);
let replies: Record<string, Reply[]>;
let calls: Array<{ path: string; auth: string | null; body: Record<string, unknown> | null }>;

beforeEach(() => {
  clearSession();
  resetChatBackoff();
  setPresenceLock(null);
  replies = { "/api/session": [], "/api/act": [] };
  calls = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ path: input, auth: headers.get("authorization"), body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    const reply = replies[input]?.shift();
    if (!reply) throw new Error(`Unexpected request to ${input}`);
    return typeof reply === "function" ? reply() : reply;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("joins and the session's world", () => {
  it("adopts the token and world a join answers with, so later actions act in that world", async () => {
    replies["/api/session"]!.push(sessionReply("t-none"));
    replies["/api/act"]!.push(json({ ok: true, now: Date.now(), world: 302, token: "t-302" }));
    await postAct({ type: "join", appearance: DEFAULT_APPEARANCE, world: "auto" });
    expect(getSession()).toMatchObject({ token: "t-302", world: 302 });
    expect(useWorldStore.getState().me).toMatchObject({ pid: PID, world: 302 });

    replies["/api/act"]!.push(json({ ok: true, now: Date.now() }));
    await postAct({ type: "heartbeat" });
    expect(calls.at(-1)!.auth).toBe("Bearer t-302");
  });

  it("sends an action that crossed a hop again with the new world's token instead of asking for a rejoin", async () => {
    replies["/api/session"]!.push(sessionReply("t-301", 301));
    await ensureSession();
    // The move left with the 301 token; the hop's answer lands before the move's not_joined does.
    replies["/api/act"]!.push(() => {
      adoptWorld(PID, "t-302", 302);
      return json({ ok: false, code: "not_joined", error: "You are not in the bank. Rejoin to continue.", now: 0 }, 409);
    });
    replies["/api/act"]!.push(json({ ok: true, now: Date.now() }));
    await expect(postAct({ type: "move", path: [{ x: 1, y: 1 }], run: false })).resolves.toMatchObject({ ok: true });
    expect(calls.filter((c) => c.path === "/api/act").map((c) => c.auth)).toEqual(["Bearer t-301", "Bearer t-302"]);

    // A not_joined with the current token is real: the caller rejoins.
    replies["/api/act"]!.push(json({ ok: false, code: "not_joined", error: "You are not in the bank.", now: 0 }, 409));
    await expect(postAct({ type: "heartbeat" })).rejects.toMatchObject({ code: "not_joined" });
  });

  it("never moves the player between worlds on a session refresh that crossed a join", async () => {
    replies["/api/session"]!.push(sessionReply("t-301", 301));
    await ensureSession();
    // The refresh was sent with the 301 token; the join to 303 answered first.
    replies["/api/session"]!.push(() => {
      adoptWorld(PID, "t-303", 303);
      return sessionReply("t-301-refreshed", 301);
    });
    await ensureSession();
    expect(getSession()).toMatchObject({ token: "t-303", world: 303 });
  });

  it("ignores a join answer for a session that now belongs to someone else", async () => {
    replies["/api/session"]!.push(sessionReply("t1"));
    await ensureSession();
    adoptWorld("zzzzzzzzzzzzzzzz", "t-other", 302);
    expect(getSession()).toMatchObject({ token: "t1", world: null });
  });
});

describe("presence and hops", () => {
  let page: EventTarget;

  beforeEach(() => {
    page = new EventTarget();
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal("window", page);
    vi.stubGlobal("navigator", { sendBeacon: () => true });
  });

  const lock = () => new PresenceLock(null, "tab", () => 1);
  const joins = () => calls.filter((c) => c.path === "/api/act" && c.body?.type === "join").map((c) => c.body);

  it("asks for the entry's world first, then for the world the player is in", async () => {
    replies["/api/session"]!.push(sessionReply("t-none"));
    replies["/api/act"]!.push(json({ ok: true, now: Date.now(), world: 303, token: "t-303" }));
    let request: number | "auto" | null = 303;
    const presence = startPresence({ appearance: () => DEFAULT_APPEARANCE, world: () => request ?? getSession()?.world ?? "auto", lock: lock() });
    await presence.rejoin();
    request = null;
    replies["/api/act"]!.push(json({ ok: true, now: Date.now(), world: 303, token: "t-303b" }));
    await presence.rejoin();
    expect(joins().map((j) => j?.world)).toEqual([303, 303]);
    expect(joins().every((j) => j?.hop === undefined)).toBe(true);
    presence.stop();
  });

  it("hops with a strict request, and a rejoin asked for meanwhile waits for the hop instead of joining again", async () => {
    replies["/api/session"]!.push(sessionReply("t-none"));
    replies["/api/act"]!.push(json({ ok: true, now: Date.now(), world: 301, token: "t-301" }));
    const presence = startPresence({ appearance: () => DEFAULT_APPEARANCE, lock: lock() });
    await presence.rejoin();

    let answer: (r: Response) => void = () => undefined;
    replies["/api/act"]!.push(() => new Promise<Response>((resolve) => (answer = resolve)));
    const hop = presence.hop(302);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rejoin = presence.rejoin();
    answer(json({ ok: true, now: Date.now(), world: 302, token: "t-302" }));
    await Promise.all([hop, rejoin]);
    expect(joins().map((j) => [j?.world, j?.hop ?? false])).toEqual([
      ["auto", false],
      [302, true],
    ]);
    expect(getSession()).toMatchObject({ world: 302, token: "t-302" });
    presence.stop();
  });

  it("rejects a refused hop with the server's reason and keeps the player's world", async () => {
    replies["/api/session"]!.push(sessionReply("t-none"));
    replies["/api/act"]!.push(json({ ok: true, now: Date.now(), world: 301, token: "t-301" }));
    const presence = startPresence({ appearance: () => DEFAULT_APPEARANCE, lock: lock() });
    await presence.rejoin();
    replies["/api/act"]!.push(json({ ok: false, code: "conflict", error: "World 302 is full.", now: 0 }, 409));
    await expect(presence.hop(302)).rejects.toMatchObject({ message: "World 302 is full." });
    expect(getSession()).toMatchObject({ world: 301, token: "t-301" });
    presence.stop();
  });
});

describe("world paths", () => {
  it("streams one world's players, chat and news", () => {
    expect(streamUrl("https://rampridge-world.firebaseio.com", "worlds/302/players")).toBe(
      "https://rampridge-world.firebaseio.com/worlds/302/players.json",
    );
  });
});
