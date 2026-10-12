import type { Tile } from "@shared/protocol";
import {
  TILE_BLOCKED,
  WALL_EAST,
  WALL_NORTH,
  WALL_SOUTH,
  WALL_WEST,
  decodeCollisionGrid,
  type SerializedCollisionGrid,
} from "@shared/world";

/**
 * Collision flags exactly as the original client stores them per tile
 * (CollisionMap). Walls are flagged on both tiles that share the edge, so a
 * step only needs to inspect the tiles it enters.
 */
export const Flag = {
  WALL_NORTH_WEST: 0x1,
  WALL_NORTH: 0x2,
  WALL_NORTH_EAST: 0x4,
  WALL_EAST: 0x8,
  WALL_SOUTH_EAST: 0x10,
  WALL_SOUTH: 0x20,
  WALL_SOUTH_WEST: 0x40,
  WALL_WEST: 0x80,
  LOC: 0x100,
  FLOOR_DECORATION: 0x40000,
  /** The bake marks tiles outside the playable bounds with this bit. */
  OUT_OF_BOUNDS: 0x100000,
  FLOOR: 0x200000,
  /** Set on tiles outside the loaded map (the client's border value). */
  UNLOADED: 0x1000000,
} as const;

/** Everything that stops a tile from being entered at all. */
export const BLOCKED = Flag.LOC | Flag.FLOOR_DECORATION | Flag.OUT_OF_BOUNDS | Flag.FLOOR | Flag.UNLOADED;
const OUTSIDE = 0x1ffffff;

// Masks the client tests on the tile being entered, per direction of travel
// (the client's 0x1240108 family, plus the bake's out-of-bounds bit).
export const MASK_WEST = BLOCKED | Flag.WALL_EAST;
export const MASK_EAST = BLOCKED | Flag.WALL_WEST;
export const MASK_SOUTH = BLOCKED | Flag.WALL_NORTH;
export const MASK_NORTH = BLOCKED | Flag.WALL_SOUTH;
export const MASK_SOUTH_WEST = BLOCKED | Flag.WALL_EAST | Flag.WALL_NORTH_EAST | Flag.WALL_NORTH;
export const MASK_SOUTH_EAST = BLOCKED | Flag.WALL_WEST | Flag.WALL_NORTH | Flag.WALL_NORTH_WEST;
export const MASK_NORTH_WEST = BLOCKED | Flag.WALL_SOUTH | Flag.WALL_SOUTH_EAST | Flag.WALL_EAST;
export const MASK_NORTH_EAST = BLOCKED | Flag.WALL_WEST | Flag.WALL_SOUTH_WEST | Flag.WALL_SOUTH;

/** Inclusive tile rectangle. */
export interface TileRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The collision grid in the client's own bit layout (the asset bake's
 * `collision.json`): `flags[(y - originY) * width + (x - originX)]`.
 */
export interface OsrsCollisionData {
  originX: number;
  originY: number;
  width: number;
  height: number;
  flags: ArrayLike<number>;
}

/** Either the client-bit grid or the server's compact grid from shared/world.ts. */
export type CollisionSource = OsrsCollisionData | SerializedCollisionGrid;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Tile collision for plane 0. Tiles outside the grid, or outside the
 * optional walk bounds, behave like the client's unloaded border: blocked.
 */
export class CollisionMap {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  readonly flags: Int32Array;
  private bounds: TileRect | null = null;

  constructor(originX: number, originY: number, width: number, height: number, flags: Int32Array) {
    if (flags.length !== width * height) {
      throw new Error(`Collision grid has ${flags.length} tiles, expected ${width * height}`);
    }
    this.originX = originX;
    this.originY = originY;
    this.width = width;
    this.height = height;
    this.flags = flags;
  }

  /**
   * Accepts the client-bit layout ({ originX, originY, width, height, flags })
   * or the compact layout of shared/world.ts ({ baseX, baseY, ... }), whose
   * walls are converted to the client's mirrored edge flags.
   */
  static from(source: unknown): CollisionMap {
    if (!isRecord(source)) throw new Error("Collision data must be an object");
    if ("baseX" in source) {
      const grid = decodeCollisionGrid(source as unknown as SerializedCollisionGrid);
      return CollisionMap.fromCompact(grid.baseX, grid.baseY, grid.width, grid.height, grid.flags);
    }
    const { originX, originY, width, height, flags } = source as Partial<OsrsCollisionData>;
    for (const [key, value] of Object.entries({ originX, originY, width, height })) {
      if (!Number.isInteger(value)) throw new Error(`Collision ${key} must be an integer`);
    }
    if (!flags || typeof flags.length !== "number") throw new Error("Collision flags are missing");
    const w = width as number;
    const h = height as number;
    const out = new Int32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = Number(flags[i] ?? 0) | 0;
    return new CollisionMap(originX as number, originY as number, w, h, out);
  }

  private static fromCompact(
    baseX: number,
    baseY: number,
    width: number,
    height: number,
    compact: ArrayLike<number>,
  ): CollisionMap {
    const out = new Int32Array(width * height);
    const mark = (dx: number, dy: number, bit: number) => {
      if (dx < 0 || dy < 0 || dx >= width || dy >= height) return;
      out[dy * width + dx]! |= bit;
    };
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const f = compact[dy * width + dx] ?? 0;
        if (f & TILE_BLOCKED) mark(dx, dy, Flag.LOC);
        if (f & WALL_NORTH) {
          mark(dx, dy, Flag.WALL_NORTH);
          mark(dx, dy + 1, Flag.WALL_SOUTH);
        }
        if (f & WALL_EAST) {
          mark(dx, dy, Flag.WALL_EAST);
          mark(dx + 1, dy, Flag.WALL_WEST);
        }
        if (f & WALL_SOUTH) {
          mark(dx, dy, Flag.WALL_SOUTH);
          mark(dx, dy - 1, Flag.WALL_NORTH);
        }
        if (f & WALL_WEST) {
          mark(dx, dy, Flag.WALL_WEST);
          mark(dx - 1, dy, Flag.WALL_EAST);
        }
      }
    }
    return new CollisionMap(baseX, baseY, width, height, out);
  }

  /** Restricts walking to a rectangle (the world's playable bounds). */
  setBounds(bounds: TileRect | null): void {
    this.bounds = bounds;
  }

  getBounds(): TileRect {
    return (
      this.bounds ?? {
        minX: this.originX,
        minY: this.originY,
        maxX: this.originX + this.width - 1,
        maxY: this.originY + this.height - 1,
      }
    );
  }

  inBounds(x: number, y: number): boolean {
    const dx = x - this.originX;
    const dy = y - this.originY;
    if (dx < 0 || dy < 0 || dx >= this.width || dy >= this.height) return false;
    const b = this.bounds;
    return !b || (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY);
  }

  /** Raw flags; outside the grid or bounds every bit is set. */
  get(x: number, y: number): number {
    if (!this.inBounds(x, y)) return OUTSIDE;
    return this.flags[(y - this.originY) * this.width + (x - this.originX)]!;
  }

  /** Whether a tile can be stood on. */
  isWalkable(x: number, y: number): boolean {
    return (this.get(x, y) & BLOCKED) === 0;
  }

  /**
   * Whether one 8-direction step from (x, y) by (dx, dy) is legal under the
   * client's rules: the entered tile must be open on the side we come from,
   * and a diagonal also needs both orthogonal neighbours to be enterable.
   */
  canStep(x: number, y: number, dx: number, dy: number): boolean {
    if (dx === -1 && dy === 0) return (this.get(x - 1, y) & MASK_WEST) === 0;
    if (dx === 1 && dy === 0) return (this.get(x + 1, y) & MASK_EAST) === 0;
    if (dx === 0 && dy === -1) return (this.get(x, y - 1) & MASK_SOUTH) === 0;
    if (dx === 0 && dy === 1) return (this.get(x, y + 1) & MASK_NORTH) === 0;
    if (dx === -1 && dy === -1) {
      return (
        (this.get(x - 1, y - 1) & MASK_SOUTH_WEST) === 0 &&
        (this.get(x - 1, y) & MASK_WEST) === 0 &&
        (this.get(x, y - 1) & MASK_SOUTH) === 0
      );
    }
    if (dx === 1 && dy === -1) {
      return (
        (this.get(x + 1, y - 1) & MASK_SOUTH_EAST) === 0 &&
        (this.get(x + 1, y) & MASK_EAST) === 0 &&
        (this.get(x, y - 1) & MASK_SOUTH) === 0
      );
    }
    if (dx === -1 && dy === 1) {
      return (
        (this.get(x - 1, y + 1) & MASK_NORTH_WEST) === 0 &&
        (this.get(x - 1, y) & MASK_WEST) === 0 &&
        (this.get(x, y + 1) & MASK_NORTH) === 0
      );
    }
    if (dx === 1 && dy === 1) {
      return (
        (this.get(x + 1, y + 1) & MASK_NORTH_EAST) === 0 &&
        (this.get(x + 1, y) & MASK_EAST) === 0 &&
        (this.get(x, y + 1) & MASK_NORTH) === 0
      );
    }
    return false;
  }

  /**
   * Whether an orthogonally adjacent pair of tiles shares an edge without a
   * wall (the tiles themselves may be occupied). Used for "can interact
   * from here" checks, like the client's rectangle reach test.
   */
  edgeOpen(x: number, y: number, dx: number, dy: number): boolean {
    const here = this.get(x, y);
    if (dx === -1 && dy === 0) return (here & Flag.WALL_WEST) === 0 && (this.get(x - 1, y) & Flag.WALL_EAST) === 0;
    if (dx === 1 && dy === 0) return (here & Flag.WALL_EAST) === 0 && (this.get(x + 1, y) & Flag.WALL_WEST) === 0;
    if (dx === 0 && dy === -1) return (here & Flag.WALL_SOUTH) === 0 && (this.get(x, y - 1) & Flag.WALL_NORTH) === 0;
    if (dx === 0 && dy === 1) return (here & Flag.WALL_NORTH) === 0 && (this.get(x, y + 1) & Flag.WALL_SOUTH) === 0;
    return false;
  }

  /** Nearest walkable tile to `tile` by ring search, or null if none within `radius`. */
  nearestWalkable(tile: Tile, radius = 8): Tile | null {
    if (this.isWalkable(tile.x, tile.y)) return { x: tile.x, y: tile.y };
    for (let r = 1; r <= radius; r++) {
      let best: Tile | null = null;
      let bestD = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = tile.x + dx;
          const y = tile.y + dy;
          if (!this.isWalkable(x, y)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }
}
