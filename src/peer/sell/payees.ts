/**
 * Local payee handling for the sell flow: display metadata, normalisation into
 * the curator's `offchainId`, and a format pre-check that catches obvious
 * typos before the live curator check. The curator remains the authority;
 * these rules only reject input it could never accept.
 */

import { normalizeCashPayee } from "@zkp2p/cash";

export interface PayeeField {
  /** Field label, e.g. "Revtag". */
  label: string;
  placeholder: string;
}

interface PlatformMeta {
  name: string;
  field: string;
  placeholder: string;
}

const PLATFORM_META: Record<string, PlatformMeta> = {
  alipay: { name: "Alipay", field: "Alipay email", placeholder: "you@example.com" },
  cashapp: { name: "Cash App", field: "Cashtag", placeholder: "$cashtag" },
  chime: { name: "Chime", field: "ChimeSign", placeholder: "$chimesign" },
  luxon: { name: "Luxon", field: "Luxon Pay ID or email", placeholder: "pay ID" },
  mercadopago: { name: "Mercado Pago", field: "Alias or CVU", placeholder: "alias" },
  monzo: { name: "Monzo", field: "Monzo.me username", placeholder: "username" },
  n26: { name: "N26", field: "MoneyBeam email or phone", placeholder: "you@example.com" },
  paypal: { name: "PayPal", field: "PayPal.Me username or email", placeholder: "paypal.me/username" },
  revolut: { name: "Revolut", field: "Revtag", placeholder: "revtag" },
  upi: { name: "UPI", field: "UPI ID", placeholder: "name@bank" },
  venmo: { name: "Venmo", field: "Venmo username", placeholder: "@username" },
  wise: { name: "Wise", field: "Wisetag or Wise email", placeholder: "wisetag" },
  xmoney: { name: "X Money", field: "X username", placeholder: "@username" },
  zelle: { name: "Zelle", field: "Zelle email or US phone", placeholder: "you@example.com" },
};

function metaFor(platform: string): PlatformMeta | null {
  return Object.hasOwn(PLATFORM_META, platform) ? (PLATFORM_META[platform] ?? null) : null;
}

/** Display name for a platform id, e.g. "cashapp" -> "Cash App". */
export function platformName(platform: string): string {
  const meta = metaFor(platform);
  if (meta) return meta.name;
  return platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : "";
}

export function payeeField(platform: string): PayeeField {
  const meta = metaFor(platform);
  return meta ? { label: meta.field, placeholder: meta.placeholder } : { label: "Payment handle", placeholder: "" };
}

export type PayeeFormat = { ok: true; offchainId: string } | { ok: false; message: string };

const MAX_PAYEE_LENGTH = 128;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const US_PHONE_CHARS = /^[\d\s().+-]+$/;

function isUsPhone(value: string): boolean {
  if (!US_PHONE_CHARS.test(value)) return false;
  return /^1?\d{10}$/.test(value.replace(/\D/g, ""));
}

function stripLink(value: string, host: RegExp): string {
  const withoutProtocol = value.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const match = host.exec(withoutProtocol);
  if (!match) return value;
  const [path = ""] = withoutProtocol.slice(match[0].length).split(/[?#]/, 1);
  return path.replace(/^\/+/, "").split("/", 1)[0] ?? "";
}

interface Rule {
  test: (offchainId: string) => boolean;
  message: string;
}

const RULES: Record<string, Rule> = {
  alipay: { test: (v) => EMAIL.test(v), message: "Enter the email address linked to your Alipay account." },
  cashapp: { test: (v) => /^[A-Za-z0-9]{1,20}$/.test(v), message: "A cashtag is letters and numbers only." },
  chime: { test: (v) => /^\$[a-z0-9]+$/.test(v), message: "A ChimeSign is $ followed by letters or numbers." },
  monzo: { test: (v) => /^[A-Za-z0-9_.-]+$/.test(v), message: "Use your monzo.me username." },
  paypal: {
    test: (v) => EMAIL.test(v) || /^[a-z0-9._-]+$/i.test(v),
    message: "Use your PayPal.Me username, PayPal.Me link or PayPal email.",
  },
  revolut: {
    test: (v) => /^[A-Za-z0-9]+$/.test(v),
    message: "Use your Revtag. This payout rail only accepts Revtags with letters and numbers.",
  },
  upi: {
    test: (v) => /^[a-z0-9][a-z0-9._-]{0,126}@[a-z][a-z0-9.-]{1,63}$/.test(v),
    message: "Enter a UPI ID like name@bank.",
  },
  venmo: { test: (v) => /^[A-Za-z0-9_-]{1,30}$/.test(v), message: "A Venmo username is letters, numbers, - or _." },
  wise: {
    test: (v) => EMAIL.test(v) || /^[A-Za-z0-9_.-]+$/.test(v),
    message: "Use your Wisetag or the email on your Wise account.",
  },
  xmoney: { test: (v) => /^[a-z0-9_]{1,15}$/.test(v), message: "Use your X username, with or without @." },
  zelle: {
    test: (v) => EMAIL.test(v) || isUsPhone(v),
    message: "Use the email or US phone number enrolled with Zelle.",
  },
};

function preNormalize(platform: string, raw: string): string {
  switch (platform) {
    case "revolut":
      return stripLink(raw, /^revolut\.me(?=\/|$)/i).replace(/^@+/, "").trim();
    case "monzo":
      return stripLink(raw, /^monzo\.me(?=\/|$)/i).replace(/^@+/, "").trim();
    case "chime": {
      const lower = raw.toLowerCase();
      return lower.startsWith("$") ? lower : `$${lower}`;
    }
    case "wise":
      // Wisetags are registered without the "@" Wise shows in-app (usdctofiat parity).
      // Emails stay exactly as typed: the curator hashes the exact offchainId of an existing registration.
      return EMAIL.test(raw) ? raw : raw.replace(/^@+/, "").trim();
    case "zelle": {
      // Phone numbers become 10 digits so the buyer sees one canonical number.
      const lower = raw.toLowerCase();
      if (EMAIL.test(lower) || !isUsPhone(lower)) return lower;
      const digits = lower.replace(/\D/g, "");
      return digits.length === 11 ? digits.slice(1) : digits;
    }
    default:
      return normalizeCashPayee(platform, raw).offchainId;
  }
}

/** Normalises a typed handle into the curator `offchainId`, or explains why it can never be accepted. */
export function normalizePayee(platform: string, raw: string): PayeeFormat {
  const { label } = payeeField(platform);
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: `Enter your ${label}.` };
  const offchainId = preNormalize(platform, trimmed);
  if (!offchainId || offchainId === "$") return { ok: false, message: `Enter your ${label}.` };
  if (offchainId.length > MAX_PAYEE_LENGTH || /\s/.test(offchainId)) {
    return { ok: false, message: `That ${label} doesn't look right.` };
  }
  const rule = Object.hasOwn(RULES, platform) ? RULES[platform] : undefined;
  if (rule && !rule.test(offchainId)) return { ok: false, message: rule.message };
  return { ok: true, offchainId };
}

/** How a handle reads back to the player, e.g. "$cashtag", "@venmo-user". */
export function displayPayee(platform: string, offchainId: string): string {
  switch (platform) {
    case "cashapp":
      return `$${offchainId}`;
    case "venmo":
    case "xmoney":
    case "revolut":
      return `@${offchainId}`;
    default:
      return offchainId;
  }
}
