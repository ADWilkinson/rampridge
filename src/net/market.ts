/** The live merchant book from GET /api/market (edge-cached for 30 s). */

import type { MarketResponse } from "@shared/world";
import { apiFetch } from "./http";

export async function fetchMarket(signal?: AbortSignal): Promise<MarketResponse> {
  return apiFetch<MarketResponse>("/market", { signal });
}
