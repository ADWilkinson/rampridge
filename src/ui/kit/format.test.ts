import { describe, expect, it } from "vitest";
import { formatCountdown, formatDecimal, formatDurationWords, formatStack, orbTextColor, shortAddress, showsStack } from "./format";

describe("formatStack", () => {
  it("draws exact counts in yellow below 100,000", () => {
    expect(formatStack(0)).toEqual({ text: "0", tier: "units", color: "#ffff00" });
    expect(formatStack(1)).toMatchObject({ text: "1", tier: "units" });
    expect(formatStack(99_999)).toMatchObject({ text: "99999", tier: "units", color: "#ffff00" });
  });

  it("switches to whole thousands in white at 100,000", () => {
    expect(formatStack(100_000)).toEqual({ text: "100K", tier: "thousands", color: "#ffffff" });
    expect(formatStack(100_999)).toMatchObject({ text: "100K" });
    expect(formatStack(9_999_999)).toMatchObject({ text: "9999K", tier: "thousands" });
  });

  it("switches to whole millions in green at 10,000,000", () => {
    expect(formatStack(10_000_000)).toEqual({ text: "10M", tier: "millions", color: "#00ff80" });
    expect(formatStack(2_147_483_647)).toMatchObject({ text: "2147M", tier: "millions" });
  });

  it("floors fractions and treats bad input as zero", () => {
    expect(formatStack(125.99).text).toBe("125");
    expect(formatStack(-5).text).toBe("0");
    expect(formatStack(Number.NaN).text).toBe("0");
    expect(formatStack(Number.POSITIVE_INFINITY).text).toBe("0");
  });
});

describe("showsStack", () => {
  it("always shows stackables and hides a single unstackable", () => {
    expect(showsStack(1, true)).toBe(true);
    expect(showsStack(1, false)).toBe(false);
    expect(showsStack(2, false)).toBe(true);
  });
});

describe("formatDecimal", () => {
  it("formats decimal strings exactly with grouping", () => {
    expect(formatDecimal("125.4", 2)).toBe("125.40");
    expect(formatDecimal("1234567.891", 2)).toBe("1,234,567.89");
    expect(formatDecimal("0.5", 2)).toBe("0.50");
    expect(formatDecimal("007", 0)).toBe("7");
    expect(formatDecimal(".25", 2)).toBe("0.25");
    expect(formatDecimal("-0.00", 2)).toBe("0.00");
    expect(formatDecimal("-12.5", 2)).toBe("-12.50");
  });
  it("formats numbers and rejects junk", () => {
    expect(formatDecimal(101.5, 2)).toBe("101.50");
    expect(formatDecimal("abc", 2)).toBe("0.00");
  });
});

describe("time and misc", () => {
  it("formats countdowns as a clock, rounding seconds up", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(14 * 60_000 + 59_000)).toBe("14:59");
    expect(formatCountdown(3_723_000)).toBe("1:02:03");
    expect(formatCountdown(-5)).toBe("0:00");
  });
  it("formats durations in words", () => {
    expect(formatDurationWords(1_000)).toBe("1 second");
    expect(formatDurationWords(45_000)).toBe("45 seconds");
    expect(formatDurationWords(14 * 60_000)).toBe("14 minutes");
    expect(formatDurationWords(2 * 3_600_000)).toBe("2 hours");
  });
  it("shortens addresses", () => {
    expect(shortAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toBe("0x8335...2913");
    expect(shortAddress("0x1234")).toBe("0x1234");
  });
  it("ramps orb text from green to red", () => {
    expect(orbTextColor(1)).toBe("#00ff00");
    expect(orbTextColor(0.5)).toBe("#ffff00");
    expect(orbTextColor(0)).toBe("#ff0000");
  });
});
