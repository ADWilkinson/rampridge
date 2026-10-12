import { describe, expect, it } from "vitest";
import { feeBreakdown } from "./fees";

describe("feeBreakdown", () => {
  it("names Peer's fee and RampRidge's fee with its rate", () => {
    const text = feeBreakdown({ serviceBps: 95, service: 1_260_000n, manager: 0n, referrer: 670_000n, referrerBps: 50, total: 1_930_000n });
    expect(text).toBe("1.26 USDC Peer + 0.67 USDC RampRidge (0.5%)");
  });

  it("shows a rate manager's fee as its own, never as Peer's", () => {
    // A live EUR offer: Peer 0.95%, a 0.1% rate-manager fee and RampRidge's 0.5% on 125 USDC.
    const text = feeBreakdown({ serviceBps: 95, service: 1_187_500n, manager: 125_000n, referrer: 625_000n, referrerBps: 50, total: 1_937_500n });
    expect(text).toBe("1.18 USDC Peer + 0.12 USDC rate manager + 0.62 USDC RampRidge (0.5%)");
  });

  it("shows only Peer's and the rate manager's fees when no integrator fee was priced in", () => {
    expect(feeBreakdown({ serviceBps: 95, service: 466_134n, manager: 49_116n, referrer: 0n, referrerBps: null, total: 515_250n })).toBe(
      "0.46 USDC Peer + 0.04 USDC rate manager",
    );
  });

  it("shows only Peer's fee with neither a rate manager nor an integrator fee", () => {
    expect(feeBreakdown({ serviceBps: 95, service: 1_200_000n, manager: 0n, referrer: 0n, referrerBps: null, total: 1_200_000n })).toBe("1.20 USDC Peer");
  });

  it("names RampRidge's fee without a rate when Curator did not report one", () => {
    expect(feeBreakdown({ serviceBps: null, service: 950_000n, manager: 0n, referrer: 500_000n, referrerBps: null, total: 1_450_000n })).toBe(
      "0.95 USDC Peer + 0.50 USDC RampRidge",
    );
  });

  it("never shows a negative Peer fee when the parts exceed the reported total", () => {
    expect(feeBreakdown({ serviceBps: 95, service: 0n, manager: 300_000n, referrer: 500_000n, referrerBps: 50, total: 600_000n })).toBe(
      "0.00 USDC Peer + 0.30 USDC rate manager + 0.50 USDC RampRidge (0.5%)",
    );
  });
});
