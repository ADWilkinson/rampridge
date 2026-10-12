/**
 * Renderer settings for the device. The world costs per pixel drawn, so
 * phones and tablets (coarse pointer) draw at most 1.5 device pixels per
 * CSS pixel and ask for the default GPU; screens of 2x density and more skip
 * MSAA, whose edges are too small to see there (the 2007 client had none).
 * On phones a governor steps the ratio down further while frames stay slow.
 */

export const MAX_PIXEL_RATIO = 2;
export const MOBILE_MAX_PIXEL_RATIO = 1.5;
/** A frame slower than this (smoothed) counts as slow: under 50 fps. */
export const SLOW_FRAME_MS = 20;
/** How long frames must stay slow before the ratio steps down. */
export const SLOW_FOR_MS = 3_000;
export const PIXEL_RATIO_STEP = 0.25;
const SMOOTHING = 0.05;
const NOMINAL_FRAME_MS = 1_000 / 60;

export interface RenderQuality {
  pixelRatio: number;
  antialias: boolean;
  powerPreference: WebGLPowerPreference;
}

/**
 * Most device pixels a touch device draws per frame: phones stay at 1.5x,
 * while a tablet (whose 1.5x is up to three times a phone's work, on a
 * battery) draws a little softer: about 1.3x on an 11-inch iPad.
 */
export const MOBILE_PIXEL_BUDGET = 1_600_000;

/** `cssPixels`: the view's area in CSS pixels, for the touch pixel budget (ignored when unknown). */
export function renderQuality(devicePixelRatio: number, coarsePointer: boolean, cssPixels = 0): RenderQuality {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const budget = coarsePointer && cssPixels > 0 ? Math.max(1, Math.floor(Math.sqrt(MOBILE_PIXEL_BUDGET / cssPixels) * 100) / 100) : Infinity;
  return {
    pixelRatio: Math.min(dpr, coarsePointer ? MOBILE_MAX_PIXEL_RATIO : MAX_PIXEL_RATIO, budget),
    antialias: dpr < 2,
    powerPreference: coarsePointer ? "default" : "high-performance",
  };
}

/**
 * Steps the pixel ratio down by PIXEL_RATIO_STEP (never below 1, never back
 * up) each time the smoothed frame time stays above SLOW_FRAME_MS for
 * SLOW_FOR_MS.
 */
export class PixelRatioGovernor {
  /** Upper bound on the pixel ratio; starts unbounded. */
  cap = Number.POSITIVE_INFINITY;
  private smoothed = NOMINAL_FRAME_MS;
  private slowFor = 0;

  /** Feeds one frame of `frameMs` drawn at `ratio`; returns true when the cap just dropped. */
  frame(frameMs: number, ratio: number): boolean {
    this.smoothed += (frameMs - this.smoothed) * SMOOTHING;
    if (this.smoothed <= SLOW_FRAME_MS || ratio <= 1) {
      this.slowFor = 0;
      return false;
    }
    this.slowFor += frameMs;
    if (this.slowFor < SLOW_FOR_MS) return false;
    this.cap = Math.max(1, ratio - PIXEL_RATIO_STEP);
    this.reset();
    return true;
  }

  /** Forgets frame history (after a pause, or once the ratio has changed). */
  reset(): void {
    this.smoothed = NOMINAL_FRAME_MS;
    this.slowFor = 0;
  }
}
