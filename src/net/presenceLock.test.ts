import { DEFAULT_APPEARANCE } from "@shared/world";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPresence } from "./actions";
import { browserLockBus, PresenceLock, setPresenceLock } from "./presenceLock";
import type { LockBus, LockClaim } from "./presenceLock";
import { clearSession } from "./session";
import { useWorldStore } from "./store";

/** Tabs of one browser: every post reaches every other listener. */
function memoryBus(): { tab(): LockBus } {
  const listeners = new Set<(message: LockClaim) => void>();
  return {
    tab() {
      const own = new Set<(message: LockClaim) => void>();
      return {
        post: (message) => {
          for (const listener of listeners) if (!own.has(listener)) listener(structuredClone(message));
        },
        listen: (handler) => {
          listeners.add(handler);
          own.add(handler);
          return () => {
            listeners.delete(handler);
            own.delete(handler);
          };
        },
      };
    },
  };
}

describe("PresenceLock", () => {
  it("hands the player to the newest tab", () => {
    const bus = memoryBus();
    let now = 100;
    const a = new PresenceLock(bus.tab(), "a", () => now);
    const b = new PresenceLock(bus.tab(), "b", () => now);
    const lostA = vi.fn();
    a.onLost(lostA);
    expect(a.state).toBe("idle");
    a.acquire("pid1");
    expect(a.state).toBe("held");
    now = 200;
    b.acquire("pid1");
    expect(b.state).toBe("held");
    expect(a.state).toBe("lost");
    expect(lostA).toHaveBeenCalledTimes(1);
    // Taking it back works the same way.
    now = 300;
    a.acquire("pid1");
    expect(a.state).toBe("held");
    expect(b.state).toBe("lost");
  });

  it("ignores other players, older claims and its own echoes", () => {
    const bus = memoryBus();
    const a = new PresenceLock(bus.tab(), "a", () => 500);
    const b = new PresenceLock(bus.tab(), "b", () => 600);
    a.acquire("pid1");
    b.acquire("pid2");
    expect(a.state).toBe("held");
    const c = new PresenceLock(bus.tab(), "c", () => 100);
    c.acquire("pid1");
    // c's claim is older than a's, so a keeps the player (and c will yield to a's next claim).
    expect(a.state).toBe("held");
  });

  it("breaks a tie on the same millisecond deterministically", () => {
    const bus = memoryBus();
    const a = new PresenceLock(bus.tab(), "a", () => 1);
    const b = new PresenceLock(bus.tab(), "b", () => 1);
    a.acquire("pid1");
    b.acquire("pid1");
    expect([a.state, b.state]).toEqual(["lost", "held"]);
  });

  it("forgets the claim on release", () => {
    const bus = memoryBus();
    const a = new PresenceLock(bus.tab(), "a", () => 1);
    const b = new PresenceLock(bus.tab(), "b", () => 2);
    a.acquire("pid1");
    a.release();
    b.acquire("pid1");
    expect(a.state).toBe("idle");
  });
});

describe("browserLockBus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to localStorage events without BroadcastChannel", () => {
    const target = new EventTarget();
    const store = new Map<string, string>();
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.stubGlobal("window", target);
    vi.stubGlobal("localStorage", { setItem: (k: string, v: string) => store.set(k, v), getItem: (k: string) => store.get(k) ?? null });
    const bus = browserLockBus("test.presence")!;
    const received: LockClaim[] = [];
    bus.listen((m) => received.push(m));
    const claim: LockClaim = { type: "claim", pid: "pid1", tab: "a", at: 5 };
    bus.post(claim);
    expect(JSON.parse(store.get("test.presence")!)).toEqual(claim);
    // Another tab's write arrives as a storage event; junk and other keys are ignored.
    const storage = (key: string, newValue: string) => target.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));
    storage("test.presence", JSON.stringify(claim));
    storage("test.presence", "{not json");
    storage("other", JSON.stringify(claim));
    expect(received).toEqual([claim]);
  });
});

describe("startPresence across tabs", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let acts: Array<{ type: string }>;
  let beacons: number;
  let page: EventTarget;

  beforeEach(() => {
    clearSession();
    setPresenceLock(null);
    acts = [];
    beacons = 0;
    page = new EventTarget();
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal("window", page);
    vi.stubGlobal("navigator", { sendBeacon: () => ++beacons > 0 });
    vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
      if (input === "/api/session") {
        return json({ ok: true, token: "t1", pid: "abcdefghij012345", name: "Guest1234", wallet: null, now: Date.now() });
      }
      acts.push(JSON.parse(String(init.body)) as { type: string });
      return json({ ok: true, now: Date.now() });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useWorldStore.getState().setPlayingElsewhere(false);
  });

  it("stands down quietly when a newer tab claims the player, and can take it back", async () => {
    const bus = memoryBus();
    const lock = new PresenceLock(bus.tab(), "old", () => 1);
    setPresenceLock(lock);
    const onSuperseded = vi.fn();
    const presence = startPresence({ appearance: () => DEFAULT_APPEARANCE, lock, onSuperseded });
    await presence.rejoin();
    expect(acts.map((a) => a.type)).toEqual(["join"]);
    expect(lock.state).toBe("held");

    // A second tab of the same browser starts playing.
    new PresenceLock(bus.tab(), "new", () => 2).acquire("abcdefghij012345");
    expect(presence.superseded).toBe(true);
    expect(onSuperseded).toHaveBeenCalledTimes(1);
    expect(useWorldStore.getState().playingElsewhere).toBe(true);
    await expect(presence.rejoin()).rejects.toMatchObject({ code: "conflict" });

    // Closing this tab neither beacons nor posts a leave that would remove the other tab's player.
    page.dispatchEvent(new Event("pagehide"));
    expect(beacons).toBe(0);

    await presence.resume();
    expect(presence.superseded).toBe(false);
    expect(useWorldStore.getState().playingElsewhere).toBe(false);
    expect(acts.map((a) => a.type)).toEqual(["join", "join"]);
    page.dispatchEvent(new Event("pagehide"));
    expect(beacons).toBe(1);
    presence.stop();
    await vi.waitFor(() => expect(acts.map((a) => a.type)).toEqual(["join", "join", "leave"]));
  });

  it("does not post a leave on stop after another tab took over", async () => {
    const bus = memoryBus();
    const lock = new PresenceLock(bus.tab(), "old", () => 1);
    setPresenceLock(lock);
    const presence = startPresence({ appearance: () => DEFAULT_APPEARANCE, lock });
    await presence.rejoin();
    new PresenceLock(bus.tab(), "new", () => 2).acquire("abcdefghij012345");
    presence.stop();
    await new Promise((r) => setTimeout(r, 10));
    expect(acts.map((a) => a.type)).toEqual(["join"]);
  });
});
