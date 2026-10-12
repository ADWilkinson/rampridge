import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

// A stand-in for the buy module: the real one brings in the Peer SDK.
interface FakeFlow {
  step: string;
  owner: string | null;
  bindSender: (sender: unknown) => void;
  watchOwner: (owner: string | null) => void;
}

const buy = { fail: null as Error | null, loads: 0 };
const noteChunkFailure = vi.fn(() => Promise.resolve());

function fakeModule() {
  const buyStore = createStore<FakeFlow>()((set) => ({
    step: "idle",
    owner: null,
    bindSender: vi.fn(),
    watchOwner: (owner) => set({ owner }),
  }));
  return { buyStore };
}

async function loadBridge() {
  vi.resetModules();
  vi.doMock("@/peer/buy", () => {
    buy.loads++;
    if (buy.fail) throw buy.fail;
    return fakeModule();
  });
  vi.doMock("./update", () => ({ noteChunkFailure }));
  return import("./buyFlow");
}

beforeEach(() => {
  buy.fail = null;
  buy.loads = 0;
  noteChunkFailure.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.doUnmock("@/peer/buy");
  vi.doUnmock("./update");
  vi.restoreAllMocks();
});

describe("buy flow bridge", () => {
  it("reads no flow until the buy module loads, then the module's store", async () => {
    const { getBuyFlow, loadBuyFlow, useBuyModule } = await loadBridge();
    expect(getBuyFlow()).toBeNull();
    expect(buy.loads).toBe(0);
    const mod = await loadBuyFlow();
    expect(useBuyModule.getState().mod).toBe(mod);
    expect(getBuyFlow()?.step).toBe("idle");
    await loadBuyFlow();
    expect(buy.loads).toBe(1);
  });

  it("delivers changes to a subscriber that subscribed before the module loaded", async () => {
    const { loadBuyFlow, subscribeBuyFlow } = await loadBridge();
    const seen: string[] = [];
    const off = subscribeBuyFlow((state, prev) => seen.push(`${prev.step}->${state.step}`));
    const mod = await loadBuyFlow();
    (mod.buyStore as unknown as ReturnType<typeof fakeModule>["buyStore"]).setState({ step: "quoting" });
    off();
    (mod.buyStore as unknown as ReturnType<typeof fakeModule>["buyStore"]).setState({ step: "quoted" });
    expect(seen).toEqual(["idle->quoting"]);
  });

  it("retries a failed download on the next call and reports it", async () => {
    const { loadBuyFlow, getBuyFlow } = await loadBridge();
    buy.fail = new TypeError("Failed to fetch dynamically imported module");
    await expect(loadBuyFlow()).rejects.toThrow();
    expect(noteChunkFailure).toHaveBeenCalledTimes(1);
    expect(getBuyFlow()).toBeNull();
    buy.fail = null;
    await loadBuyFlow();
    expect(getBuyFlow()).not.toBeNull();
  });
});
