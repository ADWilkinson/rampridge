/**
 * The player's session token: created or refreshed against /api/session,
 * kept in localStorage, mirrored into the store's `me`. Also the wallet
 * ownership proof (fetch challenge -> sign -> submit).
 */

import type { SessionRequest, SessionResponse, WalletProofRequest } from "@shared/protocol";
import type { WalletChallengeResponse } from "@shared/world";
import { isWorldId } from "@shared/worlds";
import type { TxSender } from "@/wallet/types";
import { ApiError, apiFetch } from "./http";
import { noteServerTime, useWorldStore } from "./store";

export const SESSION_STORAGE_KEY = "rampridge.session";

export interface Session {
  token: string;
  pid: string;
  name: string;
  /** Verified wallet, lowercase, or null. */
  wallet: string | null;
  /** The world the token names: the player's last join (every world action lands there), or null before one. */
  world: number | null;
}

function readStored(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "string" || typeof parsed.name !== "string") {
      return null;
    }
    return {
      token: parsed.token,
      pid: parsed.pid,
      name: parsed.name,
      wallet: typeof parsed.wallet === "string" ? parsed.wallet : null,
      world: isWorldId(parsed.world) ? parsed.world : null,
    };
  } catch {
    return null;
  }
}

let current: Session | null = typeof localStorage === "undefined" ? null : readStored();

const meOf = (session: Session) => ({ pid: session.pid, name: session.name, wallet: session.wallet, world: session.world });

function store(session: Session | null): void {
  current = session;
  try {
    if (session) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the session still works for this tab.
  }
  useWorldStore.getState().setMe(session ? meOf(session) : null);
}

function fromResponse(body: SessionResponse, sentAt: number): Session {
  if (!body.ok || !body.token || !body.pid || !body.name) {
    throw new ApiError(500, "server", body.error ?? "The server returned an incomplete session.");
  }
  noteServerTime(body.now, sentAt);
  return { token: body.token, pid: body.pid, name: body.name, wallet: body.wallet ?? null, world: isWorldId(body.world) ? body.world : null };
}

/**
 * A join answered with the world the player is now in and a token naming it
 * (`ActResponse.token`): every later action must carry that token, so it
 * replaces the stored one. A session that is now another player's (a new
 * guest, another tab) is left alone.
 */
export function adoptWorld(pid: string, token: string, world: number): void {
  if (!current || current.pid !== pid || !isWorldId(world)) return;
  store({ ...current, token, world });
}

/**
 * Only a join moves the player between worlds. A session response that names
 * another world than the token held for the same player is a refresh that
 * crossed a join in flight: it keeps the held token and world, and takes the
 * name and wallet (which the server re-reads anyway).
 */
function reconcile(next: Session): Session {
  if (current && current.pid === next.pid && current.world !== null && next.world !== current.world) {
    return { ...next, token: current.token, world: current.world };
  }
  return next;
}

/** The session stored on this device, without contacting the server. */
export function getSession(): Session | null {
  return current;
}

export function getSessionToken(): string | null {
  return current?.token ?? null;
}

let inflight: Promise<Session> | null = null;

/**
 * Refreshes the stored session (a fresh 30-day token) or creates a new player
 * when there is none or it has expired. Concurrent calls share one request.
 * Pass `name` to choose a name for a new player.
 */
export function ensureSession(options: { name?: string } = {}): Promise<Session> {
  if (inflight) return inflight;
  const body: SessionRequest = {};
  if (current?.token) body.token = current.token;
  if (options.name !== undefined) body.name = options.name;
  const sentAt = Date.now();
  inflight = apiFetch<SessionResponse>("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((response) => {
      const session = reconcile(fromResponse(response, sentAt));
      store(session);
      return session;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Changes the display name. Throws ApiError with code "name_taken" (409) or
 * "bad_request" (400, invalid name) so the UI can say why.
 */
export async function renameSession(name: string): Promise<Session> {
  if (inflight) await inflight.catch(() => undefined);
  if (!current) return ensureSession({ name });
  const sentAt = Date.now();
  const response = await apiFetch<SessionResponse>("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: current.token, name } satisfies SessionRequest),
  });
  const session = reconcile(fromResponse(response, sentAt));
  store(session);
  return session;
}

/**
 * Checks whether `name` is free for this player without taking it. Resolves
 * with the name as it would be stored; throws ApiError with code
 * "name_taken" (409) or "bad_request" (400, invalid or reserved name).
 */
export async function checkName(name: string): Promise<{ name: string }> {
  if (inflight) await inflight.catch(() => undefined);
  let session = current ?? (await ensureSession());
  for (let attempt = 0; ; attempt++) {
    const sentAt = Date.now();
    let response: SessionResponse;
    try {
      response = await apiFetch<SessionResponse>("/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.token, name, check: true } satisfies SessionRequest),
      });
    } catch (err) {
      // An expired token: refresh (or start a new player) and ask once more.
      if (err instanceof ApiError && err.status === 401 && attempt === 0) {
        session = await ensureSession();
        continue;
      }
      throw err;
    }
    noteServerTime(response.now, sentAt);
    if (!response.ok || response.available !== true || !response.name) {
      throw new ApiError(500, "server", response.error ?? "Couldn't check that name. Please try again.");
    }
    return { name: response.name };
  }
}

/**
 * Proves ownership of the sender's wallet: fetches a one-time message, asks
 * the wallet to sign it (EOA, smart wallet or counterfactual smart wallet),
 * and stores the refreshed session carrying the verified wallet.
 */
export async function proveWallet(sender: Pick<TxSender, "address" | "signMessage">): Promise<Session> {
  const session = current ?? (await ensureSession());
  const challenge = await apiFetch<WalletChallengeResponse>(
    `/wallet?address=${encodeURIComponent(sender.address)}`,
    { headers: { Authorization: `Bearer ${session.token}` } },
  );
  if (!challenge.ok || !challenge.message) {
    throw new ApiError(500, "server", challenge.error ?? "Couldn't start wallet verification.");
  }
  const signature = await sender.signMessage(challenge.message);
  const proof: WalletProofRequest = {
    token: session.token,
    address: sender.address,
    message: challenge.message,
    signature,
  };
  const sentAt = Date.now();
  const response = await apiFetch<SessionResponse>("/wallet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  });
  const next = reconcile(fromResponse(response, sentAt));
  store(next);
  return next;
}

/** Forgets the session on this device (the player keeps their name server-side until it expires). */
export function clearSession(): void {
  store(null);
}

// Another tab may refresh or replace the session; follow it.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== SESSION_STORAGE_KEY) return;
    const next = readStored();
    current = next;
    useWorldStore.getState().setMe(next ? meOf(next) : null);
  });
  if (current) useWorldStore.getState().setMe(meOf(current));
}
