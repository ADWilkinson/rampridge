/**
 * Hand-written validators for everything that crosses the network: request
 * bodies the API accepts, and records the browser reads back from the
 * realtime database. Dependency-free; each returns a typed value or a plain
 * English reason.
 */

import { CHAT_MAX_LENGTH, EMOTES, MAX_PATH_STEPS, NAME_MAX_LENGTH } from "./protocol.js";
import type {
  ActRequest,
  Appearance,
  ChatRecord,
  EmoteId,
  PlayerRecord,
  SessionRequest,
  StallSummary,
  Tile,
  WalletProofRequest,
  WorldEventRecord,
} from "./protocol.js";
import { APPEARANCE_LIMITS } from "./world.js";
import type { AppearanceLimits } from "./world.js";
import { isWorldId } from "./worlds.js";

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Validation<T> => ({ ok: true, value });
const fail = <T>(error: string): Validation<T> => ({ ok: false, error });

/** Raw chat input may carry effect prefixes and whitespace; the filter trims it to CHAT_MAX_LENGTH. */
export const CHAT_INPUT_MAX_LENGTH = CHAT_MAX_LENGTH + 40;
/** World coordinates are 14-bit in the original engine. */
const COORD_MAX = 16_383;
/** ERC-6492 wrapped signatures carry factory calldata, so allow generous lengths. */
const SIGNATURE_MAX_LENGTH = 20_000;
const MESSAGE_MAX_LENGTH = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The realtime database returns arrays as arrays, but objects keyed "0".."n" are accepted too. */
function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (!keys.every((k, i) => k === String(i))) return null;
  return keys.map((k) => value[k]);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function isTxHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function isHexSignature(value: unknown): value is `0x${string}` {
  return (
    typeof value === "string" &&
    value.length >= 132 &&
    value.length <= SIGNATURE_MAX_LENGTH &&
    /^0x[0-9a-fA-F]+$/.test(value) &&
    value.length % 2 === 0
  );
}

export function isEmote(value: unknown): value is EmoteId {
  return typeof value === "string" && (EMOTES as readonly string[]).includes(value);
}

/**
 * Deposit ids are either the on-chain number ("5559") or the composite form
 * the Peer API uses ("0x7777...00ef_5559"). Returns the lowercase escrow (when
 * given) and the decimal id.
 */
export function parseDepositId(value: unknown): { escrow: string | null; id: string } | null {
  if (typeof value !== "string") return null;
  const plain = /^(\d{1,30})$/.exec(value);
  if (plain) return { escrow: null, id: BigInt(plain[1]!).toString() };
  const composite = /^(0x[0-9a-fA-F]{40})_(\d{1,30})$/.exec(value);
  if (composite) return { escrow: composite[1]!.toLowerCase(), id: BigInt(composite[2]!).toString() };
  return null;
}

export function validateTile(value: unknown): Validation<Tile> {
  if (!isRecord(value)) return fail("A tile must be an object with x and y.");
  const { x, y } = value;
  if (!isInt(x) || !isInt(y) || x < 0 || y < 0 || x > COORD_MAX || y > COORD_MAX) {
    return fail("Tile coordinates must be whole numbers on the map.");
  }
  return ok({ x, y });
}

export function validateAppearance(
  value: unknown,
  limits: AppearanceLimits = APPEARANCE_LIMITS,
): Validation<Appearance> {
  if (!isRecord(value)) return fail("Appearance is missing.");
  const { body } = value;
  if (body !== 0 && body !== 1) return fail("Appearance body must be 0 or 1.");
  const kits = asArray(value.kits);
  const colors = asArray(value.colors);
  const kitLimits = limits.kits[body];
  if (!kits || kits.length !== kitLimits.length) return fail("Appearance must have 7 kit choices.");
  if (!colors || colors.length !== limits.colors.length) return fail("Appearance must have 5 colours.");
  for (let i = 0; i < kits.length; i++) {
    const kit = kits[i];
    if (!isInt(kit) || kit < 0 || kit >= kitLimits[i]!) return fail("That look isn't available.");
  }
  for (let i = 0; i < colors.length; i++) {
    const color = colors[i];
    if (!isInt(color) || color < 0 || color >= limits.colors[i]!) return fail("That colour isn't available.");
  }
  return ok({
    body,
    kits: kits as Appearance["kits"],
    colors: colors as Appearance["colors"],
  });
}

function validatePath(value: unknown): Validation<Tile[]> {
  if (!Array.isArray(value) || value.length === 0) return fail("The path is empty.");
  if (value.length > MAX_PATH_STEPS) return fail(`A path may have at most ${MAX_PATH_STEPS} tiles.`);
  const path: Tile[] = [];
  for (const raw of value) {
    const tile = validateTile(raw);
    if (!tile.ok) return tile;
    path.push(tile.value);
  }
  return ok(path);
}

/** Validates the body of `POST /api/act`. Unknown fields are ignored. */
export function validateActRequest(value: unknown): Validation<ActRequest> {
  if (!isRecord(value)) return fail("The request body must be a JSON object.");
  switch (value.type) {
    case "appearance": {
      const appearance = validateAppearance(value.appearance);
      if (!appearance.ok) return appearance;
      return ok({ type: "appearance", appearance: appearance.value });
    }
    case "join": {
      const appearance = validateAppearance(value.appearance);
      if (!appearance.ok) return appearance;
      // Absent `world` is a build from before worlds; the handler answers it, so it is not a 400 here.
      if (value.world === undefined) return ok({ type: "join", appearance: appearance.value });
      if (value.world !== "auto" && !isWorldId(value.world)) return fail("world must be a world number or \"auto\".");
      if (value.hop !== undefined && typeof value.hop !== "boolean") return fail("hop must be true or false.");
      if (value.hop === true && value.world === "auto") return fail("Pick a world to hop to.");
      return ok({ type: "join", appearance: appearance.value, world: value.world, ...(value.hop === true ? { hop: true } : {}) });
    }
    case "move": {
      const path = validatePath(value.path);
      if (!path.ok) return path;
      if (typeof value.run !== "boolean") return fail("run must be true or false.");
      return ok({ type: "move", path: path.value, run: value.run });
    }
    case "chat": {
      if (typeof value.text !== "string") return fail("Chat text is missing.");
      if (value.text.length > CHAT_INPUT_MAX_LENGTH) return fail("That message is too long.");
      return ok({ type: "chat", text: value.text });
    }
    case "emote":
      if (!isEmote(value.emote)) return fail("Unknown emote.");
      return ok({ type: "emote", emote: value.emote });
    case "heartbeat":
      return ok({ type: "heartbeat" });
    case "leave":
      return ok({ type: "leave" });
    case "stall": {
      if (value.depositId === null) return ok({ type: "stall", depositId: null });
      const parsed = parseDepositId(value.depositId);
      if (!parsed) return fail("depositId must be a deposit number or null.");
      return ok({ type: "stall", depositId: value.depositId as string });
    }
    case "announce": {
      if (value.kind !== "bought" && value.kind !== "listed") return fail("kind must be bought or listed.");
      if (!isTxHash(value.tx)) return fail("tx must be a transaction hash.");
      return ok({ type: "announce", kind: value.kind, tx: value.tx.toLowerCase() });
    }
    default:
      return fail("Unknown action.");
  }
}

/** Validates the body of `POST /api/session`. */
export function validateSessionRequest(value: unknown): Validation<SessionRequest> {
  if (value === null || value === undefined) return ok({});
  if (!isRecord(value)) return fail("The request body must be a JSON object.");
  const out: SessionRequest = {};
  if (value.token !== undefined && value.token !== null) {
    if (typeof value.token !== "string" || value.token.length > 2_000) return fail("token must be a string.");
    out.token = value.token;
  }
  if (value.name !== undefined && value.name !== null) {
    if (typeof value.name !== "string" || value.name.length > NAME_MAX_LENGTH * 4) {
      return fail("name must be a short string.");
    }
    out.name = value.name;
  }
  if (value.check !== undefined && value.check !== null) {
    if (typeof value.check !== "boolean") return fail("check must be true or false.");
    if (value.check) {
      if (out.name === undefined) return fail("Enter a name to check.");
      out.check = true;
    }
  }
  return ok(out);
}

/** Validates the body of `POST /api/wallet`. */
export function validateWalletProofRequest(value: unknown): Validation<WalletProofRequest> {
  if (!isRecord(value)) return fail("The request body must be a JSON object.");
  const { token, address, message, signature } = value;
  if (typeof token !== "string" || token.length > 2_000) return fail("token is missing.");
  if (!isAddress(address)) return fail("address must be a wallet address.");
  if (typeof message !== "string" || message.length === 0 || message.length > MESSAGE_MAX_LENGTH) {
    return fail("message is missing.");
  }
  if (!isHexSignature(signature)) return fail("signature must be a hex signature.");
  return ok({ token, address, message, signature });
}

// ---------------------------------------------------------------------------
// Records read back from the realtime database. The API is the only writer,
// so these are defensive: a malformed record is dropped, not rendered.

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseStallSummary(value: unknown): StallSummary | null {
  if (!isRecord(value)) return null;
  const { depositId, escrow, platform, currency, available, rate } = value;
  if (
    typeof depositId !== "string" ||
    typeof escrow !== "string" ||
    typeof platform !== "string" ||
    typeof currency !== "string" ||
    typeof available !== "string" ||
    typeof rate !== "string"
  ) {
    return null;
  }
  return { depositId, escrow, platform, currency, available, rate };
}

export function parsePlayerRecord(value: unknown): PlayerRecord | null {
  if (!isRecord(value)) return null;
  const { n, p, t, r, ls, j } = value;
  if (typeof n !== "string" || typeof p !== "string" || !isFiniteNumber(t) || !isFiniteNumber(ls)) return null;
  const appearance = validateAppearance(value.a);
  if (!appearance.ok) return null;
  return {
    n,
    a: appearance.value,
    p,
    t,
    r: r === true,
    e: isEmote(value.e) ? value.e : null,
    et: isFiniteNumber(value.et) ? value.et : null,
    w: optionalString(value.w),
    s: parseStallSummary(value.s),
    ls,
    j: isFiniteNumber(j) ? j : t,
  };
}

export function parseChatRecord(value: unknown): ChatRecord | null {
  if (!isRecord(value)) return null;
  const { pid, n, m, t } = value;
  if (typeof pid !== "string" || typeof n !== "string" || typeof m !== "string" || !isFiniteNumber(t)) return null;
  return { pid, n, m, fx: optionalString(value.fx), t };
}

export function parseWorldEventRecord(value: unknown): WorldEventRecord | null {
  if (!isRecord(value)) return null;
  const { kind, n, usdc, platform, tx, t } = value;
  if (kind !== "bought" && kind !== "listed" && kind !== "sold") return null;
  if (typeof n !== "string" || typeof usdc !== "string" || typeof platform !== "string") return null;
  if (typeof tx !== "string" || !isFiniteNumber(t)) return null;
  return {
    kind,
    pid: optionalString(value.pid),
    n,
    usdc,
    fiat: optionalString(value.fiat),
    currency: optionalString(value.currency),
    platform,
    tx,
    t,
  };
}
