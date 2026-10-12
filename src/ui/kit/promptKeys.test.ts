import { describe, expect, it } from "vitest";
import { promptKeyAction, promptOutcome, type PromptKeyFocus } from "./promptKeys";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});
const clickedButton: PromptKeyFocus = { inPrompt: false, inTextField: false, keyboardControl: false };
const tabbedButton: PromptKeyFocus = { inPrompt: false, inTextField: false, keyboardControl: true };

describe("promptKeyAction", () => {
  it("routes typing to the prompt after a click moved focus to an interface button", () => {
    expect(promptKeyAction(key("5"), clickedButton)).toEqual({ type: "insert", text: "5" });
    expect(promptKeyAction(key("k"), clickedButton)).toEqual({ type: "insert", text: "k" });
    expect(promptKeyAction(key(" "), clickedButton)).toEqual({ type: "insert", text: " " });
    expect(promptKeyAction(key("Backspace"), clickedButton)).toEqual({ type: "backspace" });
    expect(promptKeyAction(key("Enter"), clickedButton)).toEqual({ type: "submit" });
  });

  it("leaves Enter and Space to a control reached with Tab", () => {
    expect(promptKeyAction(key("Enter"), tabbedButton)).toBeNull();
    expect(promptKeyAction(key(" "), tabbedButton)).toBeNull();
    expect(promptKeyAction(key("7"), tabbedButton)).toEqual({ type: "insert", text: "7" });
  });

  it("ignores keys the prompt input or another text field already receives", () => {
    expect(promptKeyAction(key("5"), { ...clickedButton, inPrompt: true })).toBeNull();
    expect(promptKeyAction(key("5"), { ...clickedButton, inTextField: true })).toBeNull();
  });

  it("ignores shortcuts, composition and named keys", () => {
    expect(promptKeyAction(key("v", { metaKey: true }), clickedButton)).toBeNull();
    expect(promptKeyAction(key("c", { ctrlKey: true }), clickedButton)).toBeNull();
    expect(promptKeyAction(key("a", { altKey: true }), clickedButton)).toBeNull();
    expect(promptKeyAction(key("a", { isComposing: true }), clickedButton)).toBeNull();
    for (const named of ["Escape", "Tab", "ArrowLeft", "Shift", "F5"]) expect(promptKeyAction(key(named), clickedButton)).toBeNull();
  });
});

describe("promptOutcome", () => {
  it("submits a parsed amount with the raw text", () => {
    expect(promptOutcome("250", "amount")).toEqual({ type: "submit", value: "250", amount: 250 });
    expect(promptOutcome("1.5k", "amount")).toEqual({ type: "submit", value: "1.5k", amount: 1500 });
    expect(promptOutcome("12.34", "amount", 2)).toEqual({ type: "submit", value: "12.34", amount: 12.34 });
  });

  it("closes the prompt when nothing was typed", () => {
    expect(promptOutcome("", "amount")).toEqual({ type: "cancel" });
    expect(promptOutcome("   ", "amount")).toEqual({ type: "cancel" });
    expect(promptOutcome("  ", "text")).toEqual({ type: "cancel" });
  });

  it("keeps the prompt open on an amount it cannot read", () => {
    expect(promptOutcome(".", "amount")).toEqual({ type: "invalid" });
    expect(promptOutcome("kk", "amount")).toEqual({ type: "invalid" });
  });

  it("submits text trimmed", () => {
    expect(promptOutcome("  Zezima ", "text")).toEqual({ type: "submit", value: "Zezima", amount: null });
  });
});
