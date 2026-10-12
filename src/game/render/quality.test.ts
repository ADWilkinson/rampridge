import { describe, expect, it } from "vitest";
import { PixelRatioGovernor, SLOW_FOR_MS, renderQuality } from "./quality";

describe("renderQuality", () => {
  it("caps phones at 1.5x on the default GPU, without MSAA on dense screens", () => {
    expect(renderQuality(3, true)).toEqual({ pixelRatio: 1.5, antialias: false, powerPreference: "default" });
    expect(renderQuality(2, true)).toEqual({ pixelRatio: 1.5, antialias: false, powerPreference: "default" });
    expect(renderQuality(1, true)).toEqual({ pixelRatio: 1, antialias: true, powerPreference: "default" });
  });

  it("keeps desktops at up to 2x, with MSAA only below 2x", () => {
    expect(renderQuality(1, false)).toEqual({ pixelRatio: 1, antialias: true, powerPreference: "high-performance" });
    expect(renderQuality(1.5, false)).toEqual({ pixelRatio: 1.5, antialias: true, powerPreference: "high-performance" });
    expect(renderQuality(2, false)).toEqual({ pixelRatio: 2, antialias: false, powerPreference: "high-performance" });
    expect(renderQuality(3, false).pixelRatio).toBe(2);
  });

  it("keeps phones at 1.5x but draws large tablets a little softer", () => {
    expect(renderQuality(3, true, 390 * 844).pixelRatio).toBe(1.5);
    expect(renderQuality(3, true, 430 * 932).pixelRatio).toBe(1.5);
    const tablet = renderQuality(2, true, 1024 * 1366).pixelRatio;
    expect(tablet).toBeLessThan(1.5);
    expect(tablet).toBeGreaterThanOrEqual(1);
    // Never below 1, and desktops are unaffected.
    expect(renderQuality(2, true, 4_000_000).pixelRatio).toBe(1);
    expect(renderQuality(2, false, 2560 * 1440).pixelRatio).toBe(2);
  });

  it("treats a missing ratio as 1", () => {
    expect(renderQuality(Number.NaN, false).pixelRatio).toBe(1);
    expect(renderQuality(0, true).pixelRatio).toBe(1);
  });
});

describe("PixelRatioGovernor", () => {
  const run = (g: PixelRatioGovernor, frameMs: number, totalMs: number, ratio: number) => {
    let steps = 0;
    for (let t = 0; t < totalMs; t += frameMs) {
      if (g.frame(frameMs, Math.min(ratio, g.cap))) steps++;
    }
    return steps;
  };

  it("leaves fast frames alone", () => {
    const g = new PixelRatioGovernor();
    expect(run(g, 16.7, 60_000, 1.5)).toBe(0);
    expect(g.cap).toBe(Number.POSITIVE_INFINITY);
  });

  it("ignores a short hitch", () => {
    const g = new PixelRatioGovernor();
    run(g, 16.7, 2_000, 1.5);
    run(g, 100, 300, 1.5);
    expect(run(g, 16.7, 10_000, 1.5)).toBe(0);
  });

  it("steps down while frames stay slow, then stops at 1", () => {
    const g = new PixelRatioGovernor();
    expect(run(g, 33, SLOW_FOR_MS + 2_000, 1.5)).toBe(1);
    expect(g.cap).toBe(1.25);
    run(g, 33, 30_000, 1.5);
    expect(g.cap).toBe(1);
    expect(run(g, 33, 30_000, 1.5)).toBe(0);
  });
});
