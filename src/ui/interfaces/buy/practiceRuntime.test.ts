import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketResponse } from "@shared/world";
import type { BuyFlowStore } from "@/peer/buy";
import { rowMatchesOrder } from "./model";
import { PRACTICE_HANDLE, choosePractice, createPracticeRuntime, currentPractice, endPractice, enterPractice, type PracticeRuntime } from "./practiceRuntime";

const telemetry = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/telemetry", async (original) => ({ ...(await original<typeof import("@/lib/telemetry")>()), track: telemetry.track }));

const RATE_ONE = 10n ** 18n;
const HASH = `0x${"ab".repeat(32)}` as const;

function market(books: [platform: string, currency: string, rate: string][], currencies: [currency: string, bestRate: string][] = []): Pick<MarketResponse, "books" | "currencies"> {
  return {
    books: books.map(([platform, currency, rate]) => ({ platform, currency, liquidity: "1000", depositCount: 1, best: { rate } as never, offers: [] })),
    currencies: currencies.map(([currency, bestRate]) => ({ currency, bestRate, liquidity: "1000", depositCount: 1, platforms: [] })),
  };
}

async function until(runtime: PracticeRuntime, done: (s: BuyFlowStore) => boolean) {
  for (let i = 0; i < 400 && !done(runtime.store.getState()); i++) await vi.advanceTimersByTimeAsync(50);
  expect(done(runtime.store.getState())).toBe(true);
}

describe("choosePractice", () => {
  it("prices the visitor's currency at the live best Revolut rate", () => {
    expect(choosePractice(market([["wise", "GBP", "0.70"], ["revolut", "GBP", "0.7712"]]), "GBP")).toEqual({ currency: "GBP", rate: (7712n * RATE_ONE) / 10_000n });
  });

  it("falls back to the currency's best rate when Revolut has no book of its own", () => {
    expect(choosePractice(market([], [["EUR", "0.9"]]), "EUR")).toEqual({ currency: "EUR", rate: (9n * RATE_ONE) / 10n });
  });

  it("uses US dollars when the visitor's currency is not on Revolut or not priced", () => {
    const usd = market([["revolut", "USD", "1.02"]]);
    expect(choosePractice(usd, "INR")?.currency).toBe("USD");
    expect(choosePractice(usd, "GBP")?.currency).toBe("USD");
  });

  it("gives up when nothing is priced", () => {
    expect(choosePractice(market([], [["USD", "0"]]), "GBP")).toBeNull();
  });
});

describe("a practice buy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    telemetry.track.mockClear();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("a practice trade must not touch the network"))));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    endPractice();
  });

  it("walks quote, signal, payment, proof and release on simulated money alone", async () => {
    const runtime = createPracticeRuntime({ currency: "GBP", rate: (755n * RATE_ONE) / 1_000n }, HASH);
    const { store } = runtime;
    store.getState().bindSender(runtime.sender);
    await until(runtime, (s) => !s.recovering);

    const quoting = store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
    await vi.advanceTimersByTimeAsync(300);
    await quoting;
    const quote = store.getState().quotes[0]!;
    expect(quote.payeeHandle).toBe(PRACTICE_HANDLE);
    expect(quote.seller).toBe("0x5e11e45e11e45e11e45e11e45e11e45e11e45e1");
    expect(quote.successRateBps).toBeNull();
    // 100 GBP at 0.755 is 132.45 USDC before Peer's 0.95% and RampRidge's 0.5%.
    expect(quote.usdcAmount).toBeGreaterThan(130_000_000n);
    expect(quote.usdcAmount).toBeLessThan(131_000_000n);

    store.getState().selectQuote(quote.id);
    void store.getState().confirm();
    await until(runtime, (s) => s.step === "awaitingPayment" && s.order?.status === "active");
    expect(store.getState().order?.intentHash).toBe(HASH);

    void store.getState().markPaid();
    await until(runtime, (s) => s.step === "selectPayment");
    const order = store.getState().order!;
    const match = store.getState().payments.find((row) => rowMatchesOrder(row, order))!;
    expect(match.recipient).toBe(PRACTICE_HANDLE);

    void store.getState().choosePayment(match.index);
    await until(runtime, (s) => s.step === "completed");
    expect(store.getState().completion?.usdcReceived).toBeGreaterThan(0n);
    expect(fetch).not.toHaveBeenCalled();
    expect(telemetry.track).not.toHaveBeenCalled();
  });

  it("counts only its own start and finish, once each", async () => {
    const runtime = createPracticeRuntime({ currency: "USD", rate: RATE_ONE });
    enterPractice(runtime);
    enterPractice(runtime);
    expect(currentPractice()).toBe(runtime);
    runtime.store.setState({ step: "completed" });
    runtime.store.setState({ step: "completed" });
    expect(telemetry.track.mock.calls).toEqual([["practice_start"], ["practice_done"]]);
    endPractice();
    expect(currentPractice()).toBeNull();
  });
});
