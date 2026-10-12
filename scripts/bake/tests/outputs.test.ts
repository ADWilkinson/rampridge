/**
 * Checks the bake's outputs (no OSRS cache needed), so the engine/UI
 * contracts hold: walkable and reachable gameplay tiles using the masks
 * world-meta.json documents (shared/, committed), and for the files in
 * public/game: identical collision copies, manifests that point at real
 * files, and a plane-0-only GLB. public/game is Jagex's art and is not
 * committed, so those checks skip until `bun run setup:assets` has baked it.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p));
const json = <T>(p: string) => JSON.parse(read(p).toString("utf8")) as T;
/** Whether this checkout has the baked public/game (it is not in git). */
const baked = fs.existsSync(path.join(ROOT, "public/game/world/collision.json"));

interface Tile {
  x: number;
  y: number;
}
interface Grid {
  originX: number;
  originY: number;
  width: number;
  height: number;
  flags: number[];
}
interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
interface Meta {
  origin: Tile;
  floorHeight: number;
  exported: Rect;
  bounds: Rect;
  interior: Rect;
  indoors: number[];
  heightMap: { originX: number; originY: number; width: number; height: number; values: number[] };
  spawn: Tile[];
  bankers: {
    npcId: number;
    tile: Tile;
    faceDir: string;
    faceYaw: number;
    actions: (string | null)[];
    boothIndex: number | null;
  }[];
  booths: { locId: number; tile: Tile; faceDir: string; faceYaw: number; useTile: Tile; bankerIndex: number | null }[];
  merchantArea: Tile[];
  doors: { kind: string; open: boolean; tiles: Tile[]; outside: Tile[] }[];
  collision: {
    flags: Record<string, number>;
    blocked: number;
    stepMasks: Record<string, { dest: number; x?: number; y?: number }>;
  };
}

const grid = json<Grid>("shared/collision.json");
const meta = json<Meta>("shared/world-meta.json");
const key = (t: Tile) => `${t.x},${t.y}`;
const flagAt = (x: number, y: number) => {
  const lx = x - grid.originX;
  const ly = y - grid.originY;
  if (lx < 0 || ly < 0 || lx >= grid.width || ly >= grid.height) return meta.collision.flags.OUT_OF_BOUNDS!;
  return grid.flags[ly * grid.width + lx]!;
};
const standable = (t: Tile) => (flagAt(t.x, t.y) & meta.collision.blocked) === 0;

/** Flood fill with the documented step masks (what the engine's pathfinder implements). */
function reach(start: Tile): Set<string> {
  const m = meta.collision.stepMasks;
  const dirs: [string, number, number][] = [
    ["west", -1, 0],
    ["east", 1, 0],
    ["south", 0, -1],
    ["north", 0, 1],
    ["southWest", -1, -1],
    ["southEast", 1, -1],
    ["northWest", -1, 1],
    ["northEast", 1, 1],
  ];
  const seen = new Set([key(start)]);
  const queue = [start];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [name, dx, dy] of dirs) {
      const mask = m[name]!;
      if (flagAt(t.x + dx, t.y + dy) & mask.dest) continue;
      if (mask.x !== undefined && flagAt(t.x + dx, t.y) & mask.x) continue;
      if (mask.y !== undefined && flagAt(t.x, t.y + dy) & mask.y) continue;
      const n = { x: t.x + dx, y: t.y + dy };
      if (!seen.has(key(n))) {
        seen.add(key(n));
        queue.push(n);
      }
    }
  }
  return seen;
}

describe("collision + world-meta", () => {
  it("has one flag per tile of the grid, from the world-meta origin", () => {
    expect(grid.flags).toHaveLength(grid.width * grid.height);
    expect({ x: grid.originX, y: grid.originY }).toEqual(meta.origin);
  });

  it.skipIf(!baked)("ships identical collision copies for the browser and the API", () => {
    expect(read("public/game/world/collision.json").equals(read("shared/collision.json"))).toBe(true);
  });

  it("marks exactly the tiles outside bounds as OUT_OF_BOUNDS", () => {
    for (let ly = 0; ly < grid.height; ly++) {
      for (let lx = 0; lx < grid.width; lx++) {
        const x = grid.originX + lx;
        const y = grid.originY + ly;
        const inside = x >= meta.bounds.minX && x <= meta.bounds.maxX && y >= meta.bounds.minY && y <= meta.bounds.maxY;
        expect((grid.flags[ly * grid.width + lx]! & meta.collision.flags.OUT_OF_BOUNDS!) === 0).toBe(inside);
      }
    }
  });

  it("lets a spawned player reach every booth but never the counter", () => {
    expect(meta.spawn.length).toBeGreaterThanOrEqual(4);
    const r = reach(meta.spawn[0]!);
    for (const s of meta.spawn) expect(r.has(key(s))).toBe(true);
    expect(meta.booths).toHaveLength(5);
    for (const b of meta.booths) {
      expect(standable(b.tile)).toBe(false);
      expect(r.has(key(b.useTile))).toBe(true);
      expect(Math.abs(b.useTile.x - b.tile.x) + Math.abs(b.useTile.y - b.tile.y)).toBe(1);
      expect(b.faceDir).toBe("west");
      expect(b.faceYaw).toBeCloseTo(-Math.PI / 2);
    }
    for (const b of meta.bankers) expect(r.has(key(b.tile))).toBe(false);
    expect(meta.booths.filter((b) => b.bankerIndex !== null)).toHaveLength(4);
  });

  it("gives a banker the Bank op exactly when it serves a booth", () => {
    meta.bankers.forEach((b, i) => {
      expect(b.actions).toHaveLength(5);
      if (b.boothIndex !== null) {
        const booth = meta.booths[b.boothIndex]!;
        expect(booth.bankerIndex).toBe(i);
        // the banker stands directly behind (east of) the booth it serves
        expect({ x: booth.tile.x + 1, y: booth.tile.y }).toEqual(b.tile);
      }
      expect(b.actions.includes("Bank")).toBe(b.boothIndex !== null);
    });
    meta.booths.forEach((booth, i) => {
      if (booth.bankerIndex !== null) expect(meta.bankers[booth.bankerIndex]!.boothIndex).toBe(i);
    });
    // Booth bankers carry the cache ops; the north banker behind the Knock-at door has none (Examine-only).
    for (const b of meta.bankers.filter((x) => x.npcId === 2897 || x.npcId === 2898)) {
      expect(b.actions).toEqual(["Talk-to", null, "Bank", "Collect", null]);
    }
    const guard = meta.bankers.find((b) => b.npcId === 8666)!;
    expect(guard.boothIndex).toBeNull();
    expect(guard.actions.every((a) => a === null)).toBe(true);
  });

  it("spawns new players where the default camera sees them, not behind the façade", () => {
    expect(meta.spawn.length).toBeGreaterThanOrEqual(4);
    const south = meta.doors.find((d) => d.kind === "entrance" && d.outside[0]!.y < d.tiles[0]!.y)!;
    for (const s of meta.spawn) {
      expect(standable(s)).toBe(true);
      expect(flagAt(s.x, s.y) & meta.collision.flags.WALL_SOUTH!, key(s)).toBe(0);
      expect(south.tiles.some((t) => Math.abs(t.x - s.x) <= 1 && s.y - t.y >= 0 && s.y - t.y <= 1)).toBe(true);
    }
  });

  it("spreads merchants over the hall, clear of queues, doors, the entrance and furniture", () => {
    const r = reach(meta.spawn[0]!);
    const south = meta.doors.find((d) => d.kind === "entrance" && d.outside[0]!.y < d.tiles[0]!.y)!;
    // A booth's queue: its use tile and the tile behind it (booths face west, so behind is one further west).
    const queue = new Set(meta.booths.flatMap((b) => [b.useTile, { x: b.useTile.x - 1, y: b.useTile.y }]).map(key));
    const doorTiles = meta.doors.flatMap((d) => [...d.tiles, ...d.outside]);
    const entry = [...meta.spawn, ...south.tiles];
    const object = meta.collision.flags.OBJECT!;
    expect(meta.merchantArea.length).toBeGreaterThanOrEqual(24);
    expect(new Set(meta.merchantArea.map((t) => t.x)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(meta.merchantArea.map(key)).size).toBe(meta.merchantArea.length);
    for (const t of meta.merchantArea) {
      expect(standable(t), key(t)).toBe(true);
      expect(r.has(key(t)), key(t)).toBe(true);
      expect(meta.indoors[(t.y - grid.originY) * grid.width + (t.x - grid.originX)]).toBe(1);
      expect(queue.has(key(t)), key(t)).toBe(false);
      expect(doorTiles.some((d) => Math.abs(d.x - t.x) + Math.abs(d.y - t.y) <= 1), key(t)).toBe(false);
      expect(entry.some((e) => Math.max(Math.abs(e.x - t.x), Math.abs(e.y - t.y)) <= 2), key(t)).toBe(false);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) expect(flagAt(t.x + dx, t.y + dy) & object, key(t)).toBe(0);
    }
  });

  it("opens the south entrance onto the street strip", () => {
    const south = meta.doors.find((d) => d.kind === "entrance" && d.outside[0]!.y < d.tiles[0]!.y);
    expect(south?.open).toBe(true);
    const r = reach(meta.spawn[0]!);
    for (const t of south!.outside) expect(r.has(key(t))).toBe(true);
    // the street strip is lower than the bank floor
    const hm = meta.heightMap;
    const h = (x: number, y: number) => hm.values[(y - hm.originY) * hm.width + (x - hm.originX)]!;
    expect(h(meta.spawn[0]!.x, meta.spawn[0]!.y)).toBe(meta.floorHeight);
    expect(h(south!.outside[0]!.x, meta.bounds.minY)).toBeLessThan(meta.floorHeight);
    expect(hm.values).toHaveLength(hm.width * hm.height);
    expect(meta.indoors).toHaveLength(grid.width * grid.height);
  });
});

/** PNG width/height from the IHDR chunk. */
function pngSize(p: string): { w: number; h: number } {
  const b = read(p);
  expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe.skipIf(!baked)("asset manifests", () => {
  it("sprite manifest entries match their PNGs", () => {
    const m = json<Record<string, { file: string; w: number; h: number; offsetX: number; offsetY: number }>>("public/game/sprites/manifest.json");
    const required = [
      "chatbox_background",
      "side_background",
      "tab_icon_inventory",
      "tab_icon_equipment",
      "tab_icon_emotes",
      "tab_icon_settings",
      "tab_icon_logout",
      "tab_icon_account",
      "tab_highlight_top_left",
      "close_button",
      "minimap_frame",
      "minimap_mask",
      "compass",
      "orb_frame",
      "orb_fill_run",
      "cross_yellow_1",
      "cross_red_4",
      "scrollbar_thumb_middle",
      "parchment_scroll",
      "item_coins_1",
      "item_coins_10000",
      "item_bank_note",
    ];
    for (const name of required) expect(m[name], name).toBeDefined();
    for (const [name, e] of Object.entries(m)) {
      const size = pngSize(`public/game/sprites/${e.file}`);
      expect(size, name).toEqual({ w: e.w, h: e.h });
    }
  });

  it("sound manifest covers the logical names with real WAVs", () => {
    const m = json<Record<string, string>>("public/game/sounds/manifest.json");
    for (const name of ["click", "offer", "collect", "coins", "levelup", "trade", "error", "open", "close"]) {
      const file = m[name];
      expect(file, name).toBeDefined();
      const b = read(`public/game/sounds/${file!}`);
      expect(b.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(b.readUInt16LE(22)).toBe(1); // mono
      expect(b.readUInt32LE(24)).toBe(22050);
    }
  });

  it("minimap metadata matches the image", () => {
    const m = json<{ image: string; pixelsPerTile: number; minX: number; maxX: number; minY: number; maxY: number; width: number; height: number; icons: { file: string }[] }>(
      "public/game/world/minimap.json",
    );
    expect(pngSize(`public/game/world/${m.image}`)).toEqual({ w: m.width, h: m.height });
    expect(m.width).toBe((m.maxX - m.minX + 1) * m.pixelsPerTile);
    expect(m.height).toBe((m.maxY - m.minY + 1) * m.pixelsPerTile);
    expect(m.icons.some((i) => i.file.endsWith("bank.png"))).toBe(true);
    for (const i of m.icons) pngSize(`public/game/world/${i.file}`);
  });

  it("world GLB ships plane0 only, with meshopt compression", () => {
    const b = read("public/game/world/varrock-west-bank.glb");
    expect(b.subarray(0, 4).toString("ascii")).toBe("glTF");
    const len = b.readUInt32LE(12);
    const doc = JSON.parse(b.subarray(20, 20 + len).toString("utf8")) as {
      nodes: { name?: string; mesh?: number }[];
      extensionsUsed: string[];
    };
    const names = doc.nodes.map((n) => n.name);
    expect(doc.nodes.find((n) => n.name === "plane0")?.mesh).toBeDefined();
    // The engine never shows the upper floors and roofs, so they are not exported.
    for (const p of ["plane1", "plane2", "plane3"]) expect(names).not.toContain(p);
    expect(doc.extensionsUsed).toEqual(expect.arrayContaining(["EXT_meshopt_compression", "KHR_mesh_quantization", "KHR_materials_unlit"]));
  });

  it("ui art exists at the documented sizes", () => {
    expect(pngSize("public/game/ui/favicon.png")).toEqual({ w: 32, h: 32 });
    expect(pngSize("public/game/ui/apple-touch-icon.png")).toEqual({ w: 180, h: 180 });
    expect(pngSize("public/game/ui/icon-192.png")).toEqual({ w: 192, h: 192 });
    expect(pngSize("public/game/ui/icon-512.png")).toEqual({ w: 512, h: 512 });
    expect(pngSize("public/game/ui/icon-maskable-512.png")).toEqual({ w: 512, h: 512 });
    expect(pngSize("public/og-coins.png")).toEqual({ w: 108, h: 96 });
    pngSize("public/game/ui/logo.png");
    pngSize("public/game/ui/privy-logo.png");
    expect(read("public/game/fonts/fonts.css").toString()).toMatch(/font-family: "RS Quill 8"/);
  });
});
