import { formatUnits } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { MarketBook, MarketResponse } from "@shared/world";
import { BUY_PLATFORMS, isBuyPlatformId, isFiatCode, isPlatformLive } from "@/peer/platforms";
import { formatUnitsTruncated } from "@/wallet/format";
import {
  REQUOTE_MS,
  buildMerchants,
  createShoutQuoter,
  formatShoutRate,
  liquidCurrencies,
  merchantShout,
  merchantTarget,
  pickBooks,
  plainShout,
  selectQuotedBooks,
  shoutFiatAmount,
  shoutUsdc,
  type CachedQuote,
  type ShoutQuote,
} from "./merchants";

function book(
  platform: string,
  currency: string,
  liquidity: number,
  rate = "0.79",
  available = String(liquidity),
  limits: { min?: string; max?: string } = {},
): MarketBook {
  const offer = {
    depositId: `0xescrow_${platform}${currency}`,
    depositIdOnContract: "1",
    escrow: "0xescrow",
    platform,
    currency,
    rate,
    available,
    min: limits.min ?? "1",
    max: limits.max ?? available,
  };
  return { platform, currency, liquidity: String(liquidity), depositCount: 1, best: offer, offers: [offer] };
}

const key = (b: MarketBook) => `${b.platform}:${b.currency}`;
const quoted = (rate = "0.78", fiatAmount = 79): ShoutQuote => ({ rate, fiatAmount });

describe("formatShoutRate", () => {
  it("shows four significant figures, rounded up so a shout never undersells the price", () => {
    expect(formatShoutRate("0.79")).toBe("0.79");
    expect(formatShoutRate("0.79121")).toBe("0.7913");
    expect(formatShoutRate("1.019")).toBe("1.019");
    expect(formatShoutRate("1.0")).toBe("1.00");
    expect(formatShoutRate("12.5")).toBe("12.50");
    expect(formatShoutRate("151.2345")).toBe("151.24");
    expect(formatShoutRate("0.5")).toBe("0.50");
  });

  it("never rounds an exact rate up because of float noise", () => {
    expect(formatShoutRate("0.7900")).toBe("0.79");
    expect(formatShoutRate("1.1")).toBe("1.10");
  });
});

describe("pickBooks", () => {
  it("takes the deepest book of each major currency first, then the deepest overall", () => {
    const books = [
      book("wise", "USD", 9_000),
      book("venmo", "USD", 8_000),
      book("cashapp", "USD", 7_000),
      book("zelle", "USD", 6_000),
      book("revolut", "EUR", 50),
      book("revolut", "GBP", 40),
      book("revolut", "AUD", 3_000),
    ];
    const picked = pickBooks(books, { max: 6 }).map(key);
    expect(picked.slice(0, 3)).toEqual(["wise:USD", "revolut:EUR", "revolut:GBP"]);
    // At most three per currency, so the fourth USD book loses to AUD.
    expect(picked).toContain("revolut:AUD");
    expect(picked.filter((p) => p.endsWith(":USD"))).toHaveLength(3);
    expect(picked).toHaveLength(6);
  });

  it("drops dust, unpriced and untradable books", () => {
    const books = [book("wise", "USD", 100, "1.0", "0.5"), book("venmo", "USD", 100, "0"), book("n26", "EUR", 500), book("revolut", "GBP", 200)];
    const picked = pickBooks(books, { isTradable: (platform) => platform !== "n26" });
    expect(picked.map((b) => b.platform)).toEqual(["revolut"]);
  });
});

describe("shoutFiatAmount", () => {
  it("prices 100 USDC at the best offer's rate, rounded up to a whole fiat unit", () => {
    // 100 x 0.79 is 79.00000000000001 in floating point; it must stay 79.
    expect(shoutFiatAmount(book("revolut", "GBP", 5_000, "0.79"))).toBe(79);
    expect(shoutFiatAmount(book("revolut", "GBP", 5_000, "0.7912"))).toBe(80);
    expect(shoutFiatAmount(book("wise", "IDR", 5_000, "16234.5"))).toBe(1_623_450);
  });

  it("is not limited by the best offer's size: Curator picks the offer that fills it", () => {
    // The launch-eve book: a small cheap Revolut offer (max about 20 USDC) on top of 8,254 USDC.
    const gbp = book("revolut", "GBP", 8_254, "0.7554", "26.5", { max: "20" });
    expect(shoutFiatAmount(gbp)).toBe(76);
    expect(shoutFiatAmount(book("revolut", "EUR", 500, "0.93", "500", { max: "50" }))).toBe(93);
  });

  it("moves up to the lowest minimum order when every listed offer asks for more", () => {
    // The Wise USD deposit from the audit: a 101 USDC minimum at 1.01.
    expect(shoutFiatAmount(book("wise", "USD", 5_000, "1.01", "5000", { min: "101" }))).toBe(103);
    const mixed = book("wise", "USD", 5_000, "1.01", "5000", { min: "250" });
    mixed.offers = [mixed.best, { ...mixed.best, depositId: "0xother", rate: "1.02", min: "150" }];
    expect(shoutUsdc(mixed)).toBe(150);
    mixed.offers.push({ ...mixed.best, depositId: "0xthird", rate: "1.03", min: "5" });
    expect(shoutUsdc(mixed)).toBe(100);
  });

  it("returns null for a book with no price", () => {
    expect(shoutFiatAmount(book("revolut", "EUR", 500, "0"))).toBeNull();
  });
});

describe("selectQuotedBooks", () => {
  it("keeps only books Curator can quote, filling a dropped slot with the next book", async () => {
    const books = [book("wise", "USD", 9_000), book("venmo", "USD", 8_000), book("revolut", "EUR", 500), book("revolut", "GBP", 400), book("revolut", "AUD", 300)];
    const quote = vi.fn((b: MarketBook) => Promise.resolve(b.platform === "venmo" ? null : quoted()));
    const chosen = await selectQuotedBooks(books, quote, { max: 4 });
    expect(chosen.map((c) => key(c.book))).toEqual(["wise:USD", "revolut:EUR", "revolut:GBP", "revolut:AUD"]);
    expect(quote).toHaveBeenCalledTimes(5);
  });

  it("gives a major currency its next book when its deepest one can't be quoted", async () => {
    const books = [book("wise", "USD", 9_000), book("revolut", "AUD", 5_000), book("revolut", "GBP", 400), book("monzo", "GBP", 300), book("wise", "CAD", 4_000)];
    const quote = (b: MarketBook) => Promise.resolve(key(b) === "revolut:GBP" ? null : quoted());
    const chosen = await selectQuotedBooks(books, quote, { max: 3 });
    expect(chosen.map((c) => key(c.book))).toEqual(["wise:USD", "revolut:AUD", "monzo:GBP"]);
  });

  it("treats a failed quote as no quote and caps the number of books tried", async () => {
    const books = Array.from({ length: 10 }, (_, i) => book(`p${i}`, `C${i}`, 1_000 - i));
    const quote = vi.fn(() => Promise.reject(new Error("Curator down")));
    expect(await selectQuotedBooks(books, quote, { max: 3, maxAttempts: 5 })).toEqual([]);
    expect(quote).toHaveBeenCalledTimes(5);
  });

  it("skips books too small for a shout-sized order without asking Curator", async () => {
    const books = [book("wise", "USD", 9_000), book("revolut", "GBP", 60), book("monzo", "GBP", 400)];
    const quote = vi.fn(() => Promise.resolve(quoted()));
    const chosen = await selectQuotedBooks(books, quote, { max: 3 });
    expect(chosen.map((c) => key(c.book))).toEqual(["wise:USD", "monzo:GBP"]);
    expect(quote).toHaveBeenCalledTimes(2);
  });

  it("never gives one currency more than three merchants", async () => {
    const books = ["wise", "venmo", "cashapp", "zelle", "paypal"].map((p, i) => book(p, "USD", 1_000 - i));
    const chosen = await selectQuotedBooks(books, () => Promise.resolve(quoted()), { max: 5 });
    expect(chosen).toHaveLength(3);
  });
});

describe("createShoutQuoter", () => {
  const quiet = { warn: vi.fn() };
  const gbp = book("revolut", "GBP", 5_000, "0.7705");

  it("quotes the shout amount and turns Curator's 18-decimal rate into a decimal string", async () => {
    const getQuote = vi.fn(() => Promise.resolve(778_000_000_000_000_000n));
    const { quote } = createShoutQuoter(new Map(), getQuote, { log: quiet });
    expect(await quote(gbp)).toEqual({ fiatAmount: 78, rate: "0.778" });
    expect(getQuote).toHaveBeenCalledWith(gbp, 78);
  });

  it("reuses a quote until the best offer changes or it is three minutes old", async () => {
    let t = 0;
    const cache = new Map<string, CachedQuote>();
    const getQuote = vi.fn(() => Promise.resolve(780_000_000_000_000_000n));
    const make = () => createShoutQuoter(cache, getQuote, { now: () => t, log: quiet }).quote;
    await make()(gbp);
    t = REQUOTE_MS - 1;
    await make()(gbp);
    expect(getQuote).toHaveBeenCalledTimes(1);
    await make()(book("revolut", "GBP", 5_000, "0.7710"));
    expect(getQuote).toHaveBeenCalledTimes(2);
    t += REQUOTE_MS;
    await make()(book("revolut", "GBP", 5_000, "0.7710"));
    expect(getQuote).toHaveBeenCalledTimes(3);
  });

  it("quotes again when the shout amount moves with an offer other than the best", async () => {
    const getQuote = vi.fn(() => Promise.resolve(1_020_000_000_000_000_000n));
    const { quote } = createShoutQuoter(new Map(), getQuote, { log: quiet });
    const usd = book("wise", "USD", 5_000, "1.01", "5000", { min: "150" });
    usd.offers = [usd.best, { ...usd.best, depositId: "0xother", min: "120" }];
    expect(await quote(usd)).toEqual({ fiatAmount: 122, rate: "1.02" });
    usd.offers = [usd.best, { ...usd.best, depositId: "0xother", min: "1" }];
    expect(await quote(usd)).toEqual({ fiatAmount: 101, rate: "1.02" });
    expect(getQuote).toHaveBeenCalledTimes(2);
  });

  it("remembers that a book has no quote", async () => {
    const getQuote = vi.fn(() => Promise.resolve(null));
    const { quote } = createShoutQuoter(new Map(), getQuote, { log: quiet });
    expect(await quote(gbp)).toBeNull();
    expect(await quote(gbp)).toBeNull();
    expect(getQuote).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last quote for the same offer while Curator is failing, and counts the failure", async () => {
    let t = 0;
    const cache = new Map<string, CachedQuote>();
    const ok = createShoutQuoter(cache, () => Promise.resolve(780_000_000_000_000_000n), { now: () => t, log: quiet });
    await ok.quote(gbp);
    t = REQUOTE_MS + 1;
    const down = createShoutQuoter(cache, () => Promise.reject(new Error("timeout")), { now: () => t, log: quiet });
    expect(await down.quote(gbp)).toEqual({ fiatAmount: 78, rate: "0.78" });
    expect(await down.quote(book("wise", "EUR", 500, "0.93"))).toBeNull();
    expect(down.stats.failed).toBe(2);
  });
});

describe("buildMerchants", () => {
  it("names traders by platform, adding the currency only when a platform appears twice", () => {
    const merchants = buildMerchants([
      { book: book("wise", "USD", 300), quote: quoted("1.02", 102) },
      { book: book("revolut", "EUR", 400), quote: quoted("0.94", 94) },
      { book: book("revolut", "GBP", 500), quote: quoted("0.79", 79) },
    ]);
    expect(merchants.map((m) => m.spec.name)).toEqual(["Wise trader", "Revolut EUR trader", "Revolut GBP trader"]);
    expect(merchants.map((m) => m.fiatAmount)).toEqual([102, 94, 79]);
    for (const { spec } of merchants) {
      expect(spec.seed).toBe(spec.id);
      expect(spec.platform).toBe(spec.platform.toLowerCase());
      expect(spec.currency).toBe(spec.currency.toUpperCase());
    }
  });

  it("builds the short shouts on request, keeping ids, names and amounts", () => {
    const quotes = [{ book: book("revolut", "GBP", 500), quote: quoted("0.7554", 76) }];
    const [long] = buildMerchants(quotes, 2);
    const [short] = buildMerchants(quotes, 2, { short: true });
    expect(long!.spec.shout).toMatch(/:Selling USDC @ 0\.7554 GBP on Revolut!$/);
    expect(short!.spec.shout).toMatch(/:0\.7554 GBP Revolut!$/);
    expect({ ...short!.spec, shout: "" }).toEqual({ ...long!.spec, shout: "" });
    expect(short!.fiatAmount).toBe(long!.fiatAmount);
  });

  it("opens the trade window at the amount the shout was quoted for", () => {
    const [merchant] = buildMerchants([{ book: book("revolut", "GBP", 500), quote: quoted("0.78", 79) }]);
    expect(merchantTarget(merchant!)).toEqual({
      kind: "merchant",
      merchantId: "revolut:GBP",
      name: "Revolut trader",
      platform: "revolut",
      currency: "GBP",
      fiatAmount: 79,
    });
  });
});

describe("merchantShout", () => {
  it("shouts the quoted rate (not the book's) and no size, with an effect prefix", () => {
    const shout = merchantShout(book("revolut", "GBP", 5_240.75, "0.7705"), "0.77791");
    expect(shout).toMatch(/^[a-z0-9]+:[a-z0-9]+:Selling USDC @ 0\.778 GBP on Revolut!$/);
  });

  it("rounds the price in the buyer's disfavour", () => {
    expect(merchantShout(book("revolut", "GBP", 5_000), "0.75531")).toMatch(/:Selling USDC @ 0\.7554 GBP on Revolut!$/);
  });

  it("has a short form for phones with the same style", () => {
    const b = book("revolut", "GBP", 5_000);
    const long = merchantShout(b, "0.75531", 4);
    const short = merchantShout(b, "0.75531", 4, { short: true });
    expect(short).toMatch(/^[a-z0-9]+:[a-z0-9]+:0\.7554 GBP Revolut!$/);
    expect(short.split(":").slice(0, 2)).toEqual(long.split(":").slice(0, 2));
    expect(merchantShout(book("cashapp", "USD", 900), "1.0123", 0, { short: true })).toMatch(/:1\.013 USD Cash App!$/);
  });

  it("only uses motions that keep the shout readable", () => {
    const motions = new Set(Array.from({ length: 40 }, (_, round) => merchantShout(book("wise", "EUR", 800), "0.93", round).split(":")[1]));
    expect([...motions].sort()).toEqual(["wave", "wave2"]);
  });

  it("keeps a merchant's shout style for a round and varies it between rounds", () => {
    const b = book("wise", "EUR", 800);
    expect(merchantShout(b, "0.93", 3)).toBe(merchantShout(b, "0.93", 3));
    const styles = new Set(Array.from({ length: 12 }, (_, round) => merchantShout(b, "0.93", round).split(":").slice(0, 2).join(":")));
    expect(styles.size).toBeGreaterThan(1);
  });
});

describe("plainShout", () => {
  it("strips colour and motion so the text shows plain yellow", () => {
    expect(plainShout("red:wave:Selling 5 USDC!")).toBe("yellow:Selling 5 USDC!");
    expect(plainShout("Selling 5 USDC!")).toBe("yellow:Selling 5 USDC!");
  });
});

describe("liquidCurrencies", () => {
  it("lists listed currencies with a tradable book that has liquidity", () => {
    const market: Pick<MarketResponse, "books" | "currencies"> = {
      currencies: ["USD", "EUR", "GBP", "JPY"].map((currency) => ({ currency, liquidity: "1", depositCount: 1, bestRate: "1", platforms: [] })),
      books: [book("wise", "USD", 500), book("n26", "EUR", 500), book("revolut", "GBP", 0.5, "0.79", "0.5"), book("wise", "JPY", 900, "150"), book("wise", "MXN", 900, "18")],
    };
    const liquid = liquidCurrencies(market, (platform) => platform !== "n26");
    // EUR only trades on an untradable platform, GBP is dust, MXN isn't in the summary.
    expect([...liquid].sort()).toEqual(["JPY", "USD"]);
  });
});

describe("Alipay and UPI merchants", () => {
  // The same rule useMerchants applies: only a live buy platform and a currency it takes get a merchant.
  const tradable = (platform: string, currency: string) => {
    const id = platform.toLowerCase();
    const code = currency.toUpperCase();
    return isBuyPlatformId(id) && isPlatformLive(id) && isFiatCode(code) && BUY_PLATFORMS[id].currencies.includes(code);
  };
  const alipay = book("alipay", "CNY", 2_400, "7.1234");
  const upi = book("upi", "INR", 1_800, "88.4321");

  it("passes the tradable filter for Alipay in CNY and UPI in INR only", () => {
    expect(tradable("alipay", "CNY")).toBe(true);
    expect(tradable("upi", "INR")).toBe(true);
    expect(tradable("alipay", "USD")).toBe(false);
    expect(tradable("upi", "CNY")).toBe(false);
    const picked = pickBooks([book("venmo", "USD", 9_000), alipay, upi, book("n26", "EUR", 9_000)], { isTradable: tradable }).map(key);
    expect(picked).toEqual(expect.arrayContaining(["alipay:CNY", "upi:INR"]));
    expect(picked).not.toContain("n26:EUR");
  });

  it("quotes a shout-sized order in whole yuan and rupees", () => {
    expect(shoutFiatAmount(alipay)).toBe(713);
    expect(shoutFiatAmount(upi)).toBe(8_844);
  });

  it("shouts small and large rates to four significant figures, rounded against the buyer", async () => {
    const quotedBooks = await selectQuotedBooks([alipay, upi], async (b) => quoted(b.best.rate, shoutFiatAmount(b)!), { isTradable: tradable });
    const merchants = buildMerchants(quotedBooks, 1);
    const byId = new Map(merchants.map((m) => [m.spec.id, m]));
    expect(byId.get("alipay:CNY")?.spec.name).toBe("Alipay trader");
    expect(byId.get("upi:INR")?.spec.name).toBe("UPI trader");
    expect(byId.get("alipay:CNY")?.spec.shout).toMatch(/^[a-z0-9]+:[a-z0-9]+:Selling USDC @ 7\.124 CNY on Alipay!$/);
    expect(byId.get("upi:INR")?.spec.shout).toMatch(/^[a-z0-9]+:[a-z0-9]+:Selling USDC @ 88\.44 INR on UPI!$/);
    expect(byId.get("upi:INR")?.fiatAmount).toBe(8_844);
    expect(merchantShout(alipay, "7.1", 0, { short: true })).toMatch(/:7\.10 CNY Alipay!$/);
    expect(merchantShout(upi, "88.4", 0, { short: true })).toMatch(/:88\.40 INR UPI!$/);
  });

  it("names the currency when a platform trades two", () => {
    const merchants = buildMerchants([
      { book: upi, quote: quoted("88.44", 8_844) },
      { book: book("wise", "INR", 900, "88.1"), quote: quoted("88.10", 8_810) },
      { book: book("wise", "CNY", 900, "7.12"), quote: quoted("7.12", 712) },
    ]);
    expect(merchants.map((m) => m.spec.name)).toEqual(["UPI trader", "Wise INR trader", "Wise CNY trader"]);
  });

  it("counts CNY and INR as liquid currencies", () => {
    const market: Pick<MarketResponse, "books" | "currencies"> = {
      currencies: ["CNY", "INR"].map((currency) => ({ currency, liquidity: "1", depositCount: 1, bestRate: "1", platforms: [] })),
      books: [alipay, upi],
    };
    expect([...liquidCurrencies(market, tradable)].sort()).toEqual(["CNY", "INR"]);
  });
});

describe("Curator rate text", () => {
  // merchants.ts formats rates with formatUnitsTruncated so the title's download doesn't carry viem.
  it("matches viem's formatUnits for 18-decimal rates", () => {
    const rates = [1n, 5n, 10n ** 17n + 1n, 10n ** 18n, 790_000_000_000_000_000n, 893_375_000_000_000_000n, 1_234_567_890_123_456_789_012n];
    for (let i = 1n; i < 400n; i++) rates.push(i * 7_919_000_000_013n * i);
    for (const rate of rates) expect(formatUnitsTruncated(rate, 18, { grouping: false })).toBe(formatUnits(rate, 18));
  });
});
