/**
 * Plane-0 collision flags for the bank area plus the gameplay metadata the
 * engine and API need (spawn, bankers, booths, merchant roaming tiles,
 * doors, walkable bounds, floor heights). Everything is derived from the
 * decoded locs and the client's own collision logic (vendored rs-map-viewer
 * SceneBuilder + CollisionMap), then cross-checked with assertions.
 *
 * Writes public/game/world/collision.json, shared/collision.json (identical)
 * and shared/world-meta.json.
 */
import fs from "node:fs";
import path from "node:path";

import { LocModelType } from "../vendor/rs-map-viewer/src/rs/config/loctype/LocModelType";
import type { BakeCache } from "../lib/cache";
import {
  BLOCKED,
  type CollisionGrid,
  DELTA,
  DIRS,
  type Dir,
  FLAG,
  STEP_MASKS,
  type Tile,
  canStep,
  flagAt,
  reachable,
  walkable,
} from "../lib/grid";
import { type RawLoc, decodeLocsInRect } from "../lib/locs";
import { BAKE_DIR, SHARED_DIR, WORLD_DIR, rel, writeIfChanged, writeJson } from "../lib/paths";
import { ENTRY_CLEARANCE, merchantTiles, spawnTiles } from "../lib/placement";
import {
  CORE,
  ORIGIN,
  type Rect,
  TILE,
  buildAreaScene,
  inRect,
  rectHeight,
  rectWidth,
} from "../lib/region";

/** The merchant area must stay spread over the hall, not shrink to a strip (asserted below). */
const MIN_MERCHANT_TILES = 24;
const MIN_MERCHANT_COLUMNS = 3;

/**
 * NPC spawn positions are not in the OSRS cache (they are server-side); these
 * come from the community spawn dump and are validated below against the
 * decoded booths (each banker stands on the walkable tile east of a booth or
 * door, facing west).
 */
const BANKER_SPAWNS = [
  { npcId: 2898, x: 3187, y: 3438 },
  { npcId: 2897, x: 3187, y: 3440 },
  { npcId: 2898, x: 3187, y: 3442 },
  { npcId: 2897, x: 3187, y: 3444 },
  { npcId: 8666, x: 3187, y: 3446 },
];

/** rotation.y (radians) that turns a south-facing model to face `dir`. */
const YAW: Record<Dir, number> = {
  south: 0,
  west: -Math.PI / 2,
  north: Math.PI,
  east: Math.PI / 2,
};

export interface WorldMeta {
  $comment: string[];
  cache: { name: string; revision: number; timestamp: string };
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
    name: string;
    tile: Tile;
    faceDir: Dir;
    faceYaw: number;
    /** The NPC type's five cache menu ops in slot order, null = empty slot. The client always appends Examine. */
    actions: (string | null)[];
    /** Index into `booths` of the booth this banker serves (the inverse of booths[].bankerIndex), or null. */
    boothIndex: number | null;
  }[];
  booths: {
    locId: number;
    name: string;
    tile: Tile;
    faceDir: Dir;
    faceYaw: number;
    useTile: Tile;
    bankerIndex: number | null;
  }[];
  merchantArea: Tile[];
  doors: {
    locIds: number[];
    name: string;
    kind: "entrance" | "door";
    open: boolean;
    /** Tiles on each side of the opening (inside first). */
    tiles: Tile[];
    outside: Tile[];
    edge: Dir;
  }[];
  landmarks: { locId: number; name: string; tile: Tile; size: [number, number] }[];
  collision: {
    flags: Record<string, number>;
    blocked: number;
    stepMasks: typeof STEP_MASKS;
  };
}

/**
 * ASCII view of the grid, north at the top. Each tile is two characters:
 * "##" object/floor blocked, "~~" outside play bounds, "  " walkable; "|"
 * and "--" draw walls between tiles. Markers override the tile body.
 */
export function asciiGrid(grid: CollisionGrid, markers: Map<string, string> = new Map()): string {
  const lines: string[] = [];
  const header = "      " + Array.from({ length: grid.width }, (_, i) => String((grid.originX + i) % 100).padStart(2, "0") + " ").join("");
  lines.push(header);
  for (let ly = grid.height - 1; ly >= 0; ly--) {
    const y = grid.originY + ly;
    // wall line above the row (north edges)
    let top = "      ";
    let row = `${y} `.padStart(6, " ");
    for (let lx = 0; lx < grid.width; lx++) {
      const x = grid.originX + lx;
      const f = flagAt(grid, x, y);
      top += (f & FLAG.WALL_NORTH ? "--" : "  ") + (f & (FLAG.WALL_NORTH_EAST) ? "/" : " ");
      const m = markers.get(`${x},${y}`);
      let body = "  ";
      if (m) body = m.padEnd(2, m);
      else if (f & (FLAG.OBJECT | FLAG.FLOOR | FLAG.FLOOR_DECORATION)) body = "##";
      else if (f & FLAG.OUT_OF_BOUNDS) body = "~~";
      row += body + (f & FLAG.WALL_EAST ? "|" : " ");
    }
    lines.push(top.trimEnd());
    lines.push(row.trimEnd());
  }
  return lines.join("\n");
}

function tileHeightAt(heights: Int32Array[], sx: number, sy: number): number {
  return heights[sx]![sy]!;
}

/** Map tile setting bit: the client hides upper planes while the local player stands here. */
const RENDER_FLAG_INDOORS = 0x4;

/** Rows of street in front of the south entrance that players may walk on. */
const STREET_DEPTH = 4;

export async function bakeCollision(cache: BakeCache): Promise<{ grid: CollisionGrid; meta: WorldMeta; ascii: string }> {
  const { scene, baseX, baseY } = buildAreaScene(cache, CORE, false);
  const locTypes = cache.factory.getLocTypeLoader();
  const cmap = scene.collisionMaps[0]!;
  const width = rectWidth(CORE);
  const height = rectHeight(CORE);
  const key = (x: number, y: number) => `${x},${y}`;

  // ---- raw collision (client logic, plane 0) ------------------------------
  const raw: CollisionGrid = { originX: CORE.minX, originY: CORE.minY, width, height, flags: [] };
  const indoors: number[] = [];
  for (let ly = 0; ly < height; ly++) {
    for (let lx = 0; lx < width; lx++) {
      raw.flags.push(cmap.getFlag(CORE.minX + lx - baseX, CORE.minY + ly - baseY));
      indoors.push(scene.tileRenderFlags[0]![CORE.minX + lx - baseX]![CORE.minY + ly - baseY]! & RENDER_FLAG_INDOORS ? 1 : 0);
    }
  }

  // ---- decoded locs -------------------------------------------------------
  const locs = decodeLocsInRect(cache, CORE.minX, CORE.minY, CORE.maxX, CORE.maxY).filter((l) => l.level === 0);
  const nameOf = (l: RawLoc): string => {
    const t = locTypes.load(l.id);
    if (t.name && t.name !== "null") return t.name;
    for (const id of t.transforms ?? []) {
      if (id === -1) continue;
      const tt = locTypes.load(id);
      if (tt.name && tt.name !== "null") return tt.name;
    }
    return "null";
  };
  const resolvedId = (l: RawLoc): number => {
    const t = locTypes.load(l.id);
    if (!t.transforms) return l.id;
    const v = t.transform(cache.varManager, locTypes);
    return v ? v.id : l.id;
  };

  // ---- interior: the indoors tiles (one connected building in CORE) --------
  const indoorTiles: Tile[] = [];
  for (let ly = 0; ly < height; ly++) for (let lx = 0; lx < width; lx++) if (indoors[ly * width + lx]) indoorTiles.push({ x: CORE.minX + lx, y: CORE.minY + ly });
  const interior: Rect = {
    minX: Math.min(...indoorTiles.map((t) => t.x)),
    minY: Math.min(...indoorTiles.map((t) => t.y)),
    maxX: Math.max(...indoorTiles.map((t) => t.x)),
    maxY: Math.max(...indoorTiles.map((t) => t.y)),
  };
  if (indoorTiles.length !== rectWidth(interior) * rectHeight(interior)) throw new Error("bank interior is not rectangular");

  // ---- booths --------------------------------------------------------------
  const boothLocs = locs.filter((l) => l.type === LocModelType.NORMAL && nameOf(l) === "Bank booth");
  if (boothLocs.length !== 5) throw new Error(`expected 5 bank booths, decoded ${boothLocs.length}`);
  boothLocs.sort((a, b) => a.y - b.y);
  // The hall side of a booth is its only neighbour players can stand on (the counter floor is FLOOR-blocked).
  const hallSeed = (() => {
    const b = boothLocs[0]!;
    const sides = DIRS.filter((d) => walkable(raw, b.x + DELTA[d][0], b.y + DELTA[d][1]));
    if (sides.length !== 1) throw new Error(`booth at ${b.x},${b.y} has ${sides.length} standable sides`);
    return { x: b.x + DELTA[sides[0]!][0], y: b.y + DELTA[sides[0]!][1] };
  })();

  // Hall = tiles reachable from the booth side without leaving the building.
  const insideOnly: CollisionGrid = {
    ...raw,
    flags: raw.flags.map((f, i) => (indoors[i] ? f : f | FLAG.OUT_OF_BOUNDS)),
  };
  const hall = reachable(insideOnly, hallSeed);

  // ---- entrances: legal steps from a hall tile to an outdoor tile ---------
  type Opening = { side: Dir; inside: Tile[]; outside: Tile[] };
  const openings = new Map<Dir, Opening>();
  for (const k of [...hall].sort()) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    for (const d of DIRS) {
      const nx = x + DELTA[d][0];
      const ny = y + DELTA[d][1];
      if (!inRect(CORE, nx, ny) || indoors[(ny - CORE.minY) * width + (nx - CORE.minX)]) continue;
      if (!canStep(raw, x, y, d)) continue;
      const o = openings.get(d) ?? { side: d, inside: [], outside: [] };
      o.inside.push({ x, y });
      o.outside.push({ x: nx, y: ny });
      openings.set(d, o);
    }
  }
  const south = openings.get("south");
  if (!south) throw new Error("no south entrance found");

  // ---- playable bounds + OUT_OF_BOUNDS -------------------------------------
  const outsideY = south.outside[0]!.y;
  const bounds: Rect = { minX: interior.minX, minY: outsideY - (STREET_DEPTH - 1), maxX: interior.maxX, maxY: interior.maxY };
  if (bounds.minY < CORE.minY) throw new Error("street strip extends outside the exported area");
  const flags = raw.flags.map((f, i) => {
    const x = CORE.minX + (i % width);
    const y = CORE.minY + Math.floor(i / width);
    return inRect(bounds, x, y) ? f : f | FLAG.OUT_OF_BOUNDS;
  });
  const grid: CollisionGrid = { originX: CORE.minX, originY: CORE.minY, width, height, flags };

  const reach = reachable(grid, south.inside[0]!);
  // Nothing outside the hall and the street strip may be reachable.
  for (const k of reach) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    if (!hall.has(k) && !(y < interior.minY && inRect(bounds, x, y))) throw new Error(`unexpectedly reachable tile ${k}`);
  }

  // ---- doors ---------------------------------------------------------------
  const doors: WorldMeta["doors"] = [];
  for (const o of [...openings.values()].sort((a, b) => a.inside[0]!.y - b.inside[0]!.y)) {
    // The open leaves are the wall locs standing on the opening's inside row, at its two ends.
    const xs = o.inside.map((t) => t.x);
    const leafIds = locs
      .filter((l) => l.type === LocModelType.WALL && l.y === o.inside[0]!.y && l.x >= Math.min(...xs) && l.x <= Math.max(...xs) && l.rotation % 2 === 0)
      .map((l) => l.id);
    doors.push({
      locIds: [...new Set(leafIds)].sort((a, b) => a - b),
      name: o.side === "south" ? "Bank entrance" : o.side === "north" ? "Back entrance" : `${o.side} entrance`,
      kind: "entrance",
      open: true,
      tiles: o.inside,
      outside: o.outside,
      edge: o.side,
    });
  }
  for (const l of locs) {
    if (l.type !== LocModelType.WALL || nameOf(l) !== "Door") continue;
    const t = locTypes.load(l.id);
    const edge = (["west", "north", "east", "south"] as Dir[])[l.rotation]!;
    const other = { x: l.x + DELTA[edge][0], y: l.y + DELTA[edge][1] };
    const hallSide = hall.has(key(other.x, other.y)) ? other : { x: l.x, y: l.y };
    const farSide = hallSide === other ? { x: l.x, y: l.y } : other;
    doors.push({
      locIds: [l.id],
      name: `Door (${(t.actions ?? []).filter(Boolean).join("/") || "fixed"})`,
      kind: "door",
      open: false,
      tiles: [hallSide],
      outside: [farSide],
      edge: hallSide === other ? (DIRS[(DIRS.indexOf(edge) + 2) % 4] as Dir) : edge,
    });
  }

  // ---- booths, bankers ----------------------------------------------------
  const booths: WorldMeta["booths"] = boothLocs.map((l) => {
    const t = locTypes.load(l.id);
    const sides = DIRS.filter((d) => reach.has(key(l.x + DELTA[d][0], l.y + DELTA[d][1])));
    if (sides.length !== 1) throw new Error(`booth ${l.id} at ${l.x},${l.y}: expected one use side, got ${sides.join(",")}`);
    const face = sides[0]!;
    const access = rotateAccess(t.accessBlockFlag, l.rotation);
    if (access & ACCESS_BIT[face]) throw new Error(`booth ${l.id} at ${l.x},${l.y}: ${face} side is access-blocked`);
    return {
      locId: l.id,
      name: "Bank booth",
      tile: { x: l.x, y: l.y },
      faceDir: face,
      faceYaw: YAW[face],
      useTile: { x: l.x + DELTA[face][0], y: l.y + DELTA[face][1] },
      bankerIndex: null,
    };
  });
  const npcTypes = cache.factory.getNpcTypeLoader();
  const bankers: WorldMeta["bankers"] = BANKER_SPAWNS.map((b) => {
    // The counter floor is FLOOR-blocked for players; NPCs are placed by the server.
    if (flagAt(grid, b.x, b.y) & FLAG.OBJECT) throw new Error(`banker ${b.npcId} at ${b.x},${b.y} stands inside an object`);
    if (reach.has(key(b.x, b.y))) throw new Error(`banker tile ${b.x},${b.y} must not be reachable by players`);
    if (!indoors[(b.y - CORE.minY) * width + (b.x - CORE.minX)]) throw new Error(`banker ${b.npcId} is outside the bank`);
    const type = npcTypes.load(b.npcId);
    // NpcType keeps ops in a sparse 5-slot array ("hidden" ops are deleted); normalise to explicit nulls.
    const actions = Array.from({ length: 5 }, (_, i) => type.actions[i] ?? null);
    return {
      npcId: b.npcId,
      name: type.name,
      tile: { x: b.x, y: b.y },
      faceDir: "west" as Dir,
      faceYaw: YAW.west,
      actions,
      boothIndex: null,
    };
  });
  booths.forEach((booth, boothIndex) => {
    const behind = { x: booth.tile.x - DELTA[booth.faceDir][0], y: booth.tile.y - DELTA[booth.faceDir][1] };
    const idx = bankers.findIndex((b) => b.tile.x === behind.x && b.tile.y === behind.y);
    booth.bankerIndex = idx === -1 ? null : idx;
    if (idx !== -1) bankers[idx]!.boothIndex = boothIndex;
  });
  if (booths.filter((b) => b.bankerIndex !== null).length < 4) throw new Error("fewer than four booths are staffed");
  // A banker offers Bank exactly when it serves a booth. In Varrock West the door guard (8666, behind the
  // closed Knock-at door) has no ops at all, so the client shows it Examine-only.
  for (const b of bankers) {
    const banks = b.actions.includes("Bank");
    if (banks !== (b.boothIndex !== null)) {
      throw new Error(`banker ${b.npcId} at ${b.tile.x},${b.tile.y}: Bank op ${banks ? "present" : "absent"} but boothIndex ${b.boothIndex}`);
    }
  }

  // Hall floor players can reach (the booths' use tiles included).
  const floor: Tile[] = [...hall]
    .filter((k) => reach.has(k))
    .map((k) => {
      const [x, y] = k.split(",").map(Number) as [number, number];
      return { x, y };
    });

  // ---- spawn: just inside the south entrance, in view of the default camera ----
  const spawn = spawnTiles(grid, floor, south.inside);
  if (spawn.length < 4) throw new Error(`only ${spawn.length} spawn tiles`);

  // ---- merchant roaming (rules in lib/placement.ts) ------------------------
  const merchantArea = merchantTiles(grid, { floor, spawn, entrance: south.inside, booths, doors });
  const merchantColumns = new Set(merchantArea.map((t) => t.x)).size;
  if (merchantArea.length < MIN_MERCHANT_TILES || merchantColumns < MIN_MERCHANT_COLUMNS) {
    throw new Error(
      `merchant area shrank to ${merchantArea.length} tiles over ${merchantColumns} columns ` +
        `(need ${MIN_MERCHANT_TILES} over ${MIN_MERCHANT_COLUMNS}); check booths, doors and the ${ENTRY_CLEARANCE}-tile entry clearance`,
    );
  }

  // ---- landmarks (named solid locs inside) ---------------------------------
  const landmarks = locs
    .filter((l) => (l.type === LocModelType.NORMAL || l.type === LocModelType.NORMAL_DIAGIONAL) && inRect(interior, l.x, l.y))
    .map((l) => {
      const t = locTypes.load(l.id);
      const swap = l.rotation % 2 === 1;
      return {
        locId: resolvedId(l),
        name: nameOf(l),
        tile: { x: l.x, y: l.y },
        size: (swap ? [t.sizeY, t.sizeX] : [t.sizeX, t.sizeY]) as [number, number],
      };
    })
    .filter((l) => l.name !== "null");

  // ---- heights -------------------------------------------------------------
  const heights = scene.tileHeights[0]!;
  const values: number[] = [];
  for (let ly = 0; ly <= height; ly++) {
    for (let lx = 0; lx <= width; lx++) {
      values.push(-tileHeightAt(heights, CORE.minX + lx - baseX, CORE.minY + ly - baseY) / TILE);
    }
  }
  const floorHeight = -tileHeightAt(heights, hallSeed.x - baseX, hallSeed.y - baseY) / TILE;
  for (const t of indoorTiles) {
    const h = -tileHeightAt(heights, t.x - baseX, t.y - baseY) / TILE;
    if (h !== floorHeight) throw new Error(`bank floor is not flat at ${t.x},${t.y}`);
  }

  const meta: WorldMeta = {
    $comment: [
      "Generated by scripts/bake (steps/collision.ts) from the OSRS cache. Do not edit by hand.",
      "Tiles are absolute OSRS world coordinates on plane 0. Scene frame: 1 unit = 1 tile, y up, north = -z;",
      "tile (X, Y) centre is x = X - origin.x + 0.5, z = -(Y - origin.y + 0.5).",
      "faceDir is the compass direction the entity faces; faceYaw is the three.js rotation.y that turns a",
      "south-facing model (the OSRS default) to face it (south 0, west -PI/2, north PI, east PI/2).",
      "bankers[].actions: the NPC type's five cache menu ops in slot order (null = empty); the client always adds Examine.",
      "Build the banker menu from these: an NPC with no ops (8666, behind the closed Knock-at door) is Examine-only.",
      "bankers[].boothIndex: the booth the banker serves (the inverse of booths[].bankerIndex), null when it serves none.",
      "Offer Bank/Exchange on a banker only when boothIndex !== null; a banker has a Bank op iff it has a booth.",
      "heightMap.values: tile-CORNER floor heights in tiles, row-major from (originX, originY), width = tiles + 1.",
      "Interpolate bilinearly like the client; the bank floor is flat at floorHeight, the street is lower.",
      "indoors: row-major over the collision grid, 1 = the client hides planes 1-3 (roofs) while the local player stands here.",
      "collision.json flags are OSRS client bits (collision.flags). A tile can be stood on iff (flags & collision.blocked) === 0.",
      "A step is legal iff the destination passes stepMasks[dir].dest and, for diagonals, (x+dx, y) passes .x and (x, y+dy) passes .y.",
      "WALL_<dir> on a tile means a wall on that edge. OUT_OF_BOUNDS (0x100000) marks tiles outside `bounds`.",
    ],
    cache: { name: cache.info.name, revision: cache.info.revision, timestamp: cache.info.timestamp },
    origin: { x: ORIGIN.x, y: ORIGIN.y },
    floorHeight,
    exported: { ...CORE },
    bounds,
    interior,
    indoors,
    heightMap: { originX: CORE.minX, originY: CORE.minY, width: width + 1, height: height + 1, values },
    spawn,
    bankers,
    booths,
    merchantArea,
    doors,
    landmarks,
    collision: {
      flags: Object.fromEntries(Object.entries(FLAG)),
      blocked: BLOCKED,
      stepMasks: STEP_MASKS,
    },
  };

  const markers = new Map<string, string>();
  for (const m of merchantArea) markers.set(key(m.x, m.y), "m");
  for (const s of spawn) markers.set(key(s.x, s.y), "s");
  for (const b of booths) markers.set(key(b.tile.x, b.tile.y), "B");
  for (const b of booths) markers.set(key(b.useTile.x, b.useTile.y), "u");
  for (const b of bankers) markers.set(key(b.tile.x, b.tile.y), b.boothIndex === null ? "n" : "N");
  const ascii = asciiGrid(grid, markers);

  // Keep the README's walkable-grid section in step with the data.
  const readme = path.join(BAKE_DIR, "README.md");
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, "utf8");
    const start = "<!-- collision-grid:start -->";
    const end = "<!-- collision-grid:end -->";
    const i = text.indexOf(start);
    const j = text.indexOf(end);
    if (i !== -1 && j > i) {
      writeIfChanged(readme, text.slice(0, i + start.length) + "\n```text\n" + ascii + "\n```\n" + text.slice(j));
    }
  }

  writeJson(path.join(WORLD_DIR, "collision.json"), grid);
  writeJson(path.join(SHARED_DIR, "collision.json"), grid);
  writeJson(path.join(SHARED_DIR, "world-meta.json"), meta);
  console.log(`  collision ${width}x${height} -> ${rel(path.join(WORLD_DIR, "collision.json"))} + ${rel(path.join(SHARED_DIR, "collision.json"))}`);
  console.log(
    `  world-meta: ${booths.length} booths, ${bankers.length} bankers, ${spawn.length} spawn, ${merchantArea.length} merchant tiles, ${doors.length} doors -> ${rel(path.join(SHARED_DIR, "world-meta.json"))}`,
  );
  return { grid, meta, ascii };
}

/** Access-block bits: 1 north, 2 east, 4 south, 8 west. */
const ACCESS_BIT: Record<Dir, number> = { north: 1, east: 2, south: 4, west: 8 };

/** The client rotates the access mask clockwise by the loc rotation. */
function rotateAccess(mask: number, rotation: number): number {
  if (rotation === 0) return mask;
  return ((mask << rotation) & 0xf) | (mask >> (4 - rotation));
}

