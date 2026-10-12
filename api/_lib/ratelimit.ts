/**
 * Rate limits kept in the database so they hold across function instances.
 * The decisions are pure functions; the database helpers apply them inside a
 * transaction so concurrent requests cannot both spend the last token.
 */

import { createHmac } from "node:crypto";
import type { Db } from "./db.js";
import { rateLimited } from "./http.js";

export interface BucketSpec {
  capacity: number;
  refillPerSecond: number;
}

/**
 * Every action: a burst of 10, refilled at 3 per second. Heartbeats are one per
 * 15 s and following a player re-plans at most every 600 ms, so play never
 * comes close; a burst of clicks waits a fraction of a second.
 */
export const ACTION_BUCKET: BucketSpec = { capacity: 10, refillPerSecond: 3 };
/**
 * Actions that read Base through the RPC (stall, announce, wallet proof): a
 * burst of 3, then one every 10 s, so a cheap pid cannot drain the RPC key.
 */
export const CHAIN_BUCKET: BucketSpec = { capacity: 3, refillPerSecond: 0.1 };
/** Chat on top of the action bucket: one message per 1.2 s and 30 per minute. */
export const CHAT_LIMIT = { minIntervalMs: 1_200, perMinute: 30, windowMs: 60_000 } as const;
/** Chat across one world: a ceiling on what every client there has to download. */
export const ROOM_CHAT_LIMIT = { perWindow: 20, windowMs: 1_000 } as const;
/**
 * New players per IP: a burst of 60, refilled at one per 10 s (60 per 10
 * minutes). Carrier NAT, campuses and offices put many people behind one IP.
 */
export const SESSION_CREATE_BUCKET: BucketSpec = { capacity: 60, refillPerSecond: 0.1 };
/**
 * Chat per IP, on top of each player's own pace: a burst of 10, then one a
 * second. A person sends at most one every 1.2 s, so a household or office
 * sharing an address is never slowed, while one machine running many sessions
 * gets a twentieth of the room's capacity instead of all of it.
 */
export const IP_CHAT_BUCKET: BucketSpec = { capacity: 10, refillPerSecond: 1 };

/** A token bucket: tokens and the last refill, server ms. */
export interface TokenBucket {
  b: number;
  u: number;
}

/** `ratelimits/act/{pid}`: the action bucket plus the chat counters. */
export interface ActionBucket extends TokenBucket {
  /** Last chat message. */
  cl?: number;
  /** Chat window start and count. */
  cw?: number;
  cc?: number;
}

/** A fixed window counter (`meta/worldChat/{world}`). */
export interface WindowCounter {
  w: number;
  c: number;
}

export type RateDecision<T> = { ok: true; next: T } | { ok: false; retryAfterMs: number };

function isBucket(value: unknown): value is TokenBucket {
  if (value === null || typeof value !== "object") return false;
  const { b, u } = value as Record<string, unknown>;
  return typeof b === "number" && typeof u === "number";
}

/** Refills `bucket` to `now` and takes one token. */
export function takeToken(bucket: TokenBucket | null, now: number, spec: BucketSpec): RateDecision<TokenBucket> {
  const { capacity, refillPerSecond } = spec;
  const valid = isBucket(bucket) ? bucket : null;
  const elapsed = valid ? Math.max(0, now - valid.u) : 0;
  const tokens = valid ? Math.min(capacity, valid.b + (elapsed / 1000) * refillPerSecond) : capacity;
  if (tokens < 1) {
    return { ok: false, retryAfterMs: Math.ceil(((1 - tokens) / refillPerSecond) * 1000) };
  }
  return { ok: true, next: { b: tokens - 1, u: now } };
}

export function takeAction(bucket: ActionBucket | null, now: number, chat: boolean): RateDecision<ActionBucket> {
  const taken = takeToken(bucket, now, ACTION_BUCKET);
  if (!taken.ok) return taken;
  const next: ActionBucket = { ...taken.next };
  if (bucket?.cl !== undefined) next.cl = bucket.cl;
  if (bucket?.cw !== undefined) next.cw = bucket.cw;
  if (bucket?.cc !== undefined) next.cc = bucket.cc;
  if (!chat) return { ok: true, next };

  const sinceLast = bucket?.cl !== undefined ? now - bucket.cl : Infinity;
  if (sinceLast < CHAT_LIMIT.minIntervalMs) {
    return { ok: false, retryAfterMs: CHAT_LIMIT.minIntervalMs - sinceLast };
  }
  const windowOpen = bucket?.cw !== undefined && now - bucket.cw < CHAT_LIMIT.windowMs;
  const count = windowOpen ? (bucket?.cc ?? 0) : 0;
  if (count >= CHAT_LIMIT.perMinute) {
    return { ok: false, retryAfterMs: bucket!.cw! + CHAT_LIMIT.windowMs - now };
  }
  next.cl = now;
  next.cw = windowOpen ? bucket!.cw! : now;
  next.cc = count + 1;
  return { ok: true, next };
}

export function takeWindow(
  counter: WindowCounter | null,
  now: number,
  limit: number,
  windowMs: number,
): RateDecision<WindowCounter> {
  if (!counter || now - counter.w >= windowMs) return { ok: true, next: { w: now, c: 1 } };
  if (counter.c >= limit) return { ok: false, retryAfterMs: counter.w + windowMs - now };
  return { ok: true, next: { w: counter.w, c: counter.c + 1 } };
}

async function apply<T>(
  db: Db,
  path: string,
  decide: (current: T | null) => RateDecision<T>,
  message?: string,
): Promise<void> {
  let retryAfterMs = 0;
  const outcome = await db.transaction<T>(path, (current) => {
    const decision = decide(current);
    if (decision.ok) return decision.next;
    retryAfterMs = decision.retryAfterMs;
    return undefined;
  });
  if (!outcome.committed) throw rateLimited(retryAfterMs, message);
}

export const actionBucketPath = (pid: string) => `ratelimits/act/${pid}`;
export const chainBucketPath = (pid: string) => `ratelimits/chain/${pid}`;
export const ipBucketPath = (ipHash: string) => `ratelimits/ip/${ipHash}`;
export const ipChatBucketPath = (ipHash: string) => `ratelimits/ipchat/${ipHash}`;
export const WORLD_CHAT = "meta/worldChat";
export const roomChatPath = (world: number) => `${WORLD_CHAT}/${world}`;

/** Spends one action token (and a chat slot for chat). Throws 429 when limited. */
export async function limitAction(db: Db, pid: string, now: number, chat = false): Promise<void> {
  await apply<ActionBucket>(
    db,
    actionBucketPath(pid),
    (current) => takeAction(current, now, chat),
    chat ? "You're sending messages too quickly." : undefined,
  );
}

/** Spends one chain token before an action reads Base. Throws 429 when limited. */
export async function limitChain(db: Db, pid: string, now: number): Promise<void> {
  await apply<TokenBucket>(
    db,
    chainBucketPath(pid),
    (current) => takeToken(current, now, CHAIN_BUCKET),
    "You're doing that too quickly. Try again in a few seconds.",
  );
}

/** Counts a message against its world. Throws 429 when that world's chat is too busy. */
export async function limitRoomChat(db: Db, world: number, now: number): Promise<void> {
  await apply<WindowCounter>(
    db,
    roomChatPath(world),
    (current) => takeWindow(current, now, ROOM_CHAT_LIMIT.perWindow, ROOM_CHAT_LIMIT.windowMs),
    "The bank is busy. Try your message again in a moment.",
  );
}

/** Counts a new session against the caller's IP. Throws 429 when limited. */
export async function limitSessionCreation(db: Db, ipHash: string, now: number): Promise<void> {
  await apply<TokenBucket>(
    db,
    ipBucketPath(ipHash),
    (current) => takeToken(current, now, SESSION_CREATE_BUCKET),
    "Too many new players from your network. Try again in a minute.",
  );
}

/** Counts a chat message against the caller's IP. Throws 429 when limited. */
export async function limitIpChat(db: Db, ipHash: string, now: number): Promise<void> {
  await apply<TokenBucket>(
    db,
    ipChatBucketPath(ipHash),
    (current) => takeToken(current, now, IP_CHAT_BUCKET),
    "Too many messages from your network. Try again in a moment.",
  );
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  // An embedded IPv4 tail ("::ffff:203.0.113.7") becomes two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const bytes = v4.slice(1).map(Number);
    if (bytes.some((b) => b > 255)) return null;
    text = `${text.slice(0, v4.index)}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(text) || (text.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const parse = (part: string | null | undefined) => (part ? part.split(":") : []);
  const left = parse(head);
  const right = parse(tail);
  const missing = 8 - left.length - right.length;
  if (tail === null ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === null ? 0 : missing).fill("0"), ...right];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The part of an address one subscriber controls, which is what a per-IP
 * limit has to count. IPv4 is used as is. An IPv6 home or phone line is given
 * a whole /64 and can pick any address inside it for free, so IPv6 counts by
 * its /64; IPv4-mapped IPv6 counts as the IPv4 address.
 */
export function ipBucketKey(ip: string): string {
  const groups = ipv6Groups(ip);
  if (!groups) return ip.trim();
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** IPs are stored only as a keyed hash of their bucket key (ipBucketKey), never in the clear. */
export function hashIp(ip: string, secret: Uint8Array): string {
  return createHmac("sha256", secret).update(`ip:${ipBucketKey(ip)}`).digest("hex").slice(0, 32);
}
