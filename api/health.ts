import { createHealthHandler, productionHealthProbes } from "./_lib/logHealth.js";

const handle = createHealthHandler(productionHealthProbes());

/** Liveness and dependency checks for launch-day monitoring. 200 when every check passes, 503 otherwise. */
export async function GET(): Promise<Response> {
  return handle();
}
