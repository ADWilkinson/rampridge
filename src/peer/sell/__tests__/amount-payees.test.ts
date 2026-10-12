import { describe, expect, it } from "vitest";
import { formatUsdcAmount, formatUsdcInput, parseUsdcAmount } from "../amount";
import { displayPayee, normalizePayee, platformName } from "../payees";

describe("parseUsdcAmount", () => {
  it("parses plain, grouped and leading-dot amounts exactly", () => {
    expect(parseUsdcAmount("125")).toEqual({ ok: true, units: 125_000_000n });
    expect(parseUsdcAmount("1,250.5")).toEqual({ ok: true, units: 1_250_500_000n });
    expect(parseUsdcAmount(".5")).toEqual({ ok: true, units: 500_000n });
    expect(parseUsdcAmount("0.000001")).toEqual({ ok: true, units: 1n });
    expect(parseUsdcAmount("10.")).toEqual({ ok: true, units: 10_000_000n });
  });

  it("rejects empty, non-numeric and over-precise input", () => {
    expect(parseUsdcAmount("  ")).toEqual({ ok: false, reason: "empty" });
    expect(parseUsdcAmount("12abc")).toEqual({ ok: false, reason: "invalid" });
    expect(parseUsdcAmount("-5")).toEqual({ ok: false, reason: "invalid" });
    expect(parseUsdcAmount("1.0000001")).toEqual({ ok: false, reason: "precision" });
  });
});

describe("formatUsdcAmount", () => {
  it("truncates, never rounds up", () => {
    expect(formatUsdcAmount(1_234_567_891n, { maxDecimals: 2 })).toBe("1234.56");
    expect(formatUsdcAmount(1_000_000n)).toBe("1.00");
    expect(formatUsdcAmount(1_234_500_000n, { group: true })).toBe("1,234.50");
    expect(formatUsdcInput(12_340_000n)).toBe("12.34");
    expect(formatUsdcInput(5_000_000n)).toBe("5");
  });
});

describe("normalizePayee", () => {
  it("strips platform decorations into the curator offchainId", () => {
    expect(normalizePayee("venmo", "@zezima-w")).toEqual({ ok: true, offchainId: "zezima-w" });
    expect(normalizePayee("cashapp", "$Zezima")).toEqual({ ok: true, offchainId: "Zezima" });
    expect(normalizePayee("chime", "Zezima")).toEqual({ ok: true, offchainId: "$zezima" });
    expect(normalizePayee("revolut", "https://revolut.me/zezima1abc")).toEqual({ ok: true, offchainId: "zezima1abc" });
    expect(normalizePayee("revolut", "@zezima1abc")).toEqual({ ok: true, offchainId: "zezima1abc" });
    expect(normalizePayee("monzo", "monzo.me/zezima")).toEqual({ ok: true, offchainId: "zezima" });
    expect(normalizePayee("paypal", "https://www.paypal.me/Zezima.W")).toEqual({ ok: true, offchainId: "zezima.w" });
    expect(normalizePayee("zelle", " You@Example.com ")).toEqual({ ok: true, offchainId: "you@example.com" });
    expect(normalizePayee("xmoney", "@Zezima")).toEqual({ ok: true, offchainId: "zezima" });
    expect(normalizePayee("zelle", "+1 (555) 123-4567")).toEqual({ ok: true, offchainId: "5551234567" });
  });

  it("accepts email or tag forms where the rail does", () => {
    expect(normalizePayee("wise", "me@example.com").ok).toBe(true);
    expect(normalizePayee("wise", "@zezimaw").ok).toBe(true);
    expect(normalizePayee("paypal", "me@example.com").ok).toBe(true);
    expect(normalizePayee("zelle", "(555) 123-4567").ok).toBe(true);
    expect(normalizePayee("upi", "Seller@Bank").ok).toBe(true);
  });

  it("rejects input the curator can never accept with a friendly reason", () => {
    expect(normalizePayee("revolut", "zezima_w")).toMatchObject({ ok: false });
    expect(normalizePayee("cashapp", "$ze zima")).toMatchObject({ ok: false });
    expect(normalizePayee("venmo", "")).toEqual({ ok: false, message: "Enter your Venmo username." });
    expect(normalizePayee("chime", "$")).toEqual({ ok: false, message: "Enter your ChimeSign." });
    expect(normalizePayee("zelle", "12345")).toMatchObject({ ok: false });
    expect(normalizePayee("upi", "not-a-vpa")).toMatchObject({ ok: false });
    expect(normalizePayee("alipay", "nope")).toMatchObject({ ok: false });
  });

  it("names and displays platforms", () => {
    expect(platformName("cashapp")).toBe("Cash App");
    expect(platformName("newrail")).toBe("Newrail");
    expect(displayPayee("cashapp", "zezima")).toBe("$zezima");
    expect(displayPayee("venmo", "zezima")).toBe("@zezima");
    expect(displayPayee("wise", "me@example.com")).toBe("me@example.com");
  });
});
