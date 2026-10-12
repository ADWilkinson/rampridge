import { describe, expect, it } from "vitest";
import { MAX_PATH_STEPS, type Tile } from "@shared/protocol";
import {
  TILE_BLOCKED,
  WALL_EAST,
  WALL_NORTH,
  WALL_SOUTH,
  WALL_WEST,
  checkPath,
  decodeCollisionGrid,
  type CollisionGrid,
} from "@shared/world";
import { BLOCKED, CollisionMap, Flag } from "./collision";
import { findPath, isValidPath, tileGoal } from "./pathfinding";
import fixture from "@shared/collision.json";

/** Open grid with helpers that set walls the way the client does (both sides). */
function grid(width: number, height: number) {
  const flags = new Int32Array(width * height);
  const map = new CollisionMap(0, 0, width, height, flags);
  const or = (x: number, y: number, bit: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    flags[y * width + x]! |= bit;
  };
  return {
    map,
    block(x: number, y: number) {
      or(x, y, Flag.LOC);
    },
    /** Wall on the east edge of (x, y). */
    wallEast(x: number, y: number) {
      or(x, y, Flag.WALL_EAST);
      or(x + 1, y, Flag.WALL_WEST);
    },
    /** Wall on the north edge of (x, y). */
    wallNorth(x: number, y: number) {
      or(x, y, Flag.WALL_NORTH);
      or(x, y + 1, Flag.WALL_SOUTH);
    },
    /** Corner pillar on the north-east corner of (x, y). */
    pillarNorthEast(x: number, y: number) {
      or(x, y, Flag.WALL_NORTH_EAST);
      or(x + 1, y + 1, Flag.WALL_SOUTH_WEST);
    },
  };
}

const t = (x: number, y: number): Tile => ({ x, y });

describe("findPath on open ground", () => {
  it("includes the start and walks straight", () => {
    const { map } = grid(10, 10);
    expect(findPath(map, t(1, 1), t(4, 1))).toEqual([t(1, 1), t(2, 1), t(3, 1), t(4, 1)]);
  });

  it("walks diagonally where it can", () => {
    const { map } = grid(10, 10);
    const path = findPath(map, t(1, 1), t(4, 4))!;
    expect(path).toEqual([t(1, 1), t(2, 2), t(3, 3), t(4, 4)]);
  });

  it("takes the fewest steps (Chebyshev distance)", () => {
    const { map } = grid(16, 16);
    const path = findPath(map, t(2, 3), t(9, 5))!;
    expect(path.length - 1).toBe(7);
    expect(isValidPath(map, path)).toBe(true);
  });

  it("returns just the start when already there", () => {
    const { map } = grid(4, 4);
    expect(findPath(map, t(2, 2), t(2, 2))).toEqual([t(2, 2)]);
  });

  it("is deterministic", () => {
    const { map } = grid(20, 20);
    expect(findPath(map, t(3, 2), t(15, 11))).toEqual(findPath(map, t(3, 2), t(15, 11)));
  });

  it("caps the path at MAX_PATH_STEPS tiles", () => {
    const { map } = grid(130, 3);
    const path = findPath(map, t(60, 1), t(127, 1))!;
    expect(path.length).toBe(MAX_PATH_STEPS);
    expect(path[0]).toEqual(t(60, 1));
  });

  it("does not search beyond the 128-tile window", () => {
    const { map } = grid(200, 3);
    expect(findPath(map, t(0, 1), t(150, 1))).toBeNull();
  });
});

describe("walls and blocked tiles", () => {
  it("routes around a wall edge", () => {
    const g = grid(8, 8);
    // A wall along the east edge of column 2 from y=0..4; open at y=5.
    for (let y = 0; y <= 4; y++) g.wallEast(2, y);
    const path = findPath(g.map, t(1, 1), t(4, 1))!;
    expect(path.at(-1)).toEqual(t(4, 1));
    expect(isValidPath(g.map, path)).toBe(true);
    expect(path.some((p) => p.y >= 5)).toBe(true);
    // Never crosses the wall at x 2|3 below y=5.
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      if (a.x === 2 && b.x === 3) expect(b.y).toBeGreaterThanOrEqual(5);
    }
  });

  it("does not stand on or pass through blocked tiles", () => {
    const g = grid(8, 8);
    for (let y = 0; y < 7; y++) g.block(3, y);
    const path = findPath(g.map, t(1, 2), t(5, 2))!;
    expect(path.every((p) => !(p.x === 3 && p.y < 7))).toBe(true);
    expect(path.at(-1)).toEqual(t(5, 2));
  });

  it("blocks a diagonal when an adjacent orthogonal tile is blocked", () => {
    const g = grid(6, 6);
    g.block(3, 2); // east of the start
    const path = findPath(g.map, t(2, 2), t(3, 3))!;
    // Cannot cut the corner: it must step north first, then east.
    expect(path).toEqual([t(2, 2), t(2, 3), t(3, 3)]);
  });

  it("blocks a diagonal across a wall on the walker's own tile", () => {
    const g = grid(6, 6);
    g.wallEast(2, 2);
    expect(g.map.canStep(2, 2, 1, 1)).toBe(false);
    const path = findPath(g.map, t(2, 2), t(3, 3))!;
    expect(path.length).toBe(3);
    expect(isValidPath(g.map, path)).toBe(true);
  });

  it("blocks a diagonal through a corner pillar", () => {
    const g = grid(6, 6);
    g.pillarNorthEast(2, 2);
    expect(g.map.canStep(2, 2, 1, 1)).toBe(false);
    expect(g.map.canStep(2, 2, 1, 0)).toBe(true);
    expect(g.map.canStep(2, 2, 0, 1)).toBe(true);
  });

  it("checks the entered tile's wall on the side it is entered from", () => {
    const g = grid(4, 4);
    g.wallNorth(1, 1);
    expect(g.map.canStep(1, 1, 0, 1)).toBe(false);
    expect(g.map.canStep(1, 2, 0, -1)).toBe(false);
    expect(g.map.canStep(1, 1, 1, 0)).toBe(true);
  });
});

describe("unreachable targets", () => {
  it("walks to the closest reachable tile when the target is walled in", () => {
    const g = grid(12, 12);
    // A closed room around (8, 8) .. (9, 9).
    for (let x = 8; x <= 9; x++) {
      g.wallNorth(x, 9);
      g.wallNorth(x, 7);
    }
    for (let y = 8; y <= 9; y++) {
      g.wallEast(9, y);
      g.wallEast(7, y);
    }
    const path = findPath(g.map, t(2, 8), t(8, 8))!;
    expect(path.at(-1)).toEqual(t(7, 8));
    expect(isValidPath(g.map, path)).toBe(true);
  });

  it("walks next to a blocked target tile", () => {
    const g = grid(8, 8);
    g.block(5, 5);
    const path = findPath(g.map, t(1, 5), t(5, 5))!;
    expect(path.at(-1)).toEqual(t(4, 5));
  });

  it("returns null when already on the closest tile", () => {
    const g = grid(8, 8);
    g.block(5, 5);
    expect(findPath(g.map, t(4, 5), t(5, 5))).toBeNull();
  });

  it("returns null without the fallback", () => {
    const g = grid(8, 8);
    g.block(5, 5);
    expect(findPath(g.map, t(1, 5), t(5, 5), { nearest: false })).toBeNull();
  });

  it("treats tiles outside the bounds as blocked", () => {
    const { map } = grid(10, 10);
    map.setBounds({ minX: 0, minY: 0, maxX: 5, maxY: 5 });
    const path = findPath(map, t(1, 1), t(8, 1))!;
    expect(path.at(-1)).toEqual(t(5, 1));
  });
});

describe("collision formats", () => {
  it("converts the compact shared/world.ts grid to mirrored client walls", () => {
    // 3x3: centre blocked, north wall on (0,0), east wall on (0,2).
    const flags = [WALL_NORTH, 0, 0, 0, TILE_BLOCKED, 0, WALL_EAST, 0, 0];
    const map = CollisionMap.from({ plane: 0, baseX: 10, baseY: 20, width: 3, height: 3, flags });
    expect(map.isWalkable(11, 21)).toBe(false);
    expect(map.canStep(10, 20, 0, 1)).toBe(false);
    expect(map.canStep(10, 21, 0, -1)).toBe(false);
    expect(map.canStep(10, 22, 1, 0)).toBe(false);
    expect(map.canStep(11, 22, -1, 0)).toBe(false);
    expect(map.canStep(12, 20, 0, 1)).toBe(true);
  });
});

/** Converts client flags to the server's compact grid so paths can be checked by shared/world.ts. */
function toCompact(map: CollisionMap): CollisionGrid {
  const flags = new Uint8Array(map.width * map.height);
  for (let i = 0; i < flags.length; i++) {
    const f = map.flags[i]!;
    let out = 0;
    if (f & BLOCKED) out |= TILE_BLOCKED;
    if (f & Flag.WALL_NORTH) out |= WALL_NORTH;
    if (f & Flag.WALL_EAST) out |= WALL_EAST;
    if (f & Flag.WALL_SOUTH) out |= WALL_SOUTH;
    if (f & Flag.WALL_WEST) out |= WALL_WEST;
    flags[i] = out;
  }
  return decodeCollisionGrid({
    plane: 0,
    baseX: map.originX,
    baseY: map.originY,
    width: map.width,
    height: map.height,
    flags: [...flags],
  });
}

describe("Varrock West Bank collision", () => {
  const map = CollisionMap.from(fixture);

  it("keeps players out of the booths and the bankers' side", () => {
    expect(map.isWalkable(3186, 3438)).toBe(false);
    expect(map.isWalkable(3187, 3440)).toBe(false);
    expect(map.isWalkable(3185, 3438)).toBe(true);
  });

  it("walks from the door to every booth front without crossing a booth", () => {
    const server = toCompact(map);
    for (const y of [3436, 3438, 3440, 3442, 3444]) {
      const path = findPath(map, t(3182, 3434), tileGoal(t(3185, y)))!;
      expect(path.at(-1)).toEqual(t(3185, y));
      expect(isValidPath(map, path)).toBe(true);
      expect(path.every((p) => p.x <= 3185)).toBe(true);
      expect(checkPath(server, path, [path[0]!])).toBeNull();
    }
  });

  it("produces paths the server accepts from anywhere inside", () => {
    const server = toCompact(map);
    const starts = [t(3181, 3434), t(3183, 3446), t(3185, 3444), t(3182, 3430)];
    const ends = [t(3184, 3439), t(3181, 3445), t(3185, 3436), t(3190, 3430)];
    for (const s of starts) {
      for (const e of ends) {
        const path = findPath(map, s, e);
        if (!path) continue;
        expect(isValidPath(map, path)).toBe(true);
        expect(checkPath(server, path, [s])).toBeNull();
      }
    }
  });

  it("walks to the nearest tile in front when a booth is clicked", () => {
    const path = findPath(map, t(3182, 3440), t(3186, 3440))!;
    expect(path.at(-1)).toEqual(t(3185, 3440));
  });
});
