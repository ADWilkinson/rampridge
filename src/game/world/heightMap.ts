/**
 * Floor heights from the bake: tile-corner heights in tiles, row-major from
 * (originX, originY), `width` corners per row. Sampled bilinearly like the
 * client's getTileHeight, so actors follow the street slope outside while
 * the bank floor stays flat.
 */
export class HeightMap {
  constructor(
    readonly originX: number,
    readonly originY: number,
    readonly width: number,
    readonly height: number,
    readonly values: Float32Array,
    readonly fallback: number,
  ) {}

  static from(raw: unknown, fallback: number): HeightMap | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const { originX, originY, width, height, values } = r;
    if (
      typeof originX !== "number" ||
      typeof originY !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Array.isArray(values) ||
      values.length !== width * height
    ) {
      return null;
    }
    return new HeightMap(originX, originY, width, height, Float32Array.from(values as number[]), fallback);
  }

  /**
   * Height at fractional tile coordinates where an integer is a tile's centre
   * (the coordinates motion sampling produces).
   */
  at(tileX: number, tileY: number): number {
    const cx = tileX + 0.5 - this.originX;
    const cy = tileY + 0.5 - this.originY;
    if (cx < 0 || cy < 0 || cx > this.width - 1 || cy > this.height - 1) return this.fallback;
    const x0 = Math.min(this.width - 2, Math.floor(cx));
    const y0 = Math.min(this.height - 2, Math.floor(cy));
    const fx = cx - x0;
    const fy = cy - y0;
    const v = this.values;
    const w = this.width;
    const a = v[y0 * w + x0]!;
    const b = v[y0 * w + x0 + 1]!;
    const c = v[(y0 + 1) * w + x0]!;
    const d = v[(y0 + 1) * w + x0 + 1]!;
    const south = a + (b - a) * fx;
    const north = c + (d - c) * fx;
    return south + (north - south) * fy;
  }
}
