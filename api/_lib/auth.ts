import type { ApiDeps } from "./deps.js";
import { unauthorized } from "./http.js";
import type { SessionClaims } from "./token.js";
import { verifySession } from "./token.js";

/** Verifies a session token or throws 401. */
export async function authenticate(deps: ApiDeps, token: string | null | undefined): Promise<SessionClaims> {
  if (!token) throw unauthorized("Sign in to continue.");
  const claims = await verifySession(token, deps.sessionSecret(), deps.now(), deps.sessionNotBefore());
  if (!claims) throw unauthorized();
  return claims;
}
