import { describe, expect, it } from "vitest";
import collisionJson from "@shared/collision.json";
import metaJson from "@shared/world-meta.json";
import { CollisionMap } from "./collision";
import { bundledCollision, bundledWorldMeta, parseFacing, parseWorldMeta } from "./worldMeta";

describe("world meta", () => {
  const meta = parseWorldMeta(metaJson);

  it("parses the baked Varrock West Bank", () => {
    expect(meta.origin).toEqual({ x: 3176, y: 3428 });
    expect(meta.floorHeight).toBeCloseTo(2.4375);
    expect(meta.bankers).toHaveLength(5);
    expect(meta.booths).toHaveLength(5);
    expect(meta.booths[1]!.useTile).toEqual({ x: 3185, y: 3438 });
    expect(meta.bankers[0]!.faceYaw).toBeCloseTo(-Math.PI / 2);
    expect(meta.merchantArea.length).toBeGreaterThan(4);
    expect(meta.doors.length).toBeGreaterThan(0);
    expect(meta.spawn.length).toBeGreaterThan(0);
  });

  it("bundles the collision grid from the same bake as the meta (the server's copy)", () => {
    expect(bundledWorldMeta()).toEqual(metaJson);
    expect(bundledCollision()).toEqual(collisionJson);
    const map = CollisionMap.from(bundledCollision());
    map.setBounds(meta.bounds);
    for (const t of meta.spawn) expect(map.isWalkable(t.x, t.y), `${t.x},${t.y}`).toBe(true);
  });

  it("samples a flat bank floor and a lower street", () => {
    expect(meta.heights).not.toBeNull();
    expect(meta.heights!.at(3183, 3440)).toBeCloseTo(meta.floorHeight);
    expect(meta.heights!.at(3183, 3430)).toBeLessThan(meta.floorHeight);
  });

  it("accepts compass names, client orientations and vectors as facings", () => {
    expect(parseFacing("west")).toBeCloseTo(-Math.PI / 2);
    expect(parseFacing("E")).toBeCloseTo(Math.PI / 2);
    expect(parseFacing("south")).toBeCloseTo(0);
    expect(parseFacing(512)).toBeCloseTo(-Math.PI / 2);
    expect(parseFacing({ dx: 1, dy: 0 })).toBeCloseTo(Math.PI / 2);
    expect(parseFacing(3)).toBeNull();
  });

  it("rejects metadata without the essentials", () => {
    expect(() => parseWorldMeta({})).toThrow();
    expect(() => parseWorldMeta({ origin: { x: 1, y: 1 }, floorHeight: 1 })).toThrow(/bounds/);
  });

  it("expands rectangles in the merchant area", () => {
    const m = parseWorldMeta({
      origin: [0, 0],
      floorHeight: 1,
      bounds: { x0: 0, y0: 0, x1: 9, y1: 9 },
      merchantArea: [{ minX: 1, minY: 1, maxX: 2, maxY: 2 }, { x: 5, y: 5 }],
      bankers: [],
      booths: [],
    });
    expect(m.merchantArea).toHaveLength(5);
    expect(m.bounds).toEqual({ minX: 0, minY: 0, maxX: 9, maxY: 9 });
  });
});
