import { productionDeps } from "./_lib/deps.js";
import { createActHandler } from "./_lib/handlers/act.js";

const handle = createActHandler(productionDeps());

/** Every world write. Authorization: Bearer <token>; body: ActRequest. */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
