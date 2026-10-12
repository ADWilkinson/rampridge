import { describe, expect, it } from "vitest";
import { MENU_STALE_HOLD_MS, MenuPressGuard, consumesOutsidePress } from "./menu";

describe("consumesOutsidePress", () => {
  it("uses up a tap or pen press outside the menu, whatever the button", () => {
    expect(consumesOutsidePress("touch", 0)).toBe(true);
    expect(consumesOutsidePress("pen", 0)).toBe(true);
    expect(consumesOutsidePress("pen", 2)).toBe(true);
  });

  it("uses up a mouse left click like the client, and passes right and middle presses through", () => {
    expect(consumesOutsidePress("mouse", 0)).toBe(true);
    expect(consumesOutsidePress("mouse", 2)).toBe(false);
    expect(consumesOutsidePress("mouse", 1)).toBe(false);
  });
});

describe("MenuPressGuard", () => {
  it("acts at once on a menu opened by mouse or keyboard", () => {
    const guard = new MenuPressGuard([], 0);
    expect(guard.touchOpened).toBe(false);
    expect(guard.accepts(1)).toBe(true);
  });

  it("ignores the click that ends the long-press that opened the menu", () => {
    const guard = new MenuPressGuard([7], 0);
    expect(guard.accepts(1)).toBe(false);
    guard.up(7);
    // The click the browser sends after the finger lifts.
    expect(guard.accepts(1)).toBe(false);
  });

  it("acts on a fresh tap once the opening touch has lifted", () => {
    const guard = new MenuPressGuard([7], 0);
    guard.up(7);
    guard.down(100);
    expect(guard.accepts(1)).toBe(true);
  });

  it("does not count a second finger pressed while the opening touch is still down", () => {
    const guard = new MenuPressGuard([7], 0);
    guard.down(100);
    guard.up(8);
    expect(guard.accepts(1)).toBe(false);
    guard.up(7);
    guard.down(100);
    expect(guard.accepts(1)).toBe(true);
  });

  it("treats a press long after the menu opened as fresh even if the opening lift was missed", () => {
    const guard = new MenuPressGuard([7], 0);
    guard.down(MENU_STALE_HOLD_MS + 1);
    expect(guard.accepts(1)).toBe(true);
  });

  it("always acts on keyboard activation", () => {
    const guard = new MenuPressGuard([7], 0);
    expect(guard.accepts(0)).toBe(true);
  });
});
