import type { Tile } from "@shared/protocol";

/**
 * The original client's hint arrow: a yellow arrow bobbing over an NPC to
 * point a new player at it. Here it marks the banker nearest the local
 * player until their first banker or booth interaction (Talk-to, Bank,
 * Exchange, Collect), and the dismissal is remembered on the device. It is
 * drawn in the 2D overlay, which takes no pointer events, so it never gets
 * in the way of picking the banker under it.
 */

export const HINT_STORAGE_KEY = "rr.hint.banker.v1";

/** Tiles another banker must be closer by before the arrow moves to it (no flicker between equals). */
const SWITCH_MARGIN = 1;

/**
 * Index of the serving banker nearest `from` (fractional tiles allowed), or
 * -1 when none serves. The banker marked now (`current`) keeps the arrow
 * until another is SWITCH_MARGIN tiles closer, so walking along the booths
 * does not make it jump back and forth.
 */
export function nearestBanker(
  bankers: readonly { tile: Tile; serves: boolean }[],
  from: { x: number; y: number },
  current = -1,
): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < bankers.length; i++) {
    const b = bankers[i]!;
    if (!b.serves) continue;
    const d = Math.hypot(b.tile.x - from.x, b.tile.y - from.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const kept = bankers[current];
  if (best >= 0 && kept?.serves && current !== best) {
    const d = Math.hypot(kept.tile.x - from.x, kept.tile.y - from.y);
    if (d - bestD < SWITCH_MARGIN) return current;
  }
  return best;
}

/** The part of Storage this needs; a fake in tests. */
export interface HintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): HintStorage | null {
  // Reading localStorage itself throws when site data is blocked.
  return typeof localStorage === "undefined" ? null : localStorage;
}

/**
 * Whether the banker hint has been dismissed on this device. Storage may be
 * missing or throw (private windows, blocked site data): the hint then shows
 * until dismissed in this session.
 */
export class HintMemory {
  private done: boolean;
  private readonly storage: () => HintStorage | null;

  constructor(storage: () => HintStorage | null = browserStorage) {
    this.storage = storage;
    let done = false;
    try {
      done = this.storage()?.getItem(HINT_STORAGE_KEY) === "1";
    } catch {
      done = false;
    }
    this.done = done;
  }

  get dismissed(): boolean {
    return this.done;
  }

  dismiss(): void {
    if (this.done) return;
    this.done = true;
    try {
      this.storage()?.setItem(HINT_STORAGE_KEY, "1");
    } catch {
      // Remembered for this session only.
    }
  }
}

/** Bob period and height of the arrow, in ms and CSS px. */
const BOB_MS = 1_200;
const BOB_PX = 5;

/** How far the arrow is lifted above its rest point at `time` (ms); 0 under reduced motion. */
export function hintBob(time: number, reduced: boolean): number {
  if (reduced) return 0;
  return Math.round((Math.sin((time / BOB_MS) * Math.PI * 2) + 1) * (BOB_PX / 2));
}

/** Pixel art of the arrow: a shaft and a downward head, by row as [left, right] inclusive spans. */
const HEAD_WIDTH = 27;
const SHAFT_ROWS = 12;
const SHAFT_LEFT = 8;
const SHAFT_RIGHT = HEAD_WIDTH - 1 - SHAFT_LEFT;
const HEAD_ROWS = (HEAD_WIDTH + 1) / 2;
/** Sprite size in CSS px, with the one-pixel outline. */
export const HINT_ARROW_WIDTH = HEAD_WIDTH + 2;
export const HINT_ARROW_HEIGHT = SHAFT_ROWS + HEAD_ROWS + 2;

function spanOf(row: number): [number, number] | null {
  if (row < 0) return null;
  if (row < SHAFT_ROWS) return [SHAFT_LEFT, SHAFT_RIGHT];
  const k = row - SHAFT_ROWS;
  if (k >= HEAD_ROWS) return null;
  // The head narrows by one pixel each side per row, down to its one-pixel tip.
  return [k, HEAD_WIDTH - 1 - k];
}

function inside(x: number, y: number): boolean {
  const span = spanOf(y);
  return span !== null && x >= span[0] && x <= span[1];
}

/**
 * Colour of each pixel of the arrow sprite (row-major, HINT_ARROW_WIDTH by
 * HINT_ARROW_HEIGHT, with a one-pixel black outline), null for transparent.
 * Yellow with a lit left edge and an orange shaded right side, like the
 * client's arrow.
 */
export function hintArrowPixels(): (string | null)[] {
  const out: (string | null)[] = [];
  for (let py = 0; py < HINT_ARROW_HEIGHT; py++) {
    for (let px = 0; px < HINT_ARROW_WIDTH; px++) {
      const x = px - 1;
      const y = py - 1;
      if (inside(x, y)) {
        const span = spanOf(y)!;
        const centre = (span[0] + span[1]) / 2;
        out.push(x === span[0] ? "#ffff9c" : x > centre + 1 || x === span[1] ? "#d89800" : "#ffe800");
      } else if (inside(x - 1, y) || inside(x + 1, y) || inside(x, y - 1) || inside(x, y + 1)) {
        out.push("#000000");
      } else {
        out.push(null);
      }
    }
  }
  return out;
}
