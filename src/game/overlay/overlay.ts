import type { ChatEffects } from "@shared/chat";
import { FONT_BOLD, FONT_PLAIN, FONT_PX, type SpriteFrame } from "../assets";
import {
  CHAT_LIFETIME_MS,
  SCROLL_WINDOW,
  chatColour,
  cssColour,
  glyphOffset,
  motionAmplitude,
  scrollLeft,
  slideOffset,
} from "./chatEffects";
import { HINT_ARROW_HEIGHT, HINT_ARROW_WIDTH, hintArrowPixels } from "./hintArrow";

/**
 * The 2D layer drawn over the WebGL canvas, like the client's software
 * overlay: overhead chat in the RuneScape bold font with a one-pixel black
 * shadow, stall tags, the click crosses and debug labels. Pixel fonts stay
 * crisp because the canvas uses an integer scale of CSS pixels (never more
 * than the world renderer's pixel ratio) and every glyph is placed on whole
 * pixels.
 */

export interface ChatBubble {
  text: string;
  effects: ChatEffects;
  /** performance.now() when the message appeared. */
  startedAt: number;
  /** Measured width in CSS px; -1 until first drawn. */
  width: number;
  /** Left edge of each glyph relative to the text start. */
  glyphX: Float32Array | null;
}

export function createBubble(text: string, effects: ChatEffects, startedAt: number): ChatBubble {
  return { text, effects, startedAt, width: -1, glyphX: null };
}

const BOLD_FONT = `${FONT_PX}px "${FONT_BOLD}"`;
const PLAIN_FONT = `${FONT_PX}px "${FONT_PLAIN}"`;
const BOLD_HEIGHT = 13;
/** Height the client gives an overhead message when stacking (the b12 font's ascent). */
export const CHAT_ASCENT = BOLD_HEIGHT;
/** Stall tag line: its stacking height alone, and the step up to a message above it. */
export const TAG_ASCENT = 12;
export const TAG_LINE = 16;

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  width = 0;
  height = 0;
  reducedMotion = false;
  private readonly offset = { x: 0, y: 0 };
  private hintArrow: HTMLCanvasElement | null = null;

  constructor() {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      imageRendering: "pixelated",
    } satisfies Partial<CSSStyleDeclaration>);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is not available");
    this.ctx = ctx;
  }

  /** `pixelRatio` is the world renderer's; the overlay uses its whole part (at least 1). */
  resize(width: number, height: number, pixelRatio: number): void {
    this.scale = Math.max(1, Math.floor(Math.min(pixelRatio, 2) + 1e-6));
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * this.scale));
    this.canvas.height = Math.max(1, Math.round(height * this.scale));
    this.ctx.imageSmoothingEnabled = false;
  }

  clear(): void {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
  }

  private measure(bubble: ChatBubble): void {
    const { ctx } = this;
    ctx.font = BOLD_FONT;
    bubble.width = Math.round(ctx.measureText(bubble.text).width);
    const xs = new Float32Array(bubble.text.length);
    for (let i = 0; i < xs.length; i++) xs[i] = Math.round(ctx.measureText(bubble.text.slice(0, i)).width);
    bubble.glyphX = xs;
  }

  private shadowed(text: string, x: number, y: number, colour: string): void {
    const { ctx } = this;
    ctx.fillStyle = "#000000";
    ctx.fillText(text, x + 1, y + 1);
    ctx.fillStyle = colour;
    ctx.fillText(text, x, y);
  }

  /** Width of an overhead message in CSS px (measured once). */
  chatWidth(bubble: ChatBubble): number {
    if (bubble.width < 0) this.measure(bubble);
    return bubble.width;
  }

  private motionOf(bubble: ChatBubble) {
    return this.reducedMotion ? null : bubble.effects.motion;
  }

  /** Width the message takes on screen: its text plus any sideways motion, or the scroll window. */
  chatBlockWidth(bubble: ChatBubble): number {
    const motion = this.motionOf(bubble);
    if (motion === "scroll") return SCROLL_WINDOW;
    return this.chatWidth(bubble) + 2 * motionAmplitude(motion).x;
  }

  /** How far the message's motion moves glyphs up or down (room to keep above and below it). */
  chatRise(bubble: ChatBubble): number {
    return motionAmplitude(this.motionOf(bubble)).y;
  }

  /** Draws an overhead message centred on `cx` with its baseline at `y`. Returns false once expired. */
  drawChat(bubble: ChatBubble, cx: number, y: number, now: number): boolean {
    const elapsed = now - bubble.startedAt;
    if (elapsed >= CHAT_LIFETIME_MS) return false;
    if (bubble.width < 0) this.measure(bubble);
    const { ctx } = this;
    ctx.font = BOLD_FONT;
    const colour = cssColour(chatColour(bubble.effects.color, elapsed));
    const motion = this.motionOf(bubble);
    const x = Math.round(cx);
    const baseline = Math.round(y);
    const left = x - Math.floor(bubble.width / 2);

    if (motion === "wave" || motion === "wave2" || motion === "shake") {
      const xs = bubble.glyphX!;
      const { text } = bubble;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === " ") continue;
        glyphOffset(motion, i, elapsed, this.offset);
        this.shadowed(ch, left + xs[i]! + this.offset.x, baseline + this.offset.y, colour);
      }
      return true;
    }
    if (motion === "scroll") {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - SCROLL_WINDOW / 2, baseline - BOLD_HEIGHT - 2, SCROLL_WINDOW, BOLD_HEIGHT + 8);
      ctx.clip();
      this.shadowed(bubble.text, x + scrollLeft(bubble.width, elapsed), baseline, colour);
      ctx.restore();
      return true;
    }
    if (motion === "slide") {
      ctx.save();
      ctx.beginPath();
      ctx.rect(left - 2, baseline - BOLD_HEIGHT - 1, bubble.width + 4, BOLD_HEIGHT + 6);
      ctx.clip();
      this.shadowed(bubble.text, left, baseline + slideOffset(elapsed), colour);
      ctx.restore();
      return true;
    }
    this.shadowed(bubble.text, left, baseline, colour);
    return true;
  }

  /** Small cyan tag (stall adverts) centred on `cx`. */
  drawTag(text: string, width: number, cx: number, y: number): void {
    this.ctx.font = PLAIN_FONT;
    this.shadowed(text, Math.round(cx) - Math.floor(width / 2), Math.round(y), "#00ffff");
  }

  measureTag(text: string): number {
    this.ctx.font = PLAIN_FONT;
    return Math.round(this.ctx.measureText(text).width);
  }

  /** Draws a sprite frame centred on (x, y) using its original canvas offsets. */
  drawSprite(frame: SpriteFrame, x: number, y: number): void {
    this.ctx.drawImage(
      frame.image,
      Math.round(x - frame.maxWidth / 2 + frame.offsetX),
      Math.round(y - frame.maxHeight / 2 + frame.offsetY),
    );
  }

  /** Draws the hint arrow centred on `cx` with its tip at `tipY`. */
  drawHintArrow(cx: number, tipY: number): void {
    if (!this.hintArrow) {
      const sprite = document.createElement("canvas");
      sprite.width = HINT_ARROW_WIDTH;
      sprite.height = HINT_ARROW_HEIGHT;
      const g = sprite.getContext("2d");
      if (!g) return;
      const pixels = hintArrowPixels();
      for (let i = 0; i < pixels.length; i++) {
        const colour = pixels[i];
        if (!colour) continue;
        g.fillStyle = colour;
        g.fillRect(i % HINT_ARROW_WIDTH, Math.floor(i / HINT_ARROW_WIDTH), 1, 1);
      }
      this.hintArrow = sprite;
    }
    this.ctx.drawImage(this.hintArrow, Math.round(cx - HINT_ARROW_WIDTH / 2), Math.round(tipY - HINT_ARROW_HEIGHT));
  }

  /** Debug text (tile coordinates). */
  drawLabel(text: string, x: number, y: number, colour: string): void {
    const { ctx } = this;
    ctx.font = PLAIN_FONT;
    ctx.textAlign = "center";
    this.shadowed(text, Math.round(x), Math.round(y), colour);
    ctx.textAlign = "left";
  }
}
