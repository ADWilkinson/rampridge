/**
 * Live Peer liquidity for the bank's merchant NPCs, summarised from Curator's
 * orderbook table. Only rows any buyer can fill are kept: no taker stake, no
 * whitelist or private group, and at least one minimum-size order available.
 */

import { apiGetOrderbookTable } from "@zkp2p/sdk";
import type { GetOrderbookTableResponse, OrderbookTableRow } from "@zkp2p/sdk";
import { MAJOR_CURRENCIES } from "../../shared/currencies.js";
import type { MarketBook, MarketCurrencySummary, MarketOffer, MarketResponse } from "../../shared/world.js";
import { CHAIN_ID, PEER_API_URL, USDC_ADDRESS } from "./chain.js";
import { formatRate, formatUsdc } from "./units.js";

/** Always shown, even when thin, because most players trade in them. */
export const CORE_CURRENCIES = ["USD", "EUR", "GBP"] as const;
/** Other currencies are shown once this much USDC is on offer. */
export const MIN_LISTED_LIQUIDITY = 100_000_000n; // 100 USDC
export const ROWS_PER_CURRENCY = 100;
const OFFERS_PER_BOOK = 3;

/** Only the major currencies (shared/currencies.ts): merchants never shout a niche one. */
export const MARKET_CURRENCIES: readonly string[] = MAJOR_CURRENCIES;

export type TableFetcher = (currency: string) => Promise<GetOrderbookTableResponse>;

export const fetchOrderbookTable: TableFetcher = (currency) =>
  apiGetOrderbookTable(
    {
      currency,
      chainId: CHAIN_ID,
      token: USDC_ADDRESS,
      mode: "eligible",
      sortBy: "price",
      sortDirection: "asc",
      limit: ROWS_PER_CURRENCY,
    },
    { baseApiUrl: PEER_API_URL, timeoutMs: 8_000, runtimeEnv: "production" },
  );

interface Candidate {
  offer: MarketOffer;
  rate: bigint;
  available: bigint;
}

function toBigInt(value: string | null | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

/** Normalises a fillable row, or returns null for one no ordinary buyer can take. */
export function openOffer(row: OrderbookTableRow): Candidate | null {
  if (row.disputeProtectionRequiresStake || row.whitelistEnabled || row.isPrivate) return null;
  if (row.allowedGroupIds.length > 0) return null;
  const rate = toBigInt(row.takerConversionRate) ?? toBigInt(row.conversionRate);
  const available = toBigInt(row.availableTokenAmount);
  const min = toBigInt(row.intentAmountMin) ?? 0n;
  const maxRaw = toBigInt(row.intentAmountMax) ?? available;
  if (rate === null || rate <= 0n || available === null || available <= 0n || available < min) return null;
  const max = maxRaw === null || maxRaw > available ? available : maxRaw;
  const currency = row.currency.toUpperCase();
  return {
    rate,
    available,
    offer: {
      depositId: row.depositId,
      depositIdOnContract: row.depositIdOnContract,
      escrow: row.escrowAddress.toLowerCase(),
      platform: row.paymentPlatform,
      currency,
      rate: formatRate(rate),
      available: formatUsdc(available),
      min: formatUsdc(min),
      max: formatUsdc(max),
    },
  };
}

const byBestRate = (a: Candidate, b: Candidate) =>
  a.rate === b.rate ? (a.available > b.available ? -1 : a.available < b.available ? 1 : 0) : a.rate < b.rate ? -1 : 1;

export type CurrencyResult = { currency: string; rows: OrderbookTableRow[] } | { currency: string; error: unknown };

export function buildMarket(results: readonly CurrencyResult[], now: number): MarketResponse {
  const books: Array<MarketBook & { liquidityUnits: bigint }> = [];
  const currencies: Array<MarketCurrencySummary & { liquidityUnits: bigint }> = [];
  let partial = false;

  for (const result of results) {
    if ("error" in result) {
      partial = true;
      continue;
    }
    const candidates = result.rows.map(openOffer).filter((c): c is Candidate => c !== null);
    const byPlatform = new Map<string, Map<string, Candidate>>();
    const deposits = new Map<string, bigint>();
    for (const c of candidates) {
      // One row per deposit, platform and currency; keep the best if Curator repeats one.
      const book = byPlatform.get(c.offer.platform) ?? new Map<string, Candidate>();
      const existing = book.get(c.offer.depositId);
      if (!existing || byBestRate(c, existing) < 0) book.set(c.offer.depositId, c);
      byPlatform.set(c.offer.platform, book);
      deposits.set(c.offer.depositId, c.available);
    }
    const liquidity = [...deposits.values()].reduce((sum, v) => sum + v, 0n);
    const core = (CORE_CURRENCIES as readonly string[]).includes(result.currency);
    if (!core && liquidity < MIN_LISTED_LIQUIDITY) continue;

    const currencyBooks: Array<MarketBook & { liquidityUnits: bigint }> = [];
    for (const [platform, entries] of byPlatform) {
      const sorted = [...entries.values()].sort(byBestRate);
      const best = sorted[0];
      if (!best) continue;
      const liquidityUnits = sorted.reduce((sum, c) => sum + c.available, 0n);
      currencyBooks.push({
        platform,
        currency: result.currency,
        liquidity: formatUsdc(liquidityUnits),
        liquidityUnits,
        depositCount: sorted.length,
        best: best.offer,
        offers: sorted.slice(0, OFFERS_PER_BOOK).map((c) => c.offer),
      });
    }
    currencyBooks.sort((a, b) => (a.liquidityUnits === b.liquidityUnits ? 0 : a.liquidityUnits > b.liquidityUnits ? -1 : 1));
    books.push(...currencyBooks);

    const bestRate = candidates.reduce<bigint | null>((min, c) => (min === null || c.rate < min ? c.rate : min), null);
    currencies.push({
      currency: result.currency,
      liquidity: formatUsdc(liquidity),
      liquidityUnits: liquidity,
      depositCount: deposits.size,
      bestRate: bestRate === null ? "0" : formatRate(bestRate),
      platforms: currencyBooks.map((b) => b.platform),
    });
  }

  const order = (currency: string, liquidity: bigint) => {
    const coreIndex = (CORE_CURRENCIES as readonly string[]).indexOf(currency);
    return { coreIndex: coreIndex === -1 ? CORE_CURRENCIES.length : coreIndex, liquidity };
  };
  const compare = (a: { currency: string; liquidityUnits: bigint }, b: { currency: string; liquidityUnits: bigint }) => {
    const oa = order(a.currency, a.liquidityUnits);
    const ob = order(b.currency, b.liquidityUnits);
    if (oa.coreIndex !== ob.coreIndex) return oa.coreIndex - ob.coreIndex;
    return oa.liquidity === ob.liquidity ? a.currency.localeCompare(b.currency) : oa.liquidity > ob.liquidity ? -1 : 1;
  };
  currencies.sort(compare);
  const currencyRank = new Map(currencies.map((c, i) => [c.currency, i]));
  books.sort((a, b) => {
    const ra = currencyRank.get(a.currency) ?? 0;
    const rb = currencyRank.get(b.currency) ?? 0;
    if (ra !== rb) return ra - rb;
    return a.liquidityUnits === b.liquidityUnits ? 0 : a.liquidityUnits > b.liquidityUnits ? -1 : 1;
  });

  return {
    ok: true,
    generatedAt: now,
    partial,
    currencies: currencies.map(({ liquidityUnits: _units, ...rest }) => rest),
    books: books.map(({ liquidityUnits: _units, ...rest }) => rest),
    now,
  };
}

export async function fetchAllCurrencies(
  fetchTable: TableFetcher,
  currencies: readonly string[] = MARKET_CURRENCIES,
): Promise<CurrencyResult[]> {
  const settled = await Promise.allSettled(currencies.map((currency) => fetchTable(currency)));
  return settled.map((result, i) => {
    const currency = currencies[i]!;
    return result.status === "fulfilled" ? { currency, rows: result.value.rows } : { currency, error: result.reason };
  });
}
