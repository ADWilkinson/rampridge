/**
 * Minimal headless Chrome driver over the DevTools protocol (Node's global
 * WebSocket). Each browser gets a fresh profile under the suite's profile
 * directory (E2E_CHROME_PROFILES), deleted on close. CHROME_PATH overrides the
 * browser binary.
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
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP socket failed"));
  });
  let id = 0;
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Listener[]>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown; method?: string; params?: Record<string, unknown> };
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? {});
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params ?? {});
    }
  };
  const send = <T,>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const on = (method: string, fn: Listener) => {
    listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  };
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

  const waitLoad = async (navigate: () => Promise<unknown>) => {
    const loaded = new Promise((r) => on("Page.loadEventFired", r));
    await navigate();
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 60_000))]);
  };

  const page: Page = {
    send,
    on,
    logs,
    async viewport(v, opts = {}) {
      await send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: v.mobile });
      await send("Emulation.setTouchEmulationEnabled", v.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
      if (opts.userAgent) await send("Emulation.setUserAgentOverride", { userAgent: opts.userAgent });
    },
    goto: (url) => waitLoad(() => send("Page.navigate", { url })),
    reload: () => waitLoad(() => send("Page.reload", { ignoreCache: false })),
    eval: evaluate,
    async waitFor(expression, timeoutMs = 60_000, label) {
      const start = Date.now();
      let last = "";
      while (Date.now() - start < timeoutMs) {
        try {
          if (await evaluate<boolean>(expression)) return;
        } catch (error) {
          last = error instanceof Error ? error.message : String(error);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const step = await evaluate<string>("window.__e2e?.state().step ?? 'no harness'").catch(() => "?");
      const ui = await page.uiText().catch(() => "");
      throw new Error(`timeout waiting for ${label ?? expression} (step ${step}) ${last}\nUI: ${ui.slice(0, 600)}`);
    },
    async screenshot(file) {
      await new Promise((r) => setTimeout(r, 250));
      const res = await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(file, Buffer.from(res.data, "base64"));
      return file;
    },
    async click(text, opts = {}) {
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
    },
    async typeAndEnter(text) {
      await send("Input.insertText", { text });
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      }
    },
    uiText: () => evaluate<string>(`(document.querySelector('.rs-gameframe__interfaces')?.innerText ?? document.body.innerText).replace(/\\s+/g, ' ').trim()`),
    async close() {
      try {
        await send("Browser.close");
      } catch {
        // already closed
      }
      ws.close();
      const exited = new Promise((r) => (proc.exitCode !== null ? r(null) : proc.once("exit", r)));
      proc.kill("SIGKILL");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      // Helper processes can still be flushing into the profile for a moment after the browser exits.
      await new Promise((r) => setTimeout(r, 500));
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
  return page;
}
