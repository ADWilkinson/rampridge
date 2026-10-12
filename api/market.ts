import { productionDeps } from "./_lib/deps.js";
import { createMarketHandler } from "./_lib/handlers/market.js";

const handle = createMarketHandler(productionDeps());

/** Live Peer orderbook summary for the merchant NPCs. */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
