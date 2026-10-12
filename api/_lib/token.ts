/**
 * Player session tokens: HS256 JWTs signed with SESSION_SECRET. The token
 * proves which pid is acting and which world it acts in; the name and wallet
 * claims are a convenience for the client, and the server always re-reads
 * them from the profile. Only a join issues a token for a new world, so every
 * other action lands in the world the player last joined.
 */

import { jwtVerify, SignJWT } from "jose";
import { isWorldId } from "../../shared/worlds.js";

export interface SessionClaims {
  pid: string;
  name: string;
  /** Verified wallet, lowercase, or null. */
  wallet: string | null;
  /** The world the player last joined; absent before their first join (and on tokens from before worlds). */
  world?: number;
}

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ISSUER = "rampridge";
const AUDIENCE = "rampridge-world";
export const PID_PATTERN = /^[0-9a-z]{16}$/;

export async function signSession(claims: SessionClaims, secret: Uint8Array, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const body: Record<string, unknown> = { pid: claims.pid, name: claims.name, wallet: claims.wallet };
  if (claims.world !== undefined) body.world = claims.world;
  return new SignJWT(body)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.pid)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SESSION_TTL_SECONDS)
    .sign(secret);
}

/**
 * Returns the claims of a valid, unexpired token, or null for anything else.
 * With `notBeforeSeconds` (SESSION_NOT_BEFORE), tokens issued earlier are
 * refused too.
 */
export async function verifySession(
  token: string,
  secret: Uint8Array,
  nowMs: number,
  notBeforeSeconds: number | null = null,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate: new Date(nowMs),
    });
    if (notBeforeSeconds !== null && (typeof payload.iat !== "number" || payload.iat < notBeforeSeconds)) return null;
    const { pid, name, wallet, world } = payload as Record<string, unknown>;
    if (typeof pid !== "string" || !PID_PATTERN.test(pid) || payload.sub !== pid) return null;
    if (typeof name !== "string") return null;
    if (wallet !== null && typeof wallet !== "string") return null;
    // A world this server no longer has (the range shrank) reads as none: the player rejoins, keeping their identity.
    return { pid, name, wallet: wallet ?? null, ...(isWorldId(world) ? { world } : {}) };
  } catch {
    return null;
  }
}
