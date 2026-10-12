/**
 * Screen layout modes shared by the kit and the game frame. Pure (no React,
 * no DOM) so the rules are unit-tested; hooks.ts turns the queries into
 * hooks.
 */

/** Narrower than 768px: phones held upright (and narrow desktop windows). */
export const NARROW_QUERY = "(max-width: 767px)";

/**
 * A touch screen under 500px tall: a phone held sideways. The desktop
 * chatbox (165px) and side panel (336px) do not fit beside an interface
 * there, so the frame switches to its compact landscape layout.
 */
export const COMPACT_LANDSCAPE_QUERY = "(pointer: coarse) and (max-height: 500px)";

/**
 * Any touch input. Phone number keypads have no Enter key, so the chatbox
 * prompt shows OK and Cancel buttons whenever touch is available.
 */
export const TOUCH_QUERY = "(any-pointer: coarse)";

/**
 * Big monitors (2560x1440 and up): at 1x the Grand Exchange is a 488px
 * window with 11px text there, so the stylesheets draw the HUD, interfaces,
 * menus, tooltips and the title and loading screens at UI_ZOOM with CSS zoom
 * (the 3D view stays at 1x). styles/tokens.css repeats this query as
 * --rs-ui-zoom; frameLayout.test.ts keeps them in step.
 */
export const UI_ZOOM_QUERY = "(min-width: 2200px) and (min-height: 1200px)";
export const UI_ZOOM = 2;

/** The interface zoom for a window of `width` x `height` CSS pixels (UI_ZOOM_QUERY as a function). */
export function uiZoomFor(width: number, height: number): number {
  return width >= 2200 && height >= 1200 ? UI_ZOOM : 1;
}

export interface LayoutMode {
  /**
   * The portrait phone layout: interfaces use their tall phone sizes. This is
   * what useIsMobile() returns. False for a phone held sideways, where the
   * wide desktop sizes fit the short screen far better.
   */
  mobile: boolean;
  /** A phone held sideways (compact landscape). */
  compact: boolean;
  /**
   * The frame collapses the chatbox to one line and opens the side panel as
   * a sheet from a tab strip: phones in either orientation.
   */
  sheet: boolean;
}

export function layoutMode(narrow: boolean, compactLandscape: boolean): LayoutMode {
  return { mobile: narrow && !compactLandscape, compact: compactLandscape, sheet: narrow || compactLandscape };
}

/**
 * Below this fit scale an interface's 12px text drops under about 8px and its
 * controls under 25px. On a phone held sideways such an interface asks to be
 * turned upright instead of drawing an illegible window.
 */
export const MIN_LEGIBLE_SCALE = 0.7;

export function needsUpright(compact: boolean, scale: number): boolean {
  return compact && scale < MIN_LEGIBLE_SCALE;
}

/** Smallest scale an interface is ever drawn at. */
export const MIN_FIT_SCALE = 0.4;

/**
 * The scale that fits a box of natural size (w, h) into an area (pw, ph):
 * 1 whenever it fits, otherwise the largest scale (to the hundredth, rounded
 * down) that fits inside `margin` on each side, never below MIN_FIT_SCALE.
 * Null when a size is unknown (not laid out yet).
 */
export function fitScale(w: number, h: number, pw: number, ph: number, margin = 8): number | null {
  if (!(w > 0 && h > 0 && pw > 0 && ph > 0)) return null;
  if (w <= pw && h <= ph) return 1;
  const s = Math.min(1, (pw - margin * 2) / w, (ph - margin * 2) / h);
  return Math.max(MIN_FIT_SCALE, Math.floor(s * 100) / 100);
}
