import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wallet stack chunk and the update check, replaced per test; the bridge module is loaded fresh each time.
const stack = { fail: null as Error | null, loads: 0 };
const noteChunkFailure = vi.fn(() => Promise.resolve());

function StackRoot() {
  return null;
}

async function loadBridge() {
  vi.resetModules();
  vi.doMock("./walletStack", () => {
    stack.loads++;
    if (stack.fail) throw stack.fail;
    return { WalletStack: StackRoot };
  });
  vi.doMock("./update", () => ({ noteChunkFailure }));
  return import("./wallet");
}

beforeEach(() => {
  stack.fail = null;
  stack.loads = 0;
  noteChunkFailure.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.doUnmock("./walletStack");
  vi.doUnmock("./update");
  vi.restoreAllMocks();
});

describe("wallet bridge", () => {
  it("reads as a loading, logged-out wallet until the stack has loaded", async () => {
    const { LOADING_WALLET, useWalletBridge } = await loadBridge();
    const state = useWalletBridge.getState();
    expect(state.stack).toBe("idle");
    expect(state.wallet).toBe(LOADING_WALLET);
    expect(LOADING_WALLET).toMatchObject({ status: "loading", ready: false, authenticated: false, sender: null, address: null });
    await expect(LOADING_WALLET.getAccessToken()).resolves.toBeNull();
    await expect(LOADING_WALLET.sweepFallbackUsdc()).rejects.toThrow("still loading");
  });

  it("loads the stack once and hands its root to the providers", async () => {
    const { loadWalletStack, useWalletBridge } = await loadBridge();
    const first = loadWalletStack();
    expect(useWalletBridge.getState().stack).toBe("loading");
    // A second caller while it downloads shares the same attempt.
    expect(loadWalletStack()).toBe(first);
    await first;
    expect(useWalletBridge.getState()).toMatchObject({ stack: "ready", Stack: StackRoot });
    await loadWalletStack();
    expect(stack.loads).toBe(1);
  });

  it("queues a login asked for before Privy is ready", async () => {
    const { LOADING_WALLET, useWalletBridge } = await loadBridge();
    LOADING_WALLET.login();
    expect(useWalletBridge.getState()).toMatchObject({ loginQueued: true, stack: "loading" });
  });

  it("reports a failed download, drops the queued login and loads on the next request", async () => {
    const { loadWalletStack, requestWalletLogin, useWalletBridge } = await loadBridge();
    stack.fail = new Error("Failed to fetch dynamically imported module");
    await expect(requestWalletLogin()).rejects.toThrow();
    expect(useWalletBridge.getState()).toMatchObject({ stack: "failed", loginQueued: false, Stack: null });
    expect(noteChunkFailure).toHaveBeenCalledTimes(1);

    stack.fail = null;
    await loadWalletStack();
    expect(useWalletBridge.getState()).toMatchObject({ stack: "ready", Stack: StackRoot });
  });
});

describe("hasPrivySession", () => {
  const storage = (keys: string[]) => ({ length: keys.length, key: (i: number) => keys[i] ?? null });

  it("spots a stored Privy login", async () => {
    const { hasPrivySession } = await loadBridge();
    expect(hasPrivySession(storage(["rampridge.session", "privy:token"]))).toBe(true);
    expect(hasPrivySession(storage(["privy:refresh_token"]))).toBe(true);
    expect(hasPrivySession(storage(["privy:cmcq3o9ro00e2k10lklib7oo1:refresh_token"]))).toBe(true);
  });

  it("treats a visitor without one, or blocked storage, as new", async () => {
    const { hasPrivySession } = await loadBridge();
    expect(hasPrivySession(storage([]))).toBe(false);
    // Privy's analytics id is set for every visitor who loaded it, logged in or not.
    expect(hasPrivySession(storage(["privy:caid", "rampridge.settings"]))).toBe(false);
    expect(hasPrivySession(null)).toBe(false);
    expect(
      hasPrivySession({
        length: 1,
        key: () => {
          throw new Error("SecurityError");
        },
      }),
    ).toBe(false);
  });
});

describe("loading wallet's Base client", () => {
  it("loads the real client on first use and forwards to it", async () => {
    const readContract = vi.fn(() => Promise.resolve(5n));
    const real = { readContract, chain: { id: 8453 } };
    vi.doMock("@/wallet/publicClient", () => ({ publicClient: real }));
    try {
      const { LOADING_WALLET, preloadPublicClient } = await loadBridge();
      const client = LOADING_WALLET.publicClient;
      // Not thenable, so awaiting the wallet value never tries to resolve it.
      expect((client as unknown as { then?: unknown }).then).toBeUndefined();
      await expect(client.readContract({} as never)).resolves.toBe(5n);
      expect(readContract).toHaveBeenCalledTimes(1);
      preloadPublicClient();
      await vi.waitFor(() => expect(client.chain?.id).toBe(8453));
    } finally {
      vi.doUnmock("@/wallet/publicClient");
    }
  });
});
