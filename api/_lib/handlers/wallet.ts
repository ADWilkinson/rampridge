/**
 * Wallet ownership proof.
 *
 * GET /api/wallet?address=0x... (Authorization: Bearer <token>) issues a
 * one-time Sign-In with Ethereum (EIP-4361) message bound to the site, the
 * player, the wallet and a nonce, valid for 10 minutes. Wallets check a SIWE
 * message's domain against the page asking for the signature, so a phishing
 * page relaying the challenge gets a warning. POST /api/wallet with
 * WalletProofRequest checks the signature on Base (EOAs, ERC-1271 smart
 * wallets and undeployed ERC-6492 wallets), stores the wallet on the profile
 * and returns a refreshed token carrying it.
 */

import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import type { SessionResponse } from "../../../shared/protocol.js";
import { isAddress, validateWalletProofRequest } from "../../../shared/validate.js";
import type { WalletChallengeResponse } from "../../../shared/world.js";
import { authenticate } from "../auth.js";
import type { Db } from "../db.js";
import { CHAIN_ID } from "../chain.js";
import type { ApiDeps } from "../deps.js";
import {
  assertSameSite,
  badRequest,
  bearerToken,
  conflict,
  forbidden,
  HttpError,
  json,
  readJson,
  requireJsonContent,
  unauthorized,
  upstream,
  withErrors,
} from "../http.js";
import { mutatePlayer } from "../players.js";
import { getProfile, profilePath } from "../profiles.js";
import { limitAction, limitChain } from "../ratelimit.js";
import { signSession } from "../token.js";

export const WALLET_PROOF_DOMAIN = "www.rampridge.xyz";
export const WALLET_PROOF_TTL_MS = 10 * 60 * 1000;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

/** `nonces/{pid}`: the outstanding challenge. */
export interface WalletNonce {
  /** Exact message text. */
  m: string;
  /** Lowercase wallet it is bound to. */
  a: string;
  /** Nonce inside the message. */
  n: string;
  /** Expiry, server ms. */
  x: number;
}

export const noncePath = (pid: string) => `nonces/${pid}`;

/**
 * The site a proof is for: the request's host when it is a local dev server,
 * otherwise production. The SIWE domain must match the page the player signs
 * on, or the wallet warns.
 */
export function proofSite(request: Request): { domain: string; uri: string } {
  let host = "";
  try {
    host = new URL(request.url).host;
  } catch {
    // Production below.
  }
  if (LOCAL_HOST.test(host)) return { domain: host, uri: `http://${host}` };
  return { domain: WALLET_PROOF_DOMAIN, uri: `https://${WALLET_PROOF_DOMAIN}` };
}

export function walletProofMessage(input: {
  domain: string;
  uri: string;
  pid: string;
  address: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}): string {
  return createSiweMessage({
    domain: input.domain,
    uri: input.uri,
    address: getAddress(input.address),
    version: "1",
    chainId: CHAIN_ID,
    nonce: input.nonce,
    issuedAt: new Date(input.issuedAt),
    expirationTime: new Date(input.expiresAt),
    statement: `Link this wallet to RampRidge player ${input.pid}. Signing is free and sends no transaction.`,
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function issueChallenge(deps: ApiDeps, request: Request): Promise<Response> {
  const claims = await authenticate(deps, bearerToken(request));
  const address = new URL(request.url).searchParams.get("address");
  if (!isAddress(address)) throw badRequest("address must be a wallet address.");
  const db = deps.db();
  const now = deps.now();
  await limitAction(db, claims.pid, now);

  const expiresAt = now + WALLET_PROOF_TTL_MS;
  const wallet = address.toLowerCase();
  const nonce = hex(deps.randomBytes(16));
  const message = walletProofMessage({
    ...proofSite(request),
    pid: claims.pid,
    address: wallet,
    nonce,
    issuedAt: now,
    expiresAt,
  });
  const record: WalletNonce = { m: message, a: wallet, n: nonce, x: expiresAt };
  await db.set(noncePath(claims.pid), record);
  const body: WalletChallengeResponse = { ok: true, message, address: wallet, expiresAt, now };
  return json(body);
}

/** Deletes the challenge only if it is still the one we checked, so it can be used once. */
async function consumeNonce(db: Db, pid: string, message: string): Promise<boolean> {
  const outcome = await db.transaction<WalletNonce>(noncePath(pid), (current) =>
    current && current.m === message ? null : undefined,
  );
  return outcome.committed;
}

async function acceptProof(deps: ApiDeps, request: Request): Promise<Response> {
  assertSameSite(request);
  requireJsonContent(request);
  const parsed = validateWalletProofRequest(await readJson(request, 32_768));
  if (!parsed.ok) throw badRequest(parsed.error);
  const proof = parsed.value;
  const claims = await authenticate(deps, proof.token || bearerToken(request));
  const db = deps.db();
  const now = deps.now();
  await limitAction(db, claims.pid, now);

  const wallet = proof.address.toLowerCase();
  const stored = await db.get<WalletNonce>(noncePath(claims.pid));
  if (!stored || stored.x <= now) throw badRequest("That verification request has expired. Please try again.");
  if (stored.m !== proof.message || stored.a !== wallet || typeof stored.n !== "string") {
    throw badRequest("That message doesn't match the verification request. Please try again.");
  }

  await limitChain(db, claims.pid, now);
  let valid: boolean;
  try {
    valid = await deps.chain().verifySiweMessage({
      message: proof.message,
      signature: proof.signature as `0x${string}`,
      domain: proofSite(request).domain,
      nonce: stored.n,
      address: getAddress(wallet),
      time: new Date(now),
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw upstream("Couldn't reach Base to check the signature. Please try again.");
  }
  if (!valid) {
    await consumeNonce(db, claims.pid, proof.message);
    throw forbidden("That signature wasn't made by this wallet.");
  }
  if (!(await consumeNonce(db, claims.pid, proof.message))) {
    throw conflict("That verification was already used. Please try again.");
  }

  const profile = await getProfile(db, claims.pid);
  if (!profile) throw unauthorized();
  await db.update({
    [`${profilePath(claims.pid)}/w`]: wallet,
    [`${profilePath(claims.pid)}/u`]: now,
  });
  if (claims.world !== undefined) {
    try {
      await mutatePlayer(db, claims.world, claims.pid, (record) =>
        // A stall belongs to the wallet that proved it; a new wallet clears it.
        record.w === wallet ? record : { ...record, w: wallet, s: null },
      );
    } catch (err) {
      if (!(err instanceof HttpError && err.code === "not_joined")) throw err;
    }
  }

  const session = { pid: claims.pid, name: profile.n, wallet, ...(claims.world !== undefined ? { world: claims.world } : {}) };
  const body: SessionResponse = {
    ok: true,
    token: await signSession(session, deps.sessionSecret(), now),
    pid: session.pid,
    name: session.name,
    wallet,
    world: claims.world ?? null,
    now,
  };
  return json(body);
}

export function createWalletHandlers(deps: ApiDeps): {
  GET: (request: Request) => Promise<Response>;
  POST: (request: Request) => Promise<Response>;
} {
  return {
    GET: withErrors(deps.now, (request) => issueChallenge(deps, request)),
    POST: withErrors(deps.now, (request) => acceptProof(deps, request)),
  };
}
