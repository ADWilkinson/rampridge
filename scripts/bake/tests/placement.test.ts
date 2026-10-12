/**
 * Spawn and merchant placement rules (lib/placement.ts) on small synthetic
 * grids, so each rule is pinned down independently of the OSRS cache.
 */
import { describe, expect, it } from "vitest";

import { type CollisionGrid, FLAG, type Tile } from "../lib/grid";
import { boothQueueTiles, merchantTiles, spawnTiles } from "../lib/placement";

/** An open grid of `w` x `h` tiles at the origin with the given flags set. */
function grid(w: number, h: number, set: [number, number, number][] = []): CollisionGrid {
  const flags = Array.from({ length: w * h }, () => 0);
  for (const [x, y, f] of set) flags[y * w + x]! |= f;
  return { originX: 0, originY: 0, width: w, height: h, flags };
}

function tiles(g: CollisionGrid): Tile[] {
  const out: Tile[] = [];
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) out.push({ x, y });
  return out;
}

const keys = (ts: readonly Tile[]) => ts.map((t) => `${t.x},${t.y}`);

describe("spawnTiles", () => {
  // A 2-wide doorway at (3,0)-(4,0) in a façade along the south edge of row 0.
  const facade: [number, number, number][] = [0, 1, 2, 5, 6, 7].map((x) => [x, 0, FLAG.WALL_SOUTH]);
  const entrance = [
    { x: 3, y: 0 },
    { x: 4, y: 0 },
  ];

  it("takes the doorway row and the row behind it, one column either side", () => {
    const g = grid(8, 4);
    expect(keys(spawnTiles(g, tiles(g), entrance))).toEqual(["2,0", "3,0", "4,0", "5,0", "2,1", "3,1", "4,1", "5,1"]);
  });

  it("skips tiles right behind the façade wall, where the camera cannot see the player", () => {
    const g = grid(8, 4, facade);
    expect(keys(spawnTiles(g, tiles(g), entrance))).toEqual(["3,0", "4,0", "2,1", "3,1", "4,1", "5,1"]);
  });

  it("only uses walkable floor tiles it is given", () => {
    const g = grid(8, 4, [...facade, [2, 1, FLAG.OBJECT]]);
    const floor = tiles(g).filter((t) => !(t.x === 5 && t.y === 1));
    expect(keys(spawnTiles(g, floor, entrance))).toEqual(["3,0", "4,0", "3,1", "4,1"]);
  });
});

describe("merchantTiles", () => {
  const empty = { spawn: [], entrance: [], booths: [], doors: [] };

  it("keeps every open tile when nothing is reserved", () => {
    const g = grid(3, 3);
    expect(merchantTiles(g, { ...empty, floor: tiles(g) })).toHaveLength(9);
  });

  it("skips blocked tiles and tiles directly beside a solid object, but not diagonal ones", () => {
    const g = grid(5, 5, [[2, 2, FLAG.OBJECT]]);
    const area = keys(merchantTiles(g, { ...empty, floor: tiles(g) }));
    for (const k of ["2,2", "1,2", "3,2", "2,1", "2,3"]) expect(area).not.toContain(k);
    for (const k of ["1,1", "3,3", "1,3", "3,1", "0,2"]) expect(area).toContain(k);
    expect(area).toHaveLength(25 - 5);
  });

  it("lets merchants stand beside floor decorations (rugs, debris)", () => {
    const g = grid(3, 1, [[1, 0, FLAG.FLOOR_DECORATION]]);
    expect(keys(merchantTiles(g, { ...empty, floor: tiles(g) }))).toEqual(["0,0", "2,0"]);
  });

  it("keeps booth queues free: the use tile and the tile behind it", () => {
    const booths = [{ useTile: { x: 3, y: 2 }, faceDir: "west" as const }];
    expect(keys(boothQueueTiles(booths))).toEqual(["3,2", "2,2"]);
    const g = grid(4, 5);
    const area = keys(merchantTiles(g, { ...empty, floor: tiles(g), booths }));
    expect(area).not.toContain("3,2");
    expect(area).not.toContain("2,2");
    // the rest of the lane, beside the queue, stays open
    expect(area).toContain("3,3");
    expect(area).toContain("2,1");
  });

  it("stays off door tiles and their four neighbours", () => {
    const g = grid(5, 5);
    const doors = [{ tiles: [{ x: 2, y: 4 }], outside: [{ x: 2, y: 5 }] }];
    const area = keys(merchantTiles(g, { ...empty, floor: tiles(g), doors }));
    for (const k of ["2,4", "1,4", "3,4", "2,3"]) expect(area).not.toContain(k);
    expect(area).toContain("1,3");
  });

  it("keeps two clear tiles around the spawn and the entrance", () => {
    const g = grid(9, 9);
    const area = merchantTiles(g, { ...empty, floor: tiles(g), spawn: [{ x: 4, y: 1 }], entrance: [{ x: 4, y: 0 }] });
    for (const t of area) expect(Math.max(Math.abs(t.x - 4), t.y - 1)).toBeGreaterThan(2);
    expect(keys(area)).toContain("4,4");
    expect(keys(area)).toContain("1,0");
    expect(keys(area)).not.toContain("4,3");
    expect(keys(area)).not.toContain("2,3");
  });

  it("returns tiles row by row, west to east", () => {
    const g = grid(2, 2);
    const floor = [...tiles(g)].reverse();
    expect(keys(merchantTiles(g, { ...empty, floor }))).toEqual(["0,0", "1,0", "0,1", "1,1"]);
  });
});
