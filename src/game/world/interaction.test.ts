import { describe, expect, it } from "vitest";
import type { Tile } from "@shared/protocol";
import { CollisionMap, Flag } from "./collision";
import { adjacentGoal, adjacentTiles, bankerGoal, bankerUseTile, boothGoal, yawTowards } from "./interaction";
import { findPath } from "./pathfinding";
import { parseWorldMeta } from "./worldMeta";
import collision from "@shared/collision.json";
import metaJson from "@shared/world-meta.json";

const t = (x: number, y: number): Tile => ({ x, y });
const map = CollisionMap.from(collision);
const meta = parseWorldMeta(metaJson);

describe("booths", () => {
  it("are used from their front tile", () => {
    for (const booth of meta.booths) {
      const path = findPath(map, t(3182, 3435), boothGoal(booth))!;
      expect(path.at(-1)).toEqual(booth.useTile);
    }
  });
});

describe("bankers", () => {
  it("are spoken to across their booth", () => {
    for (const banker of meta.bankers.slice(0, 4)) {
      const use = bankerUseTile(map, banker, meta.booths);
      const booth = meta.booths.find((b) => b.tile.y === banker.tile.y)!;
      expect(use).toEqual(booth.useTile);
    }
  });

  it("without a booth in front, use the first open tile across the counter", () => {
    const banker = meta.bankers.find((b) => b.npcId === 8666)!;
    expect(bankerUseTile(map, banker, meta.booths)).toEqual(t(3185, 3446));
  });

  it("face the booth when the bake gives no facing", () => {
    const banker = { npcId: 2897, tile: t(3187, 3440), faceYaw: null, serves: true };
    expect(bankerUseTile(map, banker, meta.booths)).toEqual(t(3185, 3440));
  });

  it("paths end on the banker's use tile", () => {
    const banker = meta.bankers[1]!;
    const goal = bankerGoal(map, banker, meta.booths)!;
    const path = findPath(map, t(3181, 3446), goal)!;
    expect(path.at(-1)).toEqual(t(3185, 3440));
  });
});

describe("people", () => {
  it("are approached orthogonally, never diagonally", () => {
    const open = new CollisionMap(0, 0, 10, 10, new Int32Array(100));
    const path = findPath(open, t(1, 1), adjacentGoal(open, t(5, 5)))!;
    const end = path.at(-1)!;
    expect(Math.abs(end.x - 5) + Math.abs(end.y - 5)).toBe(1);
  });

  it("are not approached across a wall", () => {
    const flags = new Int32Array(100);
    const open = new CollisionMap(0, 0, 10, 10, flags);
    // Wall between (5, 5) and (4, 5).
    flags[5 * 10 + 5]! |= Flag.WALL_WEST;
    flags[5 * 10 + 4]! |= Flag.WALL_EAST;
    const tiles = adjacentTiles(open, t(5, 5));
    expect(tiles).not.toContainEqual(t(4, 5));
    const path = findPath(open, t(1, 5), adjacentGoal(open, t(5, 5)))!;
    expect(path.at(-1)).not.toEqual(t(4, 5));
  });

  it("step off when standing on the same tile", () => {
    const open = new CollisionMap(0, 0, 10, 10, new Int32Array(100));
    const path = findPath(open, t(5, 5), adjacentGoal(open, t(5, 5)))!;
    expect(path.length).toBe(2);
  });

  it("standing in a booth lane, a merchant across the rope is reached around it", () => {
    // (3184, 3438) and (3184, 3437) are separated by a rope barrier.
    const path = findPath(map, t(3184, 3438), adjacentGoal(map, t(3184, 3437)))!;
    const end = path.at(-1)!;
    expect(end).not.toEqual(t(3184, 3438));
    expect(Math.abs(end.x - 3184) + Math.abs(end.y - 3437)).toBe(1);
  });
});

describe("yawTowards", () => {
  it("uses 0 for south and +pi/2 for east", () => {
    expect(yawTowards(t(0, 1), t(0, 0))).toBeCloseTo(0);
    expect(yawTowards(t(0, 0), t(1, 0))).toBeCloseTo(Math.PI / 2);
    expect(yawTowards(t(1, 0), t(0, 0))).toBeCloseTo(-Math.PI / 2);
    expect(Math.abs(yawTowards(t(0, 0), t(0, 1))!)).toBeCloseTo(Math.PI);
    expect(yawTowards(t(0, 0), t(0, 0))).toBeNull();
  });
});
