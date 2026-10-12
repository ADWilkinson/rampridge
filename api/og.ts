import { productionDeps } from "./_lib/deps.js";
import { createShareImageHandler } from "./_lib/shareHandlers.js";

const handle = createShareImageHandler(productionDeps());

/** A shared trade's 1200x630 card: ?id=... (the site's card for an unknown id). */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

/** Some preview fetchers check an image with HEAD first. */
export async function HEAD(request: Request): Promise<Response> {
  const response = await handle(request);
  return new Response(null, { status: response.status, headers: response.headers });
}
