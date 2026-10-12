/**
 * Share links for verified trades and the site itself, shared by the share
 * functions (api/share.ts, api/og.ts), the announce handler that writes the
 * records and the in-game Share buttons. Dependency-free, like protocol.ts.
 *
 * A share record (`shares/{id}` in the realtime database) is a small,
 * durable copy of one verified world event, written when the announcement
 * is accepted. It never holds a wallet address. Its id is derived from the
 * event's kind, transaction and player, so the browser that completed the
 * trade can rebuild the link at any time (after a reload too) and only has
 * to ask whether the record exists.
 */

import { isWorldId, parseWorldId, WORLD_PARAM } from "./worlds.js";

export const SITE_ORIGIN = "https://www.rampridge.xyz";
export const SITE_URL = `${SITE_ORIGIN}/`;
export const SITE_NAME = "RampRidge";

/** `/?from=share`: where a trade link sends people into the game. */
export const FROM_PARAM = "from";
export const FROM_SHARE = "share";
export const ARRIVAL_PATH = `/?${FROM_PARAM}=${FROM_SHARE}`;

/** The site's link, asking for `world` when given: an invite brings friends to the inviter's world. */
export function siteUrlFor(world?: number | null): string {
  return isWorldId(world) ? `${SITE_URL}?${WORLD_PARAM}=${world}` : SITE_URL;
}

/** Where a trade link lands: the arrival path, asking for the world the trade was announced in when it is known. */
export function arrivalPath(world?: number | null): string {
  return isWorldId(world) ? `${ARRIVAL_PATH}&${WORLD_PARAM}=${world}` : ARRIVAL_PATH;
}

export type ShareKind = "bought" | "listed";

/** `shares/{id}`: one verified trade, as it is shown on its card. */
export interface ShareRecord {
  kind: ShareKind;
  /** Display name at the time of the trade. */
  name: string;
  /** USDC, decimal string ("130.47"). */
  usdc: string;
  /** Fiat paid, decimal string in `currency` (purchases only). */
  fiat: string | null;
  /** Upper-case fiat code. */
  currency: string | null;
  /** Payment platform id ("revolut"). */
  platform: string;
  /** Transaction that proved it, lowercase. */
  tx: string;
  /** Server ms when it was announced. */
  t: number;
  /** The world it was announced in; a trade link asks for that world (shared/worlds.ts). */
  world?: number;
}

export const SHARE_ID_LENGTH = 10;
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_PATTERN = new RegExp(`^[0-9A-Za-z]{${SHARE_ID_LENGTH}}$`);

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/**
 * The share id for one player's announcement of one transaction: ten
 * base-62 characters (about 59 bits). Not a secret: records are public.
 */
export function shareIdFor(kind: ShareKind, tx: string, pid: string): string {
  const base = BigInt(ID_ALPHABET.length);
  let n = fnv1a64(`rampridge-share:${kind}:${tx.toLowerCase()}:${pid}`);
  let out = "";
  for (let i = 0; i < SHARE_ID_LENGTH; i++) {
    out = ID_ALPHABET[Number(n % base)]! + out;
    n /= base;
  }
  return out;
}

export function isShareId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function sharePath(id: string): string {
  return `shares/${id}`;
}

/** The link people post: https://www.rampridge.xyz/t/{id}. */
export function shareUrl(id: string): string {
  return `${SITE_ORIGIN}/t/${encodeURIComponent(id)}`;
}

/** The trade's 1200x630 card. */
export function shareImageUrl(id: string): string {
  return `${SITE_ORIGIN}/api/og?id=${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------
// Shaping and validation. Names are player content: everything is checked
// on the way in and on the way out, and escaped wherever it is rendered.

const NAME_MAX = 12;
const DECIMAL = /^\d{1,15}(\.\d{1,18})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const PLATFORM = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TX = /^0x[0-9a-f]{64}$/;

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Display names are letters, digits, space, hyphen and underscore; anything else never reaches a card.
  const name = value.replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX).trim();
  return name || null;
}

function cleanDecimal(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}

/**
 * A share record from a verified world event, or from a stored record read
 * back from the database (which drops null fields). Null when anything is
 * missing or malformed.
 */
export function toShareRecord(raw: unknown): ShareRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === "bought" || r.kind === "listed" ? r.kind : null;
  const name = cleanName(r.name ?? r.n);
  const usdc = cleanDecimal(r.usdc);
  const platform = typeof r.platform === "string" && PLATFORM.test(r.platform.toLowerCase()) ? r.platform.toLowerCase() : null;
  const tx = typeof r.tx === "string" && TX.test(r.tx.toLowerCase()) ? r.tx.toLowerCase() : null;
  const t = typeof r.t === "number" && Number.isFinite(r.t) && r.t > 0 ? Math.floor(r.t) : null;
  if (!kind || !name || !usdc || !platform || !tx || t === null) return null;
  const currency = typeof r.currency === "string" && CURRENCY.test(r.currency.toUpperCase()) ? r.currency.toUpperCase() : null;
  const fiat = kind === "bought" && currency ? cleanDecimal(r.fiat) : null;
  const world = parseWorldId(r.world);
  return { kind, name, usdc, fiat, currency, platform, tx, t, ...(world !== null ? { world } : {}) };
}

/** The record as stored: null fields are left out, as the database would drop them anyway. */
export function storedShareRecord(record: ShareRecord): Record<string, string | number> {
  const out: Record<string, string | number> = {
    kind: record.kind,
    name: record.name,
    usdc: record.usdc,
    platform: record.platform,
    tx: record.tx,
    t: record.t,
  };
  if (record.fiat !== null) out.fiat = record.fiat;
  if (record.currency !== null) out.currency = record.currency;
  if (record.world !== undefined) out.world = record.world;
  return out;
}

// ---------------------------------------------------------------------------
// Wording. Amounts read like the chatbox news lines: grouped, two decimals,
// truncated rather than rounded so a card never shows more than was traded.

const PLATFORM_NAMES: Record<string, string> = {
  venmo: "Venmo",
  revolut: "Revolut",
  wise: "Wise",
  cashapp: "Cash App",
  zelle: "Zelle",
  paypal: "PayPal",
  monzo: "Monzo",
  mercadopago: "Mercado Pago",
  chime: "Chime",
  n26: "N26",
  alipay: "Alipay",
  luxon: "Luxon",
  monobank: "Monobank",
  xmoney: "X Money",
  peer: "Peer",
};

export function platformLabel(platform: string): string {
  const known = PLATFORM_NAMES[platform.toLowerCase()];
  if (known) return known;
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

/** "1,240.50": grouped, exactly two decimals, truncated. */
export function formatAmount(decimal: string): string {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(decimal.trim());
  if (!m) return "0.00";
  const whole = (m[1] ?? "").replace(/^0+(?=\d)/, "") || "0";
  const fraction = (m[2] ?? "").padEnd(2, "0").slice(0, 2);
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

/** USDC base units (6 decimals) as a plain decimal string: 130470000n -> "130.47". */
export function usdcFromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

/** Symbols the RuneScape fonts draw; other currencies read "100.00 CHF". */
const SYMBOLS: Record<string, string> = { USD: "$", GBP: "£", EUR: "€" };

export function formatFiat(decimal: string, currency: string): string {
  const symbol = SYMBOLS[currency];
  return symbol ? `${symbol}${formatAmount(decimal)}` : `${formatAmount(decimal)} ${currency}`;
}

/** "Zezima bought 130.47 USDC" / "Zezima is selling 250.00 USDC". */
export function shareHeadline(record: ShareRecord): string {
  const usdc = `${formatAmount(record.usdc)} USDC`;
  return record.kind === "bought" ? `${record.name} bought ${usdc}` : `${record.name} is selling ${usdc}`;
}

/** The rest of the trade: "for £100.00 on Revolut" / "for GBP on Revolut". */
export function shareDetail(record: ShareRecord): string {
  const on = `on ${platformLabel(record.platform)}`;
  if (record.kind === "bought" && record.fiat && record.currency) return `for ${formatFiat(record.fiat, record.currency)} ${on}`;
  if (record.currency) return `for ${record.currency} ${on}`;
  return on;
}

/** The news line: "Zezima bought 130.47 USDC for £100.00 on Revolut." */
export function shareSentence(record: ShareRecord): string {
  return `${shareHeadline(record)} ${shareDetail(record)}.`;
}

/** Page and card title: "Zezima bought 130.47 USDC at the Bank of RampRidge". */
export function shareTitle(record: ShareRecord): string {
  return `${shareHeadline(record)} at the Bank of RampRidge`;
}

export function shareDescription(record: ShareRecord): string {
  if (record.kind === "bought") {
    return `${shareSentence(record)} Paid player to player and settled on Base by Peer. Walk into Varrock West Bank and trade USDC yourself.`;
  }
  return `${shareSentence(record)} Buy it, or sell your own, with real players in Varrock West Bank. Settled on Base by Peer.`;
}

export const SITE_TITLE = "RampRidge: the Varrock bank, but it trades real USDC";
export const SITE_DESCRIPTION =
  "Walk into Varrock West Bank and buy or sell USDC for Revolut, Venmo, Wise and more with real players. Every trade settles on Base through Peer.";
export const SITE_IMAGE = `${SITE_ORIGIN}/og.png`;
export const SITE_IMAGE_ALT =
  "Varrock West Bank from Old School RuneScape, full of players and merchants shouting USDC offers, under the RampRidge logo.";

export function shareImageAlt(record: ShareRecord): string {
  return `${shareSentence(record)} Shown over Varrock West Bank with the RampRidge logo.`;
}

// ---------------------------------------------------------------------------
// Posting.

/** What a Share button posts about. */
export type ShareSubject =
  | { kind: "invite"; world?: number | null }
  | { kind: "bought"; usdc: string; platform: string }
  | { kind: "listed"; usdc: string; platform: string; currency: string | null };

/** The post, in the player's voice. The link is added by the intent. */
export function sharePostText(subject: ShareSubject): string {
  switch (subject.kind) {
    case "invite":
      return isWorldId(subject.world)
        ? `Meet me in Varrock West Bank on World ${subject.world}. It trades real USDC now:`
        : "Meet me in Varrock West Bank. It trades real USDC now:";
    case "bought":
      return `Just bought ${formatAmount(subject.usdc)} USDC in Varrock West Bank with ${platformLabel(subject.platform)}. The bank is open:`;
    case "listed":
      return `Selling ${formatAmount(subject.usdc)} USDC${subject.currency ? ` for ${subject.currency}` : ""} on ${platformLabel(subject.platform)} in Varrock West Bank. Come and trade:`;
  }
}

/** X's compose intent with the text and link filled in. */
export function xIntentUrl(text: string, url: string): string {
  const params = new URLSearchParams({ text, url });
  return `https://x.com/intent/post?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// HTML.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/** Escapes text for HTML content and double- or single-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]!);
}
