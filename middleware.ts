/**
 * Vercel Routing Middleware: Skew Protection for the code-split build.
 *
 * Privy's login and signing screens and the trading interfaces download on
 * first use. Each build names those chunks differently, so a tab opened
 * before a release would ask the new deployment for files it doesn't have.
 * Vercel routes a request carrying the `__vdpl` cookie to the deployment it
 * names (for the project's Skew Protection max age), so every page load sets
 * it to the deployment that served the page.
 *
 * Vercel honours the cookie on any request, documents included, so it is
 * scoped to /assets/ (the content-hashed build output): a reload or a new
 * visit still gets the latest release and moves the pin, while the page's
 * own chunk requests reach the build it was loaded from. API calls and the
 * /game/ files aren't pinned, so a server fix reaches every open tab.
 */

// The middleware runs outside the app's TypeScript project; Vercel provides process.env at runtime.
declare const process: { env: Record<string, string | undefined> };

export const config = {
  // Page loads only: API calls, build output and game files skip the middleware.
  matcher: ["/((?!api/|assets/|game/).*)"],
};

export const SKEW_COOKIE = "__vdpl";

/** A top-level page load, not a fetch or a subresource. */
export function isDocumentRequest(request: Pick<Request, "method" | "headers">): boolean {
  if (request.method !== "GET") return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  // Browsers without Fetch Metadata: a navigation asks for HTML.
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/** The Set-Cookie value pinning this page's chunks to the deployment serving it, or null when not applicable. */
export function skewCookie(request: Pick<Request, "method" | "headers">, env: Record<string, string | undefined>): string | null {
  if (env.VERCEL_SKEW_PROTECTION_ENABLED !== "1") return null;
  const deployment = env.VERCEL_DEPLOYMENT_ID;
  if (!deployment || !/^[\w-]+$/.test(deployment)) return null;
  if (!isDocumentRequest(request)) return null;
  return `${SKEW_COOKIE}=${deployment}; Path=/assets; HttpOnly; Secure; SameSite=Lax`;
}

export default function middleware(request: Request): Response | undefined {
  const cookie = skewCookie(request, process.env);
  // Nothing to add: the request continues untouched.
  if (!cookie) return undefined;
  // What next() from @vercel/functions returns: continue to the page, adding this header to its response.
  return new Response(null, { headers: { "x-middleware-next": "1", "set-cookie": cookie } });
}
