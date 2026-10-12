/**
 * GameFrame's layout state as modifier classes. Pure: frame.css does the
 * placing. See kit/layout.ts for the screen modes.
 */
import type { LayoutMode } from "@/ui/kit/layout";

export interface FrameLayoutInput {
  mode: LayoutMode;
  /** The player opened the full chatbox on a phone (it otherwise shows one line). */
  chatExpanded: boolean;
  /** A prompt or dialogue replaces the chat messages: the chatbox must show. */
  chatCovered: boolean;
  /** A side-panel tab with content is open. */
  sideOpen: boolean;
  /** An interface (window or scroll) is open in the interface layer. */
  interfaceOpen?: boolean;
  /** The player asked to hide the HUD (screen-record mode, desktop only). */
  hudHidden?: boolean;
}

export interface FrameLayout {
  /** The chatbox shows in full (always on desktop). */
  chatOpen: boolean;
  /** The HUD is hidden (screen-record mode). */
  hudHidden: boolean;
  /** Modifier classes for `.rs-gameframe`. */
  classes: string[];
}

/** Hiding the HUD needs a keyboard to bring it back, and an interface or chat question always shows it. */
export function canHideHud(mode: LayoutMode, interfaceOpen: boolean, chatCovered: boolean): boolean {
  return !mode.sheet && !interfaceOpen && !chatCovered;
}

/**
 * Desktop:
 * - `--hud-hidden`: screen-record mode; the chatbox, side panel, minimap,
 *   orbs and mouseover text are hidden, the 3D view and overhead text stay.
 *   Never while an interface is open or the chatbox asks something.
 *
 * Phones (the sheet layouts):
 * - `--mobile`: one-line chat and a tab strip whose tabs open the side panel as a sheet.
 * - `--compact`: a phone held sideways; chat line and tab strip share one bottom row.
 * - `--chat-open`: the full chatbox shows. Upright, interfaces refit above it; sideways it is drawn over them.
 * - `--chat-covered`: it shows a prompt or dialogue, so it is drawn above the sheet as well.
 * - `--sheet-open`: the side sheet is drawn above open interfaces.
 * - `--iface-open`: upright, an open interface reaches the top of the screen, so the minimap and
 *   orbs (which would show through the torn top of a scroll) are hidden. Sideways the interface
 *   layer stops left of the minimap column, so they stay.
 */
export function frameLayout({ mode, chatExpanded, chatCovered, sideOpen, interfaceOpen = false, hudHidden = false }: FrameLayoutInput): FrameLayout {
  if (!mode.sheet) {
    const hidden = hudHidden && canHideHud(mode, interfaceOpen, chatCovered);
    return { chatOpen: true, hudHidden: hidden, classes: hidden ? ["rs-gameframe--hud-hidden"] : [] };
  }
  const chatOpen = chatExpanded || chatCovered;
  const classes = ["rs-gameframe--mobile"];
  if (mode.compact) classes.push("rs-gameframe--compact");
  if (chatOpen) classes.push("rs-gameframe--chat-open");
  if (chatCovered) classes.push("rs-gameframe--chat-covered");
  if (sideOpen) classes.push("rs-gameframe--sheet-open");
  if (interfaceOpen && !mode.compact) classes.push("rs-gameframe--iface-open");
  return { chatOpen, hudHidden: false, classes };
}
