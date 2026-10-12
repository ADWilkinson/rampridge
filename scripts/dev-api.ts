/**
 * Serves the Vercel functions in `api/` from the Vite dev server, so
 * `bun run dev` runs the whole game locally. `/api/foo/bar` maps to
 * `api/foo/bar.ts` and the exported GET/POST/... handler receives a Web
 * Request. Modules load through Vite's SSR loader, so edits hot-reload.
 * Server env vars (FIREBASE_SERVICE_ACCOUNT, SESSION_SECRET, BASE_RPC_URL,
 * CRON_SECRET) are read from the shell or `.env*.local`, never logged.
 *
 * `rampridge-world` has a single, production instance, so the local API fails
 * closed: it answers 503 unless FIREBASE_DATABASE_EMULATOR_HOST points the
 * Admin SDK at the Firebase emulator (`firebase emulators:start --only
 * database`), or RAMPRIDGE_DEV_LIVE_DB=1 explicitly opts in to the live
 * database. With the emulator the production service account is not loaded.
 */

import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { loadEnv } from "vite";
import type { Plugin, ViteDevServer } from "vite";

const SERVER_ENV = ["FIREBASE_SERVICE_ACCOUNT", "SESSION_SECRET", "BASE_RPC_URL", "CRON_SECRET"] as const;
const DATABASE_ENV = ["FIREBASE_DATABASE_EMULATOR_HOST", "RAMPRIDGE_DEV_LIVE_DB"] as const;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
const MAX_BODY_BYTES = 1024 * 1024;

type Handler = (request: Request) => Promise<Response> | Response;

/** Which database the local API would write to. */
export type DevDatabase = { kind: "emulator"; host: string } | { kind: "live" } | { kind: "off" };

export function devDatabase(env: Readonly<Record<string, string | undefined>>): DevDatabase {
  const host = env.FIREBASE_DATABASE_EMULATOR_HOST?.trim();
  if (host) return { kind: "emulator", host };
  if (env.RAMPRIDGE_DEV_LIVE_DB?.trim() === "1") return { kind: "live" };
  return { kind: "off" };
}

export const DEV_API_OFF_MESSAGE =
  "The local API is off so it can't write to the live database. Set FIREBASE_DATABASE_EMULATOR_HOST " +
  "(for example 127.0.0.1:9000, with `firebase emulators:start --only database`), or RAMPRIDGE_DEV_LIVE_DB=1 " +
  "to use the live rampridge-world database, then restart `bun run dev`.";

/** The one startup line naming the database in use. Never includes a secret. */
export function describeDevDatabase(db: DevDatabase): string {
  switch (db.kind) {
    case "emulator":
      return `[dev-api] /api/* uses the Firebase database emulator at ${db.host}.`;
    case "live":
      return "[dev-api] /api/* writes to the LIVE rampridge-world database (RAMPRIDGE_DEV_LIVE_DB=1).";
    case "off":
      return "[dev-api] /api/* is off (503): set FIREBASE_DATABASE_EMULATOR_HOST or RAMPRIDGE_DEV_LIVE_DB=1.";
  }
}

/** Maps a URL path to its function file, refusing private (`_`-prefixed) and traversal paths. */
export function resolveApiFile(apiDir: string, pathname: string): string | null {
  if (!pathname.startsWith("/api/")) return null;
  const route = pathname.slice("/api/".length).replace(/\/+$/, "");
  if (!route) return null;
  const segments = route.split("/");
  if (segments.some((s) => !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s))) return null;
  for (const candidate of [`${route}.ts`, `${route}/index.ts`]) {
    const file = path.join(apiDir, candidate);
    if (existsSync(file)) return file;
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Converts a Node request into a Web Request, adding the client IP as Vercel would. */
export async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  if (!headers.has("x-forwarded-for") && req.socket.remoteAddress) {
    headers.set("x-forwarded-for", req.socket.remoteAddress);
  }
  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  return new Request(url, { method, headers, body: body && body.length > 0 ? new Uint8Array(body) : undefined });
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function devApi(options: { apiDir?: string } = {}): Plugin {
  let apiDir = options.apiDir ?? "";
  let database: DevDatabase = { kind: "off" };
  return {
    name: "rampridge-dev-api",
    apply: "serve",
    configResolved(config) {
      apiDir = options.apiDir ?? path.resolve(config.root, "api");
      const env = loadEnv(config.mode, config.root, "");
      const copy = (name: string) => {
        if (process.env[name] === undefined && env[name] !== undefined) process.env[name] = env[name];
      };
      for (const name of DATABASE_ENV) copy(name);
      database = devDatabase(process.env);
      for (const name of SERVER_ENV) {
        // The emulator needs no credentials; keep the production key out of the process.
        if (name === "FIREBASE_SERVICE_ACCOUNT" && database.kind === "emulator") continue;
        copy(name);
      }
    },
    configureServer(server: ViteDevServer) {
      const line = describeDevDatabase(database);
      if (database.kind === "emulator") server.config.logger.info(line);
      else server.config.logger.warn(line);
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!pathname.startsWith("/api/")) return next();
        if (database.kind === "off") {
          return sendJson(res, 503, { ok: false, error: DEV_API_OFF_MESSAGE, code: "server", now: Date.now() });
        }
        void (async () => {
          const file = resolveApiFile(apiDir, pathname);
          if (!file) return sendJson(res, 404, { ok: false, error: "Not found", code: "not_found", now: Date.now() });
          const mod = (await server.ssrLoadModule(file)) as Partial<Record<(typeof METHODS)[number], Handler>>;
          const method = (req.method ?? "GET").toUpperCase() as (typeof METHODS)[number];
          const handler = mod[method];
          if (typeof handler !== "function") {
            const allow = METHODS.filter((m) => typeof mod[m] === "function").join(", ");
            return sendJson(res, 405, { ok: false, error: "Method not allowed", code: "bad_request", now: Date.now() }, { Allow: allow });
          }
          const response = await handler(await toWebRequest(req));
          await sendWebResponse(res, response);
        })().catch((err: unknown) => {
          if (err instanceof Error) server.ssrFixStacktrace(err);
          server.config.logger.error(`[dev-api] ${pathname}: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Dev API error", code: "server", now: Date.now() });
          else res.end();
        });
      });
    },
  };
}
