/**
 * GET /api/market: live Peer liquidity for the merchant NPCs.
 *
 * Building the book fans out to one Curator orderbook call per currency, so it
 * is cached three ways: at the edge (s-maxage), in this instance's memory, and
 * in the database at `meta/market`, which every instance shares. When the copy
 * is stale exactly one caller rebuilds it, claimed with a transaction on
 * `meta/marketBuildAt`; everyone else is served the stale copy meanwhile. If
 * Curator is down the last good book is served, marked partial. A query
 * string is redirected to the canonical URL so it cannot dodge the edge cache.
 */

import type { MarketResponse } from "../../../shared/world.js";
import type { Db } from "../db.js";
import type { ApiDeps } from "../deps.js";
import { json, upstream, withErrors } from "../http.js";
import { buildMarket, fetchAllCurrencies } from "../market.js";

export const MARKET_CACHE_CONTROL = "public, s-maxage=30, stale-while-revalidate=120";
/** How long a complete book is served before a rebuild. */
export const MARKET_FRESH_MS = 30_000;
/** A book missing some currencies is rebuilt sooner. */
export const MARKET_PARTIAL_FRESH_MS = 10_000;
/** A rebuild claim expires after this, in case its builder died. */
export const MARKET_BUILD_LEASE_MS = 15_000;
/** With no copy at all, callers that lose the claim wait this long for the builder. */
export const MARKET_WAIT_MS = 9_000;
const MARKET_POLL_MS = 500;
/** Stale or fallback copies are cached briefly at the edge. */
const SHORT_CACHE_CONTROL = "public, s-maxage=5, stale-while-revalidate=30";

export const MARKET_CACHE_PATH = "meta/market";
export const MARKET_BUILD_PATH = "meta/marketBuildAt";

/** `meta/market`: the serialised MarketResponse (the database would drop empty arrays). */
export interface CachedMarket {
  body: string;
  /** Built at, server ms. */
  at: number;
  partial: boolean;
}

function asCached(value: unknown): CachedMarket | null {
  if (value === null || typeof value !== "object") return null;
  const { body, at, partial } = value as Record<string, unknown>;
  if (typeof body !== "string" || typeof at !== "number") return null;
  return { body, at, partial: partial === true };
}

function freshUntil(entry: CachedMarket): number {
  return entry.at + (entry.partial ? MARKET_PARTIAL_FRESH_MS : MARKET_FRESH_MS);
}

async function readCache(db: Db): Promise<CachedMarket | null> {
  return asCached(await db.get<unknown>(MARKET_CACHE_PATH));
}

async function claimBuild(db: Db, now: number): Promise<boolean> {
  const claim = await db.transaction<number>(MARKET_BUILD_PATH, (last) =>
    typeof last === "number" && now - last < MARKET_BUILD_LEASE_MS ? undefined : now,
  );
  return claim.committed;
}

function respond(entry: CachedMarket, now: number, fallback: boolean): Response {
  const market = JSON.parse(entry.body) as MarketResponse;
  const partial = market.partial || fallback;
  const body: MarketResponse = { ...market, partial, now };
  const remainingSeconds = Math.floor((freshUntil(entry) - now) / 1000);
  const cache =
    partial || remainingSeconds < 1
      ? SHORT_CACHE_CONTROL
      : `public, s-maxage=${Math.min(30, remainingSeconds)}, stale-while-revalidate=120`;
  return json(body, 200, { "Cache-Control": cache });
}

export interface MarketHandlerOptions {
  /** Waits between polls for another instance's build; tests advance a fake clock. */
  sleep?: (ms: number) => Promise<void>;
}

export function createMarketHandler(
  deps: ApiDeps,
  options: MarketHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** This instance's last copy, so a burst that skips the edge cache does not re-read the database. */
  let memo: CachedMarket | null = null;

  const remember = (entry: CachedMarket | null) => {
    if (entry && (!memo || entry.at >= memo.at)) memo = entry;
    return memo;
  };

  /** Builds and stores a new book; null when every currency failed. */
  const build = async (db: Db): Promise<CachedMarket | null> => {
    const results = await fetchAllCurrencies(deps.fetchTable);
    if (results.every((r) => "error" in r)) return null;
    const at = deps.now();
    const market = buildMarket(results, at);
    const entry: CachedMarket = { body: JSON.stringify(market), at, partial: market.partial };
    try {
      await db.set(MARKET_CACHE_PATH, entry);
    } catch (err) {
      console.error("Market cache write failed:", err instanceof Error ? err.message : String(err));
    }
    return remember(entry);
  };

  const waitForBuild = async (db: Db): Promise<CachedMarket | null> => {
    const deadline = deps.now() + MARKET_WAIT_MS;
    while (deps.now() < deadline) {
      await sleep(MARKET_POLL_MS);
      const entry = remember(await readCache(db));
      if (entry) return entry;
    }
    return null;
  };

  return withErrors(deps.now, async (request) => {
    const url = new URL(request.url);
    if (url.search) {
      return new Response(null, {
        status: 308,
        headers: { Location: url.pathname, "Cache-Control": "public, max-age=3600, s-maxage=86400" },
      });
    }

    const now = deps.now();
    if (memo && now < freshUntil(memo)) return respond(memo, now, false);
    const db = deps.db();
    const cached = remember(await readCache(db));
    if (cached && now < freshUntil(cached)) return respond(cached, now, false);

    if (await claimBuild(db, now)) {
      const built = await build(db);
      if (built) return respond(built, deps.now(), false);
      // Curator is down: keep the lease as a back-off and serve the last good book.
      if (cached) return respond(cached, deps.now(), true);
      throw upstream("The Peer orderbook is unavailable right now. Please try again shortly.");
    }

    // Another instance is rebuilding.
    if (cached) return respond(cached, now, false);
    const awaited = await waitForBuild(db);
    if (awaited) return respond(awaited, deps.now(), false);
    // The builder failed or died. Only a caller that wins the expired lease tries again.
    if (await claimBuild(db, deps.now())) {
      const built = await build(db);
      if (built) return respond(built, deps.now(), false);
    }
    throw upstream("The Peer orderbook is unavailable right now. Please try again shortly.");
  });
}
