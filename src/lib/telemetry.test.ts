import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildId,
  createTelemetry,
  describeError,
  FLUSH_DELAY_MS,
  isIgnoredError,
  MAX_ERRORS_PER_BATCH,
  MAX_ERRORS_PER_PAGE,
  report,
  track,
} from "./telemetry";
import type { LogBatch, TelemetryHost, TelemetryOptions } from "./telemetry";

function fakeHost(overrides: Partial<TelemetryHost> = {}) {
  const sent: LogBatch[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const host: TelemetryHost = {
    send(body) {
      sent.push(JSON.parse(body) as LogBatch);
      return true;
    },
    schedule(fn, ms) {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(handle) {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    random: () => 0,
    build: () => "index-abc123",
    path: () => "/",
    ...overrides,
  };
  const runTimers = () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
  };
  return { host, sent, timers, runTimers };
}

function setup(options: TelemetryOptions = { enabled: true }, overrides: Partial<TelemetryHost> = {}) {
  const fake = fakeHost(overrides);
  return { ...fake, telemetry: createTelemetry(fake.host, options) };
}

describe("funnel events", () => {
  it("coalesces events into one batch after the flush delay", () => {
    const { telemetry, sent, timers, runTimers } = setup();
    telemetry.track("page_view");
    telemetry.track("play");
    telemetry.track("play");
    expect(sent).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(FLUSH_DELAY_MS);
    runTimers();
    expect(sent).toEqual([{ v: 1, b: "index-abc123", e: { page_view: 1, play: 2 } }]);
  });

  it("counts a once event a single time per page", () => {
    const { telemetry, sent } = setup();
    telemetry.track("page_view", { once: true });
    telemetry.track("page_view", { once: true });
    telemetry.flush();
    telemetry.track("page_view", { once: true });
    telemetry.flush();
    expect(sent).toEqual([{ v: 1, b: "index-abc123", e: { page_view: 1 } }]);
  });

  it("sends nothing when disabled or empty", () => {
    const { telemetry, sent, timers } = setup({ enabled: false });
    telemetry.track("play");
    telemetry.report(new Error("boom"));
    telemetry.flush();
    expect(sent).toEqual([]);
    expect(timers).toEqual([]);
    const enabled = setup();
    enabled.telemetry.flush();
    expect(enabled.sent).toEqual([]);
  });

  it("survives a host that throws", () => {
    const { telemetry } = setup({ enabled: true }, {
      send: () => {
        throw new Error("beacon refused");
      },
    });
    telemetry.track("play");
    expect(() => telemetry.flush()).not.toThrow();
  });
});

describe("errors", () => {
  it("reports errors with name, message, stack, path and context", () => {
    const { telemetry, sent } = setup({ enabled: true }, { path: () => "/t/AbCdEf1234" });
    const error = new TypeError("x is undefined");
    error.stack = "TypeError: x is undefined\n    at fulfil (https://www.rampridge.xyz/assets/a.js:1:2)";
    telemetry.report(error, "fulfil");
    telemetry.report("plain string failure", "bad context!", "rejection");
    telemetry.flush();
    expect(sent[0]?.x).toEqual([
      { k: "report", m: "TypeError: x is undefined", s: error.stack, p: "/t/AbCdEf1234", c: "fulfil" },
      { k: "rejection", m: "plain string failure", p: "/t/AbCdEf1234" },
    ]);
  });

  it("ignores wallet rejections, extension noise and empty errors", () => {
    const { telemetry, sent } = setup();
    telemetry.report(new Error("User rejected the request."));
    telemetry.report({ message: "MetaMask: user denied transaction signature" });
    telemetry.report({ message: "boom", stack: "at x (chrome-extension://abc/inject.js:1:2)" });
    telemetry.report("Script error.");
    telemetry.report("");
    telemetry.flush();
    expect(sent).toEqual([]);
  });

  it("reports each distinct error once and caps a page", () => {
    const { telemetry, sent, runTimers } = setup();
    for (let i = 0; i < 3; i++) telemetry.report(new Error("same"));
    for (let i = 0; i < MAX_ERRORS_PER_PAGE + 5; i++) telemetry.report(new Error(`distinct ${i}`));
    for (let i = 0; i < 5; i++) runTimers();
    const all = sent.flatMap((batch) => batch.x ?? []);
    expect(all).toHaveLength(MAX_ERRORS_PER_PAGE);
    expect(all.filter((item) => item.m === "Error: same")).toHaveLength(1);
    expect(sent.every((batch) => (batch.x?.length ?? 0) <= MAX_ERRORS_PER_BATCH)).toBe(true);
  });

  it("flushes as soon as a batch's worth of errors is queued", () => {
    const { telemetry, sent } = setup();
    for (let i = 0; i < MAX_ERRORS_PER_BATCH; i++) telemetry.report(new Error(`e${i}`));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.x).toHaveLength(MAX_ERRORS_PER_BATCH);
  });

  it("samples distinct errors", () => {
    const { telemetry, sent } = setup({ enabled: true, errorSampleRate: 0.5 }, { random: () => 0.9 });
    telemetry.report(new Error("sampled out"));
    telemetry.track("play");
    telemetry.flush();
    expect(sent).toEqual([{ v: 1, b: "index-abc123", e: { play: 1 } }]);
  });

  it("trims what it sends", () => {
    const { telemetry, sent } = setup();
    telemetry.report(new Error("y".repeat(5_000)));
    telemetry.flush();
    expect(sent[0]?.x?.[0]?.m.length).toBe(500);
  });
});

describe("helpers", () => {
  it("describes anything thrown", () => {
    expect(describeError(new RangeError("bad"))).toMatchObject({ message: "RangeError: bad" });
    expect(describeError({ name: "ApiError", message: "nope" })).toEqual({ message: "ApiError: nope" });
    expect(describeError({ code: 4001 })).toEqual({ message: '{"code":4001}' });
    expect(describeError(undefined)).toEqual({ message: "undefined" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular).message).toBe("[object Object]");
    expect(isIgnoredError({ message: "ResizeObserver loop completed with undelivered notifications." })).toBe(true);
  });

  it("names the build after its entry chunk", () => {
    expect(buildId("/assets/index-B3x9aQ1z.js")).toBe("index-B3x9aQ1z");
    expect(buildId(null)).toBe("dev");
  });

  it("is inert outside a browser", () => {
    expect(() => {
      track("play");
      report(new Error("no window"));
    }).not.toThrow();
  });
});

describe("installTelemetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  type Listener = (event: unknown) => void;

  async function boot(env: { prod: boolean; host: string; webdriver?: boolean; flag?: string }) {
    const listeners: Record<string, Listener> = {};
    const beacons: Array<{ url: string; body: LogBatch }> = [];
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
      location: { hostname: env.host, pathname: "/" },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    vi.stubGlobal("document", {
      querySelectorAll: () => [{ getAttribute: () => "/assets/index-B3x9aQ1z.js" }],
      addEventListener: (type: string, fn: Listener) => (listeners[`document:${type}`] = fn),
      visibilityState: "hidden",
    });
    vi.stubGlobal("navigator", {
      webdriver: env.webdriver ?? false,
      sendBeacon: (url: string, body: string) => beacons.push({ url, body: JSON.parse(body) as LogBatch }) > 0,
    });
    vi.stubEnv("PROD", env.prod);
    if (env.flag !== undefined) vi.stubEnv("VITE_TELEMETRY", env.flag);
    const mod = await import("./telemetry");
    mod.installTelemetry();
    return { mod, listeners, beacons };
  }

  it("is on for the production build on www.rampridge.xyz and counts the page view", async () => {
    const { listeners, beacons, mod } = await boot({ prod: true, host: "www.rampridge.xyz" });
    mod.installTelemetry();
    listeners.pagehide?.({});
    expect(beacons).toEqual([{ url: "/api/log", body: { v: 1, b: "index-B3x9aQ1z", e: { page_view: 1 } } }]);
  });

  it("reports uncaught errors and rejections, skipping resource load failures", async () => {
    const { listeners, beacons } = await boot({ prod: true, host: "www.rampridge.xyz" });
    listeners.error?.({ error: new Error("boom") });
    listeners.error?.({ error: null, message: "" });
    listeners.error?.({ error: null, message: "Uncaught ReferenceError: x", filename: "https://www.rampridge.xyz/assets/a.js", lineno: 1, colno: 2 });
    listeners.unhandledrejection?.({ reason: "nope" });
    listeners["document:visibilitychange"]?.({});
    const errors = beacons[0]?.body.x ?? [];
    expect(errors.map((e) => [e.k, e.m])).toEqual([
      ["error", "Error: boom"],
      ["error", "Uncaught ReferenceError: x"],
      ["rejection", "nope"],
    ]);
    expect(errors[1]?.s).toBe("at https://www.rampridge.xyz/assets/a.js:1:2");
  });

  it.each([
    ["a preview deployment", { prod: true, host: "rampridge-abc-team.vercel.app" }],
    ["the dev server", { prod: false, host: "localhost" }],
    ["an automated browser", { prod: true, host: "www.rampridge.xyz", webdriver: true }],
    ["VITE_TELEMETRY=0", { prod: true, host: "www.rampridge.xyz", flag: "0" }],
  ])("is off for %s", async (_label, env) => {
    const { listeners, beacons, mod } = await boot(env);
    mod.track("play");
    listeners.pagehide?.({});
    mod.flushTelemetry();
    expect(beacons).toEqual([]);
    expect(listeners.error).toBeUndefined();
  });

  it("can be forced on for the emulator with VITE_TELEMETRY=1", async () => {
    const { listeners, beacons } = await boot({ prod: false, host: "localhost", flag: "1" });
    listeners.pagehide?.({});
    expect(beacons[0]?.body.e).toEqual({ page_view: 1 });
  });
});

