import type { Tile } from "@shared/protocol";
import type { TileRect } from "./collision";
import { HeightMap } from "./heightMap";

/**
 * World metadata baked from the cache (shared/world-meta.json): where the
 * exported area sits, the floor height, the playable bounds, spawn tiles,
 * bankers, booths, the merchants' wander area and doors. The parser accepts
 * the bake's JSON and normalises it; facings become yaw angles in radians
 * (0 = facing south, the models' default, increasing towards east).
 */

export interface BankerMeta {
  npcId: number;
  tile: Tile;
  /** Facing yaw in radians, or null when the bake gave none (face the booth). */
  faceYaw: number | null;
  /**
   * True when this banker serves a booth (the cache gives it a Bank op). The
   * door guard behind the closed door serves none and is Examine-only.
   */
  serves: boolean;
}

export interface BoothMeta {
  locId: number;
  tile: Tile;
  faceYaw: number | null;
  /** Where a player stands to use the booth. */
  useTile: Tile;
}

export interface WorldMeta {
  /** World tile at the south-west corner of the exported scene (scene origin). */
  origin: Tile;
  /** Height of the bank floor in tiles. */
  floorHeight: number;
  bounds: TileRect;
  spawn: Tile[];
  bankers: BankerMeta[];
  booths: BoothMeta[];
  merchantArea: Tile[];
  /** Door and entrance tiles. */
  doors: Tile[];
  /** Floor heights (the street outside is lower than the bank floor); null means flat. */
  heights: HeightMap | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseTile(value: unknown): Tile | null {
  if (Array.isArray(value) && value.length >= 2) {
    const x = num(value[0]);
    const y = num(value[1]);
    return x !== null && y !== null ? { x: Math.round(x), y: Math.round(y) } : null;
  }
  if (isRecord(value)) {
    if ("tile" in value) return parseTile(value.tile);
    const x = num(value.x);
    const y = num(value.y);
    return x !== null && y !== null ? { x: Math.round(x), y: Math.round(y) } : null;
  }
  return null;
}

export function parseRect(value: unknown): TileRect | null {
  if (Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === "number")) {
    const [a, b, c, d] = value as number[];
    return normaliseRect(a!, b!, c!, d!);
  }
  if (!isRecord(value)) return null;
  const minX = num(value.minX) ?? num(value.x0);
  const minY = num(value.minY) ?? num(value.y0);
  const maxX = num(value.maxX) ?? num(value.x1);
  const maxY = num(value.maxY) ?? num(value.y1);
  if (minX !== null && minY !== null && maxX !== null && maxY !== null) return normaliseRect(minX, minY, maxX, maxY);
  const min = parseTile(value.min);
  const max = parseTile(value.max);
  if (min && max) return normaliseRect(min.x, min.y, max.x, max.y);
  const x = num(value.x);
  const y = num(value.y);
  const w = num(value.width) ?? num(value.w);
  const h = num(value.height) ?? num(value.h);
  if (x !== null && y !== null && w !== null && h !== null && w > 0 && h > 0) {
    return normaliseRect(x, y, x + w - 1, y + h - 1);
  }
  return null;
}

function normaliseRect(ax: number, ay: number, bx: number, by: number): TileRect {
  return {
    minX: Math.round(Math.min(ax, bx)),
    minY: Math.round(Math.min(ay, by)),
    maxX: Math.round(Math.max(ax, bx)),
    maxY: Math.round(Math.max(ay, by)),
  };
}

/** Yaw for a step of (dx, dy) in world tiles (y = north). */
export function yawForStep(dx: number, dy: number): number {
  return Math.atan2(dx, -dy);
}

const DIRECTIONS: Record<string, [number, number]> = {
  n: [0, 1],
  north: [0, 1],
  s: [0, -1],
  south: [0, -1],
  e: [1, 0],
  east: [1, 0],
  w: [-1, 0],
  west: [-1, 0],
  ne: [1, 1],
  northeast: [1, 1],
  nw: [-1, 1],
  northwest: [-1, 1],
  se: [1, -1],
  southeast: [1, -1],
  sw: [-1, -1],
  southwest: [-1, -1],
};

/**
 * Facing as yaw radians. Accepts compass names ("west", "W", "north-east"),
 * the client's 2048-unit orientation (0 south, 512 west, 1024 north, 1536
 * east), or a direction vector { dx, dy }. Small integers are ambiguous
 * between conventions, so they return null and callers face the obvious
 * neighbour (the booth, the use tile) instead.
 */
export function parseFacing(value: unknown): number | null {
  if (typeof value === "string") {
    const key = value.toLowerCase().replace(/[^a-z]/g, "");
    const dir = DIRECTIONS[key];
    return dir ? yawForStep(dir[0], dir[1]) : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && value >= 0 && value <= 7) return null;
    return (-(value % 2048) * Math.PI * 2) / 2048;
  }
  if (isRecord(value)) {
    const dx = num(value.dx) ?? num(value.x);
    const dy = num(value.dy) ?? num(value.y);
    if (dx !== null && dy !== null && (dx !== 0 || dy !== 0)) return yawForStep(dx, dy);
  }
  return null;
}

function tileList(value: unknown): Tile[] {
  if (!Array.isArray(value)) return [];
  const out: Tile[] = [];
  for (const entry of value) {
    const tile = parseTile(entry);
    if (tile) out.push(tile);
  }
  return out;
}

/** Door tiles from entries that are tiles or { tiles: [...] }. */
function doorTiles(value: unknown): Tile[] {
  if (!Array.isArray(value)) return [];
  const out: Tile[] = [];
  for (const entry of value) {
    if (isRecord(entry) && Array.isArray(entry.tiles)) out.push(...tileList(entry.tiles));
    else {
      const tile = parseTile(entry);
      if (tile) out.push(tile);
    }
  }
  return out;
}

/** Tiles from a list of tiles, a rectangle, a list of rectangles or { tiles }. */
function areaTiles(value: unknown): Tile[] {
  if (isRecord(value) && Array.isArray(value.tiles)) return areaTiles(value.tiles);
  const rect = parseRect(value);
  if (rect) return rectTiles(rect);
  if (!Array.isArray(value)) return [];
  const out: Tile[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    const asRect = parseRect(entry);
    const single = asRect ? null : parseTile(entry);
    const tiles = asRect ? rectTiles(asRect) : single ? [single] : [];
    for (const t of tiles) {
      const key = t.x * 65536 + t.y;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

function rectTiles(rect: TileRect): Tile[] {
  const out: Tile[] = [];
  for (let y = rect.minY; y <= rect.maxY; y++) for (let x = rect.minX; x <= rect.maxX; x++) out.push({ x, y });
  return out;
}

/** Validates and normalises the bake's world-meta JSON. Throws when a required field is missing. */
export function parseWorldMeta(raw: unknown): WorldMeta {
  if (!isRecord(raw)) throw new Error("World meta must be an object");
  const origin = parseTile(raw.origin);
  if (!origin) throw new Error("World meta is missing origin");
  const floorHeight = num(raw.floorHeight);
  if (floorHeight === null) throw new Error("World meta is missing floorHeight");
  const bounds = parseRect(raw.bounds);
  if (!bounds) throw new Error("World meta is missing bounds");

  const bankers: BankerMeta[] = [];
  if (Array.isArray(raw.bankers)) {
    for (const entry of raw.bankers) {
      if (!isRecord(entry)) continue;
      const npcId = num(entry.npcId) ?? num(entry.id);
      const tile = parseTile(entry.tile ?? entry);
      if (npcId === null || !tile) continue;
      // Older bakes had no boothIndex; treat every banker as serving then.
      const serves = "boothIndex" in entry ? num(entry.boothIndex) !== null : true;
      bankers.push({ npcId, tile, faceYaw: num(entry.faceYaw) ?? parseFacing(entry.faceDir ?? entry.face ?? entry.orientation), serves });
    }
  }

  const booths: BoothMeta[] = [];
  if (Array.isArray(raw.booths)) {
    for (const entry of raw.booths) {
      if (!isRecord(entry)) continue;
      const locId = num(entry.locId) ?? num(entry.id) ?? -1;
      const tile = parseTile(entry.tile ?? entry);
      if (!tile) continue;
      const useTile = parseTile(entry.useTile) ?? { x: tile.x - 1, y: tile.y };
      booths.push({ locId, tile, faceYaw: num(entry.faceYaw) ?? parseFacing(entry.faceDir ?? entry.face), useTile });
    }
  }

  return {
    origin,
    floorHeight,
    bounds,
    spawn: tileList(raw.spawn),
    bankers,
    booths,
    merchantArea: areaTiles(raw.merchantArea),
    doors: doorTiles(raw.doors),
    heights: HeightMap.from(raw.heightMap, floorHeight),
  };
}

/**
 * The bake's shared/collision.json, bundled at build time like the world
 * meta (and read by the server), so the client never pairs new meta with a
 * stale cached grid; null until the bake has written it.
 */
export function bundledCollision(): unknown {
  const modules = import.meta.glob("/shared/collision.json", { eager: true, import: "default" });
  const first = Object.values(modules)[0];
  return first ?? null;
}

/** The bake's shared/world-meta.json, bundled at build time; null until the bake has written it. */
export function bundledWorldMeta(): unknown {
  const modules = import.meta.glob("/shared/world-meta.json", { eager: true, import: "default" });
  const first = Object.values(modules)[0];
  return first ?? null;
}
