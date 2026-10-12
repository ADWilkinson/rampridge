/**
 * The client's overhead text stacking. Entries are placed in order; each one
 * that overlaps an entry placed before it moves up to sit on that entry's
 * top, repeating until it is clear (Client.drawActors2's overheadText loop,
 * with its 2 px allowance below the baseline). Earlier entries never move,
 * so the local player's text, placed first, stays where it is.
 *
 * Entries may carry a group (merchant shouts) and a limit on how many
 * entries of their own group they may climb over; an entry over the limit
 * is not placed, so a busy column never grows past a few lines.
 */

/** Preallocated entry storage; `ensure` grows it, nothing allocates per frame otherwise. */
export class OverheadStack {
  /** Caller's index for each entry (e.g. into the actor list). */
  index = new Int32Array(32);
  /** Centre x, baseline y, half-width and height in CSS px. */
  x = new Float32Array(32);
  y = new Float32Array(32);
  halfWidth = new Float32Array(32);
  height = new Float32Array(32);
  /** Group of each entry; 0 is ungrouped. */
  group = new Int32Array(32);
  count = 0;

  ensure(capacity: number): void {
    if (capacity <= this.x.length) return;
    const size = Math.max(capacity, this.x.length * 2);
    const grow = (a: Float32Array) => {
      const b = new Float32Array(size);
      b.set(a);
      return b;
    };
    const growInt = (a: Int32Array) => {
      const b = new Int32Array(size);
      b.set(a);
      return b;
    };
    this.index = growInt(this.index);
    this.group = growInt(this.group);
    this.x = grow(this.x);
    this.y = grow(this.y);
    this.halfWidth = grow(this.halfWidth);
    this.height = grow(this.height);
  }

  reset(): void {
    this.count = 0;
  }

  /**
   * Adds an entry, moving it up clear of the earlier ones, and returns its
   * resolved baseline. With a non-zero `group`, the entry is dropped (NaN is
   * returned and nothing is added) when it would climb over `maxBelow` or
   * more entries of the same group, or when stacking would push its top
   * above `minTop` (off the top of the view).
   */
  place(index: number, x: number, y: number, halfWidth: number, height: number, group = 0, maxBelow = Infinity, minTop = -Infinity): number {
    this.ensure(this.count + 1);
    const xs = this.x;
    const ys = this.y;
    const ws = this.halfWidth;
    const hs = this.height;
    const gs = this.group;
    const n = this.count;
    let below = 0;
    let moved = true;
    while (moved) {
      moved = false;
      for (let j = 0; j < n; j++) {
        const top = ys[j]! - hs[j]!;
        if (y + 2 > top && y - height < ys[j]! + 2 && x - halfWidth < xs[j]! + ws[j]! && x + halfWidth > xs[j]! - ws[j]! && top < y) {
          y = top;
          moved = true;
          if (group !== 0 && gs[j] === group && ++below >= maxBelow) return Number.NaN;
        }
      }
    }
    if (group !== 0 && y - height < minTop) return Number.NaN;
    this.index[n] = index;
    xs[n] = x;
    ys[n] = y;
    ws[n] = halfWidth;
    hs[n] = height;
    gs[n] = group;
    this.count = n + 1;
    return y;
  }
}

/**
 * Centre x for a block `halfWidth` either side, moved inside a viewport
 * `width` wide whose `left` and `right` px are covered (a notch or rounded
 * corners in landscape), with `margin` to spare. A block wider than the
 * uncovered span keeps its start in view (text reads from the left), so
 * only its end runs off the right edge.
 */
export function clampCentre(x: number, halfWidth: number, width: number, margin = 2, left = 0, right = 0): number {
  const min = left + halfWidth + margin;
  const max = width - right - halfWidth - margin;
  if (min >= max) return min;
  return Math.min(max, Math.max(min, x));
}

/**
 * Baseline for a block `height` tall (above its baseline), moved inside a
 * viewport `height` tall whose top `top` px are covered (e.g. by a notch),
 * with `margin` to spare: text over a merchant near the top edge drops
 * down into view instead of being cut off.
 */
export function clampBaseline(y: number, blockHeight: number, viewportHeight: number, top = 0, margin = 2): number {
  const min = top + blockHeight + margin;
  const max = viewportHeight - margin;
  if (min >= max) return max;
  return Math.min(max, Math.max(min, y));
}

/** A screen area overhead text keeps out of (e.g. the minimap), in view CSS px. */
export interface ExclusionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Moves a block (centre `x`, baseline `y`, `halfWidth` either side, `height`
 * above the baseline, 2 px below it) out of `rect`: left of it or down below
 * it, whichever moves it less (left only when the block still fits right of
 * the view's covered `left` px). Returns the block unchanged when it does not
 * overlap. Writes into `out`.
 */
export function avoidRect(
  x: number,
  y: number,
  halfWidth: number,
  height: number,
  rect: ExclusionRect,
  out: { x: number; y: number },
  margin = 2,
  left = 0,
): { x: number; y: number } {
  out.x = x;
  out.y = y;
  const overlaps = x + halfWidth > rect.left && x - halfWidth < rect.right && y - height < rect.bottom && y + 2 > rect.top;
  if (!overlaps) return out;
  const leftX = rect.left - margin - halfWidth;
  const canGoLeft = leftX - halfWidth >= left + margin;
  const downY = rect.bottom + margin + height;
  if (canGoLeft && x - leftX <= downY - y) out.x = leftX;
  else out.y = downY;
  return out;
}

/**
 * How far (CSS px) an overhead anchor may be past a side edge and still be
 * drawn, moved into view: the actor's head has just left the screen but its
 * body is still partly on it, so its shout stays readable at the edge
 * instead of vanishing.
 */
export const OVERHEAD_SIDE_SLACK_PX = 16;

/** The view overhead text is fitted into, in CSS px. */
export interface OverheadView {
  width: number;
  height: number;
  /** Edges covered by a notch, status bar or rounded corners (the safe-area insets). */
  safeTop: number;
  safeLeft: number;
  safeRight: number;
  /** HUD area to keep out of (the minimap and its orbs), or null. */
  hud: ExclusionRect | null;
}

/** Where fitOverhead puts a block: centre x, baseline y, and the highest its top may be stacked to. */
export interface OverheadFit {
  x: number;
  y: number;
  minTop: number;
}

/**
 * Fits an overhead block (`halfWidth` either side, `height` above its
 * baseline, 2 px below it) anchored over an actor's head at (`x`, `y`) into
 * `view`: centred over the head where it fits, otherwise moved inside the
 * uncovered view at the sides and top (clampCentre, clampBaseline), then out
 * from under the HUD, left of it or down below it (avoidRect). `minTop` is
 * how high stacking may push it: below the HUD while the block is under it,
 * so a stacked shout gives way rather than climb under the minimap. Writes
 * into `out`; false when the anchor is more than OVERHEAD_SIDE_SLACK_PX past
 * a side edge (the actor is off screen: nothing to label).
 */
export function fitOverhead(x: number, y: number, halfWidth: number, height: number, view: OverheadView, out: OverheadFit, margin = 2): boolean {
  if (!(x >= -OVERHEAD_SIDE_SLACK_PX && x <= view.width + OVERHEAD_SIDE_SLACK_PX)) return false;
  out.x = clampCentre(x, halfWidth, view.width, margin, view.safeLeft, view.safeRight);
  out.y = clampBaseline(y, height, view.height, view.safeTop, margin);
  out.minTop = view.safeTop;
  const hud = view.hud;
  if (hud) {
    avoidRect(out.x, out.y, halfWidth, height, hud, out, margin, view.safeLeft);
    if (out.x + halfWidth > hud.left && out.x - halfWidth < hud.right) out.minTop = Math.max(out.minTop, hud.bottom);
  }
  return true;
}

/** Below this view width (phones), or in a portrait view, only a few merchant shouts show at once. */
export const NARROW_VIEW_PX = 768;
const PORTRAIT_ASPECT = 0.8;

/**
 * True for a view too narrow for more than a couple of full-length merchant
 * shouts side by side: a phone (either way up) or any portrait screen.
 */
export function isNarrowView(width: number, height: number): boolean {
  return width < NARROW_VIEW_PX || width / Math.max(1, height) < PORTRAIT_ASPECT;
}

/** Score bands: a priority line (a celebration) first, then shouts already showing, then the rest. */
const PRIORITY_BAND = -1e6;
const NEW_BAND = 1e6;

/**
 * Chooses which merchant shouts a narrow view shows when only a few fit.
 * A shout already showing keeps its place until it ends or leaves the view,
 * so nothing is swapped out mid-sentence; free places go to the shouts
 * nearest the view's centre, which are the least likely to be pushed
 * against an edge or under the minimap. Shouts are identified by their
 * bubble objects; nothing allocates per frame once the sets have grown.
 */
export class ShoutPicker {
  private showing = new Set<object>();
  private drawn = new Set<object>();
  private scores = new Float64Array(32);

  /**
   * Scores candidate `index` (the caller's index) for the shout `key`, `dx`
   * and `dy` px from the view's centre; `priority` lines go first.
   */
  score(index: number, key: object, dx: number, dy: number, priority = false): void {
    if (index >= this.scores.length) {
      const grown = new Float64Array(Math.max(index + 1, this.scores.length * 2));
      grown.set(this.scores);
      this.scores = grown;
    }
    const band = priority ? PRIORITY_BAND : this.showing.has(key) ? 0 : NEW_BAND;
    this.scores[index] = band + Math.hypot(dx, dy);
  }

  /** Sort comparator over scored indices: best first. */
  readonly compare = (a: number, b: number): number => this.scores[a]! - this.scores[b]!;

  /** Starts recording the shouts drawn this frame. */
  begin(): void {
    this.drawn.clear();
  }

  /** Records a shout drawn this frame. */
  mark(key: object): void {
    this.drawn.add(key);
  }

  /** The shouts drawn this frame become the ones showing. */
  end(): void {
    const previous = this.showing;
    this.showing = this.drawn;
    this.drawn = previous;
    this.drawn.clear();
  }

  /** Forgets what was showing (the view is wide again). */
  clear(): void {
    this.showing.clear();
    this.drawn.clear();
  }
}
