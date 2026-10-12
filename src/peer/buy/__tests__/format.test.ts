import { describe, expect, it } from "vitest";
import {
  ceilToDecimals,
  fiatForUsdc,
  formatCompact,
  formatDecimal,
  formatFiat,
  formatFiatDecimal,
  formatRate,
  formatRateText,
  formatUsdc,
  formatUsdcText,
  parseFiat,
  parseUsdc,
  rateFromAmounts,
  roundToDecimals,
  sanitizeAmountInput,
  shortAddress,
  tryParseAmount,
} from "../../format";

describe("parsing", () => {
  it("parses plain decimals into base units", () => {
    expect(parseUsdc("125.4")).toBe(125_400_000n);
    expect(parseFiat("250")).toBe(250_000_000n);
    expect(tryParseAmount(".5", 6)).toBe(500_000n);
    expect(tryParseAmount("1,250.50", 6)).toBe(1_250_500_000n);
  });

  it("rejects junk and over-precise input", () => {
    expect(tryParseAmount("abc", 6)).toBeNull();
    expect(tryParseAmount("1.2.3", 6)).toBeNull();
    expect(tryParseAmount("-5", 6)).toBeNull();
    expect(tryParseAmount("0.0000001", 6)).toBeNull();
    expect(() => parseUsdc("")).toThrow();
  });

  it("sanitises amount inputs", () => {
    expect(sanitizeAmountInput("$1,2a3.456", 2)).toBe("123.45");
    expect(sanitizeAmountInput("007", 2)).toBe("7");
    expect(sanitizeAmountInput("1.2.3", 2)).toBe("1.23");
    expect(sanitizeAmountInput(".5", 2)).toBe("0.5");
    expect(sanitizeAmountInput("12.9", 0)).toBe("12");
  });
});

describe("rounding", () => {
  it("rounds in base units", () => {
    expect(roundToDecimals(1_234_567n, 6, 2, "floor")).toBe(1_230_000n);
    expect(roundToDecimals(1_234_567n, 6, 2, "ceil")).toBe(1_240_000n);
    expect(roundToDecimals(1_235_000n, 6, 2, "half-up")).toBe(1_240_000n);
    expect(roundToDecimals(1_234_999n, 6, 2, "half-up")).toBe(1_230_000n);
    expect(ceilToDecimals(1_230_000n, 6, 2)).toBe(1_230_000n);
    expect(ceilToDecimals(1_230_001n, 6, 2)).toBe(1_240_000n);
  });
});

describe("display", () => {
  it("formats exact decimals with grouping", () => {
    expect(formatDecimal(1_234_567_890n, 6, { maxFraction: 2 })).toBe("1,234.56");
    expect(formatDecimal(1_000_000n, 6, { minFraction: 2 })).toBe("1.00");
    expect(formatDecimal(1_234_567_890n, 6, { maxFraction: 2, group: false })).toBe("1234.56");
  });

  it("never rounds USDC up", () => {
    expect(formatUsdc(125_409_999n)).toBe("125.40");
    expect(formatUsdcText(49_525_000n)).toBe("49.52 USDC");
  });

  it("formats fiat per currency", () => {
    expect(formatFiat(101_500_000n, "GBP")).toBe("£101.50");
    expect(formatFiat(101_500_000n, "GBP", { style: "code" })).toBe("101.50 GBP");
    expect(formatFiat(1_234_000_000n, "JPY")).toBe("¥1,234");
    expect(formatFiatDecimal("99.5", "USD")).toBe("$99.50");
  });

  it("formats rates", () => {
    expect(formatRate(1_019_019_019_019_019_035n)).toBe("1.019");
    expect(formatRate(10n ** 18n)).toBe("1.00");
    expect(formatRateText(790_000_000_000_000_000n, "GBP")).toBe("0.79 GBP per USDC");
    expect(rateFromAmounts(79_000_000n, 100_000_000n)).toBe(790_000_000_000_000_000n);
    expect(rateFromAmounts(1n, 0n)).toBe(0n);
    expect(fiatForUsdc(100_000_000n, 790_000_000_000_000_000n)).toBe(79_000_000n);
  });

  it("compacts OSRS style, truncating", () => {
    expect(formatCompact(999_000_000n, 6)).toBe("999");
    expect(formatCompact(1_299_000_000n, 6)).toBe("1.2K");
    expect(formatCompact(3_456_789_000_000n, 6)).toBe("3.4M");
    expect(formatCompact(10_000_000_000_000n, 6)).toBe("10M");
    expect(formatCompact(500_000n, 6)).toBe("0");
  });

  it("shortens addresses", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
});
