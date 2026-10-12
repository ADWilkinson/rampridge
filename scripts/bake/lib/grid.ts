/**
 * Plane-0 collision grid primitives shared by the collision step and the
 * gameplay placement rules: the client's collision flag bits, its step masks
 * and a flood fill over legal steps. Pure (no cache or vendor imports) so the
 * placement rules can be unit-tested on synthetic grids.
 */

/** OSRS collision flag bits (client CollisionMap / RuneLite CollisionDataFlag). */
export const FLAG = {
  WALL_NORTH_WEST: 0x1,
  WALL_NORTH: 0x2,
  WALL_NORTH_EAST: 0x4,
  WALL_EAST: 0x8,
  WALL_SOUTH_EAST: 0x10,
  WALL_SOUTH: 0x20,
  WALL_SOUTH_WEST: 0x40,
  WALL_WEST: 0x80,
  OBJECT: 0x100,
  /** 0x200..0x10000: the same eight wall directions, for line of sight / projectiles. */
  LOS_WALLS: 0x1fe00,
  OBJECT_LOS: 0x20000,
  FLOOR_DECORATION: 0x40000,
  /** RampRidge: tile is outside the playable bounds (the client's BLOCK_PLAYERS bit). */
  OUT_OF_BOUNDS: 0x100000,
  FLOOR: 0x200000,
} as const;

/** A tile can be stood on iff (flags & BLOCKED) === 0. */
export const BLOCKED = FLAG.OBJECT | FLAG.FLOOR_DECORATION | FLAG.FLOOR | FLAG.OUT_OF_BOUNDS;

/**
 * Masks the client checks on the destination tile (and, for diagonals, the
 * two orthogonal neighbours) for a one-tile step. Same constants as the
 * OSRS client pathfinder with RampRidge's OUT_OF_BOUNDS bit added.
 */
export const STEP_MASKS = {
  west: { dest: BLOCKED | FLAG.WALL_EAST },
  east: { dest: BLOCKED | FLAG.WALL_WEST },
  south: { dest: BLOCKED | FLAG.WALL_NORTH },
  north: { dest: BLOCKED | FLAG.WALL_SOUTH },
  southWest: {
    dest: BLOCKED | FLAG.WALL_NORTH | FLAG.WALL_NORTH_EAST | FLAG.WALL_EAST,
    x: BLOCKED | FLAG.WALL_EAST,
    y: BLOCKED | FLAG.WALL_NORTH,
  },
  southEast: {
    dest: BLOCKED | FLAG.WALL_NORTH_WEST | FLAG.WALL_NORTH | FLAG.WALL_WEST,
    x: BLOCKED | FLAG.WALL_WEST,
    y: BLOCKED | FLAG.WALL_NORTH,
  },
  northWest: {
    dest: BLOCKED | FLAG.WALL_EAST | FLAG.WALL_SOUTH_EAST | FLAG.WALL_SOUTH,
    x: BLOCKED | FLAG.WALL_EAST,
    y: BLOCKED | FLAG.WALL_SOUTH,
  },
  northEast: {
    dest: BLOCKED | FLAG.WALL_SOUTH | FLAG.WALL_SOUTH_WEST | FLAG.WALL_WEST,
    x: BLOCKED | FLAG.WALL_WEST,
    y: BLOCKED | FLAG.WALL_SOUTH,
  },
} as const;

export type Dir = "north" | "east" | "south" | "west";
export const DIRS: Dir[] = ["west", "north", "east", "south"];
export const DELTA: Record<Dir, [number, number]> = {
  north: [0, 1],
  east: [1, 0],
  south: [0, -1],
  west: [-1, 0],
};

export interface Tile {
  x: number;
  y: number;
}

export interface CollisionGrid {
  originX: number;
  originY: number;
  width: number;
  height: number;
  flags: number[];
}

export const tileKey = (x: number, y: number): string => `${x},${y}`;

/** Flags of a tile; tiles outside the grid read as OUT_OF_BOUNDS. */
export function flagAt(grid: CollisionGrid, x: number, y: number): number {
  const lx = x - grid.originX;
  const ly = y - grid.originY;
  if (lx < 0 || ly < 0 || lx >= grid.width || ly >= grid.height) return FLAG.OUT_OF_BOUNDS;
  return grid.flags[ly * grid.width + lx]!;
}

/** True when a single orthogonal step from (x, y) in `dir` is legal. */
export function canStep(grid: CollisionGrid, x: number, y: number, dir: Dir): boolean {
  const [dx, dy] = DELTA[dir];
  return (flagAt(grid, x + dx, y + dy) & STEP_MASKS[dir].dest) === 0;
}

export function walkable(grid: CollisionGrid, x: number, y: number): boolean {
  return (flagAt(grid, x, y) & BLOCKED) === 0;
}

/** Breadth-first flood over legal orthogonal and diagonal steps. */
export function reachable(grid: CollisionGrid, start: Tile): Set<string> {
  const seen = new Set<string>([tileKey(start.x, start.y)]);
  const queue: Tile[] = [start];
  const diag = [
    ["southWest", -1, -1],
    ["southEast", 1, -1],
    ["northWest", -1, 1],
    ["northEast", 1, 1],
  ] as const;
  while (queue.length) {
    const t = queue.shift()!;
    const next: Tile[] = [];
    for (const d of DIRS) if (canStep(grid, t.x, t.y, d)) next.push({ x: t.x + DELTA[d][0], y: t.y + DELTA[d][1] });
    for (const [name, dx, dy] of diag) {
      const m = STEP_MASKS[name];
      if (
        (flagAt(grid, t.x + dx, t.y + dy) & m.dest) === 0 &&
        (flagAt(grid, t.x + dx, t.y) & m.x) === 0 &&
        (flagAt(grid, t.x, t.y + dy) & m.y) === 0
      ) {
        next.push({ x: t.x + dx, y: t.y + dy });
      }
    }
    for (const n of next) {
      const k = tileKey(n.x, n.y);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(n);
      }
    }
  }
  return seen;
}
