/**
 * Wire contract between the browser, the Vercel game API and the realtime
 * database. The API is the only writer; clients read their world's
 * `worlds/{id}/*` (shared/worlds.ts) and post actions to `/api/act`. Keep
 * this file dependency-free: it is imported by both the Vite bundle and the
 * Node functions.
 */

/** OSRS world tile coordinate (absolute, plane 0). */
export interface Tile {
  x: number;
  y: number;
}

/** Appearance as indices into the baked identity-kit and colour tables. */
export interface Appearance {
  /** 0 = male, 1 = female body type. */
  body: 0 | 1;
  /** Identity kit choice per slot: hair, jaw, torso, arms, hands, legs, feet. */
  kits: [number, number, number, number, number, number, number];
  /** Colour choice per channel: hair, torso, legs, feet, skin. */
  colors: [number, number, number, number, number];
}

export type EmoteId =
  | "yes"
  | "no"
  | "bow"
  | "angry"
  | "think"
  | "wave"
  | "shrug"
  | "cheer"
  | "beckon"
  | "laugh"
  | "jump"
  | "dance"
  | "clap"
  | "cry";

export const EMOTES: readonly EmoteId[] = [
  "yes",
  "no",
  "bow",
  "angry",
  "think",
  "wave",
  "shrug",
  "cheer",
  "beckon",
  "laugh",
  "jump",
  "dance",
  "clap",
  "cry",
];

/** A sell stall a verified player advertises from one of their live Peer deposits. */
export interface StallSummary {
  depositId: string;
  escrow: string;
  platform: string;
  currency: string;
  /** Available USDC, decimal string. */
  available: string;
  /** Fiat per USDC, decimal string. */
  rate: string;
}

/**
 * `worlds/{id}/players/{pid}` — compact keys keep the realtime payload small.
 * Positions are deterministic: a client replays `p` from `t` at the walk or
 * run speed, so only path changes are written.
 */
export interface PlayerRecord {
  /** Display name. */
  n: string;
  /** Appearance. */
  a: Appearance;
  /** Path start tile, then each step, encoded as "x,y;x,y;...". */
  p: string;
  /** Server ms timestamp at which the path started. */
  t: number;
  /** Running (two tiles per tick) when true. */
  r: boolean;
  /** Current emote, if any. */
  e?: EmoteId | null;
  /** Server ms timestamp the emote started. */
  et?: number | null;
  /** Wallet proven with a signed message, lowercase. */
  w?: string | null;
  /** Stall advertised from a verified deposit. */
  s?: StallSummary | null;
  /** Last heartbeat, server ms. */
  ls: number;
  /** Joined at, server ms. */
  j: number;
}

/** `worlds/{id}/chat/{pushId}` */
export interface ChatRecord {
  pid: string;
  n: string;
  /** Message text after server filtering. */
  m: string;
  /** Effect prefix parsed from the message, e.g. "wave", "red". */
  fx?: string | null;
  t: number;
}

/** `worlds/{id}/events/{pushId}` — verified on-chain milestones, written to every open world. */
export interface WorldEventRecord {
  kind: "bought" | "listed" | "sold";
  pid: string | null;
  n: string;
  usdc: string;
  fiat: string | null;
  currency: string | null;
  platform: string;
  tx: string;
  t: number;
}

/**
 * Where a join wants to be: "auto" lets the server choose (the busiest world
 * with room, or the world the player is already standing in), a number asks
 * for that world and falls back to "auto" when it is full or closed.
 */
export type WorldRequest = number | "auto";

export type ActRequest =
  | {
      type: "join";
      appearance: Appearance;
      /**
       * Required since worlds: a join without it comes from a build that
       * predates them and is refused as outdated (the player is told to reload).
       */
      world?: WorldRequest;
      /** World Switcher: exactly `world` or a refusal, never another world. */
      hop?: boolean;
    }
  | { type: "move"; path: Tile[]; run: boolean }
  | { type: "chat"; text: string }
  | { type: "emote"; emote: EmoteId }
  | { type: "heartbeat" }
  | { type: "leave" }
  | { type: "appearance"; appearance: Appearance }
  | { type: "stall"; depositId: string | null }
  | { type: "announce"; kind: "bought" | "listed"; tx: string };

export interface ActResponse {
  ok: boolean;
  error?: string;
  /** Server time, used by clients to estimate clock offset. */
  now: number;
  /**
   * announce only: id of the trade's durable share record, for its link
   * https://www.rampridge.xyz/t/{shareId} (shared/share.ts). Absent when
   * the record could not be saved.
   */
  shareId?: string;
  /** join only: the world the player is now in. */
  world?: number;
  /** join only: a fresh session token carrying that world; every later action must use it. */
  token?: string;
}

export interface SessionRequest {
  /** Existing token to refresh, if the device has one. */
  token?: string;
  /** Requested display name (only on create or rename). */
  name?: string;
  /**
   * Only check whether `name` is free for this player; nothing is written.
   * Needs a valid `token`; answers `{ ok, available: true, name, now }` or
   * the same 409 name_taken / 400 bad_request a rename would get.
   */
  check?: boolean;
}

export interface SessionResponse {
  ok: boolean;
  error?: string;
  token?: string;
  pid?: string;
  name?: string;
  wallet?: string | null;
  /** The world the token names (the player's last join), or null before their first join. */
  world?: number | null;
  /** Set by a check-only request: the normalised name is free for this player. */
  available?: boolean;
  now: number;
}

export interface WalletProofRequest {
  token: string;
  address: string;
  message: string;
  signature: string;
}

/** Ticks and speeds, matching the original game's 600 ms server tick. */
export const TICK_MS = 600;
export const MAX_PATH_STEPS = 64;
export const HEARTBEAT_MS = 15_000;
/**
 * A player whose `ls` is older than this is gone: the server prunes them and
 * clients stop drawing them. The server rewrites `ls` at most every 20 s (on
 * every other heartbeat), so a live player's `ls` is up to ~30 s old and two
 * lost heartbeats still leave them in the world. Clients built before that
 * change used 45 s; they keep working and may briefly hide a player whose
 * heartbeat was lost.
 */
export const PLAYER_TIMEOUT_MS = 60_000;
export const CHAT_MAX_LENGTH = 80;
export const NAME_MAX_LENGTH = 12;

export function encodePath(path: readonly Tile[]): string {
  return path.map((t) => `${t.x},${t.y}`).join(";");
}

export function decodePath(encoded: string): Tile[] {
  if (!encoded) return [];
  const out: Tile[] = [];
  for (const part of encoded.split(";")) {
    const [xs, ys] = part.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (Number.isInteger(x) && Number.isInteger(y)) out.push({ x, y });
  }
  return out;
}

/**
 * Where a player stands at `now` given their path record: index of the last
 * reached tile plus fractional progress toward the next one.
 */
export function positionAt(
  path: readonly Tile[],
  startedAt: number,
  run: boolean,
  now: number,
): { index: number; progress: number; done: boolean } {
  if (path.length <= 1) return { index: 0, progress: 0, done: true };
  const msPerTile = run ? TICK_MS / 2 : TICK_MS;
  const elapsed = Math.max(0, now - startedAt);
  const steps = elapsed / msPerTile;
  const last = path.length - 1;
  if (steps >= last) return { index: last, progress: 0, done: true };
  const index = Math.floor(steps);
  return { index, progress: steps - index, done: false };
}
