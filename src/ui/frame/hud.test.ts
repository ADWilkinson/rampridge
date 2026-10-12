import { describe, expect, it } from "vitest";
import { hudKeyAction, type HudKey } from "./hud";

const press = (over: Partial<HudKey>): HudKey => ({ key: "h", code: "KeyH", altKey: false, ctrlKey: false, metaKey: false, ...over });

describe("hudKeyAction", () => {
  it("hides on Alt+H, including a Mac's Option+H (key '˙')", () => {
    expect(hudKeyAction(press({ altKey: true }), false, false)).toBe("hide");
    expect(hudKeyAction(press({ altKey: true, key: "˙" }), false, false)).toBe("hide");
  });

  it("leaves a bare H to the chatbox, which takes typing outside text fields", () => {
    expect(hudKeyAction(press({}), false, false)).toBeNull();
    expect(hudKeyAction(press({ key: "H" }), false, false)).toBeNull();
  });

  it("never hides from inside a text field or on a browser shortcut", () => {
    expect(hudKeyAction(press({ altKey: true }), false, true)).toBeNull();
    expect(hudKeyAction(press({ ctrlKey: true }), false, false)).toBeNull();
    expect(hudKeyAction(press({ metaKey: true }), true, false)).toBeNull();
  });

  it("shows on H or Alt+H while hidden (there is no chatbox to type into)", () => {
    expect(hudKeyAction(press({}), true, false)).toBe("show");
    expect(hudKeyAction(press({ altKey: true }), true, false)).toBe("show");
  });

  it("ignores held keys and other letters", () => {
    expect(hudKeyAction(press({ altKey: true, repeat: true }), false, false)).toBeNull();
    expect(hudKeyAction(press({ key: "g", code: "KeyG", altKey: true }), false, false)).toBeNull();
    expect(hudKeyAction(press({ key: "Escape", code: "Escape" }), true, false)).toBeNull();
  });
});
