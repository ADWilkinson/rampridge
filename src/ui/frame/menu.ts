import type { TargetKind } from "@/game/types";

/**
 * One entry of the Choose Option menu or the mouseover line. The engine's
 * `MenuOption` (src/game/types.ts) satisfies this shape, so world options
 * pass straight through; interfaces build their own entries for items.
 */
export interface MenuEntry {
  /** e.g. "Bank", "Withdraw-All", "Walk here" (drawn white). */
  verb: string;
  /** e.g. "Banker", "Coins" (drawn in the colour of `kind`). */
  targetName?: string;
  kind?: TargetKind;
  /** Trailing text after the target, e.g. "(level-3)". */
  suffix?: string;
}

/** Menu target colours: NPC yellow, object cyan, player white, item orange. */
export const TARGET_COLORS: Readonly<Record<TargetKind, string>> = {
  npc: "#ffff00",
  object: "#00ffff",
  player: "#ffffff",
  item: "#ff9040",
  tile: "#ffffff",
};

/** "Bank Banker (level-3)" as plain text, for accessible labels. */
export function entryText(entry: MenuEntry): string {
  return [entry.verb, entry.targetName, entry.suffix].filter(Boolean).join(" ");
}

/**
 * Whether a press outside the open Choose Option menu is used up closing it
 * rather than passed on to whatever is under the pointer. The client consumes
 * a left click made while its menu is open, and on touch tapping elsewhere is
 * the only way to dismiss the menu, so that tap must not also walk or press a
 * button. Mouse right and middle presses pass through, so the world can open
 * a new menu where the cursor is or start a camera drag.
 */
export function consumesOutsidePress(pointerType: string, button: number): boolean {
  return pointerType === "mouse" ? button === 0 : true;
}

/**
 * Keeps a long-press from choosing an option by accident. On a phone the
 * menu opens under a finger that is still down, and once it is moved to stay
 * on screen an option can sit under that finger; lifting it then sends a
 * click to that option. A menu opened by touch therefore acts only on a
 * press that starts after the opening touch has lifted (or on the keyboard,
 * whose clicks carry detail 0). Menus opened by mouse or keyboard act at once.
 */
export const MENU_STALE_HOLD_MS = 4_000;

export class MenuPressGuard {
  /** A touch or pen contact was down when the menu opened. */
  readonly touchOpened: boolean;
  private readonly held: Set<number>;
  private readonly openedAt: number;
  private fresh = false;

  /** `heldAtOpen`: ids of the touch and pen pointers down when the menu opened. */
  constructor(heldAtOpen: Iterable<number>, now: number) {
    this.held = new Set(heldAtOpen);
    this.touchOpened = this.held.size > 0;
    this.openedAt = now;
  }

  /**
   * A pointer went down (any type). It is a fresh press once the opening
   * touch has lifted, or after MENU_STALE_HOLD_MS in case that lift was
   * never seen (e.g. it ended over another frame).
   */
  down(now: number): void {
    if (this.held.size === 0 || now - this.openedAt > MENU_STALE_HOLD_MS) this.fresh = true;
  }

  /** A pointer lifted or was cancelled. */
  up(pointerId: number): void {
    this.held.delete(pointerId);
  }

  /** Whether an option's click (with its `detail` count) should act. */
  accepts(clickDetail: number): boolean {
    return !this.touchOpened || clickDetail === 0 || this.fresh;
  }
}
