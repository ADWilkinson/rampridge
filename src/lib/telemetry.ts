/**
 * Launch telemetry: funnel counters and client errors, batched and sent to
 * POST /api/log with sendBeacon (fetch keepalive as the fallback).
 *
 * - `installTelemetry()` once at startup: listens for uncaught errors and
 *   unhandled rejections, flushes when the page is hidden, and counts the
 *   page view with where the visit came from (a coarse class from
 *   shared/referrer.ts, never the referring URL).
 * - `track(event)` counts a funnel step. Counts carry no player, wallet or
 *   payment data; the server keeps one number per event per day.
 * - `report(error, context)` sends a handled error worth seeing (a failed
 *   signal or fulfil). The server scrubs addresses, tokens and payee handles
 *   before anything is stored or logged; this side only trims.
 *
 * Off unless this is the production build on www.rampridge.xyz, so local
 * development (which can point at the live database) and Vercel previews
 * never pollute the numbers. VITE_TELEMETRY=1 forces it on (for the
 * emulator), VITE_TELEMETRY=0 off. Automated browsers are never counted.
 * Telemetry must never break the game: every path swallows its own errors.
 */

import { referrerClass, type ReferrerClass } from "@shared/referrer";
import { runningEntry } from "@/app/update";

/** Funnel steps. Mirrors FUNNEL_EVENTS in api/_lib/log.ts (a test keeps them equal). */
export const FUNNEL_EVENTS = [
  "page_view",
  "play",
  "design_done",
  "login",
  "quote",
  "signal_ok",
  "signal_fail",
  "verify_start",
  "fulfil_ok",
  "fulfil_fail",
  "sell_start",
  "deposit_ok",
  "deposit_fail",
  "share_click",
  "gas_fail",
  "send_ok",
  "send_fail",
  "send_unconfirmed",
  "practice_start",
  "practice_done",
] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

export const LOG_URL = "/api/log";
/** Events and errors wait this long to share a request. */
export const FLUSH_DELAY_MS = 5_000;
/** Distinct errors one page load reports at most. */
export const MAX_ERRORS_PER_PAGE = 10;
/** The server takes this many errors per batch; reaching it flushes at once. */
export const MAX_ERRORS_PER_BATCH = 5;
const MESSAGE_MAX = 500;
const STACK_MAX = 4_000;

type ErrorKind = "error" | "rejection" | "report";

interface ErrorItem {
  k: ErrorKind;
  m: string;
  s?: string;
  p?: string;
  c?: string;
}

/** The wire format api/_lib/log.ts parses. */
export interface LogBatch {
  v: 1;
  b: string;
  e?: Partial<Record<FunnelEvent, number>>;
  /** Where the visit came from; sent with the page view only. */
  r?: ReferrerClass;
  x?: ErrorItem[];
}

export interface TelemetryOptions {
  /** Defaults to on for the production build on www.rampridge.xyz only. */
  enabled?: boolean;
  /** Fraction of distinct errors sent, 0 to 1 (default 1). Funnel counts are never sampled. */
  errorSampleRate?: number;
}

/** Everything the browser provides, injectable for tests. */
export interface TelemetryHost {
  /** Sends one batch; false when it could not be queued. */
  send(body: string): boolean;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  random(): number;
  build(): string;
  path(): string;
  /** Where this page's visit came from. */
  referrer(): ReferrerClass;
}

export interface Telemetry {
  readonly enabled: boolean;
  track(event: FunnelEvent, options?: { once?: boolean }): void;
  report(error: unknown, context?: string, kind?: ErrorKind): void;
  flush(): void;
}

/** Errors that say nothing about the app: browser quirks, extensions, and players saying no in their wallet. */
const IGNORED_MESSAGES = [
  /^script error\.?$/i,
  /ResizeObserver loop/i,
  /user (rejected|denied|cancell?ed|closed)/i,
  /rejected the request/i,
  /request (was )?rejected/i,
  /^AbortError\b/,
];
const EXTENSION_SOURCE = /(chrome|moz|safari|safari-web)-extension:\/\//i;

interface Described {
  message: string;
  stack?: string;
}

/** Turns anything thrown into a message and (when there is one) a stack. */
export function describeError(value: unknown): Described {
  if (value instanceof Error) {
    const message = value.message ? `${value.name}: ${value.message}` : value.name;
    return value.stack ? { message, stack: value.stack } : { message };
  }
  if (typeof value === "string") return { message: value };
  if (value !== null && typeof value === "object") {
    const { message, stack, name } = value as { message?: unknown; stack?: unknown; name?: unknown };
    if (typeof message === "string" && message) {
      const prefixed = typeof name === "string" && name ? `${name}: ${message}` : message;
      return typeof stack === "string" ? { message: prefixed, stack } : { message: prefixed };
    }
    try {
      return { message: JSON.stringify(value) ?? String(value) };
    } catch {
      return { message: Object.prototype.toString.call(value) };
    }
  }
  return { message: String(value) };
}

export function isIgnoredError(described: Described): boolean {
  if (!described.message.trim()) return true;
  if (IGNORED_MESSAGES.some((pattern) => pattern.test(described.message))) return true;
  return EXTENSION_SOURCE.test(described.stack ?? "");
}

const CONTEXT_PATTERN = /^[\w.:-]{1,40}$/;

export function createTelemetry(host: TelemetryHost, options: TelemetryOptions = {}): Telemetry {
  const enabled = options.enabled ?? false;
  const sampleRate = Math.min(1, Math.max(0, options.errorSampleRate ?? 1));
  const events = new Map<FunnelEvent, number>();
  const errors: ErrorItem[] = [];
  const once = new Set<FunnelEvent>();
  const seen = new Set<string>();
  let reported = 0;
  let timer: unknown = null;

  const flush = () => {
    if (timer !== null) {
      host.cancel(timer);
      timer = null;
    }
    if (events.size === 0 && errors.length === 0) return;
    const batch: LogBatch = { v: 1, b: host.build() };
    if (events.size > 0) batch.e = Object.fromEntries(events);
    if (events.has("page_view")) batch.r = host.referrer();
    if (errors.length > 0) batch.x = errors.splice(0, MAX_ERRORS_PER_BATCH);
    events.clear();
    try {
      host.send(JSON.stringify(batch));
    } catch {
      // Telemetry is best effort.
    }
    // Anything beyond one batch's worth of errors goes in the next request.
    if (errors.length > 0) schedule();
  };

  const schedule = () => {
    if (timer === null) timer = host.schedule(flush, FLUSH_DELAY_MS);
  };

  return {
    enabled,
    track(event, opts) {
      if (!enabled) return;
      if (opts?.once) {
        if (once.has(event)) return;
        once.add(event);
      }
      events.set(event, (events.get(event) ?? 0) + 1);
      schedule();
    },
    report(error, context, kind = "report") {
      if (!enabled || reported >= MAX_ERRORS_PER_PAGE) return;
      try {
        const described = describeError(error);
        if (isIgnoredError(described)) return;
        const key = `${kind}|${described.message}|${described.stack?.split("\n")[1] ?? ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (host.random() >= sampleRate) return;
        reported += 1;
        const item: ErrorItem = { k: kind, m: described.message.slice(0, MESSAGE_MAX), p: host.path() };
        if (described.stack) item.s = described.stack.slice(0, STACK_MAX);
        if (context && CONTEXT_PATTERN.test(context)) item.c = context;
        errors.push(item);
        if (errors.length >= MAX_ERRORS_PER_BATCH) flush();
        else schedule();
      } catch {
        // Never let reporting an error throw another.
      }
    },
    flush,
  };
}

// ---------------------------------------------------------------------------
// The page's instance

/** "index-B3x9aQ1z" from "/assets/index-B3x9aQ1z.js"; "dev" on the dev server. */
export function buildId(entry: string | null): string {
  const name = entry?.split("/").pop()?.replace(/\.js$/, "");
  return name && /^[\w.-]{1,64}$/.test(name) ? name : "dev";
}

function browserHost(): TelemetryHost {
  const build = buildId(runningEntry(document));
  // Read at startup, before the shell takes ?from=share out of the address bar.
  const source = referrerClass({ referrer: document.referrer, search: window.location.search, host: window.location.hostname });
  return {
    send(body) {
      try {
        if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon(LOG_URL, body)) return true;
      } catch {
        // Some browsers throw instead of returning false; fall through to fetch.
      }
      void fetch(LOG_URL, {
        method: "POST",
        body,
        keepalive: true,
        credentials: "same-origin",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
      }).catch(() => undefined);
      return true;
    },
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: (handle) => window.clearTimeout(handle as number),
    random: Math.random,
    build: () => build,
    path: () => window.location.pathname,
    referrer: () => source,
  };
}

function defaultEnabled(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (navigator.webdriver) return false;
  const flag = import.meta.env.VITE_TELEMETRY as string | undefined;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return import.meta.env.PROD && window.location.hostname === "www.rampridge.xyz";
}

let instance: Telemetry | null = null;
let installed = false;

function current(): Telemetry {
  instance ??=
    typeof window === "undefined"
      ? createTelemetry(nullHost(), { enabled: false })
      : createTelemetry(browserHost(), { enabled: defaultEnabled() });
  return instance;
}

function nullHost(): TelemetryHost {
  return { send: () => false, schedule: () => null, cancel: () => undefined, random: () => 1, build: () => "dev", path: () => "/", referrer: () => "direct" };
}

/**
 * Starts telemetry for this page: global error listeners, flush on hide, and
 * the page view. Safe to call more than once; only the first call counts.
 */
export function installTelemetry(options: TelemetryOptions = {}): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  try {
    instance = createTelemetry(browserHost(), { ...options, enabled: options.enabled ?? defaultEnabled() });
    const telemetry = instance;
    if (!telemetry.enabled) return;
    window.addEventListener("error", (event: ErrorEvent) => {
      // Resource load failures (an <img> 404) arrive here without an error object or message.
      if (!event.error && !event.message) return;
      const value =
        event.error ??
        { message: event.message, stack: event.filename ? `at ${event.filename}:${event.lineno}:${event.colno}` : undefined };
      telemetry.report(value, undefined, "error");
    });
    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      telemetry.report(event.reason, undefined, "rejection");
    });
    window.addEventListener("pagehide", () => telemetry.flush());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") telemetry.flush();
    });
    telemetry.track("page_view", { once: true });
  } catch {
    // A broken telemetry setup must not stop the game from starting.
  }
}

/** Counts a funnel step. `once` counts it at most once per page load. */
export function track(event: FunnelEvent, options?: { once?: boolean }): void {
  try {
    current().track(event, options);
  } catch {
    // Best effort.
  }
}

/**
 * Reports a handled error worth seeing on launch day, with a short context
 * label ("signal", "fulfil", "deposit", "sponsorship"). User rejections in a
 * wallet are ignored.
 */
export function report(error: unknown, context?: string): void {
  try {
    current().report(error, context, "report");
  } catch {
    // Best effort.
  }
}

/** Sends anything queued now (before a deliberate reload, for example). */
export function flushTelemetry(): void {
  try {
    current().flush();
  } catch {
    // Best effort.
  }
}
