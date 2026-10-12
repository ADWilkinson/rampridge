import { productionDeps } from "./_lib/deps.js";
import { createSharePageHandler } from "./_lib/shareHandlers.js";

const handle = createSharePageHandler(productionDeps());

/** A shared trade's link preview page (/t/{id} rewrites here): ?id=..., or ?id=...&format=json. */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

/** Some preview fetchers check a link with HEAD first. */
export async function HEAD(request: Request): Promise<Response> {
  const response = await handle(request);
  return new Response(null, { status: response.status, headers: response.headers });
}
