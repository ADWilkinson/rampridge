import { describe, expect, it } from "vitest";
import { sliderLevelAt } from "./slider";

describe("sliderLevelAt", () => {
  it("picks the notch under the pointer on a 128px track", () => {
    expect(sliderLevelAt(0, 128)).toBe(1);
    expect(sliderLevelAt(31.9, 128)).toBe(1);
    expect(sliderLevelAt(32, 128)).toBe(2);
    expect(sliderLevelAt(70, 128)).toBe(3);
    expect(sliderLevelAt(127, 128)).toBe(4);
  });

  it("clamps points outside the track to its end notches", () => {
    expect(sliderLevelAt(-5, 128)).toBe(1);
    expect(sliderLevelAt(140, 128)).toBe(4);
  });

  it("scales with the drawn width (a scaled window)", () => {
    expect(sliderLevelAt(48, 96)).toBe(3);
    expect(sliderLevelAt(10, 0)).toBe(1);
  });
});
