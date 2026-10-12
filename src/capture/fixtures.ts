/**
 * Capture fixtures: the market frozen from GET https://www.rampridge.xyz/api/market
 * (market-snapshot.json), the merchants it produces, believable players and
 * their chat. Capture only (dev/capture.html); the app never imports this.
 */
import type { MarketBook, MarketOffer } from "@shared/world";
import { MAX_MERCHANTS, buildMerchants, pickBooks, shoutFiatAmount, type LiveMerchant } from "@/app/merchants";
import { BUY_PLATFORMS, isBuyPlatformId, isFiatCode, isPlatformLive } from "@/peer/platforms";
import snapshot from "./market-snapshot.json";

interface SnapshotBook {
  platform: string;
  currency: string;
  liquidity: string;
  depositCount: number;
  best: Omit<MarketOffer, "depositId" | "escrow">;
}

/** The frozen books, shaped like the live response (placeholder deposit ids, no addresses). */
export const BOOKS: MarketBook[] = (snapshot.books as SnapshotBook[]).map((b, i) => {
  const best = { ...b.best, depositId: `capture_${i}`, escrow: "capture" } as MarketOffer;
  return { platform: b.platform, currency: b.currency, liquidity: b.liquidity, depositCount: b.depositCount, best, offers: [best] };
});

export const LIQUID = new Set(snapshot.currencies.map((c) => c.currency.toUpperCase()));

function isTradable(platform: string, currency: string): boolean {
  const id = platform.toLowerCase();
  const code = currency.toUpperCase();
  return isBuyPlatformId(id) && isPlatformLive(id) && isFiatCode(code) && BUY_PLATFORMS[id].currencies.includes(code);
}

/** Live rate (fiat per USDC) for a platform and currency from the frozen book, or null. */
export function liveRate(platform: string, currency: string): number | null {
  const book = BOOKS.find((b) => b.platform === platform.toLowerCase() && b.currency === currency.toUpperCase());
  if (book) return Number(book.best.rate);
  const summary = snapshot.currencies.find((c) => c.currency === currency.toUpperCase());
  return summary ? Number(summary.bestRate) : null;
}

/** The merchants the shell would build from this book, each shouting its live rate. */
export function captureMerchants(max = MAX_MERCHANTS): LiveMerchant[] {
  const books = pickBooks(BOOKS, { max, isTradable });
  const quoted = books.flatMap((book) => {
    const fiatAmount = shoutFiatAmount(book);
    return fiatAmount === null ? [] : [{ book, quote: { fiatAmount, rate: book.best.rate } }];
  });
  return buildMerchants(quoted, 3);
}

export const LOCAL = { pid: "me", name: "Ridge Runner", seed: "capture-local-7" };

/** Believable 2007-era names; none belong to a real player we know of. */
export const CROWD: { pid: string; name: string; seed: string }[] = [
  { pid: "p1", name: "Lumby Larry", seed: "crowd-a1" },
  { pid: "p2", name: "Fally Fiona", seed: "crowd-b2" },
  { pid: "p3", name: "Iron Ozzy", seed: "crowd-c3" },
  { pid: "p4", name: "Draynor Dan", seed: "crowd-d4" },
  { pid: "p5", name: "Mithril Mo", seed: "crowd-e5" },
  { pid: "p6", name: "Gz Gnome", seed: "crowd-f6" },
  { pid: "p7", name: "Bank Stand3r", seed: "crowd-g7" },
  { pid: "p8", name: "Zammy Sam", seed: "crowd-h8" },
  { pid: "p9", name: "Rune Rachel", seed: "crowd-i9" },
  { pid: "p10", name: "Cowhide Kev", seed: "crowd-j10" },
  { pid: "p11", name: "Tele Tab Tom", seed: "crowd-k11" },
  { pid: "p12", name: "Wildy Wendy", seed: "crowd-l12" },
];

export const CHAT: [string, string | null][] = [
  ["anyone on revolut?", "yellow:wave"],
  ["buying usdc gbp", "cyan:wave2"],
  ["just sold 200 on wise ez", "green:scroll"],
  ["gz!!", "flash1:wave"],
  ["first time here lol", null],
  ["selling usdc trade me", "glow1:wave"],
  ["how long does verify take", null],
  ["2 mins tops", "white:wave2"],
  ["this bank never sleeps", "purple:wave"],
  ["nice rate on zelle rn", "yellow:shake"],
  ["gf 1k usdc", "glow2:wave"],
  ["wave2 or riot", "red:wave2"],
];
