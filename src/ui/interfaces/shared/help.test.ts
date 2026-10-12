import { describe, expect, it } from "vitest";
import { HELP_HANDLE, HELP_URL, orderDetailsText, type OrderDetailsInput } from "./help";

const ORDER: OrderDetailsInput = {
  intentHash: `0x${"7e".repeat(32)}`,
  fiatToSendText: "101.50",
  currency: "GBP",
  platform: "revolut",
  usdcExpected: 124_746_836n,
  signaledAt: Date.UTC(2026, 9, 11, 14, 3, 27),
};

describe("orderDetailsText", () => {
  it("lists the intent hash, payment, USDC expected and when the order was placed", () => {
    expect(orderDetailsText(ORDER, "Revolut")).toBe(
      [
        "RampRidge buy order",
        `Intent: 0x${"7e".repeat(32)}`,
        "Payment: 101.50 GBP on Revolut",
        "USDC expected: 124.746836",
        "Placed: 2026-10-11 14:03 UTC",
      ].join("\n"),
    );
  });

  it("keeps cents and groups thousands in the USDC amount", () => {
    expect(orderDetailsText({ ...ORDER, usdcExpected: 1_250_000_000n })).toContain("USDC expected: 1,250.00");
    expect(orderDetailsText({ ...ORDER, usdcExpected: 99_500_000n })).toContain("USDC expected: 99.50");
    expect(orderDetailsText({ ...ORDER, usdcExpected: 0n })).toContain("USDC expected: 0.00");
  });

  it("names the platform from its id when no name is given", () => {
    expect(orderDetailsText({ ...ORDER, platform: "venmo" })).toContain("Payment: 101.50 GBP on Venmo");
  });

  it("never includes a payee handle or wallet address", () => {
    const text = orderDetailsText({ ...ORDER, payeeHandle: "revtag", owner: "0xabc" } as OrderDetailsInput, "Revolut");
    expect(text).not.toContain("revtag");
    expect(text).not.toContain("0xabc");
  });

  it("survives a missing creation time", () => {
    expect(orderDetailsText({ ...ORDER, signaledAt: Number.NaN })).toContain("Placed: unknown");
  });
});

describe("help contact", () => {
  it("points at the launch account on X", () => {
    expect(HELP_URL).toBe("https://x.com/andrewwilkinson");
    expect(HELP_HANDLE).toBe("@andrewwilkinson");
  });
});
