import { describe, expect, it } from "vitest";
import { minimapTileAt, type ScreenRect } from "./minimap";

/** The 152 px minimap canvas, drawn at `zoom` screen px per CSS px with its top-left at (1000, 20). */
function canvasAt(zoom: number): { rect: ScreenRect; css: number } {
  return { rect: { left: 1000, top: 20, width: 152 * zoom, height: 152 * zoom }, css: 152 };
}

/** A press `dx`, `dy` CSS px from the minimap's centre, in screen px at `zoom`. */
function press(zoom: number, dx: number, dy: number, yaw = 0, x = 3184.5, y = 3439.5) {
  const { rect, css } = canvasAt(zoom);
  return minimapTileAt(rect.left + rect.width / 2 + dx * zoom, rect.top + rect.height / 2 + dy * zoom, rect, css, css, x, y, yaw);
}

describe("minimapTileAt", () => {
  it("turns a press into tiles at 4 CSS px per tile, north up", () => {
    expect(press(1, 0, 0)).toEqual({ x: 3184, y: 3439 });
    expect(press(1, 20, 0)).toEqual({ x: 3189, y: 3439 });
    expect(press(1, 0, -20)).toEqual({ x: 3184, y: 3444 });
    expect(press(1, -20, 20)).toEqual({ x: 3179, y: 3434 });
  });

  it("walks the same distance under the 2x interface zoom (a press 40 screen px out is 5 tiles, not 10)", () => {
    for (const [dx, dy] of [[20, 0], [0, -20], [-28, 36], [50, 50]] as const) {
      expect(press(2, dx, dy), `${dx},${dy}`).toEqual(press(1, dx, dy));
    }
    const { rect, css } = canvasAt(2);
    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2;
    expect(minimapTileAt(centreX + 40, centreY, rect, css, css, 3184.5, 3439.5, 0)).toEqual({ x: 3189, y: 3439 });
  });

  it("follows any scale, including a fractional one and different scales on each axis", () => {
    for (const zoom of [0.75, 1.5, 3]) expect(press(zoom, 32, -12), `zoom ${zoom}`).toEqual(press(1, 32, -12));
    const rect = { left: 0, top: 0, width: 304, height: 152 };
    expect(minimapTileAt(152 + 40, 76 + 20, rect, 152, 152, 3184.5, 3439.5, 0)).toEqual({ x: 3189, y: 3434 });
  });

  it("turns with the camera", () => {
    // Yaw pi/2: the map is drawn turned a quarter clockwise (Minimap.draw), so north points right.
    expect(press(1, 20, 0, Math.PI / 2)).toEqual({ x: 3184, y: 3444 });
    expect(press(2, 20, 0, Math.PI / 2)).toEqual({ x: 3184, y: 3444 });
  });

  it("ignores presses outside the map's circle, at any zoom", () => {
    expect(press(1, 60, 60)).toBeNull();
    expect(press(2, 60, 60)).toBeNull();
    // Inside the circle at 2x: 70 CSS px out is 140 screen px, within the 152 screen px radius.
    expect(press(2, 70, 0)).toEqual({ x: 3202, y: 3439 });
    expect(press(2, 77, 0)).toBeNull();
  });

  it("falls back to 1:1 for a canvas that is not laid out", () => {
    const rect = { left: 0, top: 0, width: 152, height: 152 };
    expect(minimapTileAt(76 + 20, 76, rect, 0, 0, 3184.5, 3439.5, 0)).toEqual({ x: 3189, y: 3439 });
  });
});
