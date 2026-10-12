import { describe, expect, it } from "vitest";
import { addressesEqual, formatEth, formatUnitsTruncated, formatUsdc, shortAddress } from "./format";

describe("shortAddress", () => {
  it("shortens a full address", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef1234abcd")).toBe("0x1234…abcd");
  });

  it("supports custom lengths", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef1234abcd", 6, 2)).toBe("0x123456…cd");
  });

  it("handles empty and short values", () => {
    expect(shortAddress(null)).toBe("");
    expect(shortAddress(undefined)).toBe("");
    expect(shortAddress("0x12345678")).toBe("0x12345678");
  });
});

describe("addressesEqual", () => {
  it("ignores case and rejects missing values", () => {
    expect(addressesEqual("0xAbC", "0xabc")).toBe(true);
    expect(addressesEqual("0xabc", "0xabd")).toBe(false);
    expect(addressesEqual(null, null)).toBe(false);
    expect(addressesEqual(undefined, "0xabc")).toBe(false);
  });
});

describe("formatUsdc", () => {
  it("formats base units with two decimals and grouping", () => {
    expect(formatUsdc(1_234_567_890n)).toBe("1,234.56");
    expect(formatUsdc(0n)).toBe("0.00");
    expect(formatUsdc(5_000_000n)).toBe("5.00");
  });

  it("truncates instead of rounding up", () => {
    expect(formatUsdc(999_999n)).toBe("0.99");
    expect(formatUsdc(1_999_999n, 6)).toBe("1.999999");
  });

  it("keeps the sign of negative amounts", () => {
    expect(formatUsdc(-2_500_000n)).toBe("-2.50");
    expect(formatUsdc(-1n)).toBe("0.00");
  });
});

describe("formatEth", () => {
  it("trims trailing zeros", () => {
    expect(formatEth(1_200_000_000_000_000n)).toBe("0.0012");
    expect(formatEth(2_000_000_000_000_000_000n)).toBe("2");
  });

  it("truncates beyond the requested precision", () => {
    expect(formatEth(123_456_789_000_000n, 4)).toBe("0.0001");
    expect(formatEth(1n)).toBe("0");
  });
});

describe("formatUnitsTruncated", () => {
  it("can disable grouping", () => {
    expect(formatUnitsTruncated(1_234_000_000n, 6, { grouping: false, maxFractionDigits: 2 })).toBe("1234");
  });
});
