import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { createBuyStore, memoryOrderStorage, type BuyError, type BuyFlowStore, type BuyStep } from "@/peer/buy";
import { resolveVerifyMethod } from "@/peer/platforms";
import { fakeChain, fakeExtension, fakeMarket, revolutRows } from "./simulated";
import { buySlotTarget, buySlotView, isVerificationError } from "./model";
import { errorOrigin, watchErrorOrigin } from "./origin";

const HOUR = 3_600_000;
const tick = () => new Promise((r) => setTimeout(r, 10));

async function until(store: ReturnType<typeof createBuyStore>, done: (s: BuyFlowStore) => boolean) {
  for (let i = 0; i < 200 && !done(store.getState()); i++) await tick();
  expect(done(store.getState())).toBe(true);
}

/** The real buy store over the dev harness fakes, with a clock the test can move. */
function realFlow() {
  const timing = { txMs: 0, quoteMs: 0, captureMs: 0 };
  const clock = { offset: 0, now: () => Date.now() + clock.offset };
  const market = fakeMarket({ quotes: "ok", referrerFee: true, managerFeeBps: 0, stallRateFactor: 1, stallMissing: false, pricesError: false }, timing);
  const chain = fakeChain({ lockMs: 6 * HOUR, fulfil: "ok", signal: "ok", readMs: 0 }, timing, clock.now);
  const storage = memoryOrderStorage();
  const capture = { empty: false };
  const ref: { store: ReturnType<typeof createBuyStore> | null } = { store: null };
  const extension = fakeExtension({ installed: true, state: "ready" }, timing, () => {
    const order = ref.store?.getState().order ?? null;
    const method = order ? resolveVerifyMethod(order.platform, order.verifyMethodId) : null;
    return { platform: method?.actionPlatform ?? "revolut", rows: capture.empty || !order ? [] : revolutRows(order.fiatToSendText, order.currency) };
  });
  const store = createBuyStore({
    getClient: () => chain.client,
    extension,
    storage,
    quotes: market.quotes,
    fetchPayeeHandle: async () => "revtag",
    canInstallExtension: () => true,
    now: clock.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    random: () => 0.31,
    indexerTimeoutMs: 50,
    signalReconcileMs: 50,
  });
  ref.store = store;
  return { store, chain, storage, clock, capture };
}

/** A bare store driven by setState, for transitions the fakes can't reach cheaply. */
function bareStore(step: BuyStep) {
  return createStore<BuyFlowStore>(() => ({ step, error: null, errorReturnStep: null, pending: null }) as unknown as BuyFlowStore);
}

const network: BuyError = { code: "network", message: "Connection problem. Check your internet and try again.", recoverable: true };

describe("error origin", () => {
  it("keeps an expired order the player says they paid on Verify, never the instructions", async () => {
    const { store, chain, storage, clock, capture } = realFlow();
    watchErrorOrigin(store);
    store.getState().bindSender(chain.sender);
    await until(store, (s) => !s.recovering);
    await store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
    store.getState().selectQuote(store.getState().quotes[0]!.id);
    await store.getState().confirm();
    await until(store, (s) => s.step === "awaitingPayment" && s.order?.status === "active");

    // It expires; "I paid before it expired"; the extension finds no payment yet.
    clock.offset = 7 * HOUR;
    capture.empty = true;
    void store.getState().markPaid();
    await until(store, (s) => s.step === "error");

    const s = store.getState();
    expect(s.error?.code).toBe("no_payments");
    expect(errorOrigin(store)).toBe("verifying");
    expect(isVerificationError(s, errorOrigin(store))).toBe(true);
    // Still an active order in storage: every window gates on it, so nothing can quote it away.
    expect(s.order?.status).toBe("active");
    expect(storage.load(s.owner!)?.intentHash).toBe(s.order!.intentHash);
    // The slot says Expired first (nobody pays it); it opens Payment, which sends the player to Verify.
    const slot = buySlotView(s.step, s.order, clock.now(), true);
    expect(slot?.status).toBe("expired");
  });

  it("treats a release that failed after its payment list timed out as a verification error", () => {
    const store = bareStore("fulfilling");
    watchErrorOrigin(store);
    store.setState({ step: "error", error: network, errorReturnStep: "awaitingPayment" });
    expect(errorOrigin(store)).toBe("fulfilling");
    expect(isVerificationError(store.getState(), errorOrigin(store))).toBe(true);
    // Without the watcher the code and return step alone can't tell this from a failed cancel.
    expect(isVerificationError(store.getState(), null)).toBe(false);
  });

  it("leaves a failed cancel on the payment instructions", () => {
    const store = bareStore("awaitingPayment");
    watchErrorOrigin(store);
    store.setState({ pending: "cancel" });
    store.setState({ step: "error", error: network, errorReturnStep: "awaitingPayment", pending: null });
    expect(errorOrigin(store)).toBe("awaitingPayment");
    expect(isVerificationError(store.getState(), errorOrigin(store))).toBe(false);
  });

  it("keeps the first origin through a follow-up error and clears it once the error is gone", () => {
    const store = bareStore("selectPayment");
    watchErrorOrigin(store);
    watchErrorOrigin(store);
    store.setState({ step: "error", error: network, errorReturnStep: "selectPayment" });
    store.setState({ error: { ...network, code: "not_connected" } });
    expect(errorOrigin(store)).toBe("selectPayment");
    store.setState({ step: "selectPayment", error: null, errorReturnStep: null });
    expect(errorOrigin(store)).toBeNull();
  });

  it("sends a failed release on a live order to Verify from its Exchange slot", () => {
    const order = { expiresAt: 10_000, status: "active" } as Parameters<typeof buySlotView>[1];
    const view = buySlotView("error", order, 5_000, true);
    expect(view).toMatchObject({ status: "verifying", label: "Verification failed", alert: true });
    expect(buySlotTarget(view!.status)).toBe("verify");
  });
});
