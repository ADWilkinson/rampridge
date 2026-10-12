import { describe, expect, it } from "vitest";
import {
  OVERHEAD_SIDE_SLACK_PX,
  OverheadStack,
  ShoutPicker,
  avoidRect,
  clampBaseline,
  clampCentre,
  fitOverhead,
  isNarrowView,
  type OverheadFit,
  type OverheadView,
} from "./stacking";

describe("OverheadStack", () => {
  it("leaves separate entries where they are", () => {
    const s = new OverheadStack();
    expect(s.place(0, 100, 200, 20, 13)).toBe(200);
    expect(s.place(1, 200, 200, 20, 13)).toBe(200);
    expect(s.place(2, 100, 150, 20, 13)).toBe(150);
    expect(s.count).toBe(3);
  });

  it("moves an overlapping entry up onto the earlier one's top", () => {
    const s = new OverheadStack();
    s.place(0, 100, 200, 30, 13);
    expect(s.place(1, 110, 205, 30, 13)).toBe(187);
    expect(s.y[1]).toBe(187);
  });

  it("keeps climbing until clear of every earlier entry", () => {
    const s = new OverheadStack();
    s.place(0, 100, 200, 40, 13);
    s.place(1, 100, 187, 40, 13);
    s.place(2, 100, 174, 40, 13);
    // Starts on the lowest and is pushed past all three.
    expect(s.place(3, 105, 201, 40, 13)).toBe(161);
  });

  it("does not move an entry that sits above the earlier one", () => {
    const s = new OverheadStack();
    s.place(0, 100, 200, 40, 13);
    // Its baseline is above the earlier entry's top: the client leaves it.
    expect(s.place(1, 100, 186, 40, 13)).toBe(186);
  });

  it("treats a tag with chat as one tall block", () => {
    const s = new OverheadStack();
    s.place(0, 100, 200, 50, 29);
    expect(s.place(1, 120, 195, 20, 13)).toBe(171);
  });

  it("grows past its initial capacity", () => {
    const s = new OverheadStack();
    for (let i = 0; i < 100; i++) s.place(i, i * 1_000, 100, 10, 13);
    expect(s.count).toBe(100);
    expect(s.index[99]).toBe(99);
    expect(s.x[99]).toBe(99_000);
  });

  it("drops a grouped entry that would climb over too many of its group", () => {
    const s = new OverheadStack();
    // A player's line, then three merchant shouts in one column, newest first.
    s.place(0, 100, 200, 60, 13);
    expect(s.place(1, 100, 200, 80, 13, 1, 3)).toBe(187);
    expect(s.place(2, 105, 200, 80, 13, 1, 3)).toBe(174);
    expect(s.place(3, 95, 200, 80, 13, 1, 3)).toBe(161);
    // The fourth (oldest) would sit on three merchant lines: dropped.
    expect(s.place(4, 100, 200, 80, 13, 1, 3)).toBeNaN();
    expect(s.count).toBe(4);
    // Ungrouped entries and shouts elsewhere are unaffected.
    expect(s.place(5, 100, 200, 80, 13)).toBe(148);
    expect(s.place(6, 600, 200, 80, 13, 1, 3)).toBe(200);
    expect(Array.from(s.group.subarray(0, s.count))).toEqual([0, 1, 1, 1, 0, 1]);
  });

  it("drops a grouped entry that stacking would push off the top", () => {
    const s = new OverheadStack();
    s.place(0, 100, 30, 60, 13);
    // A shout below it would sit on its top (17), whose own top (4) is above the limit of 10.
    expect(s.place(1, 100, 30, 80, 13, 1, 3, 10)).toBeNaN();
    // A player's line is still placed.
    expect(s.place(2, 100, 30, 80, 13, 0, Infinity, 10)).toBe(17);
  });

  it("keeps the group through growth", () => {
    const s = new OverheadStack();
    for (let i = 0; i < 40; i++) s.place(i, i * 1_000, 100, 10, 13, i % 2);
    expect(s.group[39]).toBe(1);
    expect(s.group[38]).toBe(0);
  });
});

describe("clampCentre", () => {
  it("keeps a block inside the viewport", () => {
    expect(clampCentre(10, 100, 375)).toBe(102);
    expect(clampCentre(370, 100, 375)).toBe(273);
    expect(clampCentre(200, 100, 375)).toBe(200);
  });

  it("keeps the start of a block wider than the viewport in view, wherever its anchor is", () => {
    // 600 px of text on a 375 px phone: its left edge sits at the 2 px margin and only the end runs off.
    expect(clampCentre(10, 300, 375)).toBe(302);
    expect(clampCentre(370, 300, 375)).toBe(302);
  });

  // A phone in landscape: 844 px wide with 47 px covered by the notch and the rounded corners on each side.
  it("keeps a block clear of the side safe-area insets", () => {
    expect(clampCentre(2, 100, 844, 2, 47, 47)).toBe(149);
    expect(clampCentre(842, 100, 844, 2, 47, 47)).toBe(695);
    expect(clampCentre(400, 100, 844, 2, 47, 47)).toBe(400);
  });

  it("respects uneven insets", () => {
    expect(clampCentre(0, 50, 844, 2, 47, 0)).toBe(99);
    expect(clampCentre(844, 50, 844, 2, 47, 0)).toBe(792);
  });

  it("keeps the start of a block wider than the uncovered span clear of the left inset", () => {
    expect(clampCentre(10, 400, 844, 2, 47, 21)).toBe(449);
  });
});

describe("fitOverhead", () => {
  // The phone view the shell measures at 390x844: the minimap and orbs cover the top-right corner.
  const phone: OverheadView = { width: 390, height: 844, safeTop: 0, safeLeft: 0, safeRight: 0, hud: { left: 189, top: 0, right: 390, bottom: 160 } };
  const fit: OverheadFit = { x: 0, y: 0, minTop: 0 };
  // A short phone shout ("0.7554 GBP Revolut!") with wave2's 5 px sideways motion either side.
  const half = 72 + 5;
  const height = 13 + 2 * 5;

  it("leaves a block centred over the head when it fits", () => {
    expect(fitOverhead(100, 420, half, height, phone, fit)).toBe(true);
    expect(fit).toEqual({ x: 100, y: 420, minTop: 0 });
    // In the minimap's columns, but well below it: same place, only stacking is kept below the HUD.
    expect(fitOverhead(250, 420, half, height, phone, fit)).toBe(true);
    expect(fit).toEqual({ x: 250, y: 420, minTop: 160 });
  });

  it("moves a shout over a merchant at the far left edge inside the view, start first", () => {
    expect(fitOverhead(6, 420, half, height, phone, fit)).toBe(true);
    expect(fit.x - half).toBe(2);
    expect(fit.y).toBe(420);
  });

  it("moves a shout over a merchant at the far right edge inside the view", () => {
    expect(fitOverhead(386, 420, half, height, phone, fit)).toBe(true);
    expect(fit.x + half).toBe(388);
    // Below the minimap's columns: stacking may not push it back up under the HUD.
    expect(fit.minTop).toBe(160);
  });

  it("keeps a shout whose head has just left the screen, moved into view; drops one further off", () => {
    expect(fitOverhead(-OVERHEAD_SIDE_SLACK_PX, 420, half, height, phone, fit)).toBe(true);
    expect(fit.x - half).toBe(2);
    expect(fitOverhead(390 + OVERHEAD_SIDE_SLACK_PX, 420, half, height, phone, fit)).toBe(true);
    expect(fit.x + half).toBe(388);
    expect(fitOverhead(-OVERHEAD_SIDE_SLACK_PX - 1, 420, half, height, phone, fit)).toBe(false);
    expect(fitOverhead(391 + OVERHEAD_SIDE_SLACK_PX, 420, half, height, phone, fit)).toBe(false);
    expect(fitOverhead(Number.NaN, 420, half, height, phone, fit)).toBe(false);
  });

  it("shows the first characters of a line wider than the view at either edge", () => {
    // An 80-character line is about 540 px: wider than a 390 px phone.
    for (const x of [4, 195, 386]) {
      expect(fitOverhead(x, 420, 270, height, phone, fit)).toBe(true);
      expect(fit.x - 270).toBe(2);
    }
  });

  it("moves a block out from under the minimap and orbs: left when that is the smaller move, else below", () => {
    expect(fitOverhead(200, 60, 30, height, phone, fit)).toBe(true);
    expect(fit.x + 30).toBeLessThanOrEqual(189);
    expect(fit.y).toBe(60);
    expect(fitOverhead(300, 60, half, height, phone, fit)).toBe(true);
    expect(fit.y - height).toBeGreaterThanOrEqual(160);
    expect(fit.minTop).toBe(160);
  });

  it("leaves a block that clears the HUD where it is (never moved for nothing)", () => {
    expect(fitOverhead(90, 100, half, height, phone, fit)).toBe(true);
    expect(fit).toEqual({ x: 90, y: 100, minTop: 0 });
  });

  it("keeps clear of the notch and rounded corners in landscape", () => {
    const landscape: OverheadView = { width: 844, height: 390, safeTop: 0, safeLeft: 47, safeRight: 47, hud: null };
    expect(fitOverhead(0, 200, half, height, landscape, fit)).toBe(true);
    expect(fit.x - half).toBe(49);
    expect(fitOverhead(844, 200, half, height, landscape, fit)).toBe(true);
    expect(fit.x + half).toBe(795);
  });

  it("never lets any part of a block that fits leave the uncovered view (sampled anchors and widths)", () => {
    const views: OverheadView[] = [
      phone,
      { width: 1440, height: 900, safeTop: 0, safeLeft: 0, safeRight: 0, hud: { left: 1239, top: 0, right: 1440, bottom: 160 } },
      { width: 844, height: 390, safeTop: 0, safeLeft: 47, safeRight: 21, hud: { left: 643, top: 0, right: 823, bottom: 160 } },
    ];
    for (const view of views) {
      const span = view.width - view.safeLeft - view.safeRight - 4;
      for (let x = -OVERHEAD_SIDE_SLACK_PX; x <= view.width + OVERHEAD_SIDE_SLACK_PX; x += 7) {
        for (const hw of [8, 40, 77, 150, 290]) {
          if (2 * hw > span) continue;
          for (const y of [-30, 20, 120, 400, view.height + 20]) {
            expect(fitOverhead(x, y, hw, height, view, fit)).toBe(true);
            expect(fit.x - hw).toBeGreaterThanOrEqual(view.safeLeft + 2);
            expect(fit.x + hw).toBeLessThanOrEqual(view.width - view.safeRight - 2);
            expect(fit.y - height).toBeGreaterThanOrEqual(view.safeTop + 2);
            expect(fit.y).toBeLessThanOrEqual(view.height - 2);
          }
        }
      }
    }
  });
});

describe("clampBaseline", () => {
  it("drops a block near the top edge into view", () => {
    expect(clampBaseline(5, 13, 800)).toBe(15);
    expect(clampBaseline(-40, 13, 800, 47)).toBe(62);
  });

  it("keeps a block that is already inside the view", () => {
    expect(clampBaseline(300, 13, 800, 47)).toBe(300);
  });

  it("lifts a block below the bottom edge", () => {
    expect(clampBaseline(900, 13, 800)).toBe(798);
  });
});

describe("avoidRect", () => {
  // A 201x160 minimap in the top-right corner of a 390px view.
  const minimap = { left: 189, top: 0, right: 390, bottom: 160 };
  const out = { x: 0, y: 0 };

  it("leaves a block clear of the area alone", () => {
    expect(avoidRect(100, 300, 60, 13, minimap, out)).toEqual({ x: 100, y: 300 });
    expect(avoidRect(80, 100, 40, 13, minimap, out)).toEqual({ x: 80, y: 100 });
  });

  it("slides a short block left of the area when that is the smaller move", () => {
    expect(avoidRect(200, 60, 30, 13, minimap, out)).toEqual({ x: 157, y: 60 });
  });

  it("drops a wide block below the area when it cannot fit beside it", () => {
    expect(avoidRect(195, 90, 135, 13, minimap, out)).toEqual({ x: 195, y: 175 });
  });

  it("drops a block below the area rather than slide it under a left inset", () => {
    // Fits left of the minimap in the full view, but not right of a 47 px notch.
    expect(avoidRect(195, 60, 75, 13, minimap, out)).toEqual({ x: 112, y: 60 });
    expect(avoidRect(195, 60, 75, 13, minimap, out, 2, 47)).toEqual({ x: 195, y: 175 });
  });
});

describe("isNarrowView", () => {
  it("is narrow on phones either way up and on portrait screens", () => {
    expect(isNarrowView(390, 844)).toBe(true);
    expect(isNarrowView(360, 640)).toBe(true);
    expect(isNarrowView(740, 360)).toBe(true);
    expect(isNarrowView(768, 1024)).toBe(true);
  });

  it("is wide on desktops and landscape tablets or large phones", () => {
    expect(isNarrowView(1440, 900)).toBe(false);
    expect(isNarrowView(1024, 768)).toBe(false);
    expect(isNarrowView(844, 390)).toBe(false);
  });
});

describe("ShoutPicker", () => {
  /** One frame: scores the shouts (key, dx, dy[, priority]), returns them best first, then records the first `limit` as drawn. */
  function frame(picker: ShoutPicker, shouts: [object, number, number, boolean?][], limit = 2): object[] {
    const order = shouts.map((_, i) => i);
    shouts.forEach(([key, dx, dy, priority], i) => picker.score(i, key, dx, dy, priority));
    order.sort(picker.compare);
    picker.begin();
    const drawn = order.slice(0, limit).map((i) => shouts[i]![0]);
    for (const key of drawn) picker.mark(key);
    picker.end();
    return drawn;
  }

  const a = { name: "a" };
  const b = { name: "b" };
  const c = { name: "c" };
  const d = { name: "d" };

  it("shows the shouts nearest the middle of the view", () => {
    const picker = new ShoutPicker();
    // A is pressed against the right edge under the minimap; B and C are central.
    expect(frame(picker, [[a, 170, -300], [b, -40, -80], [c, 60, 20]])).toEqual([c, b]);
  });

  it("never swaps a showing shout out for a nearer new one before it ends", () => {
    const picker = new ShoutPicker();
    expect(frame(picker, [[a, 150, 0], [b, -140, 0]])).toEqual([b, a]);
    // A new shout D starts right in the middle: both showing shouts keep their place.
    expect(frame(picker, [[a, 150, 0], [b, -140, 0], [d, 0, 0]])).toEqual([b, a]);
    // A ends; D takes the free place, ahead of a farther new one.
    expect(frame(picker, [[b, -140, 0], [d, 0, 0], [c, 200, 0]])).toEqual([b, d]);
  });

  it("puts a priority line (a merchant's gz) first", () => {
    const picker = new ShoutPicker();
    frame(picker, [[a, 10, 0], [b, 20, 0]]);
    expect(frame(picker, [[a, 10, 0], [b, 20, 0], [c, 300, 300, true]])).toEqual([c, a]);
  });

  it("forgets what was showing when the view is wide again", () => {
    const picker = new ShoutPicker();
    frame(picker, [[a, 300, 0], [b, 290, 0]]);
    picker.clear();
    expect(frame(picker, [[a, 300, 0], [b, 290, 0], [c, 0, 0]])).toEqual([c, b]);
  });

  it("scores any number of candidates", () => {
    const picker = new ShoutPicker();
    const shouts: [object, number, number][] = Array.from({ length: 100 }, (_, i) => [{ i }, 1000 - i, 0]);
    const drawn = frame(picker, shouts);
    expect(drawn).toEqual([shouts[99]![0], shouts[98]![0]]);
  });
});
