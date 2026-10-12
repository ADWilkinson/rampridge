/**
 * POST /api/session: creates a player, or refreshes (and optionally renames)
 * an existing one, answering with a fresh 30-day token. With `check: true`
 * it only reports whether a name is free for the token's player and writes
 * nothing. Browser requests from other sites are refused.
 */

import { nameKey, normaliseName } from "../../../shared/chat.js";
import type { SessionResponse } from "../../../shared/protocol.js";
import { validateSessionRequest } from "../../../shared/validate.js";
import type { Db } from "../db.js";
import type { ApiDeps } from "../deps.js";
import {
  assertSameSite,
  badRequest,
  clientIp,
  HttpError,
  json,
  readJson,
  requireJsonContent,
  unauthorized,
  withErrors,
} from "../http.js";
import { mutatePlayer } from "../players.js";
import { checkRequestedName, claimGuestName, claimName, claimRequestedName } from "../names.js";
import { getProfile, newPid, profilePath } from "../profiles.js";
import type { Profile } from "../profiles.js";
import { hashIp, limitAction, limitSessionCreation } from "../ratelimit.js";
import { signSession, verifySession } from "../token.js";
import type { SessionClaims } from "../token.js";

/** Updates the display name on the player's world record if they are in their world. */
export async function syncOnlineName(db: Db, pid: string, name: string, world: number | undefined): Promise<void> {
  if (world === undefined) return;
  try {
    await mutatePlayer(db, world, pid, (record) => ({ ...record, n: name }));
  } catch (err) {
    if (!(err instanceof HttpError && err.code === "not_joined")) throw err;
  }
}

async function createPlayer(deps: ApiDeps, request: Request, requestedName: string | undefined): Promise<SessionClaims> {
  const db = deps.db();
  const now = deps.now();
  const ip = clientIp(request) ?? "unknown";
  await limitSessionCreation(db, hashIp(ip, deps.sessionSecret()), now);

  const pid = newPid(deps.randomBytes);
  let name: string;
  let key: string;
  if (requestedName !== undefined) {
    ({ name, key } = await claimRequestedName(db, pid, requestedName, null));
  } else {
    name = await claimGuestName(db, pid, deps.randomBytes);
    key = nameKey(name);
  }
  const profile: Profile = { n: name, k: key, w: null, c: now, u: now };
  await db.set(profilePath(pid), profile);
  return { pid, name, wallet: null };
}

/** Rebuilds a profile lost from the database, keeping the token's name when it is still free. */
async function restoreProfile(deps: ApiDeps, claims: SessionClaims): Promise<Profile> {
  const db = deps.db();
  const now = deps.now();
  const previous = normaliseName(claims.name);
  let name: string;
  if (previous && (await claimName(db, nameKey(previous), claims.pid))) {
    name = previous;
  } else {
    name = await claimGuestName(db, claims.pid, deps.randomBytes);
  }
  const profile: Profile = { n: name, k: nameKey(name), w: null, c: now, u: now };
  await db.set(profilePath(claims.pid), profile);
  return profile;
}

async function refreshPlayer(
  deps: ApiDeps,
  claims: SessionClaims,
  requestedName: string | undefined,
): Promise<SessionClaims> {
  const db = deps.db();
  const now = deps.now();
  await limitAction(db, claims.pid, now);
  let profile = (await getProfile(db, claims.pid)) ?? (await restoreProfile(deps, claims));

  if (requestedName !== undefined && normaliseName(requestedName) !== profile.n) {
    const { name, key } = await claimRequestedName(db, claims.pid, requestedName, profile.k);
    profile = { ...profile, n: name, k: key, u: now };
    await db.update({
      [`${profilePath(claims.pid)}/n`]: name,
      [`${profilePath(claims.pid)}/k`]: key,
      [`${profilePath(claims.pid)}/u`]: now,
    });
    await syncOnlineName(db, claims.pid, name, claims.world);
  }
  // The world stays the one the player last joined; only a join changes it.
  return { pid: claims.pid, name: profile.n, wallet: profile.w ?? null, ...(claims.world !== undefined ? { world: claims.world } : {}) };
}

/** `check: true`: the same validation as a rename, spending an action token, writing nothing. */
async function checkName(deps: ApiDeps, claims: SessionClaims | null, requested: string): Promise<Response> {
  if (!claims) throw unauthorized();
  const db = deps.db();
  await limitAction(db, claims.pid, deps.now());
  const { name } = await checkRequestedName(db, claims.pid, requested);
  const response: SessionResponse = { ok: true, available: true, name, now: deps.now() };
  return json(response);
}

export function createSessionHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return withErrors(deps.now, async (request) => {
    assertSameSite(request);
    requireJsonContent(request);
    const body = validateSessionRequest(await readJson(request, 4_096));
    if (!body.ok) throw badRequest(body.error);
    const secret = deps.sessionSecret();
    const { token, name, check } = body.value;
    // An expired or foreign token simply starts a new player.
    const claims = token ? await verifySession(token, secret, deps.now(), deps.sessionNotBefore()) : null;
    if (check && name !== undefined) return checkName(deps, claims, name);
    const session = claims ? await refreshPlayer(deps, claims, name) : await createPlayer(deps, request, name);
    const now = deps.now();
    const response: SessionResponse = {
      ok: true,
      token: await signSession(session, secret, now),
      pid: session.pid,
      name: session.name,
      wallet: session.wallet,
      world: session.world ?? null,
      now,
    };
    return json(response);
  });
}
