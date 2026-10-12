/** Request parsing and JSON responses shared by every function. */

import type { ApiErrorBody, ApiErrorCode } from "../../shared/world.js";
import { ConfigError } from "./env.js";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code: ApiErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const unauthorized = (message = "Your session has expired. Please reload the page.") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (message: string) => new HttpError(403, "forbidden", message);
export const notJoined = () => new HttpError(409, "not_joined", "You are not in the bank. Rejoin to continue.");
export const conflict = (message: string) => new HttpError(409, "conflict", message);
export const rateLimited = (retryAfterMs: number, message = "You're doing that too quickly.") =>
  new HttpError(429, "rate_limited", message, Math.max(1, Math.ceil(retryAfterMs)));
export const upstream = (message: string) => new HttpError(502, "upstream", message);
/** How long an outdated build is told to wait: long enough that every build shows it rather than retrying. */
export const OUTDATED_RETRY_MS = 10 * 60 * 1000;
export const OUTDATED_MESSAGE = "RampRidge was updated. Reload the page to keep playing.";
/**
 * A request from a build older than the server (a join without a world). A
 * 429 with a long wait is the refusal builds from before worlds show in the
 * chatbox (and on the title), so the player there is told to reload.
 */
export const outdated = () => new HttpError(429, "outdated", OUTDATED_MESSAGE, OUTDATED_RETRY_MS);

const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, status = 200, headers: Record<string, string> = NO_STORE): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(err: HttpError, now: number): Response {
  const body: ApiErrorBody = { ok: false, error: err.message, code: err.code, now };
  const headers: Record<string, string> = { ...NO_STORE };
  if (err.retryAfterMs !== undefined) {
    body.retryAfterMs = err.retryAfterMs;
    headers["Retry-After"] = String(Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
  }
  return json(body, err.status, headers);
}

/**
 * Wraps a handler so every failure becomes a JSON error. Unexpected errors are
 * logged by message only (never request bodies or configuration values).
 */
export function withErrors(
  now: () => number,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err, now());
      if (err instanceof ConfigError) {
        console.error(err.message);
        return errorResponse(new HttpError(500, "server", err.message), now());
      }
      const path = safePath(request.url);
      console.error(`Unhandled error in ${request.method} ${path}:`, err instanceof Error ? err.message : String(err));
      return errorResponse(new HttpError(500, "server", "Something went wrong. Please try again."), now());
    }
  };
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(unknown)";
  }
}

/** Browser origins allowed to call the session and wallet endpoints, besides the API's own origin. */
export const ALLOWED_ORIGINS: readonly string[] = ["https://www.rampridge.xyz", "http://localhost:5173"];

/**
 * Refuses browser requests made from another site. Session creation needs no
 * credentials, so without this any page could spend a visitor's new-player
 * allowance. Non-browser clients send neither header and are let through;
 * they are rate-limited like everyone else.
 */
export function assertSameSite(request: Request): void {
  const refuse = () => forbidden("Requests from other sites are not allowed.");
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") throw refuse();
  const origin = request.headers.get("origin");
  if (origin === null) return;
  if (ALLOWED_ORIGINS.includes(origin)) return;
  let own: string | null = null;
  try {
    own = new URL(request.url).origin;
  } catch {
    // Fall through to the refusal.
  }
  if (origin !== own) throw refuse();
}

/** Requires a JSON body, which also makes a cross-site browser request need a CORS preflight it never gets. */
export function requireJsonContent(request: Request): void {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "bad_request", "Requests must be sent as JSON.");
}

/** Reads a JSON body of at most `maxBytes`. Accepts any content type (sendBeacon posts text/plain). */
export async function readJson(request: Request, maxBytes = 8_192): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "payload_too_large", "The request is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new HttpError(413, "payload_too_large", "The request is too large.");
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest("The request body is not valid JSON.");
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * Client IP. Vercel's edge sets x-vercel-forwarded-for and overwrites any value
 * a client sends; x-real-ip and x-forwarded-for are the local dev server's.
 */
export function clientIp(request: Request): string | null {
  for (const header of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) {
    const first = request.headers.get(header)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
