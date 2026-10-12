/**
 * The Peer Cash client and the read-side helpers the sell flow is built on:
 * what can be offered (capabilities), the live market rate (estimate) and
 * how quickly each corridor historically fills (fill stats).
 */

import {
  createCashClient,
  RECOMMENDED_MIN_CASHOUT_AMOUNT,
  type CashCapabilities,
  type CashClient,
  type CashFillStats,
  type CurrencyType,
} from "@zkp2p/cash";
import { isMajorCurrency } from "@shared/currencies";
import { BASE_RPC_URL, PEER_REFERRAL_CODE, PEER_REFERRER } from "@/config";
import { usdcToNumber } from "./amount";
import { payeeField, platformName } from "./payees";
import { singleOrderPolicy } from "./singleOrder";
import { withSpreadOrders } from "./spreadOrders";

let client: CashClient | null = null;

/**
 * The app's single production Peer Cash client. Every transaction it prepares
 * carries the `rampridge` ERC-8021 analytics code after Peer Cash's own. Its
 * order reads, withdraw and top-up also cover seller-spread orders
 * (`spreadOrders.ts`), which Peer Cash itself does not treat as its own.
 */
export function getCashClient(): CashClient {
  client ??= withSpreadOrders(
    createCashClient({
      environment: "production",
      rpcUrl: BASE_RPC_URL,
      // peer-ref-TOFIAT: Curator pays Galleon an integration share of Peer's fee on fills.
      referralCode: PEER_REFERRAL_CODE,
      referrer: PEER_REFERRER,
    }),
  );
  return client;
}

/** How a payee that the curator does not know yet gets registered. */
export type PayeeRegistrationRoute =
  /** Wise, PayPal, Alipay: a TEE identity attestation captured by the PeerAuth extension. */
  | "peerExtensionIdentity"
  /** Cash App: a seller credential captured by the PeerAuth extension. */
  | "peerExtensionCredential";

export interface SellPlatform {
  /** Platform id the SDK accepts, e.g. "revolut". */
  platform: string;
  /** Display name, e.g. "Revolut". */
  name: string;
  currencies: CurrencyType[];
  /** The SDK's own hint for the handle format. */
  payeeHint: string;
  payeeLabel: string;
  payeePlaceholder: string;
  /** New payees need a signed identity attestation (Wise, PayPal, Alipay). */
  requiresIdentityAttestation: boolean;
  /** How a new or unknown payee can be registered, when there is a way. */
  registration: PayeeRegistrationRoute | null;
  /** Zelle: the seller must confirm the handle is enrolled and can receive payments (Peer's text). */
  payeeEnrollment: { text: string } | null;
  /** Alipay: deposits fill in one order, so they have a minimum and a seller warning. */
  singleOrder: { minAmount: bigint; warning: string } | null;
}

export interface SellCapabilities {
  platforms: SellPlatform[];
  /** Every currency at least one platform can pay out. */
  currencies: CurrencyType[];
  /** Minimum this app accepts (the SDK's recommended 1 USDC; smaller orders starve matching). */
  minAmount: bigint;
  /** Protocol hard floor. */
  hardMinAmount: bigint;
  /** No protocol maximum; the wallet balance is the only ceiling. */
  maxAmount: bigint | null;
}

export function registrationRouteFor(platform: string, requiresIdentityAttestation: boolean): PayeeRegistrationRoute | null {
  if (requiresIdentityAttestation) return "peerExtensionIdentity";
  if (platform === "cashapp") return "peerExtensionCredential";
  return null;
}

/** Peer's Zelle enrolment confirmation, adapted to email or phone. */
export const ZELLE_ENROLLMENT_TEXT = "I have enrolled this email address or phone number with Zelle and can receive payments at it";

/**
 * Platforms x currencies x payee hints x amount bounds: Peer Cash's
 * production capabilities (every currency priced by a live oracle at the
 * market rate, 0% spread) narrowed to the major currencies
 * (`shared/currencies.ts`). A platform left with none is not offered.
 * Synchronous.
 */
export function sellCapabilities(cash: { capabilities(): CashCapabilities } = getCashClient()): SellCapabilities {
  const caps = cash.capabilities();
  const platforms: SellPlatform[] = [];
  for (const p of caps.platforms) {
    const currencies = p.currencies.filter(isMajorCurrency);
    if (!currencies.length) continue;
    const field = payeeField(p.platform);
    const single = singleOrderPolicy(p.platform);
    platforms.push({
      platform: p.platform,
      name: platformName(p.platform),
      currencies,
      payeeHint: p.payeeHint,
      payeeLabel: field.label,
      payeePlaceholder: field.placeholder,
      requiresIdentityAttestation: p.requiresIdentityAttestation,
      registration: registrationRouteFor(p.platform, p.requiresIdentityAttestation),
      payeeEnrollment: p.platform === "zelle" ? { text: ZELLE_ENROLLMENT_TEXT } : null,
      singleOrder: single ? { minAmount: single.minAmount, warning: single.warning } : null,
    });
  }
  const recommended = caps.amount.recommendedMin > 0n ? caps.amount.recommendedMin : RECOMMENDED_MIN_CASHOUT_AMOUNT;
  return {
    platforms,
    currencies: [...new Set(platforms.flatMap((p) => p.currencies))].sort(),
    minAmount: recommended > caps.amount.min ? recommended : caps.amount.min,
    hardMinAmount: caps.amount.min,
    maxAmount: caps.amount.max,
  };
}

export function findPlatform(caps: SellCapabilities, platform: string): SellPlatform | null {
  return caps.platforms.find((p) => p.platform === platform) ?? null;
}

/** 1 USDC: rates are read once per corridor and scaled locally so typing never refetches. */
export const RATE_PROBE_AMOUNT = 1_000_000n;

export interface SellRate {
  currency: CurrencyType;
  platform: string | null;
  /** Fiat per 1 USDC at the time of the read. Binds only when a buyer signals. */
  rate: number;
  /** Unix seconds the oracle was read. */
  asOf: number;
  /** The feed reading is over a day old; show the rate with caution. */
  stale: boolean;
}

/** Live oracle rate for a corridor (no ETA, so it renders first). */
export async function fetchSellRate(
  cash: Pick<CashClient, "estimate">,
  input: { currency: CurrencyType; platform?: string | null },
): Promise<SellRate> {
  const estimate = await cash.estimate(
    { amount: RATE_PROBE_AMOUNT, currency: input.currency, ...(input.platform ? { platform: input.platform } : {}) },
    { includeEta: false },
  );
  return {
    currency: estimate.currency,
    platform: input.platform ?? null,
    rate: estimate.rate,
    asOf: estimate.asOf,
    stale: estimate.stale === true,
  };
}

/** Approximate fiat for a USDC amount at a rate, truncated to cents. An estimate, never a quote. */
export function estimateReceive(amount: bigint, rate: number): number {
  return Math.floor(usdcToNumber(amount) * rate * 100) / 100;
}

/** The fill-stats key the SDK uses: `platform:CUR` or a sorted set `platform:EUR+GBP+USD`. */
export function fillStatsKey(platform: string, currencies: readonly string[]): string {
  const set = [...new Set(currencies.map((c) => c.toUpperCase()))].sort();
  return `${platform.toLowerCase()}:${set.join("+")}`;
}

export type SellLiquidity =
  /** At least 10 fills in 30 days with a median first fill within 48 hours. */
  | "active"
  /** Some recent fills, but fewer or slower than the active bar. */
  | "slow"
  /** No recent fills for this corridor. */
  | "unproven";

export interface SellEta {
  /** Median deposit-to-first-fill seconds over 30 days, when sampled. */
  seconds: number | null;
  /** Fills in the last 30 days. */
  fills: number;
  liquidity: SellLiquidity;
  /** Display copy, historical and never a promise, e.g. "Usually fills in ~25 min". */
  label: string;
}

const ACTIVE_MIN_FILLS = 10;
const ACTIVE_MAX_MEDIAN_SECONDS = 48 * 60 * 60;

/** Compact duration: "~45 sec", "~25 min", "~3 hr", "~2 days". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} sec`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `~${Math.round(seconds / 3600)} hr`;
  const days = Math.round(seconds / 86_400);
  return `~${days} day${days === 1 ? "" : "s"}`;
}

/** Turns raw fill stats into ETA copy for a leg. Pass all of a leg's currencies for a multi-currency offer. */
export function etaFromFillStats(stats: CashFillStats, platform: string, currencies: readonly string[]): SellEta {
  const pair = stats[fillStatsKey(platform, currencies)];
  const fills = pair?.fills ?? 0;
  const seconds = typeof pair?.medianFillSeconds === "number" ? pair.medianFillSeconds : null;
  if (!fills || seconds === null) {
    return { seconds, fills, liquidity: "unproven", label: "No recent fills on this method" };
  }
  const liquidity: SellLiquidity =
    fills >= ACTIVE_MIN_FILLS && seconds <= ACTIVE_MAX_MEDIAN_SECONDS ? "active" : "slow";
  return { seconds, fills, liquidity, label: `Usually fills in ${formatDuration(seconds)}` };
}

/** Cached 30-day fill evidence (the SDK caches for 15 minutes). */
export function fetchFillStats(cash: Pick<CashClient, "fillStats"> = getCashClient()): Promise<CashFillStats> {
  return cash.fillStats();
}

/** Regions whose own currency is a major one; everywhere else falls back to USD, EUR, GBP. */
const REGION_CURRENCY: Record<string, string> = {
  US: "USD",
  GB: "GBP",
  IE: "EUR",
  DE: "EUR",
  FR: "EUR",
  ES: "EUR",
  IT: "EUR",
  NL: "EUR",
  PT: "EUR",
  BE: "EUR",
  AT: "EUR",
  FI: "EUR",
  CA: "CAD",
  AU: "AUD",
  NZ: "NZD",
  SG: "SGD",
  IN: "INR",
  CN: "CNY",
  MX: "MXN",
  CH: "CHF",
};

/** A sensible default currency for a platform: the player's locale currency, then USD, EUR, GBP. */
export function preferredCurrency(available: readonly CurrencyType[], locale?: string): CurrencyType | null {
  const tag = locale ?? (typeof navigator === "undefined" ? "" : navigator.language);
  const region = /[-_]([A-Za-z]{2})\b/.exec(tag)?.[1]?.toUpperCase();
  const localCurrency = region ? REGION_CURRENCY[region] : undefined;
  for (const code of [localCurrency, "USD", "EUR", "GBP"]) {
    const match = available.find((c) => c === code);
    if (match) return match;
  }
  return available[0] ?? null;
}
