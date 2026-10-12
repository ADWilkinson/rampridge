/** Fetch helpers for the game API, turning error bodies into typed errors. */

import type { ApiErrorBody, ApiErrorCode } from "@shared/world";

export const API_BASE = "/api";

export class ApiError extends Error {
  readonly status: number;
  /** Server error code; "network" when the request never got a response. */
  readonly code: ApiErrorCode | "network";
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code: ApiErrorCode | "network", message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  /** Worth retrying unchanged: no response, or a transient server or gateway failure. */
  get transient(): boolean {
    return this.code === "network" || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

const outdatedListeners = new Set<() => void>();

/**
 * Called whenever the server says this build is older than it ("outdated"):
 * the page needs a reload to keep working. Returns a function that stops
 * listening.
 */
export function onOutdated(listener: () => void): () => void {
  outdatedListeners.add(listener);
  return () => outdatedListeners.delete(listener);
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

/** Performs a request and returns the parsed JSON body, or throws ApiError. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network", "Can't reach the RampRidge server. Check your connection.");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON bodies (e.g. a gateway error page) fall through to the status check.
  }
  if (!response.ok || isErrorBody(body)) {
    if (isErrorBody(body)) {
      if (body.code === "outdated") for (const listener of outdatedListeners) listener();
      throw new ApiError(response.status, body.code ?? "server", body.error, body.retryAfterMs);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ApiError(
      response.status,
      response.status === 429 ? "rate_limited" : "server",
      response.status >= 500 ? "The RampRidge server is having trouble. Please try again." : "Request failed.",
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
  return body as T;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
