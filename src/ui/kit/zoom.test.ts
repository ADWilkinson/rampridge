import { describe, expect, it } from "vitest";
import { cssZoomOf, menuPlacement, tooltipPlacement } from "./zoom";

describe("menuPlacement", () => {
  it("centres the header on the cursor at 1x, as before", () => {
    expect(menuPlacement(400, 300, 100, 80, 1280, 720)).toEqual({ left: 350, top: 300 });
  });

  it("works in the menu's own pixels when it is zoomed, so it still opens under the cursor", () => {
    // Zoom 2: left 450 CSS px is drawn at 900 screen px, centring the 200 screen px wide menu on x 1000.
    const p = menuPlacement(1000, 600, 100, 80, 2560, 1440, 2);
    expect(p).toEqual({ left: 450, top: 300 });
    expect(p.left * 2 + (100 * 2) / 2).toBe(1000);
  });

  it("clamps to the viewport in zoomed pixels", () => {
    expect(menuPlacement(2550, 1430, 100, 80, 2560, 1440, 2)).toEqual({ left: 1180, top: 640 });
    expect(menuPlacement(5, 5, 100, 80, 2560, 1440, 2)).toEqual({ left: 0, top: 3 });
  });
});

describe("tooltipPlacement", () => {
  it("sits below-right of the cursor at 1x, as before", () => {
    expect(tooltipPlacement(100, 100, 120, 30, 1280, 720)).toEqual({ left: 112, top: 116 });
  });

  it("keeps the cursor offset in screen pixels when zoomed", () => {
    expect(tooltipPlacement(100, 100, 120, 30, 2560, 1440, 2)).toEqual({ left: 56, top: 58 });
  });

  it("flips left and up by its zoomed size near the edges", () => {
    // 120 x 30 CSS px at zoom 2 is 240 x 60 on screen.
    expect(tooltipPlacement(2500, 1420, 120, 30, 2560, 1440, 2)).toEqual({ left: (2500 - 240 - 4) / 2, top: (1420 - 60 - 4) / 2 });
  });
});

describe("cssZoomOf", () => {
  it("reads the browser's effective zoom when it reports one", () => {
    expect(cssZoomOf({ currentCSSZoom: 2 } as unknown as Element)).toBe(2);
  });

  it("is 1 when nothing is known", () => {
    expect(cssZoomOf({} as Element)).toBe(1);
  });
});
