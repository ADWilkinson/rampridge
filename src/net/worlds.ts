/**
 * The World Switcher's list from GET /api/worlds. The edge caches it for 5 s;
 * the browser never does (`no-store`), and `fresh` (after a hop) asks past
 * the edge's copy once, so the counts include the hop that just landed.
 */

import type { WorldListResponse } from "@shared/worlds";
import { apiFetch } from "./http";

export async function fetchWorlds(signal?: AbortSignal, fresh?: number): Promise<WorldListResponse> {
  return apiFetch<WorldListResponse>(fresh === undefined ? "/worlds" : `/worlds?fresh=${fresh}`, { signal, cache: "no-store" });
}
