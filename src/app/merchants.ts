import type { MarketBook, MarketResponse } from "@shared/world";
import { platformName } from "@/game/menu";
import type { MerchantSpec } from "@/game/types";
import type { MerchantTarget } from "@/ui/interfaces/context";
// Not viem's formatUnits: importing viem here would put it in the title's download (same text, merchants.test.ts).
import { formatUnitsTruncated } from "@/wallet/format";

/**
 * Turns the live market book (GET /api/market) into merchant NPCs: one per
 * platform and currency with real liquidity, each shouting its price the way
 * traders advertised in the original ("Selling USDC @ 0.7554 GBP on
 * Revolut!", or "0.7554 GBP Revolut!" on a phone).
 *
 * The book only says which deposits exist. The price a buyer actually gets
 * comes from a Curator quote, which can differ from the book's best row
 * (order limits, eligibility, fees), so a merchant only appears once a quote
 * for a typical order (SHOUT_USDC) has come back, and it shouts that quote's
 * rate. Its trade window opens at the same amount, so the window shows the
 * price the merchant shouted. Pure apart from the injected quote function, so
 * the selection is testable.
 */

export const MAX_MERCHANTS = 8;
/** Currencies that always get a merchant when one of their books can be quoted. */
export const ANCHOR_CURRENCIES = ["USD", "EUR", "GBP"] as const;
/** No single currency takes more than this many of the merchant slots. */
export const MAX_PER_CURRENCY = 3;
/** USDC a merchant's shout is quoted for: a typical first order. */
export const SHOUT_USDC = 100;
/** A merchant's quote is reused until its book's best offer changes, or for this long. */
export const REQUOTE_MS = 3 * 60_000;
/** Curator rates are fiat per USDC with 18 decimals. */
const RATE_DECIMALS = 18;

const COLOURS = ["yellow", "red", "green", "cyan", "purple", "white", "glow1", "flash1"] as const;
// Only the motions that keep a shout readable: "scroll" clips and "shake" breaks a long shout into fragments.
const MOTIONS = ["wave", "wave2"] as const;

export function merchantId(platform: string, currency: string): string {
  return `${platform.toLowerCase()}:${currency.toUpperCase()}`;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function amount(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A rate to four significant figures (two decimals at 100 and above),
 * rounded up so a shout never shows a better price than the quote has.
 */
export function formatShoutRate(rate: string): string {
  const n = amount(rate);
  if (n <= 0) return rate;
  const decimals = n >= 100 ? 2 : Math.max(0, 3 - Math.floor(Math.log10(n)));
  const factor = 10 ** decimals;
  const up = Math.ceil(Math.round(n * factor * 1e6) / 1e6) / factor;
  const text = up.toFixed(decimals);
  // Trim trailing zeros past two decimals: 0.7900 -> 0.79, 1.0190 -> 1.019.
  return decimals > 2 ? text.replace(/(\.\d{2}\d*?)0+$/, "$1") : text;
}

/** A book that can carry a merchant: real liquidity, a price, and a platform and currency the buy flow trades. */
function usableBooks(books: readonly MarketBook[], tradable: (platform: string, currency: string) => boolean): MarketBook[] {
  return books
    .filter((b) => amount(b.best.available) >= 1 && amount(b.best.rate) > 0 && tradable(b.platform, b.currency))
    .sort((a, b) => amount(b.liquidity) - amount(a.liquidity) || merchantId(a.platform, a.currency).localeCompare(merchantId(b.platform, b.currency)));
}

/**
 * The next books to try for up to `slots` merchants, given the ones already
 * taken: the deepest remaining book of each major currency that has no
 * merchant yet, then the deepest remaining overall, never more than
 * MAX_PER_CURRENCY of one currency. `remaining` must be deepest first.
 */
export function nextBooks(remaining: readonly MarketBook[], taken: readonly MarketBook[], slots: number): MarketBook[] {
  const counts = new Map<string, number>();
  for (const b of taken) counts.set(b.currency.toUpperCase(), (counts.get(b.currency.toUpperCase()) ?? 0) + 1);
  const batch: MarketBook[] = [];
  const add = (book: MarketBook) => {
    const currency = book.currency.toUpperCase();
    if (batch.length >= slots || batch.includes(book) || (counts.get(currency) ?? 0) >= MAX_PER_CURRENCY) return;
    batch.push(book);
    counts.set(currency, (counts.get(currency) ?? 0) + 1);
  };
  for (const currency of ANCHOR_CURRENCIES) {
    if ((counts.get(currency) ?? 0) > 0) continue;
    const top = remaining.find((b) => b.currency.toUpperCase() === currency);
    if (top) add(top);
  }
  for (const book of remaining) add(book);
  return batch;
}

/** Picks the books that get a merchant when every book can be quoted (the order merchants are tried in). */
export function pickBooks(
  books: readonly MarketBook[],
  options: { max?: number; isTradable?: (platform: string, currency: string) => boolean } = {},
): MarketBook[] {
  return nextBooks(usableBooks(books, options.isTradable ?? (() => true)), [], options.max ?? MAX_MERCHANTS);
}

/** The price a merchant shouts: what Curator quoted for a typical order on its book. */
export interface ShoutQuote {
  /** Fiat the quote was for, in display units of the book's currency (what the trade window opens at). */
  fiatAmount: number;
  /** Fiat per USDC the quote gives, as a decimal string. */
  rate: string;
}

export interface QuotedBook {
  book: MarketBook;
  quote: ShoutQuote;
}

/**
 * USDC a book's shout is quoted for: SHOUT_USDC, or the lowest minimum order
 * among its listed offers when every one of them asks for more.
 */
export function shoutUsdc(book: MarketBook): number {
  const offers = Array.isArray(book.offers) && book.offers.length > 0 ? book.offers : [book.best];
  return Math.max(SHOUT_USDC, Math.min(...offers.map((o) => amount(o.min))));
}

/**
 * Fiat to quote a book at: shoutUsdc priced at the best offer's rate and
 * rounded up to a whole fiat unit. Not limited to the best offer's size:
 * Curator picks whichever offer fills the order, so one small cheap offer
 * can't set a price that only holds for a few dollars. Null when the book
 * has no price.
 */
export function shoutFiatAmount(book: MarketBook): number | null {
  const rate = amount(book.best.rate);
  if (rate <= 0) return null;
  // toFixed strips float noise (100 x 0.79 is 79.00000000000001) before rounding to a whole unit.
  const fiat = Math.ceil(Number((shoutUsdc(book) * rate).toFixed(6)));
  return fiat > 0 ? fiat : null;
}

/** Whether a book holds enough USDC in all for a shout-sized order (one deposit fills an order, so a smaller book can't). */
function canFillShout(book: MarketBook): boolean {
  return amount(book.liquidity) >= shoutUsdc(book);
}

export interface SelectOptions {
  max?: number;
  /** Most books to try in one selection, so a market with many unquotable books stays cheap. */
  maxAttempts?: number;
}

/**
 * Chooses up to `max` books that Curator can quote for a shout-sized order,
 * in pickBooks order. Books too small for one are skipped without asking.
 * Books are quoted in parallel batches; a book whose quote comes back empty
 * (or fails) is dropped and the next book takes its place.
 */
export async function selectQuotedBooks(
  books: readonly MarketBook[],
  quote: (book: MarketBook) => Promise<ShoutQuote | null>,
  options: SelectOptions & { isTradable?: (platform: string, currency: string) => boolean } = {},
): Promise<QuotedBook[]> {
  const max = options.max ?? MAX_MERCHANTS;
  let attempts = options.maxAttempts ?? max * 2;
  const remaining = usableBooks(books, options.isTradable ?? (() => true)).filter(canFillShout);
  const chosen: QuotedBook[] = [];
  while (chosen.length < max && attempts > 0) {
    const batch = nextBooks(
      remaining,
      chosen.map((c) => c.book),
      Math.min(max - chosen.length, attempts),
    );
    if (batch.length === 0) break;
    attempts -= batch.length;
    for (const book of batch) remaining.splice(remaining.indexOf(book), 1);
    const quotes = await Promise.all(batch.map((book) => quote(book).catch(() => null)));
    batch.forEach((book, i) => {
      const q = quotes[i];
      if (q) chosen.push({ book, quote: q });
    });
  }
  return chosen;
}

export interface CachedQuote {
  /** The book's best offer and the fiat amount the quote was taken against. */
  key: string;
  at: number;
  quote: ShoutQuote | null;
}

function bestKey(book: MarketBook): string {
  const b = book.best;
  return `${b.depositId}|${b.rate}|${b.available}|${b.min}|${b.max}`;
}

/**
 * Quotes a book the way its trade window will: Curator's buy quote on that
 * platform and currency for the merchant's shout amount. Reuses a quote
 * while the book's best offer is unchanged and the quote is under
 * REQUOTE_MS old, so a refresh costs Curator only the books that moved.
 */
export function createShoutQuoter(
  cache: Map<string, CachedQuote>,
  getQuote: (book: MarketBook, fiatAmount: number) => Promise<bigint | null>,
  options: { now?: () => number; log?: Pick<Console, "warn"> } = {},
): { quote: (book: MarketBook) => Promise<ShoutQuote | null>; stats: { quoted: number; failed: number } } {
  const { now = Date.now, log = console } = options;
  const stats = { quoted: 0, failed: 0 };
  const quote = async (book: MarketBook): Promise<ShoutQuote | null> => {
    const id = merchantId(book.platform, book.currency);
    const fiatAmount = shoutFiatAmount(book);
    // The amount too: it can move with an offer other than the best (shoutUsdc).
    const key = `${bestKey(book)}|${fiatAmount}`;
    const hit = cache.get(id);
    if (hit && hit.key === key && now() - hit.at < REQUOTE_MS) return hit.quote;
    if (fiatAmount === null) {
      cache.set(id, { key, at: now(), quote: null });
      return null;
    }
    try {
      const rate = await getQuote(book, fiatAmount);
      const result = rate !== null && rate > 0n ? { fiatAmount, rate: formatUnitsTruncated(rate, RATE_DECIMALS, { grouping: false }) } : null;
      stats.quoted++;
      cache.set(id, { key, at: now(), quote: result });
      return result;
    } catch (err) {
      stats.failed++;
      log.warn(`[market] could not quote ${id}`, err instanceof Error ? err.message : err);
      // Curator unreachable: an earlier quote against the same best offer is still the best guess.
      return hit && hit.key === key ? hit.quote : null;
    }
  };
  return { quote, stats };
}

export interface ShoutOptions {
  /** The phone form, "0.7554 GBP Revolut!", which fits a narrow screen. */
  short?: boolean;
}

/**
 * "red:wave:Selling USDC @ 0.7554 GBP on Revolut!" (or the short form) with a
 * style that varies by merchant and round. The price only: the size a book
 * holds is not what a buyer gets at that price.
 */
export function merchantShout(book: MarketBook, rate: string, round = 0, options: ShoutOptions = {}): string {
  const id = merchantId(book.platform, book.currency);
  const h = hash(`${id}#${round}`);
  const colour = COLOURS[h % COLOURS.length]!;
  const motion = MOTIONS[(h >>> 8) % MOTIONS.length]!;
  const price = `${formatShoutRate(rate)} ${book.currency.toUpperCase()}`;
  const platform = platformName(book.platform);
  const text = options.short ? `${price} ${platform}!` : `Selling USDC @ ${price} on ${platform}!`;
  return `${colour}:${motion}:${text}`;
}

/** Strips chat effect prefixes (for players who turned chat effects off). */
export function plainShout(shout: string): string {
  return `yellow:${shout.replace(/^(?:[a-z0-9]+:){1,2}/i, "")}`;
}

/** A merchant in the world and the fiat amount its shout was quoted at. */
export interface LiveMerchant {
  spec: MerchantSpec;
  fiatAmount: number;
}

/** The trade target for a merchant: its window opens at the amount the shout was quoted for. */
export function merchantTarget({ spec, fiatAmount }: LiveMerchant): MerchantTarget {
  return { kind: "merchant", merchantId: spec.id, name: spec.name, platform: spec.platform, currency: spec.currency, fiatAmount };
}

/**
 * Merchant NPCs for the quoted books. `round` rotates shout styles; pass
 * something that changes each refresh. `short` gives the phone shouts.
 */
export function buildMerchants(quoted: readonly QuotedBook[], round = 0, options: ShoutOptions = {}): LiveMerchant[] {
  const platformCount = new Map<string, number>();
  for (const { book } of quoted) platformCount.set(book.platform.toLowerCase(), (platformCount.get(book.platform.toLowerCase()) ?? 0) + 1);
  return quoted.map(({ book, quote }) => {
    const id = merchantId(book.platform, book.currency);
    const label = platformName(book.platform);
    const shared = (platformCount.get(book.platform.toLowerCase()) ?? 0) > 1;
    return {
      spec: {
        id,
        name: shared ? `${label} ${book.currency.toUpperCase()} trader` : `${label} trader`,
        platform: book.platform.toLowerCase(),
        currency: book.currency.toUpperCase(),
        shout: merchantShout(book, quote.rate, round, options),
        seed: id,
      },
      fiatAmount: quote.fiatAmount,
    };
  });
}

/**
 * Upper-case codes of the currencies in the market summary that have at
 * least one book with liquidity on a payment method the buy flow trades.
 */
export function liquidCurrencies(
  market: Pick<MarketResponse, "books" | "currencies">,
  isTradable: (platform: string, currency: string) => boolean = () => true,
): Set<string> {
  const listed = new Set(market.currencies.map((c) => c.currency.toUpperCase()));
  const out = new Set<string>();
  for (const book of usableBooks(market.books, isTradable)) {
    const code = book.currency.toUpperCase();
    if (listed.has(code)) out.add(code);
  }
  return out;
}
