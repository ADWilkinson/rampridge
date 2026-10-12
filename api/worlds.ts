import { productionDeps } from "./_lib/deps.js";
import { createWorldsHandler } from "./_lib/handlers/worlds.js";

const handle = createWorldsHandler(productionDeps());

/** The open worlds and their player counts (World Switcher). */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
