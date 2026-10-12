import { describe, expect, it } from "vitest";
import meta from "../../shared/world-meta.json" with { type: "json" };
import { canStep, checkPath, FALLBACK_WORLD_RULES, isWalkable, reachableWithin } from "../../shared/world";
import { bakedWorldRules } from "./worldRules";

// Runs against the real bake output, so a bake that breaks the bank fails here.
describe("baked world rules", () => {
  const rules = bakedWorldRules();

  it("loads the bake rather than the fallback", () => {
    expect(rules).not.toBe(FALLBACK_WORLD_RULES);
    expect(rules.grid.osrs).toBeDefined();
    expect(rules.spawn.length).toBeGreaterThan(0);
  });

  it("spawns players on walkable tiles", () => {
    for (const tile of rules.spawn) expect(isWalkable(rules.grid, tile)).toBe(true);
  });

  it("spawns arrivals inside the hall, never on the door tiles, the merchant pitch or a booth's use tile", () => {
    const key = (t: { x: number; y: number }) => `${t.x},${t.y}`;
    const door = new Set([...meta.spawn, ...meta.doors.flatMap((d) => d.tiles)].map(key));
    const merchants = new Set(meta.merchantArea.map(key));
    const useTiles = new Set(meta.booths.map((b) => key(b.useTile)));
    const entrance = meta.doors.find((d) => d.name === "Bank entrance")!;
    expect(rules.spawn.length).toBeGreaterThanOrEqual(4);
    for (const tile of rules.spawn) {
      expect(door.has(key(tile)), key(tile)).toBe(false);
      expect(merchants.has(key(tile)), key(tile)).toBe(false);
      expect(useTiles.has(key(tile)), key(tile)).toBe(false);
      // Two to three tiles in from the entrance, and a short walk back out of it.
      expect(tile.y - entrance.tiles[0]!.y).toBeGreaterThanOrEqual(2);
      expect(tile.y - entrance.tiles[0]!.y).toBeLessThanOrEqual(3);
      expect(entrance.tiles.some((d) => reachableWithin(rules.grid, tile, d, 4)), key(tile)).toBe(true);
    }
  });

  it("connects every spawn tile to the others", () => {
    for (const a of rules.spawn) {
      for (const b of rules.spawn) expect(reachableWithin(rules.grid, a, b, 8)).toBe(true);
    }
  });

  it("accepts a one-step move between open neighbours", () => {
    const open = rules.spawn.find((t) => rules.spawn.some((u) => u.y === t.y && u.x === t.x + 1 && canStep(rules.grid, t, u)));
    expect(open).toBeDefined();
    const next = { x: open!.x + 1, y: open!.y };
    expect(checkPath(rules.grid, [open!, next], [open!])).toBeNull();
  });

  it("is closed at its edges", () => {
    const { baseX, baseY } = rules.grid;
    expect(isWalkable(rules.grid, { x: baseX - 1, y: baseY })).toBe(false);
    expect(canStep(rules.grid, { x: baseX, y: baseY }, { x: baseX - 1, y: baseY })).toBe(false);
  });
});
