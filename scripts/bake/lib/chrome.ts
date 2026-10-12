/**
 * Headless Chrome over the DevTools Protocol, for bake steps that render
 * HTML/WebGL to PNG (the logo) and for preview screenshots. Each
 * session uses a throwaway profile that is deleted on close. Pages signal
 * completion by setting document.title to READY (or ERROR).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const CHROME_PATH = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface CaptureOptions {
  width: number;
  height: number;
  /** Transparent page background (for logos). */
  transparent?: boolean;
  /** Fail when the page sets document.title to ERROR (default true). */
  strict?: boolean;
  timeoutMs?: number;
}

export interface ChromeSession {
  capture(url: string, opts: CaptureOptions): Promise<{ png: Buffer; title: string; ms: number }>;
  close(): void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export async function openChrome(): Promise<ChromeSession> {
  if (!fs.existsSync(CHROME_PATH)) throw new Error(`Chrome not found at ${CHROME_PATH} (set CHROME_PATH)`);
  const root = process.env.SHOOT_PROFILE_ROOT ?? os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const profile = fs.mkdtempSync(path.join(root, "bake-chrome-"));
  const proc = spawn(
    CHROME_PATH,
    [
      "--headless=new",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--hide-scrollbars",
      "--font-render-hinting=none",
      // Deterministic output: CPU raster on one thread (SVG filters otherwise vary by a few
      // pixel levels between runs); WebGL still runs on SwiftShader.
      "--disable-gpu-rasterization",
      "--num-raster-threads=1",
      "--disable-partial-raster",
      "--run-all-compositor-stages-before-draw",
      ...(process.env.CHROME_EXTRA_FLAGS?.split(" ").filter(Boolean) ?? []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const close = () => {
    proc.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  };
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error("Chrome did not start")), 20000);
      proc.stderr!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(t);
          resolve(m[1]!);
        }
      });
    });
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("CDP connection failed"));
    });
    let nextId = 1;
    const pending = new Map<number, Pending>();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    };
    const send = <T>(method: string, params: object = {}, sessionId?: string) =>
      new Promise<T>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    return {
      async capture(url, opts) {
        const started = Date.now();
        const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        try {
          await send("Emulation.setDeviceMetricsOverride", { width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false }, sessionId);
          if (opts.transparent) {
            await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } }, sessionId);
          }
          await send("Page.enable", {}, sessionId);
          await send("Page.navigate", { url }, sessionId);
          let title = "";
          const deadline = started + (opts.timeoutMs ?? 120000);
          while (Date.now() < deadline) {
            const r = await send<{ result: { value: string } }>("Runtime.evaluate", { expression: "document.title" }, sessionId);
            title = r.result.value;
            if (title === "READY" || title === "ERROR") break;
            await new Promise((r2) => setTimeout(r2, 200));
          }
          if (title !== "READY" && title !== "ERROR") throw new Error(`${url} did not finish (title "${title}")`);
          if (title === "ERROR" && opts.strict !== false) {
            const r = await send<{ result: { value: string } }>("Runtime.evaluate", { expression: "document.body.innerText" }, sessionId);
            throw new Error(`${url} reported an error: ${r.result.value.slice(0, 2000)}`);
          }
          await new Promise((r2) => setTimeout(r2, 250));
          const shot = await send<{ data: string }>("Page.captureScreenshot", { format: "png" }, sessionId);
          return { png: Buffer.from(shot.data, "base64"), title, ms: Date.now() - started };
        } finally {
          await send("Target.closeTarget", { targetId });
        }
      },
      close() {
        ws.close();
        close();
      },
    };
  } catch (e) {
    close();
    throw e;
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".glb": "model/gltf-binary",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
};

/** Minimal static file server (localhost, random port) for bake render pages. */
export async function serveDir(root: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(path.resolve(root)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server failed to bind");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
