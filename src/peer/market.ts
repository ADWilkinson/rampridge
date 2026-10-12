/**
 * Live Peer buy-side market: quotes for a fiat amount, a best-price board per
 * platform and the public orderbook for the merchant NPCs.
 *
 * Quotes use Curator mode "eligible", which only returns liquidity a brand
 * new taker can fill (no taker stake, no whitelist). Rows that still carry a
 * stake or whitelist requirement are dropped defensively.
 */

import {
  APIError,
  apiGetOrderbookTable,
  resolveFiatCurrencyBytes32,
  type GetPlatformQuote,
  type GetQuoteSingleResponse,
  type OrderbookTableRow,
  type Zkp2pClient,
} from "@zkp2p/sdk";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { BUY_REFERRER_FEE, CHAIN_ID, USDC_ADDRESS } from "@/config";
import { PEER_API_OPTIONS, READ_ONLY_ACCOUNT, getReadOnlyPeerClient } from "./client";
import { FIAT_DECIMALS, RATE_ONE, parseFiat, parseUsdc, tryParseAmount } from "./format";
import {
  BUY_PLATFORMS,
  isBuyPlatformId,
  platformsForCurrency,
  type BuyPlatformId,
  type FiatCode,
} from "./platforms";

export interface BuyQuoteFees {
  /** Peer service fee in basis points, when Curator reports it. */
  serviceBps: number | null;
  /** All amounts in USDC base units. */
  service: bigint;
  manager: bigint;
  /** RampRidge's integrator fee (USDC base units) and its rate, when the quote priced one in. */
  referrer: bigint;
  referrerBps: number | null;
  total: bigint;
}

export interface BuyQuote {
  /** Stable key: escrow:depositId:platform. */
  id: string;
  depositId: string;
  escrow: Address;
  platform: BuyPlatformId;
  currency: FiatCode;
  /** Fiat the buyer pays, 6-decimal base units. */
  fiatAmount: bigint;
  /** USDC the buyer receives after fees, base units. */
  usdcAmount: bigint;
  /** Gross USDC reserved on-chain by the signal (what the rate applies to). */
  signalAmount: bigint;
  /** Fiat per USDC, 18 decimals, exactly as it will be signalled. */
  rate: bigint;
  /** Seller's payment handle (maker offchainId). */
  payeeHandle: string;
  /** Hashed payee details the intent is signalled against. */
  payeeDetailsHash: Hex;
  /** Seller's wallet (deposit owner), when Curator reports it. */
  seller: Address | null;
  fees: BuyQuoteFees;
  sellerAutomatedRelease: boolean;
  /** Seller's historical success rate in basis points, when reported. */
  successRateBps: number | null;
  /** When Curator stops honouring the quote, ms since epoch. */
  expiresAt: number;
  /** Untouched Curator quote. */
  raw: GetQuoteSingleResponse;
}

export interface NearbyBuyQuote {
  /** Suggested fiat amount, 6-decimal base units. */
  fiatAmount: bigint;
  /** e.g. "-5.0%" relative to the requested amount. */
  percentDifference: string | null;
  quote: BuyQuote;
}

export interface BuyQuoteResult {
  fiatAmount: bigint;
  currency: FiatCode;
  /** Best first (most USDC for the buyer). Empty when no seller can fill the amount. */
  quotes: BuyQuote[];
  /** Fillable amounts near the requested one; only populated when `quotes` is empty. */
  nearby: { below: NearbyBuyQuote[]; above: NearbyBuyQuote[] };
  expiresAt: number;
}

export interface GetBuyQuotesParams {
  /** Fiat to pay, decimal string ("250.00") or 6-decimal base units. */
  fiatAmount: string | bigint;
  currency: FiatCode;
  /** Restrict to these platforms; defaults to every live platform for the currency. */
  platforms?: readonly BuyPlatformId[];
  /** Wallet that will receive the USDC; logged-out quoting uses a placeholder. */
  recipient?: Address | null;
  quotesToReturn?: number;
  client?: Zkp2pClient;
}

export class MarketError extends Error {
  readonly code: "invalid_amount" | "amount_too_low" | "no_platforms";
  constructor(code: MarketError["code"], message: string) {
    super(message);
    this.name = "MarketError";
    this.code = code;
  }
}

function toFiatBase(amount: string | bigint): bigint {
  if (typeof amount === "bigint") return amount;
  const parsed = tryParseAmount(amount, FIAT_DECIMALS);
  if (parsed === null) throw new MarketError("invalid_amount", "Enter an amount like 100 or 99.50.");
  return parsed;
}

function toBigInt(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * The rate manager's fee as the escrow takes it at release: its 18-decimal
 * rate (Curator's `intent.managerFee`) of the gross, floored. Falls back to
 * Curator's `managerFeeAmount` when the rate is missing.
 */
function managerCut(raw: GetQuoteSingleResponse, gross: bigint): bigint {
  const rate = toBigInt((raw.intent as { managerFee?: string | null } | undefined)?.managerFee);
  if (rate !== null) return rate > 0n ? (gross * rate) / RATE_ONE : 0n;
  return toBigInt(raw.managerFeeAmount) ?? 0n;
}

/** Optional rate fields Curator may add beyond the SDK's declared quote type. */
type ExtraRateFields = { effectiveConversionRate?: string | null };

/** The rate to signal with: taker rate first, matching Peer's web client. */
export function preferredRate(raw: GetQuoteSingleResponse): bigint | null {
  const extra = raw as GetQuoteSingleResponse & ExtraRateFields;
  return (
    toBigInt(raw.takerConversionRate) ??
    toBigInt(extra.effectiveConversionRate) ??
    toBigInt(raw.conversionRate)
  );
}

/** True when a quote needs taker stake, a whitelist or an access group. */
export function requiresTakerPermission(raw: {
  disputeProtectionRequiresStake: boolean;
  whitelistEnabled: boolean;
  allowedGroupIds?: readonly string[];
}): boolean {
  return raw.disputeProtectionRequiresStake || raw.whitelistEnabled || (raw.allowedGroupIds?.length ?? 0) > 0;
}

/**
 * Curator's quoteExpiresAt is its gating-signature TTL (3600 s in production),
 * not a hold: nothing is reserved until signalIntent lands, and the escrow
 * re-reads the deposit's effective (rate-manager) rate at signal time.
 * Quotes count as fresh for two minutes, measured on this device's clock.
 */
export const QUOTE_FRESH_MS = 120_000;

function parseExpiry(value: string | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  const fresh = Date.now() + QUOTE_FRESH_MS;
  return Number.isFinite(ms) ? Math.min(ms, fresh) : fresh;
}

/**
 * Peer's processSingleRawQuote + isCanonicalDisputeProtectionProjection: a
 * quote whose access or dispute-protection policy is missing or malformed
 * never counts as open liquidity.
 */
function hasCanonicalPolicy(raw: GetQuoteSingleResponse): boolean {
  const policy = raw as unknown as Record<"disputeProtectionRequiresStake" | "disputeProtectionOptedOut" | "whitelistEnabled" | "allowedGroupIds", unknown>;
  return (
    typeof policy.whitelistEnabled === "boolean" &&
    typeof policy.disputeProtectionRequiresStake === "boolean" &&
    typeof policy.disputeProtectionOptedOut === "boolean" &&
    !(policy.disputeProtectionRequiresStake && policy.disputeProtectionOptedOut) &&
    Array.isArray(policy.allowedGroupIds) &&
    policy.allowedGroupIds.every((id) => typeof id === "string")
  );
}

/** The quote's intent is denominated in the requested currency (Curator sends the bytes32 code). */
function quotedInCurrency(raw: GetQuoteSingleResponse, currency: FiatCode): boolean {
  const code = raw.intent?.fiatCurrencyCode;
  if (!code) return false;
  if (!code.startsWith("0x")) return code.toUpperCase() === currency;
  return code.toLowerCase() === resolveFiatCurrencyBytes32(currency).toLowerCase();
}

/**
 * Normalises one Curator quote. Returns null for anything this app must not
 * offer: unknown or non-live platform, wrong currency, permissioned
 * liquidity, missing or inconsistent amounts (no gross signal amount, or a
 * gross below the net), or a Venmo order above its per-order cap.
 */
export function normalizeQuote(
  raw: GetQuoteSingleResponse,
  currency: FiatCode,
  expiresAt: number,
): BuyQuote | null {
  const platformId = (raw.intent?.processorName ?? raw.paymentMethod ?? "").toLowerCase();
  if (!isBuyPlatformId(platformId)) return null;
  const platform = BUY_PLATFORMS[platformId];
  if (!platform.live || !platform.currencies.includes(currency)) return null;
  if (!hasCanonicalPolicy(raw) || requiresTakerPermission(raw)) return null;
  if (!quotedInCurrency(raw, currency)) return null;

  const fiatAmount = toBigInt(raw.fiatAmount);
  const quotedNet = toBigInt(raw.tokenAmount);
  // The gross the intent reserves; fees come off it on-chain. Never fall back to the net
  // tokenAmount: signalling that would take the fees a second time from what "You receive" shows.
  const signalAmount = toBigInt(raw.signalIntentAmount) ?? toBigInt(raw.intent?.amount);
  const rate = preferredRate(raw);
  const payeeHandle = raw.maker?.offchainId ?? raw.payeeData?.offchainId ?? "";
  const payeeDetailsHash = raw.intent?.payeeDetails;
  const escrow = raw.intent?.escrowAddress;
  if (
    fiatAmount === null ||
    quotedNet === null ||
    signalAmount === null ||
    rate === null ||
    rate <= 0n ||
    signalAmount <= 0n ||
    signalAmount < quotedNet ||
    !payeeHandle ||
    !payeeDetailsHash?.startsWith("0x") ||
    !escrow ||
    !isAddress(escrow, { strict: false })
  ) {
    return null;
  }
  if (platform.maxUsdc !== null && signalAmount > parseUsdc(platform.maxUsdc)) return null;

  const service = toBigInt(raw.zkp2pFeeAmount) ?? 0n;
  const manager = managerCut(raw, signalAmount);
  const referrer = toBigInt(raw.referrerFeeAmount) ?? toBigInt(raw.takerReferralFeeAmount) ?? 0n;
  // Curator's tokenAmount nets out Peer's and the referrer's legs but not a rate
  // manager's fee, which the orchestrator also takes from the release (proven
  // against the deployed contracts, tests/fork). Never show more than arrives.
  const fromGross = signalAmount - service - referrer - manager;
  const usdcAmount = fromGross < quotedNet ? fromGross : quotedNet;
  if (usdcAmount <= 0n) return null;
  // Curator's total, with its manager figure replaced by the cut the escrow takes.
  const quotedTotal = toBigInt(raw.totalFeeAmount);
  const total =
    quotedTotal === null ? service + manager + referrer : quotedTotal - (toBigInt(raw.managerFeeAmount) ?? 0n) + manager;
  const depositId = String(raw.intent.depositId);
  const escrowAddress = getAddress(escrow);
  const seller = raw.payeeAddress && isAddress(raw.payeeAddress, { strict: false }) ? getAddress(raw.payeeAddress) : null;
  const successRate = (raw as GetQuoteSingleResponse & { depositSuccessRateBps?: number }).depositSuccessRateBps;

  return {
    id: `${escrowAddress.toLowerCase()}:${depositId}:${platformId}`,
    depositId,
    escrow: escrowAddress,
    platform: platformId,
    currency,
    fiatAmount,
    usdcAmount,
    signalAmount,
    rate,
    payeeHandle,
    payeeDetailsHash: payeeDetailsHash as Hex,
    seller,
    fees: {
      serviceBps: typeof raw.serviceFeeBps === "number" ? raw.serviceFeeBps : null,
      service,
      manager,
      referrer,
      referrerBps: typeof raw.referrerFeeBps === "number" ? raw.referrerFeeBps : referrer > 0n ? BUY_REFERRER_FEE.feeBps : null,
      total,
    },
    sellerAutomatedRelease: raw.sellerAutomatedReleaseAvailable === true,
    successRateBps: typeof successRate === "number" ? successRate : null,
    expiresAt,
    raw,
  };
}

function byBestForBuyer(a: BuyQuote, b: BuyQuote): number {
  if (a.usdcAmount !== b.usdcAmount) return a.usdcAmount > b.usdcAmount ? -1 : 1;
  return 0;
}

function quotePlatforms(currency: FiatCode, fiat: bigint, requested?: readonly BuyPlatformId[]): BuyPlatformId[] {
  const live = platformsForCurrency(currency).filter((p) => !requested || requested.includes(p.id));
  if (live.length === 0) {
    throw new MarketError("no_platforms", `No payment method takes ${currency} right now.`);
  }
  const eligible = live.filter((p) => fiat >= parseFiat(p.minFiat));
  if (eligible.length === 0) {
    const lowest = live.reduce((min, p) => (parseFiat(p.minFiat) < parseFiat(min.minFiat) ? p : min));
    throw new MarketError("amount_too_low", `The smallest order is ${lowest.minFiat} ${currency}.`);
  }
  return eligible.map((p) => p.id);
}

function isNoQuotes(error: unknown): boolean {
  return error instanceof APIError && error.status === 404;
}

/**
 * Curator answers 503 ("V3 admission state unavailable", "Indexer
 * unavailable") for a moment under load, and the SDK only retries network
 * errors and 429s. Two short retries (1.9 s of waiting at most) ride most of that out
 * without holding a quote screen for long.
 */
export const CURATOR_RETRY_DELAYS_MS: readonly number[] = [500, 1400];

function isCuratorUnavailable(error: unknown): boolean {
  return error instanceof APIError && error.status === 503;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs a Curator quote call, retrying a 503 at most twice with backoff. */
export async function withCuratorRetry<T>(run: () => Promise<T>, sleep: (ms: number) => Promise<void> = pause): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const delay = CURATOR_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isCuratorUnavailable(error)) throw error;
      await sleep(delay);
    }
  }
}

/** Quotes to buy USDC for an exact fiat amount, best first. */
export async function getBuyQuotes(params: GetBuyQuotesParams): Promise<BuyQuoteResult> {
  const fiatAmount = toFiatBase(params.fiatAmount);
  if (fiatAmount <= 0n) throw new MarketError("invalid_amount", "Enter an amount above zero.");
  const platforms = quotePlatforms(params.currency, fiatAmount, params.platforms);
  const client = params.client ?? getReadOnlyPeerClient();
  const recipient = params.recipient ?? READ_ONLY_ACCOUNT;
  const empty: BuyQuoteResult = {
    fiatAmount,
    currency: params.currency,
    quotes: [],
    nearby: { below: [], above: [] },
    expiresAt: Date.now() + 60_000,
  };

  let response;
  try {
    response = await withCuratorRetry(() => client.getQuote({
      paymentPlatforms: platforms,
      fiatCurrency: params.currency,
      user: recipient,
      recipient,
      destinationChainId: CHAIN_ID,
      destinationToken: USDC_ADDRESS,
      amount: fiatAmount.toString(),
      isExactFiat: true,
      quotesToReturn: params.quotesToReturn ?? 5,
      includeNearbyQuotes: true,
      nearbyQuotesCount: 3,
      mode: "eligible",
      quotePreference: "PREFER_BUYER_TEE",
      referrerFeeConfig: { ...BUY_REFERRER_FEE },
    }));
  } catch (error) {
    if (isNoQuotes(error)) return empty;
    throw error;
  }

  const body = response.responseObject;
  if (!body) return empty;
  const expiresAt = parseExpiry(body.quoteExpiresAt);
  const quotes = (body.quotes ?? [])
    .map((raw) => normalizeQuote(raw, params.currency, expiresAt))
    .filter((q): q is BuyQuote => q !== null)
    .sort(byBestForBuyer);

  const nearby = (list: NonNullable<typeof body.nearbySuggestions>["below"] | undefined): NearbyBuyQuote[] =>
    (list ?? []).flatMap((entry) => {
      const quote = normalizeQuote(entry.quote, params.currency, expiresAt);
      const suggested = toBigInt(entry.suggestedFiatAmount) ?? quote?.fiatAmount ?? null;
      if (!quote || suggested === null) return [];
      return [{ fiatAmount: suggested, percentDifference: entry.fiatPercentDifference ?? null, quote }];
    });

  return {
    fiatAmount,
    currency: params.currency,
    quotes,
    nearby: quotes.length
      ? { below: [], above: [] }
      : { below: nearby(body.nearbySuggestions?.below), above: nearby(body.nearbySuggestions?.above) },
    expiresAt,
  };
}

/**
 * Best quote Curator can find against one specific deposit (a merchant or a
 * player's stall), or null when that deposit cannot fill the amount.
 */
export async function getDepositQuote(
  params: Omit<GetBuyQuotesParams, "platforms" | "quotesToReturn"> & {
    platform: BuyPlatformId;
    depositId: string;
    escrow: Address;
  },
): Promise<BuyQuote | null> {
  const result = await getBuyQuotes({ ...params, platforms: [params.platform], quotesToReturn: 20 });
  const escrow = params.escrow.toLowerCase();
  return result.quotes.find((q) => q.depositId === params.depositId && q.escrow.toLowerCase() === escrow) ?? null;
}

export interface PlatformPrice {
  platform: BuyPlatformId;
  /** Curator found a seller able to fill the amount. */
  available: boolean;
  quote: BuyQuote | null;
}

/** Best price per live platform for a currency and amount (the price board). */
export async function getBestPricesByPlatform(params: {
  currency: FiatCode;
  fiatAmount: string | bigint;
  recipient?: Address | null;
  client?: Zkp2pClient;
}): Promise<PlatformPrice[]> {
  const fiatAmount = toFiatBase(params.fiatAmount);
  if (fiatAmount <= 0n) throw new MarketError("invalid_amount", "Enter an amount above zero.");
  const client = params.client ?? getReadOnlyPeerClient();
  const recipient = params.recipient ?? READ_ONLY_ACCOUNT;
  const live = platformsForCurrency(params.currency);

  let platformQuotes: GetPlatformQuote[] = [];
  let expiresAt = Date.now() + 60_000;
  try {
    const response = await withCuratorRetry(() => client.getQuotesBestByPlatform({
      fiatCurrency: params.currency,
      user: recipient,
      recipient,
      destinationChainId: CHAIN_ID,
      destinationToken: USDC_ADDRESS,
      amount: fiatAmount.toString(),
      isExactFiat: true,
      mode: "eligible",
      quotePreference: "PREFER_BUYER_TEE",
      referrerFeeConfig: { ...BUY_REFERRER_FEE },
    }));
    platformQuotes = response.responseObject?.platformQuotes ?? [];
    expiresAt = parseExpiry(response.responseObject?.quoteExpiresAt);
  } catch (error) {
    if (!isNoQuotes(error)) throw error;
  }

  return live.map((platform) => {
    const entry = platformQuotes.find((p) => p.platform.toLowerCase() === platform.id);
    const quote = entry?.bestQuote ? normalizeQuote(entry.bestQuote, params.currency, expiresAt) : null;
    return { platform: platform.id, available: Boolean(entry?.available && quote), quote };
  });
}

export interface OrderbookOffer {
  /** Composite id from Curator ("escrow_depositId"). */
  id: string;
  depositId: string;
  escrow: Address;
  depositor: Address;
  platform: BuyPlatformId;
  currency: FiatCode;
  /** Fiat per USDC a taker pays, 18 decimals. */
  rate: bigint;
  /** USDC available to take, base units. */
  availableUsdc: bigint;
  minUsdc: bigint;
  maxUsdc: bigint;
  /** Fiat order range, 6-decimal base units. */
  minFiat: bigint;
  maxFiat: bigint;
  successRateBps: number;
  feeBps: number;
  sellerAutomatedRelease: boolean;
  payeeDetailsHash: Hex;
}

/** Public, permissionless rows only, mapped to the live buy catalog. */
export function normalizeOrderbookRow(row: OrderbookTableRow, currency: FiatCode): OrderbookOffer | null {
  const platformId = row.paymentPlatform.toLowerCase();
  if (!isBuyPlatformId(platformId) || !BUY_PLATFORMS[platformId].live) return null;
  if (!BUY_PLATFORMS[platformId].currencies.includes(currency)) return null;
  if (row.isPrivate || requiresTakerPermission(row)) return null;
  if (row.currency !== currency) return null;
  const rate = toBigInt(row.takerConversionRate) ?? toBigInt(row.conversionRate);
  const available = toBigInt(row.availableTokenAmount);
  const minUsdc = toBigInt(row.intentAmountMin);
  const maxUsdc = toBigInt(row.intentAmountMax);
  if (rate === null || rate <= 0n || available === null || available <= 0n || minUsdc === null || maxUsdc === null) {
    return null;
  }
  if (!isAddress(row.escrowAddress, { strict: false }) || !isAddress(row.depositor, { strict: false })) return null;
  return {
    id: row.depositId,
    depositId: row.depositIdOnContract,
    escrow: getAddress(row.escrowAddress),
    depositor: getAddress(row.depositor),
    platform: platformId,
    currency,
    rate,
    availableUsdc: available,
    minUsdc,
    maxUsdc: maxUsdc < available ? maxUsdc : available,
    minFiat: toBigInt(row.minFiatSupported) ?? 0n,
    maxFiat: toBigInt(row.maxFiatSupported) ?? 0n,
    successRateBps: row.successRateBps,
    feeBps: row.feeBps,
    sellerAutomatedRelease: row.sellerAutomatedReleaseAvailable,
    payeeDetailsHash: row.payeeDetailsHash as Hex,
  };
}

/** Cheapest public offers for a currency (optionally one platform), cheapest first. */
export async function getOrderbookSnapshot(params: {
  currency: FiatCode;
  limit?: number;
  platform?: BuyPlatformId;
}): Promise<OrderbookOffer[]> {
  const response = await apiGetOrderbookTable(
    {
      currency: params.currency,
      paymentPlatform: params.platform,
      mode: "eligible",
      sortBy: "price",
      sortDirection: "asc",
      limit: params.limit ?? 25,
      chainId: CHAIN_ID,
      token: USDC_ADDRESS,
    },
    PEER_API_OPTIONS,
  );
  return (response.rows ?? [])
    .map((row) => normalizeOrderbookRow(row, params.currency))
    .filter((offer): offer is OrderbookOffer => offer !== null);
}
