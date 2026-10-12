/**
 * Screen-record mode: the player hides the HUD (chatbox, side panel, minimap,
 * orbs and mouseover text) to film the bank. GameFrame owns the state;
 * SettingsPanel reaches it through HudVisibilityContext.
 *
 * The hotkey is Alt+H, not a bare H: any letter typed outside a text field
 * goes to the chatbox (Chatbox's captureTyping, as in the original client),
 * so a bare H would hide the HUD on the first letter of "hi". While the HUD
 * is hidden there is no chatbox to type into, so H, Alt+H and Esc all bring
 * it back.
 */
import { createContext, useContext } from "react";

export const HUD_HIDE_SHORTCUT = "Alt+H";

export interface HudKey {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}

/**
 * What a key press does to the HUD: "hide", "show" or nothing. `inTextField`
 * is true while focus is in an input or textarea. Esc is handled as an escape
 * layer by GameFrame (so an open menu closes first), not here.
 */
export function hudKeyAction(e: HudKey, hidden: boolean, inTextField: boolean): "hide" | "show" | null {
  if (e.ctrlKey || e.metaKey || e.repeat) return null;
  // e.code, not e.key: Option+H on a Mac reports key "˙".
  const h = e.code === "KeyH" || e.key === "h" || e.key === "H";
  if (!h) return null;
  if (hidden) return "show";
  if (inTextField || !e.altKey) return null;
  return "hide";
}

export interface HudVisibility {
  /** The layout offers hiding: desktop only, as a phone has no key to bring the HUD back. */
  available: boolean;
  /** Hiding is possible now: available, no interface open and no question in the chatbox. */
  canHide: boolean;
  hide: () => void;
}

export const HudVisibilityContext = createContext<HudVisibility | null>(null);

/** The HUD controls of the enclosing GameFrame, or null outside one. */
export function useHudVisibility(): HudVisibility | null {
  return useContext(HudVisibilityContext);
}
