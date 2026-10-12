/**
 * What the buyer must do off-platform for a signalled order: the exact
 * amount, who to pay, the link or QR to pay with and the platform's rules.
 */

import { formatFiat } from "../format";
import {
  BUY_PLATFORMS,
  FIAT_CURRENCIES,
  needsRecipientId,
  resolveVerifyMethod,
  type BuyPlatformId,
  type FiatCode,
  type PaymentRule,
  type VerifyMethod,
} from "../platforms";
import type { BuyOrder } from "./types";

/**
 * Neutral single-emoji notes, a subset of the memo bank Peer uses for direct
 * payments. Venmo needs a note; words like "crypto" or "Peer" get payments
 * flagged, so the note is never text.
 */
const MEMOS = ["🍕", "🌮", "🍔", "☕", "🍩", "🍿", "🍜", "🍣", "🥗", "🍦", "🎂", "🎉", "🎁", "🏠", "🎮", "🌯"] as const;

/** A note for platforms that need one (null for the rest). Chosen once per order and persisted. */
export function pickMemo(platform: BuyPlatformId, random: () => number = Math.random): string | null {
  if (!BUY_PLATFORMS[platform].usesMemo) return null;
  return MEMOS[Math.floor(random() * MEMOS.length) % MEMOS.length] ?? MEMOS[0];
}

/**
 * Revolut Business profiles have no working revolut.me page, so Peer drops
 * the QR and link for them and has the buyer find the Revtag in the app.
 */
const REVOLUT_BUSINESS_STEPS: readonly PaymentRule[] = [
  { kind: "do", text: "In the Revolut app, go to Payments and paste the Revtag into the search bar at the top." },
  { kind: "do", text: "If no match shows, tap the eye icon to find them." },
  { kind: "dont", text: "Don't look for a revolut.me link. This seller is a business account and has none." },
];

function isRevolutBusiness(order: BuyOrder): boolean {
  return order.platform === "revolut" && order.payeeBusiness === true;
}

/**
 * A plain decimal ("16587.68") in a platform's own number format, string based
 * so it stays exact: es-AR "16.587,68", uk-UA "16 587,68" grouped, or
 * ungrouped for pasting ("16587,68"). Mirrors Peer's intentHelper, which
 * formats the send amount with the platform's locale. Unchanged without one.
 */
export function localizeAmount(plain: string, locale: string | undefined, group: boolean): string {
  if (!locale) return plain;
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const groupSep = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimalSep = parts.find((p) => p.type === "decimal")?.value ?? ".";
  const [whole = "", fraction] = plain.split(".");
  const grouped = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, groupSep) : whole;
  return fraction ? `${grouped}${decimalSep}${fraction}` : grouped;
}

export interface PaymentInstructions {
  platform: BuyPlatformId;
  platformName: string;
  currency: FiatCode;
  /** Exact amount to type, ungrouped, in the platform's decimal format ("101.50"; "44,98" on Monobank). */
  amount: string;
  /** Exact amount for display ("£101.50"). */
  amountText: string;
  /** Raw payee handle to copy. Null only if Curator could not return it (show a retry). */
  payee: string | null;
  /** Payee as the platform shows it ("@revtag", "$cashtag"). */
  payeeDisplay: string | null;
  /** What the payee is, e.g. "Revtag". */
  payeeLabel: string;
  deepLink: string | null;
  webLink: string | null;
  qrValue: string | null;
  /** Note to add to the payment, when the platform needs one. */
  memo: string | null;
  /** One-line platform warning to show prominently. */
  warning: string | null;
  rules: PaymentRule[];
  /** The verify method these instructions are for (Zelle bank, PayPal account type). */
  method: VerifyMethod | null;
  /** True when the buyer must choose a method (Zelle bank) before paying. */
  needsMethodChoice: boolean;
  expiresAt: number;
}

export function getPaymentInstructions(order: BuyOrder): PaymentInstructions {
  const platform = BUY_PLATFORMS[order.platform];
  const method = resolveVerifyMethod(order.platform, order.verifyMethodId);
  const locale = platform.amountLocale;
  const ctx = {
    payee: order.payeeHandle ?? "",
    // Localized platforms (Mercado Pago, Monobank) use this only in rule text: their links carry no amount.
    // Alipay's link does, and strips the zh-CN grouping back out.
    amount: localizeAmount(order.fiatToSendText, locale, true),
    currency: order.currency,
    memo: order.memo,
    // Only platforms whose link needs it (Alipay's PID); every other platform gets null.
    recipientId: needsRecipientId(order.platform) ? (order.recipientId ?? null) : null,
  };
  const business = isRevolutBusiness(order);
  const links = order.payeeHandle && !business
    ? platform.sendLinks(ctx, method)
    : { deepLink: null, webLink: null, qrValue: null };
  return {
    platform: order.platform,
    platformName: platform.name,
    currency: order.currency,
    amount: localizeAmount(order.fiatToSendText, locale, false),
    amountText: locale ? `${FIAT_CURRENCIES[order.currency].symbol}${ctx.amount}` : formatFiat(order.fiatToSend, order.currency),
    payee: order.payeeHandle,
    payeeDisplay: order.payeeHandle ? platform.formatPayee(order.payeeHandle) : null,
    payeeLabel: platform.payeeLabel,
    deepLink: links.deepLink,
    webLink: links.webLink,
    qrValue: links.qrValue,
    memo: order.memo,
    warning: platform.warning(ctx, method),
    rules: business ? [...REVOLUT_BUSINESS_STEPS, ...platform.rules(ctx, method)] : platform.rules(ctx, method),
    method,
    needsMethodChoice: platform.methodChoice === "beforePayment" && method === null,
    expiresAt: order.expiresAt,
  };
}
