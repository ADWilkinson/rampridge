// Minimal headless Chrome driver over the DevTools Protocol (Node 22+ global
// WebSocket, no dependencies). Each launch uses a throwaway profile under
// SHOOT_PROFILE_ROOT (or the OS temp dir) that is deleted on close.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_PATH = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts Chrome and attaches to its first tab. `gpu: true` renders WebGL on
 * the real GPU (Metal), which the engine needs to run at a normal frame rate.
 */
export async function launch({ gpu = true, extraArgs = [] } = {}) {
  const root = process.env.SHOOT_PROFILE_ROOT ?? os.tmpdir();
  mkdirSync(root, { recursive: true });
  const profile = mkdtempSync(path.join(root, "og-chrome-"));
  const proc = spawn(
    CHROME_PATH,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      gpu ? "--use-angle=metal" : "--disable-gpu",
      "--enable-unsafe-swiftshader",
      ...extraArgs,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const kill = () => {
    proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  };
  let ws;
  try {
    const browserUrl = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("Chrome did not start (set CHROME_PATH?)")), 20000);
      proc.stderr.on("data", (d) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });
    const { host } = new URL(browserUrl);
    const targets = await (await fetch(`http://${host}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("CDP connection failed"));
    });
  } catch (e) {
    kill();
    throw e;
  }

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };
  await send("Page.enable");
  await send("Runtime.enable");
  const logs = [];
  on("Runtime.consoleAPICalled", (p) => logs.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description ?? "").join(" ")}`));
  on("Runtime.exceptionThrown", (p) => logs.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));

  const api = {
    logs,
    /** Errors and exceptions the page logged, most recent last. */
    errors: () => logs.filter((l) => l.startsWith("exception") || l.startsWith("error")),
    async viewport(width, height, dpr = 1) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
    },
    async goto(url) {
      const loaded = new Promise((r) => on("Page.loadEventFired", r));
      await send("Page.navigate", { url });
      await Promise.race([loaded, sleep(30000)]);
    },
    /** Evaluates script text written by these scripts in the local page under capture. */
    async eval(expression) {
      const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
      return res.result.value;
    },
    async waitFor(expression, timeoutMs = 60000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          if (await api.eval(expression)) return;
        } catch {
          // Not there yet: keep polling.
        }
        await sleep(250);
      }
      throw new Error(`timed out waiting for ${expression}`);
    },
    async screenshot(file) {
      const res = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(res.data, "base64"));
      return file;
    },
    async close() {
      try {
        await send("Browser.close");
      } catch {
        // Already gone.
      }
      ws.close();
      await sleep(300);
      kill();
    },
  };
  return api;
}

export { sleep };
