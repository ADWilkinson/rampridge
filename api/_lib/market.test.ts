import type { OrderbookTableRow } from "@zkp2p/sdk";
import { describe, expect, it } from "vitest";
import {
  createMarketHandler,
  MARKET_BUILD_LEASE_MS,
  MARKET_BUILD_PATH,
  MARKET_CACHE_CONTROL,
  MARKET_CACHE_PATH,
  MARKET_FRESH_MS,
} from "./handlers/market";
import type { TableFetcher } from "./market";
import { MARKET_CURRENCIES, buildMarket, fetchAllCurrencies, openOffer } from "./market";
import type { MarketResponse } from "../../shared/world";
import { readBody, testDeps } from "./testing";

const ESCROW = "0x777777779d229cdf3110e9de47943791c26300ef";
const E18 = 10n ** 18n;

function row(overrides: Partial<OrderbookTableRow> & { id: number; currency: string; rate: string }): OrderbookTableRow {
  const { id, currency, rate, ...rest } = overrides;
  return {
    depositId: `${ESCROW}_${id}`,
    depositIdOnContract: String(id),
    depositor: "0x0000000000000000000000000000000000000abc",
    escrowAddress: ESCROW,
    chainId: 8453,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    paymentPlatform: "revolut",
    paymentMethodHash: "0x01",
    payeeDetailsHash: "0x02",
    currency,
    currencyCode: "0x03",
    conversionRate: rate,
    takerConversionRate: rate,
    rateManagerId: null,
    availableTokenAmount: "50000000",
    intentAmountMin: "1000000",
    intentAmountMax: "200000000",
    minFiatSupported: "1000000",
    maxFiatSupported: "200000000",
    successRateBps: 10_000,
    feeBps: 0,
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
    ...rest,
  };
}

describe("openOffer", () => {
  it("normalises a fillable row and caps max at the available amount", () => {
    const candidate = openOffer(row({ id: 1, currency: "gbp", rate: String((79n * E18) / 100n) }));
    expect(candidate?.offer).toEqual({
      depositId: `${ESCROW}_1`,
      depositIdOnContract: "1",
      escrow: ESCROW,
      platform: "revolut",
      currency: "GBP",
      rate: "0.79",
      available: "50",
      min: "1",
      max: "50",
    });
  });

  it("drops rows that need stake, a whitelist, a private group, or cannot fill the minimum", () => {
    const base = { id: 1, currency: "USD", rate: String(E18) };
    expect(openOffer(row({ ...base, disputeProtectionRequiresStake: true }))).toBeNull();
    expect(openOffer(row({ ...base, whitelistEnabled: true }))).toBeNull();
    expect(openOffer(row({ ...base, allowedGroupIds: ["0xabc"] }))).toBeNull();
    expect(openOffer(row({ ...base, isPrivate: true }))).toBeNull();
    expect(openOffer(row({ ...base, availableTokenAmount: "500000" }))).toBeNull();
    expect(openOffer(row({ ...base, rate: "0" }))).toBeNull();
  });
});

describe("buildMarket", () => {
  it("groups by platform and currency, best rate first, with totals", () => {
    const market = buildMarket(
      [
        {
          currency: "GBP",
          rows: [
            row({ id: 1, currency: "GBP", rate: String((80n * E18) / 100n) }),
            row({ id: 2, currency: "GBP", rate: String((78n * E18) / 100n), availableTokenAmount: "10000000" }),
            row({ id: 2, currency: "GBP", rate: String((78n * E18) / 100n), paymentPlatform: "wise", availableTokenAmount: "10000000" }),
            row({ id: 3, currency: "GBP", rate: String((77n * E18) / 100n), whitelistEnabled: true }),
          ],
        },
        { currency: "USD", rows: [row({ id: 9, currency: "USD", rate: String(E18), paymentPlatform: "zelle" })] },
        { currency: "JPY", rows: [row({ id: 10, currency: "JPY", rate: String(150n * E18) })] },
        {
          currency: "MXN",
          rows: [row({ id: 11, currency: "MXN", rate: String(18n * E18), availableTokenAmount: "500000000" })],
        },
        { currency: "EUR", error: new Error("timeout") },
      ],
      123,
    );

    expect(market.ok).toBe(true);
    expect(market.partial).toBe(true);
    expect(market.generatedAt).toBe(123);
    // Core currencies first; JPY is below the liquidity threshold; MXN is above it.
    expect(market.currencies.map((c) => c.currency)).toEqual(["USD", "GBP", "MXN"]);

    const gbp = market.currencies.find((c) => c.currency === "GBP")!;
    expect(gbp).toEqual({ currency: "GBP", liquidity: "60", depositCount: 2, bestRate: "0.78", platforms: ["revolut", "wise"] });

    const revolut = market.books.find((b) => b.currency === "GBP" && b.platform === "revolut")!;
    expect(revolut.best.depositIdOnContract).toBe("2");
    expect(revolut.offers.map((o) => o.depositIdOnContract)).toEqual(["2", "1"]);
    expect(revolut.liquidity).toBe("60");
    expect(revolut.depositCount).toBe(2);
    expect(market.books[0]!.currency).toBe("USD");
  });
});

describe("GET /api/market", () => {
  it("serves an edge-cacheable book", async () => {
    const deps = testDeps({
      fetchTable: async (currency) => ({
        chainId: 8453,
        token: "USDC",
        currency,
        paymentPlatform: null,
        mode: "eligible",
        takerAddress: null,
        sortBy: "price",
        sortDirection: "asc",
        sellerAutomatedRelease: "include",
        generatedAt: "",
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
        rows: currency === "USD" ? [row({ id: 1, currency: "USD", rate: String(E18) })] : [],
      }),
    });
    const response = await createMarketHandler(deps)(new Request("https://www.rampridge.xyz/api/market"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(MARKET_CACHE_CONTROL);
    const body = await readBody<MarketResponse>(response);
    expect(body.partial).toBe(false);
    expect(body.books).toHaveLength(1);
    expect(body.currencies.map((c) => c.currency)).toEqual(["USD", "EUR", "GBP"]);
  });

  it("returns 502 when the orderbook is unreachable", async () => {
    const deps = testDeps();
    const response = await createMarketHandler(deps)(new Request("https://www.rampridge.xyz/api/market"));
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  describe("server-side cache", () => {
    const MARKET_URL = "https://www.rampridge.xyz/api/market";
    let calls = 0;
    let down = false;
    const fetchTable: TableFetcher = async (currency) => {
      calls++;
      if (down) throw new Error("Curator throttled");
      return {
        chainId: 8453,
        token: "USDC",
        currency,
        paymentPlatform: null,
        mode: "eligible",
        takerAddress: null,
        sortBy: "price",
        sortDirection: "asc",
        sellerAutomatedRelease: "include",
        generatedAt: "",
        pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
        rows: currency === "USD" ? [row({ id: 1, currency: "USD", rate: String(E18) })] : [],
      };
    };
    const currencyCount = async () => {
      const before = calls;
      await createMarketHandler(testDeps({ fetchTable }))(new Request(MARKET_URL));
      return calls - before;
    };

    it("builds once, then serves the stored copy to every instance until it is stale", async () => {
      calls = 0;
      down = false;
      const perBuild = await currencyCount();
      expect(perBuild).toBe(MARKET_CURRENCIES.length);

      const deps = testDeps({ fetchTable });
      const first = createMarketHandler(deps);
      const second = createMarketHandler(deps);
      calls = 0;
      expect((await first(new Request(MARKET_URL))).status).toBe(200);
      expect(calls).toBe(perBuild);
      expect(deps.memory.read(MARKET_CACHE_PATH)).toMatchObject({ at: deps.clock.now, partial: false });

      deps.clock.now += 20_000;
      const cached = await second(new Request(MARKET_URL));
      expect(calls).toBe(perBuild);
      expect(cached.headers.get("cache-control")).toBe("public, s-maxage=10, stale-while-revalidate=120");
      const body = await readBody<MarketResponse>(cached);
      expect(body).toMatchObject({ ok: true, partial: false, generatedAt: deps.clock.now - 20_000, now: deps.clock.now });

      // Stale: exactly one caller rebuilds; another instance that loses the claim gets the stale copy.
      deps.clock.now += MARKET_FRESH_MS;
      deps.memory.write(MARKET_BUILD_PATH, deps.clock.now);
      const stale = await createMarketHandler(deps)(new Request(MARKET_URL));
      expect(stale.status).toBe(200);
      expect(stale.headers.get("cache-control")).toBe("public, s-maxage=5, stale-while-revalidate=30");
      expect(calls).toBe(perBuild);
      deps.clock.now += MARKET_BUILD_LEASE_MS;
      await createMarketHandler(deps)(new Request(MARKET_URL));
      expect(calls).toBe(perBuild * 2);
    });

    it("serves the last good book, marked partial, while Curator is down", async () => {
      down = false;
      const deps = testDeps({ fetchTable });
      await createMarketHandler(deps)(new Request(MARKET_URL));
      down = true;
      deps.clock.now += MARKET_FRESH_MS;
      const response = await createMarketHandler(deps)(new Request(MARKET_URL));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, s-maxage=5, stale-while-revalidate=30");
      const body = await readBody<MarketResponse>(response);
      expect(body.partial).toBe(true);
      expect(body.books).toHaveLength(1);
      // The failed build keeps its lease, so the next caller does not hammer Curator again.
      calls = 0;
      expect((await createMarketHandler(deps)(new Request(MARKET_URL))).status).toBe(200);
      expect(calls).toBe(0);
    });

    it("waits for another instance's first build instead of starting its own", async () => {
      down = false;
      calls = 0;
      const deps = testDeps({ fetchTable });
      deps.memory.write(MARKET_BUILD_PATH, deps.clock.now);
      const built = testDeps({ fetchTable });
      await createMarketHandler(built)(new Request(MARKET_URL));
      const stored = built.memory.read(MARKET_CACHE_PATH);
      calls = 0;
      let polls = 0;
      const handler = createMarketHandler(deps, {
        sleep: async (ms) => {
          deps.clock.now += ms;
          if (++polls === 3) deps.memory.write(MARKET_CACHE_PATH, stored);
        },
      });
      const response = await handler(new Request(MARKET_URL));
      expect(response.status).toBe(200);
      expect(polls).toBe(3);
      expect(calls).toBe(0);
    });

    it("redirects query strings to the canonical URL without building", async () => {
      calls = 0;
      const deps = testDeps({ fetchTable });
      const response = await createMarketHandler(deps)(new Request(`${MARKET_URL}?x=${Math.random()}`));
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("/api/market");
      expect(calls).toBe(0);
      expect(deps.memory.read(MARKET_CACHE_PATH)).toBeNull();
    });
  });

  it("fetches every currency even when some fail", async () => {
    const results = await fetchAllCurrencies(async (c) => {
      if (c === "EUR") throw new Error("down");
      return { rows: [] } as never;
    }, ["USD", "EUR"]);
    expect(results).toEqual([{ currency: "USD", rows: [] }, { currency: "EUR", error: expect.any(Error) }]);
  });
});
