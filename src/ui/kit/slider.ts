/** Volume slider geometry. Pure: no DOM. */

/**
 * The notch (1 to `notches`) under a point `x` pixels into a track `width`
 * pixels wide. Points left of the track pick the first notch and points right
 * of it the last, so the track's enlarged touch area works at its ends.
 */
export function sliderLevelAt(x: number, width: number, notches = 4): number {
  if (!(width > 0)) return 1;
  return Math.max(1, Math.min(notches, Math.floor((x / width) * notches) + 1));
}
