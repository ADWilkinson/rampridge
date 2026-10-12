/**
 * Pointer maths under CSS zoom. On big monitors frame.css draws the HUD,
 * interfaces, menus and tooltips at --rs-ui-zoom (UI_ZOOM_QUERY). Pointer
 * events and getBoundingClientRect report screen (viewport) pixels, but an
 * element's own lengths (left, top, a translate, scrollTop) are in its zoomed
 * CSS pixels: `left: 10px` lands 20 screen pixels along at zoom 2. Code that
 * turns a pointer position or drag distance into a length divides by the
 * scale these helpers read. Without zoom they return 1 and nothing changes.
 */

interface ZoomedElement {
  /** The element's effective zoom (its own and its ancestors'), where the browser reports it. */
  currentCSSZoom?: number;
}

/** Screen pixels per CSS pixel along `el`'s width: its zoom and any transforms. Null when not laid out. */
function measuredScale(el: HTMLElement, vertical = false): number | null {
  const own = vertical ? el.offsetHeight : el.offsetWidth;
  if (!(own > 0)) return null;
  const r = el.getBoundingClientRect();
  const drawn = vertical ? r.height : r.width;
  return drawn > 0 ? drawn / own : null;
}

/**
 * The CSS zoom in effect on `el` (1 without zoom). Transforms are not
 * included: a translate or a fixed position on `el` is multiplied by this.
 */
export function cssZoomOf(el: Element): number {
  const z = (el as Element & ZoomedElement).currentCSSZoom;
  if (typeof z === "number" && z > 0) return z;
  // Older engines: the drawn size over the layout size (fine for untransformed elements).
  const m = typeof HTMLElement !== "undefined" && el instanceof HTMLElement ? measuredScale(el) : null;
  return m === null ? 1 : Math.round(m * 100) / 100;
}

/**
 * Screen pixels per CSS pixel of `el` vertically, zoom and transforms
 * included (a window fitted to a phone is scaled down): divide a pointer's
 * movement by it to get a distance in `el`'s own pixels.
 */
export function screenScaleY(el: HTMLElement): number {
  return measuredScale(el, true) ?? cssZoomOf(el);
}

export interface Placement {
  left: number;
  top: number;
}

/**
 * The Choose Option menu's position in its own CSS pixels: the header's
 * centre under the cursor (`x`, `y` in screen pixels), clamped to the
 * viewport (`vw` x `vh` screen pixels). `w` x `h` is the menu's CSS size and
 * `zoom` its CSS zoom.
 */
export function menuPlacement(x: number, y: number, w: number, h: number, vw: number, vh: number, zoom = 1): Placement {
  const z = zoom > 0 ? zoom : 1;
  const width = vw / z;
  const height = vh / z;
  return {
    left: Math.min(Math.max(0, Math.round(x / z - w / 2)), Math.max(0, width - w)),
    top: Math.min(Math.max(0, Math.round(y / z)), Math.max(0, height - h)),
  };
}

/**
 * The examine box beside the cursor, in its own CSS pixels: below-right of
 * (`x`, `y`) by a cursor's size in screen pixels, flipped left or up to stay
 * 4px inside the viewport. Sizes as for menuPlacement.
 */
export function tooltipPlacement(x: number, y: number, w: number, h: number, vw: number, vh: number, zoom = 1): Placement {
  const z = zoom > 0 ? zoom : 1;
  const sw = w * z;
  const sh = h * z;
  let left = x + 12;
  let top = y + 16;
  if (left + sw > vw - 4) left = Math.max(4, x - sw - 4);
  if (top + sh > vh - 4) top = Math.max(4, y - sh - 4);
  return { left: left / z, top: top / z };
}
