import type { ChatColor, ChatMotion } from "@shared/chat";

/**
 * Overhead chat effects reproduced from the original client. The client
 * runs a 20 ms cycle and gives overhead text 150 cycles; here a message
 * lives CHAT_LIFETIME_MS and the timed effects (glow, shake, scroll, slide)
 * are spread over that lifetime so they complete exactly once.
 */

export const CHAT_LIFETIME_MS = 5_000;
const CYCLE_MS = 20;
const TEXT_CYCLES = 150;

/** Client loop cycle for `elapsed` ms. */
export function loopCycle(elapsed: number): number {
  return Math.floor(elapsed / CYCLE_MS);
}

/** 0..149: how far through its life the message is, in the client's text cycles. */
export function textCycle(elapsed: number, lifetime = CHAT_LIFETIME_MS): number {
  return Math.max(0, Math.min(TEXT_CYCLES - 1, Math.floor((elapsed / lifetime) * TEXT_CYCLES)));
}

const STATIC: Partial<Record<ChatColor, number>> = {
  yellow: 0xffff00,
  red: 0xff0000,
  green: 0x00ff00,
  cyan: 0x00ffff,
  purple: 0xff00ff,
  white: 0xffffff,
};

/** RGB colour (0xRRGGBB) of a chat colour effect at `elapsed` ms. */
export function chatColour(color: ChatColor, elapsed: number, lifetime = CHAT_LIFETIME_MS): number {
  const fixed = STATIC[color];
  if (fixed !== undefined) return fixed;
  const cycle = loopCycle(elapsed);
  const firstHalf = cycle % 20 < 10;
  const j = textCycle(elapsed, lifetime);
  switch (color) {
    case "flash1":
      return firstHalf ? 0xff0000 : 0xffff00;
    case "flash2":
      return firstHalf ? 0x0000ff : 0x00ffff;
    case "flash3":
      return firstHalf ? 0x00b000 : 0x80ff80;
    case "glow1":
      if (j < 50) return 0xff0000 + 0x500 * j;
      if (j < 100) return 0xffff00 - 0x50000 * (j - 50);
      return 0x00ff00 + 5 * (j - 100);
    case "glow2":
      if (j < 50) return 0xff0000 + 5 * j;
      if (j < 100) return 0xff00ff - 0x50000 * (j - 50);
      return 0x0000ff + 0x50000 * (j - 100) - 5 * (j - 100);
    case "glow3":
      if (j < 50) return 0xffffff - 0x50005 * j;
      if (j < 100) return 0x00ff00 + 0x50005 * (j - 50);
      return 0xffffff - 0x50000 * (j - 100);
    default:
      return 0xffff00;
  }
}

/** Pixel offset of glyph `index` for the per-character motions (wave, wave2, shake). */
export function glyphOffset(
  motion: ChatMotion | null,
  index: number,
  elapsed: number,
  out: { x: number; y: number },
  lifetime = CHAT_LIFETIME_MS,
): { x: number; y: number } {
  out.x = 0;
  out.y = 0;
  const cycle = loopCycle(elapsed);
  if (motion === "wave") {
    out.y = Math.trunc(Math.sin(index / 2 + cycle / 5) * 5);
  } else if (motion === "wave2") {
    out.x = Math.trunc(Math.sin(index / 5 + cycle / 5) * 5);
    out.y = Math.trunc(Math.sin(index / 3 + cycle / 5) * 5);
  } else if (motion === "shake") {
    const amplitude = Math.max(0, 7 - textCycle(elapsed, lifetime) / 8);
    out.y = Math.trunc(Math.sin(index / 1.5 + cycle) * amplitude);
  }
  return out;
}

const STILL: Readonly<{ x: number; y: number }> = { x: 0, y: 0 };
const WAVE: Readonly<{ x: number; y: number }> = { x: 0, y: 5 };
const WAVE2: Readonly<{ x: number; y: number }> = { x: 5, y: 5 };
const SHAKE: Readonly<{ x: number; y: number }> = { x: 0, y: 7 };

/**
 * The furthest `glyphOffset` moves a glyph, sideways and up or down, over a
 * message's life (shake starts at 7 px and settles). Overhead stacking
 * reserves this much room so moving text never runs into its neighbours.
 */
export function motionAmplitude(motion: ChatMotion | null): Readonly<{ x: number; y: number }> {
  switch (motion) {
    case "wave":
      return WAVE;
    case "wave2":
      return WAVE2;
    case "shake":
      return SHAKE;
    default:
      return STILL;
  }
}

/** Width of the window a scrolling message passes through, centred on the speaker. */
export const SCROLL_WINDOW = 100;

/**
 * Scroll: the text enters from the right of a 100 px window centred on the
 * actor and leaves on the left. Returns the left x of the text relative to
 * the centre.
 */
export function scrollLeft(textWidth: number, elapsed: number, lifetime = CHAT_LIFETIME_MS): number {
  const travelled = Math.floor((textCycle(elapsed, lifetime) * (textWidth + SCROLL_WINDOW)) / TEXT_CYCLES);
  return SCROLL_WINDOW / 2 - travelled;
}

/** Slide: the text drops in during the first sixth of its life and out during the last. */
export function slideOffset(elapsed: number, lifetime = CHAT_LIFETIME_MS): number {
  const j = textCycle(elapsed, lifetime);
  if (j < 25) return j - 25;
  if (j > 125) return j - 125;
  return 0;
}

const cssCache = new Map<number, string>();

/** CSS colour string for an RGB value, memoised so per-frame drawing does not allocate. */
export function cssColour(rgb: number): string {
  const key = rgb & 0xffffff;
  let css = cssCache.get(key);
  if (css === undefined) {
    css = `#${key.toString(16).padStart(6, "0")}`;
    cssCache.set(key, css);
  }
  return css;
}
