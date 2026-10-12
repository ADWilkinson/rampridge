/**
 * Pure view-model helpers for the buy interfaces (Exchange, Trade, Payment,
 * Verify): offer slot assembly, rate comparison, amount rules, payment row
 * hints and error recovery choices. No React, no DOM, no network; the one
 * browser check (verifyNeedsComputer) takes the user agent and extension as
 * arguments for tests.
 */

import type { ProgressState } from "@/ui/kit/ProgressBar";
import type { PaymentInstructions } from "@/peer/buy/instructions";
import type { BuyError, BuyErrorCode, BuyOrder, BuyStep } from "@/peer/buy/types";
import { canInstallPeerExtension, extensionBrowser, peerExtension, type ExtensionStatus, type PaymentRow } from "@/peer/extension";
import { FIAT_DECIMALS, RATE_DECIMALS, fiatDisplayDecimals, formatDecimal, formatFiat, rateFromAmounts, tryParseAmount } from "@/peer/format";
import type { BuyQuote, PlatformPrice } from "@/peer/market";
import { BUY_PLATFORMS, needsRecipientId, platformsForCurrency, type BuyPlatform, type BuyPlatformId, type FiatCode } from "@/peer/platforms";

// ---------------------------------------------------------------------------
// Offer slots

export const SLOT_COUNT = 8;

export type BuySlotStatus = "awaitingPayment" | "verifying" | "releasing" | "completed" | "cancelled" | "expired";

export interface BuySlotView {
  status: BuySlotStatus;
  /** 0..1 for the GE bar. */
  progress: number;
  bar: ProgressState;
  /** Short status under the bar, e.g. "Pay the seller". */
  label: string;
  /** Draw the label in red: something needs the player's attention. */
  alert?: boolean;
}

const BUY_SLOT_VIEW: Record<BuySlotStatus, BuySlotView> = {
  awaitingPayment: { status: "awaitingPayment", progress: 0.2, bar: "progress", label: "Pay the seller" },
  verifying: { status: "verifying", progress: 0.55, bar: "progress", label: "Verifying payment" },
  releasing: { status: "releasing", progress: 0.85, bar: "progress", label: "Releasing USDC" },
  completed: { status: "completed", progress: 1, bar: "complete", label: "Completed" },
  cancelled: { status: "cancelled", progress: 1, bar: "aborted", label: "Cancelled" },
  expired: { status: "expired", progress: 1, bar: "aborted", label: "Expired" },
};

const VERIFY_FAILED: BuySlotView = { status: "verifying", progress: 0.55, bar: "progress", label: "Verification failed", alert: true };
/** The player said they paid (persisted on the order) but isn't verifying right now, e.g. after a reload. */
const PAID_CLAIMED: BuySlotView = { status: "verifying", progress: 0.4, bar: "progress", label: "Verify payment" };

/**
 * Where the buy order stands for its Exchange slot, or null when there is no
 * order to show. Expiry is checked first for live orders because the
 * contract still accepts proofs for expired, unpruned intents: the slot must
 * say "Expired" so nobody pays it. `verificationFailed` (see
 * isVerificationError) marks an error raised while proving a payment, and an
 * order's persisted paid claim survives a reload, so a player who has paid is
 * sent to Verify, never back to "Pay the seller".
 */
export function buySlotView(step: BuyStep, order: BuyOrder | null, now: number, verificationFailed = false): BuySlotView | null {
  if (!order) return null;
  if (order.status === "fulfilled" || step === "completed") return BUY_SLOT_VIEW.completed;
  if (order.status === "cancelled" || step === "cancelled") return BUY_SLOT_VIEW.cancelled;
  if (step === "fulfilling") return BUY_SLOT_VIEW.releasing;
  if (now >= order.expiresAt) return BUY_SLOT_VIEW.expired;
  if (step === "verifying" || step === "selectPayment") return BUY_SLOT_VIEW.verifying;
  if (step === "error" && verificationFailed) return VERIFY_FAILED;
  if (paidClaimed(order)) return PAID_CLAIMED;
  return BUY_SLOT_VIEW.awaitingPayment;
}

/**
 * True when the player said they paid this order (persisted on it, so it
 * survives a reload). Strict on the type: an order stored before the claim
 * was recorded has no field at all and counts as unpaid.
 */
export function paidClaimed(order: Pick<BuyOrder, "paidClaimedAt">): boolean {
  return typeof order.paidClaimedAt === "number";
}

/** Steps after the player has said they paid: proving the payment and releasing the USDC. */
const VERIFY_STEPS: ReadonlySet<BuyStep> = new Set(["verifying", "selectPayment", "fulfilling"]);

/** Error codes only capturing, checking or releasing a payment can raise. */
const VERIFY_ERROR_CODES: ReadonlySet<BuyErrorCode> = new Set([
  "capture_failed",
  "no_payments",
  "payment_session_expired",
  "extension_unavailable",
  "payee_mismatch",
  "nullifier_used",
  "payment_verification_failed",
  "payment_not_settled",
]);

/**
 * True when the buy flow's error was raised while proving a payment, so the
 * player has said they paid and must be led back to Verify, not to the
 * payment instructions. `origin` is the step the flow was in when the error
 * arrived (see errorOrigin); without it the return step and code decide,
 * which covers every verify-only error but not a generic one (network, a
 * failed transaction) from a release whose payment list has timed out.
 */
export function isVerificationError(
  state: { step: BuyStep; error: Pick<BuyError, "code"> | null; errorReturnStep: BuyStep | null },
  origin: BuyStep | null,
): boolean {
  if (state.step !== "error" || !state.error) return false;
  if (origin !== null && VERIFY_STEPS.has(origin)) return true;
  if (state.errorReturnStep !== null && VERIFY_STEPS.has(state.errorReturnStep)) return true;
  return VERIFY_ERROR_CODES.has(state.error.code);
}

/** Where clicking the buy slot leads. */
export function buySlotTarget(status: BuySlotStatus): "payment" | "verify" | "collect" {
  switch (status) {
    case "verifying":
    case "releasing":
      return "verify";
    case "completed":
    case "cancelled":
      return "collect";
    default:
      return "payment";
  }
}

/** Sell order states as @zkp2p/cash reports them. */
export type SellState = "awaiting-buyer" | "matched" | "delivering" | "delivered" | "returned";

export function sellSlotView(state: SellState, progress: number): { progress: number; bar: ProgressState; label: string } {
  switch (state) {
    case "awaiting-buyer":
      return { progress, bar: "progress", label: "Waiting for a buyer" };
    case "matched":
      return { progress, bar: "progress", label: "Buyer is paying" };
    case "delivering":
      return { progress, bar: "progress", label: "Partly sold" };
    case "delivered":
      return { progress: 1, bar: "complete", label: "Sold" };
    case "returned":
      return { progress: 1, bar: "aborted", label: "Returned" };
  }
}

export type SlotModel<B, S> =
  | { kind: "empty"; key: string }
  | { kind: "buy"; key: string; buy: B }
  | { kind: "sell"; key: string; sell: S }
  | { kind: "more"; key: string; count: number };

/**
 * Lays out the eight offer slots: the buy order first, then sell orders, with
 * at least one empty slot kept free so Buy and Sell stay reachable. When sell
 * orders overflow, the last sell slot becomes "N more in the bank".
 */
export function assembleSlots<B, S extends { depositId: string }>(buy: B | null, sells: readonly S[], total = SLOT_COUNT): SlotModel<B, S>[] {
  const slots: SlotModel<B, S>[] = [];
  if (buy) slots.push({ kind: "buy", key: "buy", buy });
  const capacity = Math.max(0, total - slots.length - 1);
  if (sells.length <= capacity) {
    for (const sell of sells) slots.push({ kind: "sell", key: `sell:${sell.depositId}`, sell });
  } else {
    const shown = Math.max(0, capacity - 1);
    for (const sell of sells.slice(0, shown)) slots.push({ kind: "sell", key: `sell:${sell.depositId}`, sell });
    slots.push({ kind: "more", key: "more", count: sells.length - shown });
  }
  while (slots.length < total) slots.push({ kind: "empty", key: `empty:${slots.length}` });
  return slots;
}

// ---------------------------------------------------------------------------
// Rates

export interface MarketBest {
  rate: bigint;
  platform: BuyPlatformId;
  quote: BuyQuote;
}

/** The cheapest available rate (fiat per USDC) across platforms, or null when none are available. */
export function bestMarketRate(prices: readonly PlatformPrice[] | null | undefined): MarketBest | null {
  let best: MarketBest | null = null;
  for (const p of prices ?? []) {
    if (!p.available || !p.quote) continue;
    if (!best || p.quote.rate < best.rate) best = { rate: p.quote.rate, platform: p.platform, quote: p.quote };
  }
  return best;
}

export interface RateComparison {
  /** True when `rate` is worse (more fiat per USDC) than `best` by more than the threshold. */
  warn: boolean;
  /** How much worse, as a percentage with one decimal ("2.3%"); "0.0%" when not worse. */
  percentText: string;
}

/**
 * Compares a buyer's rate with the best market rate. Rates are 18-decimal
 * fiat per USDC, so a higher rate is worse for the buyer. `thresholdBps`
 * defaults to 100 (1%); the warning needs strictly more than that.
 */
export function compareRate(rate: bigint, best: bigint, thresholdBps = 100n): RateComparison {
  if (best <= 0n || rate <= best) return { warn: false, percentText: "0.0%" };
  const diff = rate - best;
  const warn = diff * 10_000n > best * thresholdBps;
  // Tenths of a percent, rounded half up.
  const tenths = (diff * 2_000n + best) / (2n * best);
  return { warn, percentText: `${tenths / 10n}.${tenths % 10n}%` };
}

/** "0.7900 GBP per USDC" */
export function rateText(rate: bigint, currency: FiatCode): string {
  return `${formatDecimal(rate, RATE_DECIMALS, { minFraction: 4, maxFraction: 4, rounding: "half-up" })} ${currency} per USDC`;
}

/**
 * What the buyer actually pays per USDC received, fees included: the fiat
 * sent over the USDC that lands (net of Peer's and RampRidge's fees). A
 * listed rate of 1.0100 with 1.48 USDC of fees on $103.00 is 1.0249 here.
 * Null when there is nothing to divide by.
 */
export function effectiveRate(fiat: bigint, usdcNet: bigint): bigint | null {
  if (fiat <= 0n || usdcNet <= 0n) return null;
  return rateFromAmounts(fiat, usdcNet);
}

/** "After fees: 1.0249 USD per USDC", or null when there is nothing to show. */
export function afterFeesText(fiat: bigint, usdcNet: bigint, currency: FiatCode): string | null {
  const rate = effectiveRate(fiat, usdcNet);
  return rate === null ? null : `After fees: ${rateText(rate, currency)}`;
}

/**
 * True when no RampRidge fee was taken from this order: the seller's deposit
 * carries Galleon's TOFIAT referral code, so Curator's own leg already pays
 * RampRidge's wallet and the intent was signed without the 50 bps fee (or
 * the quote never priced it). An order rebuilt from the chain has no fees on
 * record (null) and says nothing.
 */
export function feeWaived(order: Pick<BuyOrder, "fees">): boolean {
  return order.fees !== null && order.fees.referrer === 0n;
}

/** How far above the cheapest method a method may price before the buyer is warned, in basis points. */
export const OVER_CHEAPEST_WARN_BPS = 300n;

export interface OverCheapest {
  /** "+15.0%" */
  percentText: string;
  /** The cheapest available method for the currency. */
  best: MarketBest;
}

/**
 * Whether `rate` sits more than 3% above the cheapest available method for
 * the currency at this amount (US buyers see Cash App about 15% above Zelle,
 * for one). Null when it doesn't, or when no method has a price.
 */
export function overCheapest(rate: bigint, prices: readonly PlatformPrice[] | null | undefined): OverCheapest | null {
  const best = bestMarketRate(prices);
  if (!best) return null;
  const comparison = compareRate(rate, best.rate, OVER_CHEAPEST_WARN_BPS);
  return comparison.warn ? { percentText: `+${comparison.percentText}`, best } : null;
}

/**
 * A currency's home method, which Peer lists first for it: Alipay for yuan,
 * UPI for rupees. Other currencies keep the catalogue order.
 */
const HOME_METHODS: Readonly<Partial<Record<string, string>>> = { CNY: "alipay", INR: "upi" };

/**
 * The methods for `currency` in Peer's order: its home method first, then the
 * rest as given. rankPlatforms keeps this order for methods that tie (no
 * offers, the same rate, or prices still loading).
 */
export function peerOrder<P extends { id: string }>(platforms: readonly P[], currency: string): P[] {
  const home = HOME_METHODS[currency];
  if (!home) return [...platforms];
  return [...platforms.filter((p) => p.id === home), ...platforms.filter((p) => p.id !== home)];
}

/**
 * What a method with no fillable offer says in the picker: the platform's
 * own reason when it has one (Venmo and PayPal sellers only take Peer Pay
 * merchants), otherwise "No sellers yet".
 */
export function noOffersText(platform: Pick<BuyPlatform, "noOffersNote">): string {
  return platform.noOffersNote ?? "No sellers yet";
}

export interface PlatformRow {
  platform: BuyPlatform;
  /** The price board's entry for this method, when it has one. */
  price: PlatformPrice | null;
  /** A seller can fill the amount on this method right now. */
  available: boolean;
  /** "+15.0%" when this method is more than 3% above the cheapest one; otherwise null. */
  overCheapest: string | null;
}

/**
 * The payment-method picker's rows: methods with offers first, cheapest rate
 * (least fiat per USDC) first, then methods nobody is selling on, in their
 * given order. While prices load (`prices` undefined) the given order stands.
 */
export function rankPlatforms(platforms: readonly BuyPlatform[], prices: readonly PlatformPrice[] | null | undefined): PlatformRow[] {
  const rows: PlatformRow[] = platforms.map((platform) => {
    const price = prices?.find((p) => p.platform === platform.id) ?? null;
    const available = Boolean(price?.available && price.quote);
    const over = available && price?.quote ? overCheapest(price.quote.rate, prices) : null;
    return { platform, price, available, overCheapest: over?.percentText ?? null };
  });
  if (!prices) return rows;
  const rate = (row: PlatformRow) => row.price?.quote?.rate ?? 0n;
  const withOffers = rows.filter((r) => r.available).sort((a, b) => (rate(a) < rate(b) ? -1 : rate(a) > rate(b) ? 1 : 0));
  return [...withOffers, ...rows.filter((r) => !r.available)];
}

// ---------------------------------------------------------------------------
// Amounts

/** Amount entry steps sized for the currency (the original +10/+100/+1K for most). */
export function amountSteps(currency: FiatCode): number[] {
  if (HUGE.has(currency)) return [10_000, 100_000, 1_000_000];
  if (LARGE.has(currency)) return [1_000, 10_000, 100_000];
  if (MEDIUM.has(currency)) return [100, 1_000, 10_000];
  return [10, 100, 1_000];
}

/** A sensible opening amount for the currency. */
export function defaultAmount(currency: FiatCode): number {
  const steps = amountSteps(currency);
  return steps[1] ?? 100;
}

/**
 * Where a trade window's amount starts. A merchant's shout quotes its offer
 * at a specific fiat amount (display units), so its trade opens there and
 * shows the advertised rate, clamped to the platform's limits and rounded to
 * the currency's decimals; otherwise the currency's default amount.
 */
export function openingTradeAmount(quotedFiat: number | undefined, currency: FiatCode, platform: BuyPlatform): number {
  if (quotedFiat === undefined || !Number.isFinite(quotedFiat) || quotedFiat <= 0) return defaultAmount(currency);
  const rules = amountRules(platform, currency, null);
  const scale = 10 ** rules.decimals;
  let amount = Math.max(rules.min, quotedFiat);
  if (rules.max !== undefined) amount = Math.min(rules.max, amount);
  // Round inward so a clamp to the minimum never rounds back below it.
  const rounded = Math.round(amount * scale) / scale;
  if (rounded < rules.min) return Math.ceil(amount * scale) / scale;
  if (rules.max !== undefined && rounded > rules.max) return Math.floor(amount * scale) / scale;
  return rounded;
}

const MEDIUM: ReadonlySet<FiatCode> = new Set(["CNY", "HKD", "MXN", "ZAR", "TRY", "SEK", "NOK", "DKK", "CZK", "THB", "UAH", "PHP", "AED", "SAR", "ILS", "PLN", "RON", "MYR"]);
const LARGE: ReadonlySet<FiatCode> = new Set(["JPY", "INR", "KES", "HUF", "ARS"]);
const HUGE: ReadonlySet<FiatCode> = new Set(["IDR", "VND", "UGX"]);

export interface FiatAmountRules {
  min: number;
  max?: number;
  decimals: number;
}

/**
 * Amount limits for a platform and currency: the platform minimum, and for a
 * platform with a per-order USDC cap (Venmo, 5,000 USDC) the fiat that cap
 * buys at the guide rate, or the cap itself in fiat units before a rate is
 * known.
 */
export function amountRules(platform: BuyPlatform | null, currency: FiatCode, guideRate: bigint | null): FiatAmountRules {
  const decimals = fiatDisplayDecimals(currency);
  const candidates = platform ? [platform] : platformsForCurrency(currency);
  const mins = candidates.map((p) => Number(p.minFiat)).filter((n) => Number.isFinite(n) && n > 0);
  const min = mins.length ? Math.min(...mins) : 0;
  const rules: FiatAmountRules = { min, decimals };
  if (platform?.maxUsdc) {
    const capUsdc = tryParseAmount(platform.maxUsdc, FIAT_DECIMALS) ?? 0n;
    const capFiat = guideRate && guideRate > 0n ? (capUsdc * guideRate) / 10n ** BigInt(RATE_DECIMALS) : capUsdc;
    const step = 10n ** BigInt(FIAT_DECIMALS - decimals);
    rules.max = Number(formatDecimal(capFiat - (capFiat % step), FIAT_DECIMALS, { group: false, maxFraction: decimals }));
  }
  return rules;
}

/** The pad's number as a plain decimal string Curator accepts ("100", "99.50"). */
export function fiatAmountText(value: number, currency: FiatCode): string {
  const decimals = fiatDisplayDecimals(currency);
  return (Number.isFinite(value) && value > 0 ? value : 0).toFixed(decimals);
}

/** The pad's number as 6-decimal fiat base units. */
export function fiatUnits(value: number, currency: FiatCode): bigint {
  return tryParseAmount(fiatAmountText(value, currency), FIAT_DECIMALS) ?? 0n;
}

/**
 * The currency picker's order: currencies with fillable offers right now
 * first, each group keeping its given order. `liquid` is null when the shell
 * doesn't know yet, and then every currency counts as liquid (today's list).
 */
export function orderByLiquidity<C extends string>(codes: readonly C[], liquid: ReadonlySet<string> | null): { code: C; liquid: boolean }[] {
  const rows = codes.map((code) => ({ code, liquid: liquid === null || liquid.has(code) }));
  return [...rows.filter((r) => r.liquid), ...rows.filter((r) => !r.liquid)];
}

/** "£100.00 (Revolut)", the fiat offer drawn as an item. */
export function fiatOfferLabel(fiat: bigint, currency: FiatCode, platform: BuyPlatformId): string {
  return `${formatFiat(fiat, currency)} (${BUY_PLATFORMS[platform].name})`;
}

/** Whole USDC for an item stack count (the exact amount goes in the examine text). */
export function usdcStack(usdc: bigint): number {
  const whole = usdc / 1_000_000n;
  return whole > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(whole);
}

// ---------------------------------------------------------------------------
// Stalls

/** A stall's deposit id is "escrow_onchainId"; quotes use the on-chain id. */
export function onchainDepositId(depositId: string): string {
  const i = depositId.lastIndexOf("_");
  return i >= 0 ? depositId.slice(i + 1) : depositId;
}

/**
 * Methods whose Peer Cash sell orders only Peer Pay merchants may fill: the
 * deposit carries Peer Pay's whitelist (@zkp2p/cash CASH_RESTRICTED_PLATFORMS,
 * not exported by the package), so no player in the bank can take that stall.
 */
const PEER_PAY_ONLY: ReadonlySet<string> = new Set(["venmo", "paypal"]);

/** True when a stall on this method can only be filled by Peer Pay merchants. */
export function stallPeerPayOnly(platform: string): boolean {
  return PEER_PAY_ONLY.has(platform.toLowerCase());
}

/** True when `quote` is against the stall's own deposit (composite or on-chain id, any address case). */
export function isDepositQuote(quote: Pick<BuyQuote, "depositId" | "escrow">, depositId: string, escrow: string): boolean {
  return quote.depositId === onchainDepositId(depositId) && quote.escrow.toLowerCase() === escrow.toLowerCase();
}

// ---------------------------------------------------------------------------
// Captured payments

/**
 * True when a captured payment's amount equals what the order asks for (and
 * the currency matches, when the platform reports one). Used only as a hint:
 * the player still picks the row.
 */
export function rowMatchesOrder(row: Pick<PaymentRow, "amount" | "currency">, order: Pick<BuyOrder, "fiatToSendText" | "currency">): boolean {
  if (!row.amount) return false;
  if (row.currency && row.currency.toUpperCase() !== order.currency) return false;
  const paid = tryParseAmount(row.amount.replace(/,/g, ""), FIAT_DECIMALS);
  const owed = tryParseAmount(order.fiatToSendText, FIAT_DECIMALS);
  return paid !== null && owed !== null && paid === owed;
}

/** A captured payment amount for display ("£101.50"), or the raw text when it does not parse. */
/**
 * A captured payment's date for display ("Oct 11, 2:00 PM"), like Peer's
 * formatDateTime. The extension's rows carry raw platform values: Revolut's
 * completedDate (and Cash App's display_date) are epoch milliseconds, Venmo
 * is UTC without a zone, Zelle can be "YYYYMMDD". Only those shapes and ISO
 * date-times are parsed; any other text is shown as-is, because Date's
 * lenient parser turns words like "Bob 12" into made-up dates.
 */
export function paymentRowDate(date: string | null, platform: BuyPlatformId): string {
  const raw = (date ?? "").trim();
  if (!raw) return "";
  let d: Date;
  let dateOnly = false;
  const ymd = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw);
  if (ymd) {
    d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    dateOnly = true;
  } else if (/^\d{10}$|^\d{13}$/.test(raw)) {
    d = new Date(raw.length === 10 ? Number(raw) * 1000 : Number(raw));
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    d = new Date(platform === "venmo" && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? `${raw}Z` : raw);
  } else {
    return raw;
  }
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString(
    undefined,
    dateOnly ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  );
}

export function paymentRowAmount(row: Pick<PaymentRow, "amount" | "currency">, fallback: FiatCode): string {
  if (!row.amount) return "Unknown amount";
  const code = (row.currency ?? fallback).toUpperCase();
  const units = tryParseAmount(row.amount.replace(/,/g, ""), FIAT_DECIMALS);
  if (units === null) return `${row.amount} ${code}`;
  return code === fallback ? formatFiat(units, fallback) : `${formatDecimal(units, FIAT_DECIMALS, { minFraction: 2, maxFraction: 2 })} ${code}`;
}

// ---------------------------------------------------------------------------
// Errors

const PICK_AGAIN: ReadonlySet<BuyErrorCode> = new Set(["payee_mismatch", "nullifier_used", "payment_verification_failed", "payment_not_settled"]);
const CHECK_AGAIN: ReadonlySet<BuyErrorCode> = new Set(["capture_failed", "no_payments", "payment_session_expired", "tx_pending"]);
const FRESH_PRICES: ReadonlySet<BuyErrorCode> = new Set(["quote_expired", "rate_changed", "liquidity", "signature_expired"]);
const TERMINAL: ReadonlySet<BuyErrorCode> = new Set(["intent_expired", "intent_closed"]);

export interface ErrorActions {
  /** The main recovery button, or null when going back is the only option. */
  primary: { label: string; action: "retry" | "back" } | null;
  /** Show a "Back" button as well. */
  back: boolean;
}

/**
 * The buttons for a buy-flow error. `back()` from an error whose return step
 * is "selectPayment" goes back to the captured list, so wrong-payment errors
 * offer "Pick another payment" instead of a retry that may not exist.
 */
export function errorActions(error: Pick<BuyError, "code" | "recoverable">, returnStep: BuyStep | null): ErrorActions {
  if (PICK_AGAIN.has(error.code) && returnStep === "selectPayment") {
    return { primary: { label: "Pick another payment", action: "back" }, back: false };
  }
  if (TERMINAL.has(error.code)) return { primary: null, back: true };
  if (CHECK_AGAIN.has(error.code)) return { primary: { label: "Check again", action: "retry" }, back: true };
  if (FRESH_PRICES.has(error.code)) return { primary: { label: "Get fresh prices", action: "retry" }, back: true };
  if (error.recoverable) return { primary: { label: "Try again", action: "retry" }, back: true };
  return { primary: null, back: true };
}

/**
 * The error text to show. Once the order has expired, "no payments found"
 * also says not to send money: by then the player may only prove a payment
 * made in time.
 */
export function errorText(error: Pick<BuyError, "code" | "message">, orderExpired: boolean): string {
  if (orderExpired && error.code === "no_payments") {
    return "No payment for this offer was found yet. If you paid before it expired, wait a minute, then check again. Do not send money now.";
  }
  return error.message;
}

// ---------------------------------------------------------------------------
// Where the payment can be proven

/**
 * True when this browser can't prove a payment: proving needs the Peer
 * extension, which installs only on desktop Chrome or Brave (phones, iPads,
 * Firefox and Safari can't), and it isn't already here. Such a buyer must be
 * told before they place an order and pay, not after "I have paid". A
 * browser where the extension is somehow present (it is available) can
 * verify, so it is never stopped.
 */
export function verifyNeedsComputer(userAgent?: string, sdk: { isAvailable(): boolean } = peerExtension()): boolean {
  if (canInstallPeerExtension(userAgent)) return false;
  try {
    return !sdk.isAvailable();
  } catch {
    return true;
  }
}

/**
 * What the Payment scroll flags about the Peer extension while the player
 * pays, as Peer web's extra "Extension" step on its payment screen: missing
 * here (a browser that can install it) or too old for this platform. Nothing
 * for a browser that can't run it (the "verify on a computer" note covers
 * that), an unconnected or ready extension, or a status not read yet.
 */
export function extensionHeadsUp(status: ExtensionStatus | null): "install" | "update" | null {
  if (status === "needs_install") return "install";
  if (status === "needs_update") return "update";
  return null;
}

/** The install button as Peer web words it: "Add to Chrome", "Add to Brave", or "Add to browser" (Edge, Opera). */
export function addExtensionLabel(browser: ReturnType<typeof extensionBrowser> = extensionBrowser()): string {
  if (browser === "brave") return "Add to Brave";
  if (browser === "chrome") return "Add to Chrome";
  return "Add to browser";
}

/** Where an outdated extension is updated by hand (Chrome's page; Brave opens it too as brave://extensions). */
export function extensionsPage(browser: ReturnType<typeof extensionBrowser> = extensionBrowser()): string {
  return browser === "brave" ? "brave://extensions" : "chrome://extensions";
}

/**
 * Where the Peer extension reads the payment from, in words: the platform,
 * or the site behind it where that differs (UPI payments are read from
 * Amazon Pay on amazon.in, Alipay's from alipay.com).
 */
export function verifySite(platform: Pick<BuyPlatform, "id" | "name">): string {
  if (platform.id === "upi") return "Amazon Pay on amazon.in";
  if (platform.id === "alipay") return "alipay.com";
  return platform.name;
}

/**
 * "Verifying needs PeerAuth 0.6.7 or newer, on a computer." for a platform
 * whose payments only a newer Peer extension can capture (Alipay 0.6.7, UPI
 * 0.6.8, X Money 0.7.1, Monobank 0.7.2); null on Peer's 0.6.3 floor.
 */
export function peerAuthVersionText(platform: Pick<BuyPlatform, "minExtensionVersion">): string | null {
  return platform.minExtensionVersion ? `Verifying needs PeerAuth ${platform.minExtensionVersion} or newer, on a computer.` : null;
}

/** What a phone's pay button says: the app it opens (UPI's link lets the phone pick the app). */
export function payButtonLabel(platform: Pick<BuyPlatform, "id" | "name">): string {
  return platform.id === "upi" ? "Pay with UPI" : `Open ${platform.name}`;
}

/** Under the QR on a computer: which app to scan it with. */
export function qrCaption(platform: Pick<BuyPlatform, "id" | "name">): string {
  if (platform.id === "alipay") return "Scan with the Alipay app on your phone.";
  if (platform.id === "upi") return "Scan with the Amazon Pay app on your phone and pay with standard UPI.";
  return `Scan the QR code with your phone and pay in the ${platform.name} app.`;
}

/**
 * True when the order can't be paid at all: the platform's payment link
 * needs the seller's account id from Curator (Alipay's PID) and it is
 * missing, so there is no QR or link to pay with. The buyer must cancel and
 * pick another seller.
 */
export function missingPayLink(
  platform: Pick<BuyPlatform, "id">,
  info: Pick<PaymentInstructions, "payee" | "deepLink" | "webLink" | "qrValue">,
  needsRecipient: (id: BuyPlatformId) => boolean = needsRecipientId,
): boolean {
  return Boolean(info.payee) && needsRecipient(platform.id) && !info.deepLink && !info.webLink && !info.qrValue;
}

/** Steps where a transaction (signal, fulfil, cancel) may be in flight; nothing else may start. */
export function txInFlight(step: BuyStep, pending: string | null): boolean {
  return step === "signaling" || step === "fulfilling" || pending === "signal" || pending === "fulfill" || pending === "cancel";
}

// ---------------------------------------------------------------------------
// The Payment scroll's "Before you pay" checklist

/** One line of the Payment scroll's checklist: a rule to follow, a thing not to do, or the platform's warning. */
export interface ChecklistItem {
  kind: "do" | "dont" | "warn";
  text: string;
  /** The platform's warning, or the rules that say what it says: listed first, in heavier ink. */
  important: boolean;
}

/** Words that carry no meaning when comparing a warning with a rule. */
const CHECKLIST_FILLER = new Set(
  "a an the in on to of for and or is it be you your this that with from as by at do so will can through &".split(" "),
);

/**
 * The meaningful words of a rule or warning, normalised so that "Do not" and
 * "Don't", "a single" and "one", "payment" and "pay" compare equal. The
 * platform's own name is context, not content.
 */
function checklistWords(text: string, platformName: string): Set<string> {
  const skip = new Set([...CHECKLIST_FILLER, ...platformName.toLowerCase().split(/\s+/)]);
  const words =
    text
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\b(do not|don't|never)\b/g, " not ")
      .replace(/\b(a single|single)\b/g, " one ")
      .match(/[a-z0-9%$@.'&-]+/g) ?? [];
  const out = new Set<string>();
  for (const raw of words) {
    let word = raw.replace(/^[.'-]+|[.'-]+$/g, "").replace(/'s$/, "");
    if (word === "payment" || word === "payments") word = "pay";
    if (word && !skip.has(word)) out.add(word);
  }
  return out;
}

function sameWords(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((w) => b.has(w));
}

/**
 * The Payment scroll's checklist: the platform's rules with its one-line
 * warning folded in, so nothing is said twice. When the rules already say
 * everything the warning does (Cash App's "Send exactly ... in a single
 * payment", Venmo's friends & family), the rules that say it lead and the
 * warning is not repeated. Otherwise the warning leads, and any rule that
 * only repeats it (Revolut's "A wrong-currency payment loses 5%") is left
 * out. Before a Zelle bank is chosen the warning only asks for that choice,
 * which the scroll asks itself.
 */
export function paymentChecklist(info: Pick<PaymentInstructions, "warning" | "rules" | "platformName" | "needsMethodChoice">): ChecklistItem[] {
  const rules: ChecklistItem[] = info.rules.map((r) => ({ kind: r.kind, text: r.text, important: false }));
  const warning = info.needsMethodChoice ? null : info.warning?.trim() || null;
  if (!warning) return rules;
  const words = (text: string) => checklistWords(text, info.platformName);
  const warned = words(warning);
  const ruleWords = rules.map((r) => words(r.text));
  const inWarning = (i: number) => {
    const w = ruleWords[i]!;
    return w.size > 0 && [...w].every((x) => warned.has(x));
  };
  const said = new Set(ruleWords.flatMap((w) => [...w]));
  if ([...warned].every((w) => said.has(w))) {
    const lead = rules.filter((_, i) => inWarning(i)).map((r) => ({ ...r, important: true }));
    return [...lead, ...rules.filter((_, i) => !inWarning(i))];
  }
  const sentences = (text: string) =>
    text
      .split(/(?<=[.!?])\s+/)
      .map(words)
      .filter((w) => w.size > 0);
  const warningSentences = sentences(warning);
  const repeats = (i: number) => inWarning(i) || sentences(rules[i]!.text).some((s) => warningSentences.some((w) => sameWords(s, w)));
  return [{ kind: "warn", text: warning, important: true }, ...rules.filter((_, i) => !repeats(i))];
}

/** The fee line under the Payment scroll's buttons: "Fees already taken: 1.20 USDC Peer + 0.63 USDC RampRidge (0.5%)." */
export function feesTakenText(breakdown: string): string {
  return `Fees already taken: ${breakdown}.`;
}

/** The expiry countdown turns to warning ink in its last 15 minutes. */
export const EXPIRY_WARN_MS = 15 * 60_000;
