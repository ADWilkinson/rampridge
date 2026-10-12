import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noteChunkFailure = vi.fn(() => Promise.resolve());

async function helper() {
  vi.resetModules();
  vi.doMock("./update", () => ({ noteChunkFailure }));
  return (await import("./lazyChunk")).lazyChunk;
}

beforeEach(() => {
  noteChunkFailure.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.doUnmock("./update");
  vi.restoreAllMocks();
});

describe("lazyChunk", () => {
  it("loads once and shares the result", async () => {
    const lazyChunk = await helper();
    const load = vi.fn(() => Promise.resolve({ ok: true }));
    const get = lazyChunk(load, { chunk: /\/x-[^/]*\.js$/, message: "Try again.", label: "x" });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rejects in plain English, reports the failure and loads again on the next call", async () => {
    const lazyChunk = await helper();
    let calls = 0;
    const load = vi.fn(() => (++calls === 1 ? Promise.reject(new TypeError("Importing a module script failed.")) : Promise.resolve("mod")));
    const get = lazyChunk(load, { chunk: /\/x-[^/]*\.js$/, message: "The game didn't finish loading.", label: "x" });
    await expect(get()).rejects.toThrow("The game didn't finish loading.");
    expect(noteChunkFailure).toHaveBeenCalledTimes(1);
    // Safari names no URL: the loader runs again.
    await expect(get()).resolves.toBe("mod");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("re-imports a named chunk under a fresh URL after a failure", async () => {
    const lazyChunk = await helper();
    const url = "https://www.rampridge.xyz/assets/x-B1x2.js";
    const load = vi.fn(() => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${url}`)));
    const get = lazyChunk(load, { chunk: /\/x-[^/]*\.js$/, message: "Try again.", label: "x" });
    await expect(get()).rejects.toThrow("Try again.");
    // The retry imports `${url}?retry=<now>`, which fails here (no network in tests) without calling `load` again.
    await expect(get()).rejects.toThrow("Try again.");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
