import { afterEach, describe, expect, it } from "vitest";
import { DESIGNER_COLOR_COUNTS, DESIGNER_KIT_COUNTS } from "../src/game/osrs/catalog.generated";
import { encodePath, MAX_PATH_STEPS, TICK_MS } from "./protocol";
import type { Tile } from "./protocol";
import {
  APPEARANCE_LIMITS,
  ARRIVAL_AREA,
  canStep,
  checkPath,
  collisionGridFromOsrs,
  currentTiles,
  decodeCollisionGrid,
  FALLBACK_BOUNDS,
  FALLBACK_COLLISION_GRID,
  getCollisionGrid,
  isWalkable,
  loadCollisionGrid,
  parseOsrsCollisionRules,
  pickSpawnTile,
  reachableWithin,
  setCollisionGrid,
  SPAWN_TILE,
  TILE_BLOCKED,
  WALL_EAST,
  WALL_NORTH,
  worldRulesFromBake,
} from "./world";
import type { CollisionGrid } from "./world";

const grid = FALLBACK_COLLISION_GRID;

/** A 5x5 open grid at (100,100) with optional per-tile flags. */
function smallGrid(flags: Record<string, number> = {}): CollisionGrid {
  const width = 5;
  const height = 5;
  const data = new Uint8Array(width * height);
  for (const [key, value] of Object.entries(flags)) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    data[(y - 100) * width + (x - 100)] = value;
  }
  return { plane: 0, baseX: 100, baseY: 100, width, height, flags: data };
}

function line(from: Tile, steps: number, dx: number, dy: number): Tile[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + dx * i, y: from.y + dy * i }));
}

afterEach(() => setCollisionGrid(FALLBACK_COLLISION_GRID));

describe("fallback grid", () => {
  it("covers exactly the bank interior and doorway box", () => {
    const { minX, maxX, minY, maxY } = FALLBACK_BOUNDS;
    expect(isWalkable(grid, { x: minX, y: minY })).toBe(true);
    expect(isWalkable(grid, { x: maxX, y: maxY })).toBe(true);
    expect(isWalkable(grid, { x: minX - 1, y: minY })).toBe(false);
    expect(isWalkable(grid, { x: maxX + 1, y: maxY })).toBe(false);
    expect(isWalkable(grid, { x: minX, y: maxY + 1 })).toBe(false);
    expect(isWalkable(grid, { x: minX, y: minY - 1 })).toBe(false);
  });

  it("contains the spawn", () => {
    expect(isWalkable(grid, SPAWN_TILE)).toBe(true);
    const spawn = pickSpawnTile(grid, () => 0.999);
    expect(isWalkable(grid, spawn)).toBe(true);
    expect(Math.abs(spawn.x - SPAWN_TILE.x)).toBeLessThanOrEqual(2);
  });

  it("keeps SPAWN_TILE within a move's start tolerance of every arrival tile", () => {
    for (let y = ARRIVAL_AREA.minY; y <= ARRIVAL_AREA.maxY; y++) {
      for (let x = ARRIVAL_AREA.minX; x <= ARRIVAL_AREA.maxX; x++) {
        expect(checkPath(grid, [SPAWN_TILE], [{ x, y }]), `${x},${y}`).toBeNull();
      }
    }
  });

  it("is the active grid until a baked one is loaded", () => {
    expect(getCollisionGrid()).toBe(FALLBACK_COLLISION_GRID);
  });
});

describe("canStep", () => {
  it("allows 8-neighbour steps on open floor only", () => {
    const g = smallGrid();
    expect(canStep(g, { x: 102, y: 102 }, { x: 103, y: 103 })).toBe(true);
    expect(canStep(g, { x: 102, y: 102 }, { x: 102, y: 101 })).toBe(true);
    expect(canStep(g, { x: 102, y: 102 }, { x: 104, y: 102 })).toBe(false);
    expect(canStep(g, { x: 102, y: 102 }, { x: 102, y: 102 })).toBe(false);
    expect(canStep(g, { x: 104, y: 104 }, { x: 105, y: 104 })).toBe(false);
  });

  it("refuses blocked tiles and walls from either side", () => {
    const g = smallGrid({ "103,102": TILE_BLOCKED, "101,101": WALL_NORTH, "101,103": WALL_EAST });
    expect(canStep(g, { x: 102, y: 102 }, { x: 103, y: 102 })).toBe(false);
    expect(canStep(g, { x: 101, y: 101 }, { x: 101, y: 102 })).toBe(false);
    expect(canStep(g, { x: 101, y: 102 }, { x: 101, y: 101 })).toBe(false);
    expect(canStep(g, { x: 102, y: 103 }, { x: 101, y: 103 })).toBe(false);
    expect(canStep(g, { x: 101, y: 103 }, { x: 101, y: 104 })).toBe(true);
  });

  it("never cuts a corner diagonally", () => {
    const g = smallGrid({ "103,102": TILE_BLOCKED });
    expect(canStep(g, { x: 102, y: 102 }, { x: 103, y: 103 })).toBe(false);
    expect(canStep(g, { x: 102, y: 101 }, { x: 103, y: 101 })).toBe(true);
    const walled = smallGrid({ "102,102": WALL_EAST });
    expect(canStep(walled, { x: 102, y: 102 }, { x: 103, y: 103 })).toBe(false);
  });
});

describe("reachableWithin", () => {
  it("measures real walking distance around walls", () => {
    const g = smallGrid({ "102,101": TILE_BLOCKED, "102,102": TILE_BLOCKED, "102,103": TILE_BLOCKED });
    expect(reachableWithin(g, { x: 101, y: 102 }, { x: 103, y: 102 }, 2)).toBe(false);
    expect(reachableWithin(g, { x: 101, y: 102 }, { x: 103, y: 102 }, 6)).toBe(true);
    expect(reachableWithin(g, { x: 101, y: 102 }, { x: 101, y: 102 }, 0)).toBe(true);
  });
});

describe("checkPath", () => {
  const start = { x: 3185, y: 3438 };

  it("accepts a straight walk from where the player stands", () => {
    expect(checkPath(grid, line(start, 5, 1, 0), [start])).toBeNull();
    expect(checkPath(grid, [start], [start])).toBeNull();
  });

  it("accepts a start up to two steps from the server position", () => {
    expect(checkPath(grid, line({ x: 3187, y: 3438 }, 3, 0, 1), [start])).toBeNull();
    expect(checkPath(grid, line({ x: 3188, y: 3438 }, 3, 0, 1), [start])).toBe("too_far");
  });

  it("rejects gaps, repeats and teleports between steps", () => {
    expect(checkPath(grid, [start, { x: 3187, y: 3438 }], [start])).toBe("not_adjacent");
    expect(checkPath(grid, [start, start], [start])).toBe("not_adjacent");
  });

  it("rejects paths that leave the walkable area", () => {
    const toEdge = line({ x: FALLBACK_BOUNDS.maxX - 1, y: 3438 }, 2, 1, 0);
    expect(checkPath(grid, toEdge, [toEdge[0]!])).toBe("blocked");
  });

  it("enforces the length cap and non-empty paths", () => {
    expect(checkPath(grid, [], [start])).toBe("empty");
    const zigzag: Tile[] = [];
    for (let i = 0; i <= MAX_PATH_STEPS; i++) zigzag.push({ x: 3180 + (i % 2), y: 3431 + Math.floor(i / 4) });
    expect(zigzag.length).toBe(MAX_PATH_STEPS + 1);
    expect(checkPath(grid, zigzag, [zigzag[0]!])).toBe("too_long");
  });

  it("does not let a start tile hop through a wall", () => {
    const g = smallGrid({ "102,102": WALL_EAST, "102,101": WALL_EAST, "102,103": WALL_EAST });
    setCollisionGrid(g);
    expect(checkPath(g, [{ x: 103, y: 102 }], [{ x: 102, y: 102 }])).toBe("too_far");
    expect(checkPath(g, [{ x: 101, y: 102 }], [{ x: 102, y: 102 }])).toBeNull();
  });

  it("lets a player stranded on a now-blocked tile step off it", () => {
    const g = smallGrid({ "102,102": TILE_BLOCKED });
    expect(checkPath(g, [{ x: 103, y: 102 }, { x: 104, y: 102 }], [{ x: 102, y: 102 }])).toBeNull();
  });
});

describe("currentTiles", () => {
  const path = line({ x: 3180, y: 3435 }, 4, 1, 0);

  it("replays a walk on the 600 ms tick", () => {
    const record = { p: encodePath(path), t: 1_000, r: false };
    expect(currentTiles(record, 1_000)).toEqual([path[0], path[1]]);
    expect(currentTiles(record, 1_000 + TICK_MS * 2 + 10)).toEqual([path[2], path[3]]);
    expect(currentTiles(record, 1_000 + TICK_MS * 10)).toEqual([path[4]]);
  });

  it("runs two tiles per tick", () => {
    const record = { p: encodePath(path), t: 0, r: true };
    expect(currentTiles(record, TICK_MS * 2)).toEqual([path[4]]);
  });
});

describe("decodeCollisionGrid", () => {
  it("decodes array and base64 flags", () => {
    const fromArray = decodeCollisionGrid({ plane: 0, baseX: 1, baseY: 2, width: 2, height: 1, flags: [0, 1] });
    expect(isWalkable(fromArray, { x: 1, y: 2 })).toBe(true);
    expect(isWalkable(fromArray, { x: 2, y: 2 })).toBe(false);
    const fromBase64 = decodeCollisionGrid({ plane: 0, baseX: 1, baseY: 2, width: 2, height: 1, flags: btoa("\u0001\u0000") });
    expect(isWalkable(fromBase64, { x: 1, y: 2 })).toBe(false);
    expect(isWalkable(fromBase64, { x: 2, y: 2 })).toBe(true);
  });

  it("rejects a size mismatch", () => {
    expect(() => decodeCollisionGrid({ plane: 0, baseX: 0, baseY: 0, width: 3, height: 3, flags: [0] })).toThrow();
  });

  it("installs the loaded grid", () => {
    const loaded = loadCollisionGrid({ plane: 0, baseX: 0, baseY: 0, width: 1, height: 1, flags: [0] });
    expect(getCollisionGrid()).toBe(loaded);
  });
});

describe("grids in the original client's bits", () => {
  // The bake's masks: walls are flagged on both tiles that share an edge, and
  // diagonals also refuse corner posts.
  const N = 0x2, E = 0x8, S = 0x20, W = 0x80, NE = 0x4, SW = 0x40, OBJECT = 0x100;
  const blocked = OBJECT | 0x40000 | 0x100000 | 0x200000;
  const rules = parseOsrsCollisionRules({
    blocked,
    stepMasks: {
      west: { dest: blocked | E },
      east: { dest: blocked | W },
      south: { dest: blocked | N },
      north: { dest: blocked | S },
      southWest: { dest: blocked | E | NE | N, x: blocked | E, y: blocked | N },
      southEast: { dest: blocked | W | N | 0x1, x: blocked | W, y: blocked | N },
      northWest: { dest: blocked | S | 0x10 | E, x: blocked | E, y: blocked | S },
      northEast: { dest: blocked | W | SW | S, x: blocked | W, y: blocked | S },
    },
  });

  function osrsGrid(flags: Record<string, number>): CollisionGrid {
    const data = Array.from({ length: 25 }, () => 0);
    for (const [key, value] of Object.entries(flags)) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      data[(y - 100) * 5 + (x - 100)] = value;
    }
    return collisionGridFromOsrs({ originX: 100, originY: 100, width: 5, height: 5, flags: data }, rules);
  }

  it("uses the bake's blocked mask and wall bits", () => {
    const g = osrsGrid({ "102,102": OBJECT, "101,101": N, "101,102": S });
    expect(isWalkable(g, { x: 102, y: 102 })).toBe(false);
    expect(canStep(g, { x: 101, y: 102 }, { x: 102, y: 102 })).toBe(false);
    expect(canStep(g, { x: 101, y: 101 }, { x: 101, y: 102 })).toBe(false);
    expect(canStep(g, { x: 101, y: 102 }, { x: 101, y: 101 })).toBe(false);
    expect(canStep(g, { x: 100, y: 101 }, { x: 100, y: 102 })).toBe(true);
    expect(canStep(g, { x: 104, y: 104 }, { x: 105, y: 104 })).toBe(false);
  });

  it("refuses diagonals past a corner post or a blocked neighbour", () => {
    expect(canStep(osrsGrid({ "103,103": SW }), { x: 102, y: 102 }, { x: 103, y: 103 })).toBe(false);
    expect(canStep(osrsGrid({ "103,102": OBJECT }), { x: 102, y: 102 }, { x: 103, y: 103 })).toBe(false);
    expect(canStep(osrsGrid({}), { x: 102, y: 102 }, { x: 103, y: 103 })).toBe(true);
  });

  it("validates its inputs", () => {
    expect(() => parseOsrsCollisionRules({ blocked, stepMasks: { north: { dest: 1 } } })).toThrow();
    expect(() => collisionGridFromOsrs({ originX: 0, originY: 0, width: 2, height: 2, flags: [0] }, rules)).toThrow();
  });

  it("builds world rules from the bake's two files and spawns on a listed tile", () => {
    const world = worldRulesFromBake(
      { originX: 100, originY: 100, width: 5, height: 5, flags: Array.from({ length: 25 }, () => 0) },
      { collision: rules, spawn: [{ x: 101, y: 101 }, { x: 999, y: 999 }, "junk"] },
    );
    expect(world.spawn).toEqual([{ x: 101, y: 101 }, { x: 999, y: 999 }]);
    expect(pickSpawnTile(world.grid, () => 0.99, world.spawn)).toEqual({ x: 101, y: 101 });
    expect(() => worldRulesFromBake({}, { collision: rules })).toThrow();
  });

  describe("arrivals on a grid that covers the bank", () => {
    // x 3179-3186, y 3432-3439: the doorway rows, the arrival rows and the first merchant row.
    const origin = { x: 3179, y: 3432 };
    const size = 8;
    function bankGrid(blockedTiles: readonly Tile[] = []) {
      const flags = Array.from({ length: size * size }, () => 0);
      for (const t of blockedTiles) flags[(t.y - origin.y) * size + (t.x - origin.x)] = OBJECT;
      return { originX: origin.x, originY: origin.y, width: size, height: size, flags };
    }
    const door = [{ x: 3182, y: 3433 }, { x: 3183, y: 3433 }, { x: 3181, y: 3434 }, { x: 3184, y: 3434 }];

    it("spawns two to three tiles inside the door, off the merchant pitch and the booths' use tiles", () => {
      const world = worldRulesFromBake(bankGrid([{ x: 3182, y: 3436 }]), {
        collision: rules,
        spawn: door,
        merchantArea: [{ x: 3181, y: 3437 }, { minX: 3184, minY: 3436, maxX: 3184, maxY: 3437 }],
        booths: [{ tile: { x: 3186, y: 3436 }, useTile: { x: 3181, y: 3435 } }, { useTile: "junk" }],
      });
      expect(world.spawn).toEqual([
        { x: 3182, y: 3435 },
        { x: 3183, y: 3435 },
        { x: 3184, y: 3435 },
        { x: 3181, y: 3436 },
        { x: 3183, y: 3436 },
      ]);
      for (const tile of world.spawn) expect(tile.y - 3433).toBeGreaterThanOrEqual(2);
    });

    it("falls back to the bake's list when no arrival tile is walkable", () => {
      const blocked: Tile[] = [];
      for (let y = 3435; y <= 3436; y++) for (let x = 3181; x <= 3184; x++) blocked.push({ x, y });
      const world = worldRulesFromBake(bankGrid(blocked), { collision: rules, spawn: door });
      expect(world.spawn).toEqual(door);
    });

    it("picks an arrival tile when the rules list none", () => {
      const g = collisionGridFromOsrs(bankGrid(), rules);
      for (const r of [0, 0.3, 0.6, 0.999]) {
        const tile = pickSpawnTile(g, () => r, []);
        expect(tile.y === 3435 || tile.y === 3436).toBe(true);
        expect(tile.x).toBeGreaterThanOrEqual(3181);
        expect(tile.x).toBeLessThanOrEqual(3184);
      }
    });
  });
});

describe("APPEARANCE_LIMITS", () => {
  it("matches the character designer the bake generated", () => {
    // The server rejects any look outside these limits, so a re-bake that
    // changes the designer must update shared/world.ts too.
    expect(APPEARANCE_LIMITS.kits).toEqual(DESIGNER_KIT_COUNTS);
    expect(APPEARANCE_LIMITS.colors).toEqual(DESIGNER_COLOR_COUNTS);
  });
});
