import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEV_API_OFF_MESSAGE, describeDevDatabase, devApi, devDatabase } from "../../scripts/dev-api";

describe("devDatabase", () => {
  it("prefers the emulator, then an explicit live opt-in, else stays off", () => {
    expect(devDatabase({ FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000", RAMPRIDGE_DEV_LIVE_DB: "1" })).toEqual({
      kind: "emulator",
      host: "127.0.0.1:9000",
    });
    expect(devDatabase({ RAMPRIDGE_DEV_LIVE_DB: "1" })).toEqual({ kind: "live" });
    expect(devDatabase({ RAMPRIDGE_DEV_LIVE_DB: "true" })).toEqual({ kind: "off" });
    expect(devDatabase({ FIREBASE_DATABASE_EMULATOR_HOST: " " })).toEqual({ kind: "off" });
    expect(devDatabase({})).toEqual({ kind: "off" });
  });

  it("names the database without echoing configuration", () => {
    expect(describeDevDatabase({ kind: "live" })).toMatch(/LIVE rampridge-world/);
    expect(describeDevDatabase({ kind: "off" })).toMatch(/503/);
  });
});

describe("devApi plugin", () => {
  const names = [
    "FIREBASE_DATABASE_EMULATOR_HOST",
    "RAMPRIDGE_DEV_LIVE_DB",
    "FIREBASE_SERVICE_ACCOUNT",
    "SESSION_SECRET",
    "BASE_RPC_URL",
    "CRON_SECRET",
  ] as const;
  let saved: Record<string, string | undefined>;
  let root: string;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) delete process.env[n];
    root = mkdtempSync(path.join(tmpdir(), "dev-api-"));
  });

  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    rmSync(root, { recursive: true, force: true });
  });

  function start(plugin: Plugin) {
    const logs: string[] = [];
    let middleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | null = null;
    (plugin.configResolved as (config: ResolvedConfig) => void)({ mode: "development", root } as ResolvedConfig);
    const server = {
      config: { logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: () => {} } },
      middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
    } as unknown as ViteDevServer;
    (plugin.configureServer as (server: ViteDevServer) => void)(server);
    return { logs, middleware: middleware! };
  }

  /** A ServerResponse stand-in that records what the middleware sent. */
  function response(onEnd: (status: number, body: string) => void): ServerResponse {
    const res = { statusCode: 0, setHeader: () => {}, end: (body: string) => onEnd(res.statusCode, body) };
    return res as unknown as ServerResponse;
  }

  function call(middleware: ReturnType<typeof start>["middleware"], url: string) {
    const out = { status: 0, body: "", nextCalled: false };
    const res = response((status, body) => Object.assign(out, { status, body }));
    middleware({ url } as IncomingMessage, res, () => (out.nextCalled = true));
    return out;
  }

  it("refuses /api/* when neither the emulator nor the live opt-in is set", () => {
    const { logs, middleware } = start(devApi({ apiDir: root }));
    expect(logs).toEqual([describeDevDatabase({ kind: "off" })]);
    const blocked = call(middleware, "/api/session");
    expect(blocked.status).toBe(503);
    expect(JSON.parse(blocked.body)).toMatchObject({ ok: false, code: "server", error: DEV_API_OFF_MESSAGE });
    expect(call(middleware, "/index.html").nextCalled).toBe(true);
  });

  it("reads the opt-in from .env.local like the other server variables", () => {
    writeFileSync(path.join(root, ".env.local"), "RAMPRIDGE_DEV_LIVE_DB=1\nFIREBASE_SERVICE_ACCOUNT=placeholder\n");
    const { logs } = start(devApi({ apiDir: root }));
    expect(logs).toEqual([describeDevDatabase({ kind: "live" })]);
    expect(process.env.FIREBASE_SERVICE_ACCOUNT).toBe("placeholder");
  });

  it("routes /api/* against the emulator without loading the service account", () => {
    writeFileSync(
      path.join(root, ".env.local"),
      "FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000\nFIREBASE_SERVICE_ACCOUNT=placeholder\nSESSION_SECRET=placeholder\n",
    );
    const { logs, middleware } = start(devApi({ apiDir: root }));
    expect(logs).toEqual(["[dev-api] /api/* uses the Firebase database emulator at 127.0.0.1:9000."]);
    expect(process.env.FIREBASE_SERVICE_ACCOUNT).toBeUndefined();
    expect(process.env.SESSION_SECRET).toBe("placeholder");
    // No api/ files exist in the temp root, so the request reaches routing and 404s instead of 503.
    return new Promise<void>((resolve) => {
      const res = response((status) => {
        expect(status).toBe(404);
        resolve();
      });
      middleware({ url: "/api/session" } as IncomingMessage, res, () => {});
    });
  });
});
