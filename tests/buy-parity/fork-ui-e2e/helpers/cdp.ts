/**
 * Minimal headless Chrome driver over the DevTools protocol (Node's global
 * WebSocket). Each browser gets a fresh profile under the suite's profile
 * directory (E2E_CHROME_PROFILES), deleted on close. CHROME_PATH overrides the
 * browser binary.
 *
 * No call waits forever: each has a deadline (DEADLINE_MS), and a crashed page,
 * a dead browser or a dropped socket fails every pending and later call at
 * once. The error names the method, the step the scenario was on and its last
 * screenshot.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  dpr: number;
}

export const DESKTOP: Viewport = { name: "desktop", width: 1440, height: 900, mobile: false, dpr: 1 };
export const PHONE: Viewport = { name: "phone", width: 390, height: 844, mobile: true, dpr: 2 };

type Listener = (params: Record<string, unknown>) => void;

/**
 * How long a call may go unanswered, by method (30 s otherwise). These catch a hung or dead
 * browser, not a slow page, so they sit far above the slowest real answer:
 * - Runtime.evaluate: every expression the suite evaluates is synchronous, so awaitPromise never
 *   waits on the page; only a busy main thread delays the answer. waitFor and click poll under
 *   their own deadlines.
 * - Page.navigate and Page.reload answer once the document commits; waitLoad bounds the load.
 * - Page.captureScreenshot waits for a fresh frame from the renderer.
 * - Browser.close: close() kills the process after it anyway.
 */
const DEADLINE_MS: Record<string, number> = {
  "Runtime.evaluate": 60_000,
  "Page.navigate": 90_000,
  "Page.reload": 90_000,
  "Page.captureScreenshot": 60_000,
  "Browser.close": 5_000,
};

/** A call that will never be answered (deadline passed, page crashed, browser or socket gone); waitFor stops on it instead of polling on. */
class CdpError extends Error {}

/** Every profile directory this process created, so a suite can sweep them after a crash mid-scenario. */
export const createdProfiles = new Set<string>();

export function removeProfiles(): void {
  for (const dir of createdProfiles) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  createdProfiles.clear();
}

export interface Page {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(method: string, fn: Listener): void;
  logs: string[];
  viewport(v: Viewport, opts?: { userAgent?: string }): Promise<void>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  eval<T = unknown>(expression: string): Promise<T>;
  waitFor(expression: string, timeoutMs?: number, label?: string): Promise<void>;
  screenshot(file: string): Promise<string>;
  /** Clicks the first visible, enabled button or link inside the open interfaces whose text or aria-label matches. */
  click(text: string | RegExp, opts?: { within?: string; timeoutMs?: number }): Promise<void>;
  /** Visible text of the interface layer (what the player reads). */
  uiText(): Promise<string>;
  /** Types into the focused field, then presses Enter. */
  typeAndEnter(text: string): Promise<void>;
  close(): Promise<void>;
}

export async function launchChrome(profilesDir: string, port: number): Promise<Page> {
  const dir = path.join(profilesDir, `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  createdProfiles.add(dir);
  const proc: ChildProcess = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let version: unknown = null;
  for (let i = 0; i < 150 && !version; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!version) {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw new Error("Chrome did not start");
  }
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("no Chrome page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP socket did not open in 30 s")), 30_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("CDP socket failed"));
    };
  }).catch((error: unknown) => {
    proc.kill("SIGKILL");
    throw error;
  });

  /** The driver action in progress (or the last one finished) and the screenshot in progress or last taken: where a failed call was. */
  let action = "launch";
  let shot = "";
  const where = () => `${action}${shot ? `; last shot ${shot}` : ""}`;
  const fault = (method: string, why: string) => new CdpError(`CDP ${method} ${why} (${where()})`);
  const during = async <T,>(name: string, run: () => Promise<T>): Promise<T> => {
    action = name;
    try {
      return await run();
    } finally {
      action = `after ${name}`;
    }
  };

  let id = 0;
  const pending = new Map<number, { method: string; resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Map<string, Listener[]>();
  /** Why the browser can no longer answer, once it can't. */
  let broken: string | null = null;
  let markBroken = () => {};
  const brokenSignal = new Promise<void>((r) => (markBroken = r));
  const fail = (why: string) => {
    broken ??= why;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(fault(p.method, `failed: ${broken}`));
    }
    pending.clear();
    markBroken();
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown; method?: string; params?: Record<string, unknown> };
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      // A protocol error (say, the context went away mid-reload) is an answer: waitFor polls on through it.
      if (msg.error) p.reject(new Error(`CDP ${p.method} failed: ${JSON.stringify(msg.error)} (${where()})`));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params ?? {});
    }
  };
  // A socket error is always followed by close, which carries the code.
  ws.onclose = (event) => fail(`socket closed (${event.code})`);
  proc.once("exit", (code, signal) => fail(`Chrome exited (${signal ?? code})`));
  const send = <T,>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      if (broken) return reject(fault(method, `failed: ${broken}`));
      const mid = ++id;
      const ms = DEADLINE_MS[method] ?? 30_000;
      const timer = setTimeout(() => {
        pending.delete(mid);
        reject(fault(method, `got no answer in ${ms / 1000} s`));
      }, ms);
      pending.set(mid, { method, resolve: resolve as (v: Record<string, unknown>) => void, reject, timer });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const on = (method: string, fn: Listener) => {
    listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  };
  on("Inspector.targetCrashed", () => fail("page crashed"));
  await send("Page.enable");
  await send("Runtime.enable");
  const logs: string[] = [];
  on("Runtime.consoleAPICalled", (p) => {
    const args = (p.args as Array<{ value?: unknown; description?: string }>) ?? [];
    logs.push(`${String(p.type)}: ${args.map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ")}`);
  });
  on("Runtime.exceptionThrown", (p) => {
    const d = p.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
    logs.push(`exception: ${d?.exception?.description ?? d?.text ?? ""}`);
  });

  const evaluate = async <T,>(expression: string): Promise<T> => {
    const res = await send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluation failed");
    return res.result.value as T;
  };

  const waitLoad = async (method: string, params: Record<string, unknown>) => {
    const loaded = new Promise((r) => on("Page.loadEventFired", r));
    await send(method, params);
    await Promise.race([loaded, brokenSignal, new Promise((r) => setTimeout(r, 60_000))]);
    if (broken) throw fault(method, `failed before the page loaded: ${broken}`);
  };

  const page: Page = {
    send,
    on,
    logs,
    viewport: (v, opts = {}) =>
      during(`viewport ${v.name}`, async () => {
        await send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: v.mobile });
        await send("Emulation.setTouchEmulationEnabled", v.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        if (opts.userAgent) await send("Emulation.setUserAgentOverride", { userAgent: opts.userAgent });
      }),
    goto: (url) => during(`goto ${url}`, () => waitLoad("Page.navigate", { url })),
    reload: () => during("reload", () => waitLoad("Page.reload", { ignoreCache: false })),
    eval: evaluate,
    waitFor: (expression, timeoutMs = 60_000, label) =>
      during(`waiting for ${label ?? expression}`, async () => {
        const start = Date.now();
        let last = "";
        while (Date.now() - start < timeoutMs) {
          try {
            if (await evaluate<boolean>(expression)) return;
          } catch (error) {
            if (error instanceof CdpError) throw error;
            last = error instanceof Error ? error.message : String(error);
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        const step = await evaluate<string>("window.__e2e?.state().step ?? 'no harness'").catch(() => "?");
        const ui = await page.uiText().catch(() => "");
        throw new Error(`timeout waiting for ${label ?? expression} (step ${step}) ${last}\nUI: ${ui.slice(0, 600)}`);
      }),
    async screenshot(file) {
      shot = path.basename(file, ".png");
      await new Promise((r) => setTimeout(r, 250));
      const res = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(file, Buffer.from(res.data, "base64"));
      return file;
    },
    click: (text, opts = {}) =>
      during(`clicking ${String(text)}`, async () => {
        const within = opts.within ?? ".rs-gameframe__interfaces";
        const matcher = typeof text === "string" ? JSON.stringify({ s: text }) : JSON.stringify({ r: text.source, f: text.flags });
        const expression = `(() => {
          const m = ${matcher};
          const test = (t) => m.s !== undefined ? t === m.s : new RegExp(m.r, m.f).test(t);
          const root = document.querySelector(${JSON.stringify(within)}) ?? document;
          const els = Array.from(root.querySelectorAll('button, a, [role="radio"]'));
          const el = els.find((e) => !e.disabled && e.getClientRects().length > 0 && (test((e.textContent ?? '').trim()) || test(e.getAttribute('aria-label') ?? '')));
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        })()`;
        const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
        while (Date.now() < deadline) {
          if (await evaluate<boolean>(expression)) return;
          await new Promise((r) => setTimeout(r, 250));
        }
        const ui = await page.uiText().catch(() => "");
        throw new Error(`nothing clickable matching ${String(text)}\nUI: ${ui.slice(0, 800)}`);
      }),
    typeAndEnter: (text) =>
      during("typing", async () => {
        await send("Input.insertText", { text });
        for (const type of ["keyDown", "keyUp"]) {
          await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        }
      }),
    uiText: () => evaluate<string>(`(document.querySelector('.rs-gameframe__interfaces')?.innerText ?? document.body.innerText).replace(/\\s+/g, ' ').trim()`),
    async close() {
      try {
        await send("Browser.close");
      } catch {
        // already closed
      }
      ws.close();
      const exited = new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r(null) : proc.once("exit", r)));
      proc.kill("SIGKILL");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      // Helper processes can still be flushing into the profile for a moment after the browser exits.
      await new Promise((r) => setTimeout(r, 500));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
  return page;
}
