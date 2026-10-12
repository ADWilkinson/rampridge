/**
 * Writes to the shared worlds go through POST /api/act. This module adds the
 * session token, retries transient failures, backs off on 429, refreshes an
 * expired session once, and keeps the player present with heartbeats. A
 * join's answer names the player's world and carries a token for it, which
 * replaces the stored one; every later action acts in that world. Only one
 * tab per player keeps a presence (presenceLock.ts).
 */

import { HEARTBEAT_MS } from "@shared/protocol";
import type { ActRequest, ActResponse, Appearance, WorldRequest } from "@shared/protocol";
import { API_BASE, ApiError, apiFetch, sleep } from "./http";
import { peekPresenceLock, presenceLock } from "./presenceLock";
import type { PresenceLock } from "./presenceLock";
import { adoptWorld, ensureSession, getSession, getSessionToken } from "./session";
import { noteServerTime, useWorldStore } from "./store";

/** Waits longer than this are surfaced as errors rather than slept through. */
export const MAX_RATE_LIMIT_WAIT_MS = 3_000;
/** A rate-limited action is sent again at most this many times. */
export const MAX_RATE_LIMIT_RETRIES = 2;
/** A hidden tab stops heartbeating after this long, so the player leaves the world. */
export const HIDDEN_PAUSE_MS = 5 * 60 * 1000;
export const PLAYING_ELSEWHERE_MESSAGE = "You are playing in another tab.";

/** Actions that act as the player in the world; another tab holding the presence refuses them. */
const PRESENCE_ACTIONS: ReadonlySet<ActRequest["type"]> = new Set([
  "join",
  "move",
  "chat",
  "emote",
  "heartbeat",
  "leave",
  "appearance",
]);

export interface PostActOptions {
  /** Extra attempts after a network failure or a 5xx. Default 2 (0 for chat). */
  retries?: number;
  signal?: AbortSignal;
}

function backoffMs(attempt: number): number {
  return Math.min(4_000, 400 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

/** The server asked chat to pause (this player's pace, or the whole room's): until when, and why. */
let chatPause: { until: number; message: string } | null = null;

/** Clears the chat pause (tests). */
export function resetChatBackoff(): void {
  chatPause = null;
}

function playingElsewhere(): ApiError {
  return new ApiError(409, "conflict", PLAYING_ELSEWHERE_MESSAGE);
}

/**
 * Sends one action. Resolves with the server's response; throws ApiError
 * with the server's code (e.g. "not_joined" means join first, "rate_limited"
 * carries retryAfterMs). 4xx responses other than 401 and 429 are never
 * retried. A 429 means nothing was applied, so any action, chat included,
 * waits out a short one and is sent again; a long one is surfaced. Chat is
 * not retried after other failures because a lost response would otherwise
 * post the message twice. After a chat 429, later messages wait (or fail
 * fast) until the server's pause is over instead of hammering it.
 */
export async function postAct(action: ActRequest, options: PostActOptions = {}): Promise<ActResponse> {
  if (PRESENCE_ACTIONS.has(action.type) && peekPresenceLock()?.state === "lost") throw playingElsewhere();
  const retries = options.retries ?? (action.type === "chat" ? 0 : 2);
  let refreshedSession = false;
  let resentAfterJoin = false;
  let rateLimited = 0;
  for (let attempt = 0; ; attempt++) {
    if (action.type === "chat" && chatPause) {
      const wait = chatPause.until - Date.now();
      if (wait > MAX_RATE_LIMIT_WAIT_MS) throw new ApiError(429, "rate_limited", chatPause.message, wait);
      if (wait > 0) await sleep(wait, options.signal);
    }
    const session = getSession() ?? (await ensureSession());
    const token = session.token;
    const sentAt = Date.now();
    try {
      const response = await apiFetch<ActResponse>("/act", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(action),
        signal: options.signal,
        keepalive: action.type === "leave",
      });
      noteServerTime(response.now, sentAt);
      if (action.type === "join" && response.token && typeof response.world === "number") {
        adoptWorld(session.pid, response.token, response.world);
      }
      return response;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === "not_joined" && !resentAfterJoin && getSessionToken() !== token) {
        // Sent with the token from before a join (a hop) that has answered since: the player is in the new
        // world, so the action goes there instead of asking for a rejoin.
        resentAfterJoin = true;
        attempt--;
        continue;
      }
      if (err.status === 401 && !refreshedSession) {
        // Expired token: refresh (or start a new player) and try once more.
        refreshedSession = true;
        await ensureSession();
        attempt--;
        continue;
      }
      if (err.status === 429) {
        const wait = err.retryAfterMs ?? 1_000;
        if (action.type === "chat") chatPause = { until: Date.now() + wait, message: err.message };
        if (wait > MAX_RATE_LIMIT_WAIT_MS || rateLimited >= MAX_RATE_LIMIT_RETRIES) throw err;
        rateLimited++;
        if (action.type !== "chat") await sleep(wait, options.signal);
        attempt--;
        continue;
      }
      if (attempt >= retries) throw err;
      if (err.transient) {
        await sleep(backoffMs(attempt), options.signal);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Best-effort leave while the page is being unloaded. sendBeacon cannot set
 * headers, so the token rides in the body (the API accepts that for leave only).
 */
export function sendLeaveBeacon(): boolean {
  const token = getSessionToken();
  if (!token || typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return false;
  const body = new Blob([JSON.stringify({ type: "leave", token })], { type: "text/plain;charset=UTF-8" });
  return navigator.sendBeacon(`${API_BASE}/act`, body);
}

export interface HeartbeatOptions {
  /** The server no longer has the player (pruned after a pause, or a new session): rejoin. */
  onNotJoined?: () => void;
  onError?: (err: unknown) => void;
  /** Whether pagehide should send the leave beacon (only the tab holding the presence does). Default true. */
  shouldLeave?: () => boolean;
}

/**
 * Heartbeats every HEARTBEAT_MS while the tab is visible or has been hidden
 * for less than HIDDEN_PAUSE_MS, and sends a leave beacon on pagehide.
 * Returns a function that stops it.
 */
export function startHeartbeat(options: HeartbeatOptions = {}): () => void {
  let hiddenSince: number | null = document.hidden ? Date.now() : null;
  let inflight = false;

  const paused = () => hiddenSince !== null && Date.now() - hiddenSince > HIDDEN_PAUSE_MS;

  const beat = async () => {
    if (inflight || paused()) return;
    inflight = true;
    try {
      await postAct({ type: "heartbeat" }, { retries: 1 });
    } catch (err) {
      if (err instanceof ApiError && err.code === "not_joined") options.onNotJoined?.();
      else options.onError?.(err);
    } finally {
      inflight = false;
    }
  };

  const onVisibility = () => {
    if (document.hidden) {
      hiddenSince ??= Date.now();
      return;
    }
    const wasPaused = paused();
    hiddenSince = null;
    // After a long pause the server has pruned us; the heartbeat's not_joined triggers the rejoin.
    if (wasPaused) void beat();
  };
  const onPageHide = () => {
    if (options.shouldLeave?.() ?? true) sendLeaveBeacon();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    // Restored from the back/forward cache after we sent a leave.
    if (event.persisted) options.onNotJoined?.();
  };

  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
  };
}

export interface Presence {
  /**
   * Joins again with the current appearance: in the world the session names
   * (where the player was), or wherever `world()` asks for the first join.
   * Rejects while another tab is playing.
   */
  rejoin(): Promise<void>;
  /**
   * World Switcher: moves the player to `world` (and its token to that
   * world). Rejects with the server's reason ("World 302 is full.") and
   * leaves the player where they are.
   */
  hop(world: number): Promise<void>;
  /** Takes the player back from another tab: claims the presence, then joins again. */
  resume(): Promise<void>;
  /** True while another tab holds the player's presence. */
  readonly superseded: boolean;
  /** Stops heartbeats and leaves the world (unless another tab is playing). */
  stop(): void;
}

export interface PresenceOptions {
  appearance: () => Appearance;
  /**
   * Where a join asks to be: "auto" (the server picks), or a world number it
   * honours when there is room. Default: the world the session names, else
   * "auto".
   */
  world?: () => WorldRequest;
  onError?: (err: unknown) => void;
  /**
   * Another tab took over this player: heartbeats have stopped, world actions
   * reject with PLAYING_ELSEWHERE_MESSAGE, and `useWorldStore` has
   * `playingElsewhere` set. Call `resume()` to play here again.
   */
  onSuperseded?: () => void;
  /** This tab's presence lock (tests). */
  lock?: PresenceLock;
}

/**
 * Joins the world and keeps the player present: heartbeats, automatic rejoin
 * when the server has dropped the player, and leave on page exit. Claims the
 * player's presence lock first, so an older tab of the same player stands
 * down quietly instead of later removing this one with its leave.
 */
export function startPresence(options: PresenceOptions): Presence {
  const onError = options.onError ?? (() => undefined);
  const lock = options.lock ?? presenceLock();
  let joining: Promise<void> | null = null;
  let stopped = false;
  let superseded = false;
  let stopHeartbeat: (() => void) | null = null;

  const setElsewhere = (value: boolean) => {
    if (useWorldStore.getState().playingElsewhere !== value) useWorldStore.getState().setPlayingElsewhere(value);
  };

  const sendJoin = async (world: WorldRequest, hop: boolean): Promise<void> => {
    const session = getSession() ?? (await ensureSession());
    if (stopped || superseded) return;
    lock.acquire(session.pid);
    await postAct({ type: "join", appearance: options.appearance(), world, ...(hop ? { hop: true } : {}) });
  };

  const rejoin = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (superseded) return Promise.reject(playingElsewhere());
    // While a hop is in flight a rejoin waits for it: the hop decides where the player is.
    joining ??= sendJoin(options.world?.() ?? getSession()?.world ?? "auto", false).finally(() => {
      joining = null;
    });
    return joining;
  };

  const hop = async (world: number): Promise<void> => {
    if (stopped) return;
    if (superseded) throw playingElsewhere();
    while (joining) await joining.catch(() => undefined);
    const run = sendJoin(world, true).finally(() => {
      if (joining === run) joining = null;
    });
    joining = run;
    return run;
  };

  const beginHeartbeat = () => {
    stopHeartbeat?.();
    stopHeartbeat = startHeartbeat({
      onNotJoined: () => void rejoin().catch(onError),
      onError,
      shouldLeave: () => lock.state === "held",
    });
  };

  const unlisten = lock.onLost(() => {
    if (stopped || superseded) return;
    superseded = true;
    stopHeartbeat?.();
    stopHeartbeat = null;
    setElsewhere(true);
    options.onSuperseded?.();
  });

  setElsewhere(false);
  beginHeartbeat();
  void rejoin().catch(onError);

  return {
    rejoin,
    hop,
    resume() {
      if (stopped) return Promise.resolve();
      if (superseded) {
        superseded = false;
        setElsewhere(false);
        beginHeartbeat();
      }
      return rejoin();
    },
    get superseded() {
      return superseded;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unlisten();
      stopHeartbeat?.();
      stopHeartbeat = null;
      const holding = lock.state === "held";
      lock.release();
      setElsewhere(false);
      if (holding) void postAct({ type: "leave" }, { retries: 0 }).catch(() => undefined);
    },
  };
}
