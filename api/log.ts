import { productionDeps } from "./_lib/deps.js";
import { createLogHandler } from "./_lib/log.js";

const handle = createLogHandler(productionDeps());

/** Client telemetry: funnel counters and scrubbed client errors. Body: LogBatch (text/plain from sendBeacon). */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
