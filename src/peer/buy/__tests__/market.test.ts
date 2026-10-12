import { APIError, type GetQuoteResponse, type OrderbookTableRow, type Zkp2pClient } from "@zkp2p/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  MarketError,
  QUOTE_FRESH_MS,
  getBestPricesByPlatform,
  getBuyQuotes,
  getDepositQuote,
  normalizeOrderbookRow,
  normalizeQuote,
  preferredRate,
} from "../../market";
import { BUYER, ESCROW, PAYEE_HASH, rawQuote } from "./helpers";

const EXPIRES = 1_800_000_000_000;

function quoteResponse(quotes = [rawQuote()], extra: Partial<GetQuoteResponse["responseObject"]> = {}): GetQuoteResponse {
  return {
    success: true,
    message: "ok",
    statusCode: 200,
    responseObject: {
      fiat: { currencyCode: "USD", currencyName: "USD", currencySymbol: "$", countryCode: "us" },
      token: { token: "0x", decimals: 6, name: "USD Coin", symbol: "USDC", chainId: 8453 },
      quotes: quotes as GetQuoteResponse["responseObject"]["quotes"],
      fees: { zkp2pFee: "0", zkp2pFeeFormatted: "0", swapFee: "0", swapFeeFormatted: "0" },
      quoteExpiresAt: new Date(EXPIRES).toISOString(),
      orchestratorAddress: "0x014025fde093f8701d86e9f38e2c3a9b779cb5c7",
      mode: "eligible",
      ...extra,
    },
  };
}

function clientWith(getQuote: (req: unknown) => Promise<GetQuoteResponse>) {
  const fn = vi.fn(getQuote);
  return { client: { getQuote: fn } as unknown as Zkp2pClient, getQuote: fn };
}

describe("normalizeQuote", () => {
  it("maps a live quote into a stable BuyQuote", () => {
    const quote = normalizeQuote(rawQuote(), "USD", EXPIRES);
    expect(quote).toMatchObject({
      id: `${ESCROW.toLowerCase()}:6528:revolut`,
      depositId: "6528",
      escrow: ESCROW,
      platform: "revolut",
      currency: "USD",
      fiatAmount: 50_000_000n,
      // tokenAmount (48_600_663) does not net out the 49_116 rate-manager fee the release pays.
      usdcAmount: 48_551_547n,
      signalAmount: 49_066_797n,
      rate: 1_019_019_019_019_019_035n,
      payeeHandle: "madouche",
      payeeDetailsHash: PAYEE_HASH,
      fees: { serviceBps: 95, service: 466_134n, manager: 49_116n, referrer: 0n, referrerBps: null, total: 515_250n },
      expiresAt: EXPIRES,
    });
  });

  it("carries RampRidge's integrator fee when Curator priced it in", () => {
    const quote = normalizeQuote(rawQuote({ referrerFeeAmount: "245333", referrerFeeBps: 50 }), "USD", EXPIRES);
    expect(quote?.fees.referrer).toBe(245_333n);
    expect(quote?.fees.referrerBps).toBe(50);
  });

  it("reserves the gross amount, falling back to the intent's amount, never the net", () => {
    const noSignal = rawQuote({ signalIntentAmount: undefined as unknown as string });
    expect(normalizeQuote(noSignal, "USD", EXPIRES)).toMatchObject({ signalAmount: 49_066_797n, usdcAmount: 48_551_547n });

    const neither = rawQuote({ signalIntentAmount: undefined as unknown as string });
    neither.intent = { ...neither.intent, amount: undefined as unknown as string };
    expect(normalizeQuote(neither, "USD", EXPIRES)).toBeNull();

    // A gross below the net is not a quote this app can honour.
    expect(normalizeQuote(rawQuote({ signalIntentAmount: "48000000" }), "USD", EXPIRES)).toBeNull();
  });

  it("never shows more USDC than the release pays: a rate manager's fee comes off Curator's tokenAmount", () => {
    // Live 20 EUR Revolut quote on deposit 6529 (0.1% manager fee): tokenAmount is gross less Peer's
    // and RampRidge's legs only; on a Base fork the release also paid floor(gross x 0.1%) = 22_099.
    const live = rawQuote({
      fiatAmount: "20000000",
      tokenAmount: "21778978",
      signalIntentAmount: "22099419",
      zkp2pFeeAmount: "209944",
      managerFeeAmount: "22122",
      referrerFeeAmount: "110497",
      referrerFeeBps: 50,
      totalFeeAmount: "342563",
    });
    live.intent = { ...live.intent, amount: "22099419", managerFee: "1000000000000000" } as typeof live.intent;
    expect(normalizeQuote(live, "USD", EXPIRES)).toMatchObject({
      usdcAmount: 21_756_879n,
      fees: { service: 209_944n, manager: 22_099n, referrer: 110_497n },
    });
    // No manager fee: tokenAmount is exactly what arrives.
    const plain = rawQuote({ managerFeeAmount: "0", totalFeeAmount: "466134" });
    plain.intent = { ...plain.intent, managerFee: "0" } as typeof plain.intent;
    expect(normalizeQuote(plain, "USD", EXPIRES)?.usdcAmount).toBe(48_600_663n);
  });

  it("prefers the taker rate", () => {
    expect(preferredRate(rawQuote({ takerConversionRate: "1020000000000000000" }))).toBe(1_020_000_000_000_000_000n);
    expect(preferredRate(rawQuote())).toBe(1_019_019_019_019_019_035n);
  });

  it("drops permissioned, unknown, non-live and over-cap quotes", () => {
    expect(normalizeQuote(rawQuote({ disputeProtectionRequiresStake: true }), "USD", EXPIRES)).toBeNull();
    expect(normalizeQuote(rawQuote({ whitelistEnabled: true }), "USD", EXPIRES)).toBeNull();
    expect(normalizeQuote(rawQuote({ allowedGroupIds: ["g1"] }), "USD", EXPIRES)).toBeNull();
    // Missing or malformed policy flags never count as open liquidity (Peer's canonical projection check).
    expect(normalizeQuote(rawQuote({ disputeProtectionRequiresStake: undefined as never }), "USD", EXPIRES)).toBeNull();
    expect(normalizeQuote(rawQuote({ disputeProtectionOptedOut: undefined as never }), "USD", EXPIRES)).toBeNull();
    expect(normalizeQuote(rawQuote({ whitelistEnabled: undefined as never }), "USD", EXPIRES)).toBeNull();
    expect(normalizeQuote(rawQuote({ allowedGroupIds: undefined as never }), "USD", EXPIRES)).toBeNull();
    const mercadopago = rawQuote();
    mercadopago.intent = { ...mercadopago.intent, processorName: "mercadopago" };
    expect(normalizeQuote(mercadopago, "USD", EXPIRES)).toBeNull();
    // A live platform quoted in a currency it does not take.
    const upi = rawQuote();
    upi.intent = { ...upi.intent, processorName: "upi" };
    expect(normalizeQuote(upi, "USD", EXPIRES)).toBeNull();
    expect(normalizeQuote(rawQuote(), "GBP", EXPIRES)).toBeNull();
    const venmo = rawQuote({ signalIntentAmount: "5000000001", paymentMethod: "venmo" });
    venmo.intent = { ...venmo.intent, processorName: "venmo" };
    expect(normalizeQuote(venmo, "USD", EXPIRES)).toBeNull();
    const venmoOk = rawQuote({ signalIntentAmount: "5000000000" });
    venmoOk.intent = { ...venmoOk.intent, processorName: "venmo" };
    expect(normalizeQuote(venmoOk, "USD", EXPIRES)?.platform).toBe("venmo");
  });
});

describe("getBuyQuotes", () => {
  it("asks Curator for eligible exact-fiat buyer-TEE quotes in base units", async () => {
    const before = Date.now();
    const { client, getQuote } = clientWith(async () =>
      quoteResponse([rawQuote(), rawQuote({ tokenAmount: "49525000", signalIntentAmount: "50000000" })]),
    );
    const result = await getBuyQuotes({ fiatAmount: "50", currency: "USD", recipient: BUYER, client });
    expect(getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        fiatCurrency: "USD",
        user: BUYER,
        recipient: BUYER,
        destinationChainId: 8453,
        destinationToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "50000000",
        isExactFiat: true,
        quotesToReturn: 5,
        includeNearbyQuotes: true,
        mode: "eligible",
        quotePreference: "PREFER_BUYER_TEE",
        referrerFeeConfig: { recipient: "0xC141Cbe4f4a9CAbc3cc78159a9268a4e008922CD", feeBps: 50 },
      }),
    );
    const request = getQuote.mock.calls[0]?.[0] as { paymentPlatforms: string[] } | undefined;
    const platforms = request?.paymentPlatforms ?? [];
    expect(platforms).toContain("venmo");
    expect(platforms).not.toContain("luxon");
    expect(result.quotes.map((q) => q.usdcAmount)).toEqual([49_484_750n, 48_551_547n]);
    // Curator's hour-long signature TTL is capped to the two-minute freshness window.
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + QUOTE_FRESH_MS);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + QUOTE_FRESH_MS);
  });

  it("treats Curator's 404 as no sellers", async () => {
    const { client } = clientWith(async () => {
      throw new APIError("No quotes found", 404);
    });
    const result = await getBuyQuotes({ fiatAmount: "900000", currency: "USD", client });
    expect(result.quotes).toEqual([]);
  });

  it("returns nearby amounts when nothing fills exactly", async () => {
    const { client } = clientWith(async () =>
      quoteResponse([], {
        nearbySuggestions: {
          below: [{ suggestedFiatAmount: "45000000", fiatPercentDifference: "-10.0%", quote: rawQuote() }],
          above: [],
        },
      }),
    );
    const result = await getBuyQuotes({ fiatAmount: "50", currency: "USD", client });
    expect(result.quotes).toEqual([]);
    expect(result.nearby.below[0]).toMatchObject({ fiatAmount: 45_000_000n, percentDifference: "-10.0%" });
  });

  it("validates the amount before calling Curator", async () => {
    const { client, getQuote } = clientWith(async () => quoteResponse());
    await expect(getBuyQuotes({ fiatAmount: "abc", currency: "USD", client })).rejects.toBeInstanceOf(MarketError);
    await expect(getBuyQuotes({ fiatAmount: "0.05", currency: "USD", platforms: ["venmo"], client })).rejects.toMatchObject({
      code: "amount_too_low",
    });
    await expect(getBuyQuotes({ fiatAmount: "10", currency: "EUR", platforms: ["n26"], client })).rejects.toMatchObject({
      code: "no_platforms",
    });
    expect(getQuote).not.toHaveBeenCalled();
  });

  it("finds a specific deposit's quote", async () => {
    const { client } = clientWith(async () => quoteResponse());
    const found = await getDepositQuote({
      fiatAmount: "50",
      currency: "USD",
      platform: "revolut",
      depositId: "6528",
      escrow: ESCROW,
      client,
    });
    expect(found?.depositId).toBe("6528");
    const missing = await getDepositQuote({
      fiatAmount: "50",
      currency: "USD",
      platform: "revolut",
      depositId: "1",
      escrow: ESCROW,
      client,
    });
    expect(missing).toBeNull();
  });
});

describe("price board", () => {
  it("returns one entry per live platform", async () => {
    const client = {
      getQuotesBestByPlatform: vi.fn(async () => ({
        success: true,
        message: "ok",
        statusCode: 200,
        responseObject: {
          quoteExpiresAt: new Date(EXPIRES).toISOString(),
          platformQuotes: [
            { platform: "revolut", supported: true, available: true, bestQuote: rawQuote() },
            { platform: "venmo", supported: true, available: false },
          ],
        },
      })),
    } as unknown as Zkp2pClient;
    const board = await getBestPricesByPlatform({ currency: "USD", fiatAmount: "100", client });
    expect(board.find((p) => p.platform === "revolut")).toMatchObject({ available: true });
    expect(board.find((p) => p.platform === "venmo")).toMatchObject({ available: false, quote: null });
    expect(board.some((p) => p.platform === "luxon")).toBe(false);
  });
});

describe("orderbook rows", () => {
  const row: OrderbookTableRow = {
    depositId: `${ESCROW.toLowerCase()}_5559`,
    depositIdOnContract: "5559",
    depositor: "0x0011eaa39468412f260c45397a30790e42260ded",
    escrowAddress: ESCROW.toLowerCase(),
    chainId: 8453,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    paymentPlatform: "revolut",
    paymentMethodHash: "0x",
    payeeDetailsHash: PAYEE_HASH,
    currency: "USD",
    currencyCode: "0x",
    conversionRate: "1000000000000000000",
    takerConversionRate: "1010000000000000000",
    rateManagerId: null,
    availableTokenAmount: "9966326",
    intentAmountMin: "1000000",
    intentAmountMax: "149966326",
    minFiatSupported: "1000000",
    maxFiatSupported: "149966326",
    successRateBps: 9000,
    feeBps: 95,
    apr: null,
    spread: null,
    sellerAutomatedReleaseAvailable: false,
    sellerAutomatedReleaseEnabled: false,
    whitelistEnabled: false,
    allowedGroupIds: [],
    disputeProtectionOptedOut: false,
    disputeProtectionRequiresStake: false,
    isPrivate: false,
    updatedAt: "0",
  };

  it("keeps public rows and clamps the max to what is available", () => {
    expect(normalizeOrderbookRow(row, "USD")).toMatchObject({
      depositId: "5559",
      platform: "revolut",
      rate: 1_010_000_000_000_000_000n,
      availableUsdc: 9_966_326n,
      maxUsdc: 9_966_326n,
    });
  });

  it("drops private, staked, whitelisted and unsupported rows", () => {
    expect(normalizeOrderbookRow({ ...row, isPrivate: true }, "USD")).toBeNull();
    expect(normalizeOrderbookRow({ ...row, disputeProtectionRequiresStake: true }, "USD")).toBeNull();
    expect(normalizeOrderbookRow({ ...row, whitelistEnabled: true }, "USD")).toBeNull();
    expect(normalizeOrderbookRow({ ...row, paymentPlatform: "mercadopago" }, "USD")).toBeNull();
    // A live platform listed in a currency it does not take.
    expect(normalizeOrderbookRow({ ...row, paymentPlatform: "upi" }, "USD")).toBeNull();
  });
});
