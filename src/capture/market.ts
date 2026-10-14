/**
 * A Curator stand-in for the capture harness priced at the frozen live book
 * (fixtures.ts): quotes carry Peer's 0.95% fee plus RampRidge's 0.5%, exactly
 * as the buy harness fixtures do, but at the real rates of the day.
 */
import type { Address } from "viem";
import { RATE_ONE, tryParseAmount } from "@/peer/format";
import type { BuyQuote, BuyQuoteResult, GetBuyQuotesParams, PlatformPrice } from "@/peer/market";
import { platformsForCurrency, type BuyPlatformId, type FiatCode } from "@/peer/platforms";
import { fixtureQuote } from "@/ui/interfaces/buy/simulated";
import { BOOKS, liveRate } from "./fixtures";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A patterned, obviously synthetic seller wallet: no real address appears on screen. */
export const DEMO_SELLER = "0xa11ce000000000000000000000000000000a11ce" as Address;
/** The payee handle every demo order shows (and the Payment scroll's QR encodes). */
export const DEMO_HANDLE = "rampridge";

function scrub(quote: BuyQuote): BuyQuote {
  return { ...quote, seller: DEMO_SELLER, payeeHandle: DEMO_HANDLE };
}

function rateFor(currency: FiatCode, platform: BuyPlatformId, worse = 1): bigint {
  const value = (liveRate(platform, currency) ?? liveRate("revolut", currency) ?? 1) * worse;
  return (BigInt(Math.round(value * 1e6)) * RATE_ONE) / 1_000_000n;
}

export interface CaptureTiming {
  quoteMs: number;
}

export function captureMarket(timing: CaptureTiming) {
  const fiatOf = (amount: string | bigint) => (typeof amount === "bigint" ? amount : (tryParseAmount(amount, 6) ?? 0n));
  const quotes = async (params: GetBuyQuotesParams): Promise<BuyQuoteResult> => {
    await wait(timing.quoteMs);
    const fiat = fiatOf(params.fiatAmount);
    const platforms = params.platforms ?? platformsForCurrency(params.currency).map((p) => p.id);
    const expiresAt = Date.now() + 90_000;
    const list = platforms.flatMap((platform, i) => [
      fixtureQuote({ fiat, currency: params.currency, platform, depositId: String(6528 + i), rate: rateFor(params.currency, platform), expiresAt }),
      fixtureQuote({ fiat, currency: params.currency, platform, depositId: String(6600 + i), rate: rateFor(params.currency, platform, 1.006), expiresAt, successBps: 9_120 }),
    ]);
    list.sort((a, b) => (a.usdcAmount > b.usdcAmount ? -1 : 1));
    return { fiatAmount: fiat, currency: params.currency, quotes: list.slice(0, params.quotesToReturn ?? 5).map(scrub), nearby: { below: [], above: [] }, expiresAt };
  };

  const getBestPricesByPlatform = async (params: { currency: FiatCode; fiatAmount: string | bigint }): Promise<PlatformPrice[]> => {
    await wait(timing.quoteMs);
    const fiat = fiatOf(params.fiatAmount);
    return platformsForCurrency(params.currency).map((p, i) => {
      const available = BOOKS.some((b) => b.platform === p.id && b.currency === params.currency);
      return {
        platform: p.id,
        available,
        quote: available ? scrub(fixtureQuote({ fiat, currency: params.currency, platform: p.id, depositId: String(6528 + i), rate: rateFor(params.currency, p.id) })) : null,
      };
    });
  };

  const getDepositQuote = async (params: GetBuyQuotesParams & { platform: BuyPlatformId; depositId: string; escrow: Address }): Promise<BuyQuote | null> => {
    await wait(timing.quoteMs);
    return scrub(
      fixtureQuote({
        fiat: fiatOf(params.fiatAmount),
        currency: params.currency,
        platform: params.platform,
        depositId: params.depositId,
        rate: rateFor(params.currency, params.platform),
        successBps: 10_000,
      }),
    );
  };

  return { quotes, getBestPricesByPlatform, getDepositQuote };
}
