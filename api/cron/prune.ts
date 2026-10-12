import { productionDeps } from "../_lib/deps.js";
import { createPruneHandler } from "../_lib/handlers/prune.js";

const handle = createPruneHandler(productionDeps());

/** Scheduled housekeeping. Authorization: Bearer ${CRON_SECRET}. */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
