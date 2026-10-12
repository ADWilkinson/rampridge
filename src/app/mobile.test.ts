import { describe, expect, it } from "vitest";
import { KEYBOARD_MIN_PX, keyboardInset } from "./mobile";

describe("keyboardInset", () => {
  it("is zero while the visible area fills the layout", () => {
    expect(keyboardInset(844, 844, 0)).toBe(0);
  });

  it("ignores small losses such as a toolbar showing", () => {
    expect(keyboardInset(844, 844 - (KEYBOARD_MIN_PX - 1), 0)).toBe(0);
  });

  it("is the height a keyboard covers", () => {
    expect(keyboardInset(844, 508, 0)).toBe(336);
  });

  it("allows for the browser panning the page up to show the field", () => {
    // iOS: 336px keyboard, the visible area scrolled 120px down the layout.
    expect(keyboardInset(844, 508, 120)).toBe(216);
  });
});
