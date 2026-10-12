import { describe, expect, it } from "vitest";
import { clampAmount, filterAmountKeystrokes, formatAmount, parseAmount, roundTo, stepAmount, stepLabel } from "./amount";

describe("stepLabel", () => {
  it("labels the original buttons", () => {
    expect([1, 10, 100, 1_000].map(stepLabel)).toEqual(["+1", "+10", "+100", "+1K"]);
    expect(stepLabel(10_000)).toBe("+10K");
    expect(stepLabel(1_000_000)).toBe("+1M");
    expect(stepLabel(-5)).toBe("-5");
    expect(stepLabel(1_500)).toBe("+1500");
  });
});

describe("stepAmount", () => {
  it("adds steps and clamps into range", () => {
    expect(stepAmount(0, 10)).toBe(10);
    expect(stepAmount(95, 10, { max: 100 })).toBe(100);
    expect(stepAmount(5, -10)).toBe(0);
    expect(stepAmount(5, -10, { min: 1 })).toBe(1);
  });
  it("keeps fiat precision without float drift", () => {
    expect(stepAmount(0.1, 0.2, { decimals: 2 })).toBe(0.3);
    expect(stepAmount(101.5, 100, { decimals: 2 })).toBe(201.5);
    expect(stepAmount(10.005, 0, { decimals: 2 })).toBe(10.01);
  });
});

describe("clampAmount", () => {
  it("rounds to the rule precision and handles bad input", () => {
    expect(clampAmount(12.345, { decimals: 2 })).toBe(12.35);
    expect(clampAmount(12.6)).toBe(13);
    expect(clampAmount(Number.NaN, { min: 5 })).toBe(5);
    expect(clampAmount(-1)).toBe(0);
  });
  it("rounds half up in decimal terms", () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(2.675, 2)).toBe(2.68);
    expect(roundTo(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundTo(1e-7, 2)).toBe(0);
    expect(roundTo(123456789.125, 2)).toBe(123456789.13);
  });
});

describe("parseAmount", () => {
  it("reads plain, grouped and suffixed amounts", () => {
    expect(parseAmount("1250")).toBe(1250);
    expect(parseAmount(" 1,250 ")).toBe(1250);
    expect(parseAmount("10k")).toBe(10_000);
    expect(parseAmount("1.5K")).toBe(1_500);
    expect(parseAmount("2m")).toBe(2_000_000);
    expect(parseAmount("1b")).toBe(1_000_000_000);
  });
  it("respects decimals", () => {
    expect(parseAmount("101.50", { decimals: 2 })).toBe(101.5);
    expect(parseAmount("101.5")).toBeNull();
    expect(parseAmount("0.001", { decimals: 2 })).toBeNull();
    expect(parseAmount("1.25k")).toBe(1250);
    expect(parseAmount(".5", { decimals: 2 })).toBe(0.5);
  });
  it("rejects junk", () => {
    for (const bad of ["", "abc", "-5", "1e3", "1..2", "k", "10kk", "1,2.3.4"]) expect(parseAmount(bad)).toBeNull();
  });
});

describe("filterAmountKeystrokes", () => {
  it("keeps digits, one dot and a trailing suffix", () => {
    expect(filterAmountKeystrokes("12a3")).toBe("123");
    expect(filterAmountKeystrokes("1.2.3")).toBe("1.23");
    expect(filterAmountKeystrokes("15kx9")).toBe("15k");
    expect(filterAmountKeystrokes("k12")).toBe("12");
    expect(filterAmountKeystrokes("1M")).toBe("1m");
  });
});

describe("formatAmount", () => {
  it("groups and only shows decimals when present", () => {
    expect(formatAmount(1250)).toBe("1,250");
    expect(formatAmount(101.5, 2)).toBe("101.50");
    expect(formatAmount(100, 2)).toBe("100");
  });
});
