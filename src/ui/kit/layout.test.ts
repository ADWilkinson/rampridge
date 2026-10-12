import { describe, expect, it } from "vitest";
import { MIN_FIT_SCALE, fitScale, layoutMode, needsUpright } from "./layout";

describe("layoutMode", () => {
  it("uses the portrait phone layout only for narrow screens that are not phones held sideways", () => {
    expect(layoutMode(true, false)).toEqual({ mobile: true, compact: false, sheet: true });
    expect(layoutMode(false, false)).toEqual({ mobile: false, compact: false, sheet: false });
  });

  it("gives a phone held sideways desktop-sized interfaces with the phone chatbox and sheet", () => {
    // 844x390 (wide) and 740x360 (narrow) landscape phones.
    expect(layoutMode(false, true)).toEqual({ mobile: false, compact: true, sheet: true });
    expect(layoutMode(true, true)).toEqual({ mobile: false, compact: true, sheet: true });
  });
});

describe("fitScale", () => {
  it("keeps the natural size whenever it fits", () => {
    expect(fitScale(488, 356, 580, 390)).toBe(1);
    expect(fitScale(488, 356, 488, 356)).toBe(1);
  });

  it("shrinks to fit inside the margin, rounded down to the hundredth", () => {
    // Sell (488x500) in a 580x390 landscape layer: (390 - 16) / 500.
    expect(fitScale(488, 500, 580, 390)).toBe(0.74);
    // Width-limited: (403 - 16) / 488.
    expect(fitScale(488, 356, 403, 375)).toBe(0.79);
    expect(fitScale(100, 100, 100, 50, 0)).toBe(0.5);
  });

  it("never goes below the floor and waits for a layout", () => {
    expect(fitScale(1000, 2000, 300, 300)).toBe(MIN_FIT_SCALE);
    expect(fitScale(0, 100, 300, 300)).toBeNull();
    expect(fitScale(100, 100, 0, 300)).toBeNull();
  });
});

describe("needsUpright", () => {
  it("asks to turn the phone only in compact landscape and below a legible scale", () => {
    expect(needsUpright(true, 0.69)).toBe(true);
    expect(needsUpright(true, 0.7)).toBe(false);
    expect(needsUpright(true, 1)).toBe(false);
    expect(needsUpright(false, 0.4)).toBe(false);
  });
});
