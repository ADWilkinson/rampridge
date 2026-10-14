/**
 * The practice trade: the real buy store and the real trade window, Payment
 * scroll and Verify, driven by the simulated Peer client, wallet and
 * extension in simulated.ts. A visitor walks the whole buy to the
 * Congratulations screen with no login and no money. Nothing reaches Peer's
 * API, the chain, Privy, the paymaster or the world: quotes are priced here
 * at the live best Revolut rate from GET /api/market (the merchants' own
 * book) with Peer's and RampRidge's fees, and the store's telemetry counts
 * only `practice_start` and `practice_done`, never a quote or a fulfilment.
 */

import { QueryClient } from "@tanstack/react-query";
import type { CashClient } from "@zkp2p/cash";
import type { Address, Hex } from "viem";
import type { StoreApi } from "zustand/vanilla";
import type { MarketResponse } from "@shared/world";
import { track } from "@/lib/telemetry";
import { DEFAULT_INTENT_TTL_MS, createBuyStore, memoryOrderStorage, type BuyFlowStore } from "@/peer/buy";
import { tryParseAmount } from "@/peer/format";
import type { BuyQuote, BuyQuoteResult, GetBuyQuotesParams, PlatformPrice } from "@/peer/market";
import { BUY_PLATFORMS, defaultCurrencyForLocale, type FiatCode } from "@/peer/platforms";
import type { TxSender } from "@/wallet/types";
import type { MerchantTarget } from "../context";
import { fakeCash, fakeChain, fakeExtension, fixtureQuote, revolutRows, type Timing } from "./simulated";

/** Revolut: one verify method, the captured rows the simulated extension returns, and liquidity in the major currencies. */
const PRACTICE_PLATFORM = "revolut";
const PRACTICE_SELLER_NAME = "Practice seller";
/** The practice seller's handle: Revtag-shaped, but a hyphen no real Revtag has. */
export const PRACTICE_HANDLE = "practice-seller";

/** Patterned, obviously synthetic wallets: no real address appears in a practice trade. */
const PRACTICE_BUYER: Address = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0";
const PRACTICE_SELLER: Address = "0x5e11e45e11e45e11e45e11e45e11e45e11e45e1";

/** Long enough to read each step as it happens, short enough not to drag. */
const TIMING: Timing = { txMs: 900, quoteMs: 250, captureMs: 1_500 };
const QUOTE_TTL_MS = 90_000;

export interface PracticeChoice {
  currency: FiatCode;
  /** Fiat per USDC, 18 decimals: the live best Revolut rate for the currency. */
  rate: bigint;
}

function revolutRate(market: Pick<MarketResponse, "books" | "currencies">, currency: FiatCode): bigint | null {
  const book = market.books.find((b) => b.platform.toLowerCase() === PRACTICE_PLATFORM && b.currency.toUpperCase() === currency);
  const text = book?.best.rate ?? market.currencies.find((c) => c.currency.toUpperCase() === currency)?.bestRate;
  const rate = text ? tryParseAmount(text, 18) : null;
  return rate !== null && rate > 0n ? rate : null;
}

/**
 * The visitor's own currency when Revolut sells it and the market prices it,
 * else US dollars; null when the market prices neither.
 */
export function choosePractice(market: Pick<MarketResponse, "books" | "currencies">, preferred: FiatCode = defaultCurrencyForLocale()): PracticeChoice | null {
  for (const currency of new Set<FiatCode>([preferred, "USD"])) {
    if (!BUY_PLATFORMS[PRACTICE_PLATFORM].currencies.includes(currency)) continue;
    const rate = revolutRate(market, currency);
    if (rate !== null) return { currency, rate };
  }
  return null;
}

export interface PracticeRuntime {
  store: StoreApi<BuyFlowStore>;
  /** Its own query cache, so practice prices never stand in for live ones under the same keys. */
  queryClient: QueryClient;
  sender: TxSender;
  /** The practice seller the trade window opens against. */
  target: MerchantTarget;
  quotes(params: GetBuyQuotesParams): Promise<BuyQuoteResult>;
  bestPrices(params: { fiatAmount: string | bigint }): Promise<PlatformPrice[]>;
  cash: CashClient;
}

function randomIntentHash(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A practice buy on its own store, signal and intent, with nothing shared with the player's real orders. */
export function createPracticeRuntime({ currency, rate }: PracticeChoice, intentHash: Hex = randomIntentHash()): PracticeRuntime {
  const chain = fakeChain({ lockMs: DEFAULT_INTENT_TTL_MS, fulfil: "ok", signal: "ok", readMs: 0 }, TIMING, Date.now, { buyer: PRACTICE_BUYER, intentHash });

  const quote = (fiat: bigint): BuyQuote => ({
    ...fixtureQuote({ fiat, currency, platform: PRACTICE_PLATFORM, depositId: "1", rate, expiresAt: Date.now() + QUOTE_TTL_MS }),
    seller: PRACTICE_SELLER,
    payeeHandle: PRACTICE_HANDLE,
    successRateBps: null,
  });
  const fiatOf = (amount: string | bigint) => (typeof amount === "bigint" ? amount : (tryParseAmount(amount, 6) ?? 0n));
  const quotes = async (params: GetBuyQuotesParams): Promise<BuyQuoteResult> => {
    await wait(TIMING.quoteMs);
    const fiat = fiatOf(params.fiatAmount);
    return { fiatAmount: fiat, currency, quotes: [quote(fiat)], nearby: { below: [], above: [] }, expiresAt: Date.now() + QUOTE_TTL_MS };
  };

  const store: StoreApi<BuyFlowStore> = createBuyStore({
    getClient: () => chain.client,
    extension: fakeExtension({ installed: true, state: "ready" }, TIMING, () => {
      const order = store.getState().order;
      const rows = order ? revolutRows(order.fiatToSendText, order.currency).map((r) => (r.recipient === "revtag" ? { ...r, recipient: PRACTICE_HANDLE } : r)) : [];
      return { platform: PRACTICE_PLATFORM, rows };
    }),
    storage: memoryOrderStorage(),
    quotes,
    fetchPayeeHandle: async () => PRACTICE_HANDLE,
    canInstallExtension: () => true,
    openInstallPage: () => undefined,
    every: () => () => undefined,
    onFocus: () => () => undefined,
    indexerTimeoutMs: 1_500,
    track: () => undefined,
    reportFailure: () => undefined,
  });

  return {
    store,
    queryClient: new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } } }),
    sender: chain.sender,
    target: { kind: "merchant", merchantId: "practice", name: PRACTICE_SELLER_NAME, platform: PRACTICE_PLATFORM, currency },
    quotes,
    bestPrices: async (params) => {
      await wait(TIMING.quoteMs);
      return [{ platform: PRACTICE_PLATFORM, available: true, quote: quote(fiatOf(params.fiatAmount)) }];
    },
    cash: fakeCash("none"),
  };
}

let current: PracticeRuntime | null = null;

/** Makes `runtime` the practice trade in progress, replacing any earlier one, and counts it once. */
export function enterPractice(runtime: PracticeRuntime): void {
  if (current === runtime) return;
  current = runtime;
  track("practice_start");
  runtime.store.subscribe((state, prev) => {
    if (state.step === "completed" && prev.step !== "completed") track("practice_done");
  });
}

/** The practice trade in progress, if any. */
export function currentPractice(): PracticeRuntime | null {
  return current;
}

/** Forgets the practice trade (its window closed, or the player moved on to a real interface). */
export function endPractice(): void {
  current = null;
}
