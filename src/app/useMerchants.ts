import { useEffect, useMemo, useRef, useState } from "react";
import type { MarketBook } from "@shared/world";
import type { Engine } from "@/game";
import { fetchMarket } from "@/net/market";
import { useIsMobile } from "@/ui/kit";
import { prefetchEntryCode } from "./entryCode";
import { afterPaintIdle } from "./idle";
import { useMarketStore } from "./marketStore";
import {
  MAX_MERCHANTS,
  buildMerchants,
  createShoutQuoter,
  liquidCurrencies,
  plainShout,
  selectQuotedBooks,
  type CachedQuote,
  type LiveMerchant,
  type QuotedBook,
} from "./merchants";

const MARKET_REFRESH_MS = 60_000;
const MARKET_RETRY_MS = 15_000;
const MOBILE_MERCHANTS = 6;

type Platforms = typeof import("@/peer/platforms");

/** Only platforms and currencies the buy flow can actually signal get a merchant. */
function tradableWith({ BUY_PLATFORMS, isBuyPlatformId, isFiatCode, isPlatformLive }: Platforms): (platform: string, currency: string) => boolean {
  return (platform, currency) => {
    const id = platform.toLowerCase();
    const code = currency.toUpperCase();
    return isBuyPlatformId(id) && isPlatformLive(id) && isFiatCode(code) && BUY_PLATFORMS[id].currencies.includes(code);
  };
}

/** Curator's best buy rate (18 decimals) for this book's platform and currency at `fiatAmount`, or null. */
async function curatorRate(book: MarketBook, fiatAmount: number): Promise<bigint | null> {
  const platform = book.platform.toLowerCase();
  const currency = book.currency.toUpperCase();
  const { isBuyPlatformId, isFiatCode } = await import("@/peer/platforms");
  if (!isBuyPlatformId(platform) || !isFiatCode(currency)) return null;
  const { getBuyQuotes } = await import("@/peer/market");
  const result = await getBuyQuotes({ fiatAmount: String(fiatAmount), currency, platforms: [platform] });
  return result.quotes[0]?.rate ?? null;
}

/**
 * Live merchants from the market book (GET /api/market), refreshed every
 * minute while the tab is visible and retried sooner after a failure. Each merchant shouts the rate
 * Curator quotes for a typical order on its book, so the trade window
 * (opened at the same amount) shows the advertised price. The world keeps
 * the last good set while the market or Curator is unreachable. Also
 * publishes which currencies have liquidity (useMarketStore). The portrait
 * phone layout gets the short shouts, rebuilt when the layout changes.
 * Returns the current merchants by id.
 */
export function useMerchants(engine: Engine, chatEffects: boolean): { readonly current: ReadonlyMap<string, LiveMerchant> } {
  const [quoted, setQuoted] = useState<{ books: QuotedBook[]; round: number } | null>(null);
  const short = useIsMobile();
  const merchants = useMemo(() => (quoted ? buildMerchants(quoted.books, quoted.round, { short }) : []), [quoted, short]);
  const byId = useRef<ReadonlyMap<string, LiveMerchant>>(new Map());
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let round = 0;
    const controller = new AbortController();
    const cache = new Map<string, CachedQuote>();
    // A refresh that falls due while the tab is hidden waits until it is shown again: no market or
    // Curator requests (and no battery) for a bank nobody is looking at.
    let due = false;
    const onVisibility = () => {
      if (!document.hidden && due && !stopped) {
        due = false;
        void refresh();
      }
    };
    const refresh = async () => {
      if (document.hidden) {
        due = true;
        return;
      }
      let next = MARKET_REFRESH_MS;
      try {
        // The platform table and the Peer SDK under the quotes load here, after the title is up, so they stay
        // out of the boot graph; the market answer comes in alongside.
        const [market, platforms] = await Promise.all([fetchMarket(controller.signal), import("@/peer/platforms")]);
        const isTradable = tradableWith(platforms);
        if (stopped) return;
        // A host without the API (static preview) can answer 200 with a page instead of JSON.
        if (!market || !market.ok || !Array.isArray(market.books)) throw new Error(market?.error ?? "The market returned no offers.");
        if (Array.isArray(market.currencies)) useMarketStore.setState({ liquidCurrencies: liquidCurrencies(market, isTradable) });
        // Phones get fewer traders so the shouts stay readable on a narrow screen.
        const max = window.matchMedia("(max-width: 767px)").matches ? MOBILE_MERCHANTS : MAX_MERCHANTS;
        const quoter = createShoutQuoter(cache, curatorRate);
        const quoted = await selectQuotedBooks(market.books, quoter.quote, { max, isTradable });
        if (stopped) return;
        // Every quote failed (Curator unreachable): keep the merchants already in the world.
        if (quoted.length === 0 && quoter.stats.failed > 0) throw new Error("Curator did not answer any quote.");
        setQuoted({ books: quoted, round: round++ });
      } catch (err) {
        if (stopped) return;
        console.warn("[market] could not load offers", err instanceof Error ? err.message : err);
        next = MARKET_RETRY_MS;
      }
      if (!stopped) timer = window.setTimeout(() => void refresh(), next);
    };
    document.addEventListener("visibilitychange", onVisibility);
    // After the code entering the world needs, which goes first once the title is up.
    const cancelFirst = afterPaintIdle(
      () =>
        void prefetchEntryCode().then(() => {
          if (!stopped) void refresh();
        }),
    );
    return () => {
      stopped = true;
      cancelFirst();
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  useEffect(() => {
    byId.current = new Map(merchants.map((m) => [m.spec.id, m]));
    const specs = merchants.map((m) => m.spec);
    engine.setMerchants(chatEffects ? specs : specs.map((m) => ({ ...m, shout: plainShout(m.shout) })));
  }, [engine, merchants, chatEffects]);
  return byId;
}
