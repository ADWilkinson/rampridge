import { productionDeps } from "./_lib/deps.js";
import { createSessionHandler } from "./_lib/handlers/session.js";

const handle = createSessionHandler(productionDeps());

/** Create, refresh or rename a player session. Body: SessionRequest. */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
