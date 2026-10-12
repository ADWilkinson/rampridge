/**
 * Keystroke routing for the open chatbox input dialog ("Enter amount:").
 * In the client every keystroke goes to the open input dialog, wherever the
 * mouse last clicked. Here focus can sit on a button the player clicked in
 * the interface that opened the prompt, so keys typed there are routed to the
 * prompt instead of being lost.
 */

import { parseAmount } from "./amount";

export type PromptKeyAction = { type: "submit" } | { type: "backspace" } | { type: "insert"; text: string };

export interface PromptKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

export interface PromptKeyFocus {
  /** Focus is already in the prompt's own input (it handles the key itself). */
  inPrompt: boolean;
  /** Focus is in another text field (the name field, a search box...). */
  inTextField: boolean;
  /**
   * Focus is on a control the player reached with the keyboard (Tab), so
   * Enter and Space keep activating it. A control focused by a click does not
   * count: the client had no keyboard focus, only the input dialog.
   */
  keyboardControl: boolean;
}

/** What the prompt should do with a keydown, or null to leave the key alone. */
export function promptKeyAction(e: PromptKeyEvent, focus: PromptKeyFocus): PromptKeyAction | null {
  if (focus.inPrompt || focus.inTextField) return null;
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
  if (e.key === "Enter") return focus.keyboardControl ? null : { type: "submit" };
  if (e.key === "Backspace") return { type: "backspace" };
  if ([...e.key].length !== 1) return null;
  if (e.key === " " && focus.keyboardControl) return null;
  return { type: "insert", text: e.key };
}

/** Elements whose Enter/Space has its own activation behaviour. */
const ACTIVATABLE =
  'button, a[href], summary, select, input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"]';

export function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

let tracking = false;
let navigating = false;
let keyboardFocused: Element | null = null;

/**
 * Starts remembering which element the keyboard last moved focus to (Tab or
 * an arrow key, not a click). Idempotent; a no-op outside the browser.
 * `:focus-visible` cannot answer this: Chrome turns it on for a clicked
 * button as soon as a key is pressed.
 */
export function trackKeyboardFocus(): void {
  if (tracking || typeof window === "undefined") return;
  tracking = true;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) navigating = true;
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    () => {
      navigating = false;
    },
    true,
  );
  window.addEventListener(
    "focusin",
    (e) => {
      keyboardFocused = navigating ? (e.target as Element | null) : null;
    },
    true,
  );
}

/** True when `el` is an activatable control the player moved to with the keyboard. */
export function isKeyboardFocusedControl(el: Element | null): boolean {
  if (!(el instanceof HTMLElement) || el !== keyboardFocused) return false;
  try {
    return el.matches(ACTIVATABLE);
  } catch {
    return false;
  }
}

/** What submitting the prompt does with the typed value. */
export type PromptOutcome =
  | { type: "submit"; value: string; amount: number | null }
  /** Nothing typed: submitting closes the prompt, like Esc. */
  | { type: "cancel" }
  /** Not a valid amount: the prompt stays open and says so. */
  | { type: "invalid" };

/**
 * The result of OK or Enter for a typed value. Amounts parse with k/m/b
 * suffixes at `decimals` places and submit the raw text with the number;
 * text submits trimmed.
 */
export function promptOutcome(raw: string, kind: "amount" | "text", decimals = 0): PromptOutcome {
  if (!raw.trim()) return { type: "cancel" };
  if (kind === "text") return { type: "submit", value: raw.trim(), amount: null };
  const amount = parseAmount(raw, { decimals });
  return amount === null ? { type: "invalid" } : { type: "submit", value: raw, amount };
}
