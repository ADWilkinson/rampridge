/**
 * GET /api/worlds: the open worlds and how many players each holds, for the
 * World Switcher in the Logout tab. Counts come from `meta/worldPop` (soft,
 * refreshed about every 30 s, and moved by every arrival, hop and leave), so
 * the answer is cached briefly at the edge: however many tabs have the
 * switcher open, the database is read a few times a minute.
 */

import type { WorldListResponse } from "../../../shared/worlds.js";
import type { ApiDeps } from "../deps.js";
import { json, withErrors } from "../http.js";
import { populations, worldConfig } from "../worlds.js";

/**
 * Edge only (as /api/market): the edge answers a crowd of open switchers from
 * one read every 5 s. The switcher fetches with `cache: "no-store"`, so the
 * browser never answers from its own copy, and right after a hop it adds a
 * `fresh` query parameter to skip the edge's copy once (src/net/worlds.ts):
 * the counts it gets back include the hop.
 */
export const WORLDS_CACHE_CONTROL = "public, s-maxage=5, stale-while-revalidate=5";

export function createWorldsHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return withErrors(deps.now, async () => {
    const db = deps.db();
    const [config, pops] = await Promise.all([worldConfig(db), populations(db)]);
    const body: WorldListResponse = {
      ok: true,
      worlds: config.open.map((id) => {
        const players = pops.get(id) ?? 0;
        return { id, players, full: players >= config.cap };
      }),
      cap: config.cap,
      now: deps.now(),
    };
    return json(body, 200, { "Cache-Control": WORLDS_CACHE_CONTROL });
  });
}
