/**
 * World rules shared by the API (which enforces them) and the browser (which
 * predicts them): the collision grid, path legality, the spawn area and the
 * appearance limits, plus the API envelope types that protocol.ts does not
 * cover. Dependency-free so both the Vite bundle and the Node functions can
 * import it.
 */

import { decodePath, MAX_PATH_STEPS, positionAt } from "./protocol.js";
import type { Appearance, PlayerRecord, Tile } from "./protocol.js";

// ---------------------------------------------------------------------------
// Collision

/** The bank sits on the ground floor; every tile the game uses is plane 0. */
export const WORLD_PLANE = 0;

/**
 * Per-tile flags, a subset of the original client's clipping flags. A wall
 * flag blocks movement across that edge of the tile; the opposite tile does
 * not need the mirrored flag (either side blocks).
 */
export const TILE_BLOCKED = 0x1;
export const WALL_NORTH = 0x2;
export const WALL_EAST = 0x4;
export const WALL_SOUTH = 0x8;
export const WALL_WEST = 0x10;

export interface CollisionGrid {
  plane: number;
  /** South-west corner of the grid (inclusive). */
  baseX: number;
  baseY: number;
  width: number;
  height: number;
  /** `flags[(y - baseY) * width + (x - baseX)]`. Tiles outside the grid are blocked. */
  flags: ArrayLike<number>;
  /**
   * When set, `flags` hold the original client's clipping bits and steps are
   * checked with these masks (the bake's exact rules) instead of the compact
   * TILE_BLOCKED / WALL_* bits above.
   */
  osrs?: OsrsCollisionRules;
}

export type StepDirection =
  | "north"
  | "south"
  | "east"
  | "west"
  | "northEast"
  | "northWest"
  | "southEast"
  | "southWest";

/** Bits that must be clear on the destination and, for diagonals, on the two orthogonal neighbours. */
export interface StepMask {
  dest: number;
  x?: number;
  y?: number;
}

/** `collision` in the bake's world-meta.json. */
export interface OsrsCollisionRules {
  /** A tile can be stood on iff `(flags & blocked) === 0`. */
  blocked: number;
  stepMasks: Record<StepDirection, StepMask>;
}

/** The bake's collision.json: original client bits for a rectangle of plane 0. */
export interface OsrsCollisionGrid {
  originX: number;
  originY: number;
  width: number;
  height: number;
  flags: ArrayLike<number>;
}

/** The shape the asset bake writes; `flags` is a plain array or base64 of a Uint8Array. */
export interface SerializedCollisionGrid {
  plane: number;
  baseX: number;
  baseY: number;
  width: number;
  height: number;
  flags: number[] | string;
}

/**
 * Conservative fallback until the baked grid is installed: the bounding box of
 * Varrock West Bank's interior and its doorway, all open.
 */
export const FALLBACK_BOUNDS = { minX: 3178, maxX: 3194, minY: 3430, maxY: 3448, plane: WORLD_PLANE } as const;

function openGrid(bounds: typeof FALLBACK_BOUNDS): CollisionGrid {
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  return {
    plane: bounds.plane,
    baseX: bounds.minX,
    baseY: bounds.minY,
    width,
    height,
    flags: new Uint8Array(width * height),
  };
}

export const FALLBACK_COLLISION_GRID: CollisionGrid = openGrid(FALLBACK_BOUNDS);

let activeGrid: CollisionGrid = FALLBACK_COLLISION_GRID;

/** The grid every path check uses unless one is passed explicitly. */
export function getCollisionGrid(): CollisionGrid {
  return activeGrid;
}

export function setCollisionGrid(grid: CollisionGrid): void {
  activeGrid = grid;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Validates and decodes the baked grid. Throws on a malformed payload. */
export function decodeCollisionGrid(data: SerializedCollisionGrid): CollisionGrid {
  const { plane, baseX, baseY, width, height } = data;
  for (const [key, value] of Object.entries({ plane, baseX, baseY, width, height })) {
    if (!Number.isInteger(value)) throw new Error(`Collision grid ${key} must be an integer`);
  }
  if (width <= 0 || height <= 0) throw new Error("Collision grid must not be empty");
  const flags = typeof data.flags === "string" ? decodeBase64(data.flags) : Uint8Array.from(data.flags);
  if (flags.length !== width * height) {
    throw new Error(`Collision grid has ${flags.length} tiles, expected ${width * height}`);
  }
  return { plane, baseX, baseY, width, height, flags };
}

/** Decodes the baked grid and makes it the active grid for every later check. */
export function loadCollisionGrid(data: SerializedCollisionGrid): CollisionGrid {
  const grid = decodeCollisionGrid(data);
  setCollisionGrid(grid);
  return grid;
}

const STEP_DIRECTIONS: readonly StepDirection[] = [
  "north",
  "south",
  "east",
  "west",
  "northEast",
  "northWest",
  "southEast",
  "southWest",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInt(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

/** Validates the bake's step rules (world-meta.json `collision`). */
export function parseOsrsCollisionRules(value: unknown): OsrsCollisionRules {
  if (!isObject(value) || !isObject(value.stepMasks)) throw new Error("Collision rules are missing stepMasks");
  const blocked = requireInt(value.blocked, "collision.blocked");
  const masks = value.stepMasks;
  const stepMasks = {} as Record<StepDirection, StepMask>;
  for (const dir of STEP_DIRECTIONS) {
    const raw = masks[dir];
    if (!isObject(raw)) throw new Error(`Collision rules are missing stepMasks.${dir}`);
    const mask: StepMask = { dest: requireInt(raw.dest, `stepMasks.${dir}.dest`) };
    if (dir !== "north" && dir !== "south" && dir !== "east" && dir !== "west") {
      mask.x = requireInt(raw.x, `stepMasks.${dir}.x`);
      mask.y = requireInt(raw.y, `stepMasks.${dir}.y`);
    }
    stepMasks[dir] = mask;
  }
  return { blocked, stepMasks };
}

/** Wraps the bake's client-bit grid so every check uses the bake's own step masks. */
export function collisionGridFromOsrs(
  data: OsrsCollisionGrid,
  rules: OsrsCollisionRules,
  plane: number = WORLD_PLANE,
): CollisionGrid {
  const baseX = requireInt(data.originX, "collision originX");
  const baseY = requireInt(data.originY, "collision originY");
  const width = requireInt(data.width, "collision width");
  const height = requireInt(data.height, "collision height");
  if (width <= 0 || height <= 0) throw new Error("Collision grid must not be empty");
  if (!data.flags || data.flags.length !== width * height) {
    throw new Error(`Collision grid has ${data.flags?.length ?? 0} tiles, expected ${width * height}`);
  }
  const flags = new Int32Array(width * height);
  for (let i = 0; i < flags.length; i++) {
    const flag = data.flags[i];
    if (!Number.isInteger(flag)) throw new Error("Collision flags must be integers");
    flags[i] = flag as number;
  }
  return { plane, baseX, baseY, width, height, flags, osrs: rules };
}

/** Collision plus where new players appear. */
export interface WorldRules {
  grid: CollisionGrid;
  /** Spawn tiles; empty means "the arrival area, else near SPAWN_TILE". */
  spawn: readonly Tile[];
}

export const FALLBACK_WORLD_RULES: WorldRules = { grid: FALLBACK_COLLISION_GRID, spawn: [] };

function tileFrom(raw: unknown): Tile | null {
  return isObject(raw) && Number.isInteger(raw.x) && Number.isInteger(raw.y) ? { x: raw.x as number, y: raw.y as number } : null;
}

function tileList(raw: unknown): Tile[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(tileFrom).filter((tile): tile is Tile => tile !== null);
}

/** Tiles of a list that mixes single tiles and `{minX, minY, maxX, maxY}` rectangles. */
function areaTiles(raw: unknown): Tile[] {
  if (!Array.isArray(raw)) return [];
  const out: Tile[] = [];
  for (const entry of raw) {
    const tile = tileFrom(entry);
    if (tile) {
      out.push(tile);
    } else if (isObject(entry) && [entry.minX, entry.minY, entry.maxX, entry.maxY].every(Number.isInteger)) {
      const { minX, minY, maxX, maxY } = entry as Record<"minX" | "minY" | "maxX" | "maxY", number>;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Builds the rules from the bake's outputs: shared/collision.json and
 * shared/world-meta.json (its `collision` step masks, plus the tiles that
 * place arrivals). Spawn tiles are the walkable arrival-area tiles that are
 * neither merchant pitch nor a booth's use tile; the bake's `spawn` list (the
 * doorway) is the fallback when none are. Throws on a malformed payload so a
 * bad bake fails loudly.
 */
export function worldRulesFromBake(collision: unknown, meta: unknown): WorldRules {
  if (!isObject(collision)) throw new Error("collision.json must be an object");
  if (!isObject(meta)) throw new Error("world-meta.json must be an object");
  const grid = collisionGridFromOsrs(
    collision as unknown as OsrsCollisionGrid,
    parseOsrsCollisionRules(meta.collision),
  );
  const boothUseTiles = Array.isArray(meta.booths)
    ? meta.booths.map((booth) => (isObject(booth) ? tileFrom(booth.useTile) : null)).filter((tile): tile is Tile => tile !== null)
    : [];
  const arrivals = arrivalTiles(grid, [...areaTiles(meta.merchantArea), ...boothUseTiles]);
  return { grid, spawn: arrivals.length > 0 ? arrivals : tileList(meta.spawn) };
}

function flagsAt(grid: CollisionGrid, x: number, y: number): number | null {
  const dx = x - grid.baseX;
  const dy = y - grid.baseY;
  if (dx < 0 || dy < 0 || dx >= grid.width || dy >= grid.height) return null;
  return grid.flags[dy * grid.width + dx] ?? null;
}

export function isWalkable(grid: CollisionGrid, tile: Tile): boolean {
  const flags = flagsAt(grid, tile.x, tile.y);
  if (flags === null) return false;
  return (flags & (grid.osrs ? grid.osrs.blocked : TILE_BLOCKED)) === 0;
}

function stepDirection(dx: number, dy: number): StepDirection {
  if (dx === 0) return dy > 0 ? "north" : "south";
  if (dy === 0) return dx > 0 ? "east" : "west";
  if (dy > 0) return dx > 0 ? "northEast" : "northWest";
  return dx > 0 ? "southEast" : "southWest";
}

/** The original client's rule: tiles outside the grid behave as fully blocked. */
function passes(grid: CollisionGrid, x: number, y: number, mask: number): boolean {
  const flags = flagsAt(grid, x, y);
  return flags !== null && (flags & mask) === 0;
}

function osrsStep(grid: CollisionGrid, rules: OsrsCollisionRules, from: Tile, dx: number, dy: number): boolean {
  const mask = rules.stepMasks[stepDirection(dx, dy)];
  if (!passes(grid, from.x + dx, from.y + dy, mask.dest)) return false;
  if (dx === 0 || dy === 0) return true;
  return passes(grid, from.x + dx, from.y, mask.x ?? rules.blocked) && passes(grid, from.x, from.y + dy, mask.y ?? rules.blocked);
}

/** True when a wall separates two orthogonally adjacent tiles. */
function edgeBlocked(grid: CollisionGrid, from: Tile, to: Tile): boolean {
  const a = flagsAt(grid, from.x, from.y) ?? 0;
  const b = flagsAt(grid, to.x, to.y) ?? 0;
  if (to.y === from.y + 1) return (a & WALL_NORTH) !== 0 || (b & WALL_SOUTH) !== 0;
  if (to.y === from.y - 1) return (a & WALL_SOUTH) !== 0 || (b & WALL_NORTH) !== 0;
  if (to.x === from.x + 1) return (a & WALL_EAST) !== 0 || (b & WALL_WEST) !== 0;
  return (a & WALL_WEST) !== 0 || (b & WALL_EAST) !== 0;
}

function orthogonalStep(grid: CollisionGrid, from: Tile, to: Tile): boolean {
  return isWalkable(grid, to) && !edgeBlocked(grid, from, to);
}

/**
 * Whether a single 8-neighbour step is legal. Diagonals follow the original
 * game: both orthogonal detours must be open, so players never cut a corner
 * through a wall or a booth. Grids from the bake use its exact step masks.
 */
export function canStep(grid: CollisionGrid, from: Tile, to: Tile): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return false;
  if (grid.osrs) return osrsStep(grid, grid.osrs, from, dx, dy);
  if (dx === 0 || dy === 0) return orthogonalStep(grid, from, to);
  const viaX = { x: from.x + dx, y: from.y };
  const viaY = { x: from.x, y: from.y + dy };
  return (
    isWalkable(grid, to) &&
    orthogonalStep(grid, from, viaX) &&
    orthogonalStep(grid, viaX, to) &&
    orthogonalStep(grid, from, viaY) &&
    orthogonalStep(grid, viaY, to)
  );
}

/** Chebyshev distance: the number of 8-neighbour steps on an open floor. */
export function tileDistance(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Breadth-first check that `to` can be reached from `from` in at most `maxSteps` legal steps. */
export function reachableWithin(grid: CollisionGrid, from: Tile, to: Tile, maxSteps: number): boolean {
  if (from.x === to.x && from.y === to.y) return true;
  if (tileDistance(from, to) > maxSteps) return false;
  let frontier: Tile[] = [from];
  const seen = new Set<string>([`${from.x},${from.y}`]);
  for (let depth = 0; depth < maxSteps; depth++) {
    const next: Tile[] = [];
    for (const tile of frontier) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const step = { x: tile.x + dx, y: tile.y + dy };
          const key = `${step.x},${step.y}`;
          if (seen.has(key) || !canStep(grid, tile, step)) continue;
          if (step.x === to.x && step.y === to.y) return true;
          seen.add(key);
          next.push(step);
        }
      }
    }
    frontier = next;
  }
  return false;
}

/** How far (in steps) a move may start from the server's estimate of the player. */
export const MOVE_START_TOLERANCE = 2;

export type PathError = "empty" | "too_long" | "not_adjacent" | "blocked" | "too_far";

export const PATH_ERROR_MESSAGES: Record<PathError, string> = {
  empty: "The path is empty.",
  too_long: `A path may have at most ${MAX_PATH_STEPS} tiles.`,
  not_adjacent: "Each step must be next to the previous one.",
  blocked: "You can't walk there.",
  too_far: "That path starts too far from where you are standing.",
};

/**
 * Checks a move: the path is `[start, step, step, ...]`, at most
 * MAX_PATH_STEPS tiles; the start is reachable within MOVE_START_TOLERANCE
 * steps of one of `origins` (the server's estimate of where the player
 * stands); every step is a legal 8-neighbour move on walkable tiles.
 */
export function checkPath(
  grid: CollisionGrid,
  path: readonly Tile[],
  origins: readonly Tile[],
): PathError | null {
  const start = path[0];
  if (!start) return "empty";
  if (path.length > MAX_PATH_STEPS) return "too_long";
  if (!isWalkable(grid, start)) return "blocked";
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1]!;
    const next = path[i]!;
    if (tileDistance(prev, next) !== 1) return "not_adjacent";
    if (!canStep(grid, prev, next)) return "blocked";
  }
  const nearOrigin = origins.some((origin) =>
    // A player standing on a tile that is no longer walkable (the grid changed
    // under them) may step off it in a straight line rather than be stuck.
    isWalkable(grid, origin)
      ? reachableWithin(grid, origin, start, MOVE_START_TOLERANCE)
      : tileDistance(origin, start) <= MOVE_START_TOLERANCE,
  );
  return nearOrigin ? null : "too_far";
}

/**
 * The tiles a player could be standing on at `now`: the last reached tile,
 * plus the next one while mid-step.
 */
export function currentTiles(record: Pick<PlayerRecord, "p" | "t" | "r">, now: number): Tile[] {
  const path = decodePath(record.p);
  if (path.length === 0) return [];
  const pos = positionAt(path, record.t, record.r, now);
  const here = path[pos.index]!;
  const next = pos.done ? undefined : path[pos.index + 1];
  return next ? [here, next] : [here];
}

// ---------------------------------------------------------------------------
// Spawn

const tileKey = (tile: Tile) => `${tile.x},${tile.y}`;

/**
 * Where arrivals appear: the open floor two to three tiles inside the front
 * door, south of the merchants' pitch (which starts at y 3437) and west of the
 * booths' use tiles (x 3185). The bake's own spawn list is the doorway itself
 * (y 3433-3434), so new players appeared standing in the door frame.
 */
export const ARRIVAL_AREA = { minX: 3181, maxX: 3184, minY: 3435, maxY: 3436 } as const;

/** Walkable tiles of ARRIVAL_AREA on `grid`, minus `reserved` ones, south row first. */
export function arrivalTiles(grid: CollisionGrid, reserved: readonly Tile[] = []): Tile[] {
  const taken = new Set(reserved.map(tileKey));
  const out: Tile[] = [];
  for (let y = ARRIVAL_AREA.minY; y <= ARRIVAL_AREA.maxY; y++) {
    for (let x = ARRIVAL_AREA.minX; x <= ARRIVAL_AREA.maxX; x++) {
      const tile = { x, y };
      if (isWalkable(grid, tile) && !taken.has(tileKey(tile))) out.push(tile);
    }
  }
  return out;
}

/**
 * The middle of ARRIVAL_AREA. Every arrival tile is within MOVE_START_TOLERANCE
 * of it, so a client that places its player here before the server's record
 * arrives can still walk from where the server has them.
 */
export const SPAWN_TILE: Tile = { x: 3183, y: 3436 };
export const SPAWN_RADIUS = 2;

/**
 * A random walkable spawn tile so arrivals do not stack: one of `spawnTiles`
 * (the world rules' list) when any are walkable, else an arrival-area tile,
 * else a tile near SPAWN_TILE.
 */
export function pickSpawnTile(
  grid: CollisionGrid,
  random: () => number = Math.random,
  spawnTiles: readonly Tile[] = [],
): Tile {
  let options = spawnTiles.filter((tile) => isWalkable(grid, tile));
  if (options.length === 0) options = arrivalTiles(grid);
  if (options.length === 0) {
    for (let dx = -SPAWN_RADIUS; dx <= SPAWN_RADIUS; dx++) {
      for (let dy = -SPAWN_RADIUS; dy <= SPAWN_RADIUS; dy++) {
        const tile = { x: SPAWN_TILE.x + dx, y: SPAWN_TILE.y + dy };
        if (isWalkable(grid, tile)) options.push(tile);
      }
    }
  }
  if (options.length === 0) return SPAWN_TILE;
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))]!;
}

// ---------------------------------------------------------------------------
// Appearance

/**
 * Number of designer choices per slot; every choice is an index 0..count-1.
 * Kits are indexed by body type (0 male, 1 female) then slot (hair, jaw,
 * torso, arms, hands, legs, feet); colours by channel (hair, torso, legs,
 * feet, skin). These mirror DESIGNER_KIT_COUNTS and DESIGNER_COLOR_COUNTS in
 * the bake's src/game/osrs/catalog.generated.ts, which the client's character
 * designer uses. shared/world.test.ts fails if a re-bake changes them.
 */
export interface AppearanceLimits {
  kits: readonly [readonly number[], readonly number[]];
  colors: readonly number[];
}

export const APPEARANCE_LIMITS: AppearanceLimits = {
  kits: [
    [71, 16, 20, 17, 2, 22, 2],
    [73, 15, 20, 17, 2, 22, 2],
  ],
  colors: [25, 29, 29, 6, 8],
};

export const DEFAULT_APPEARANCE: Appearance = {
  body: 0,
  kits: [0, 0, 0, 0, 0, 0, 0],
  colors: [0, 0, 0, 0, 0],
};

// ---------------------------------------------------------------------------
// API envelope

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "not_joined"
  | "name_taken"
  | "conflict"
  | "rate_limited"
  /**
   * The request comes from a build that predates the server (a join without a
   * world). Sent as a 429 with a long wait, the one refusal every build shows
   * in the chatbox; newer builds also show the reload notice.
   */
  | "outdated"
  | "payload_too_large"
  | "upstream"
  | "server";

/** Every non-2xx JSON response from /api/*. `error` is plain English for the player. */
export interface ApiErrorBody {
  ok: false;
  error: string;
  code: ApiErrorCode;
  /** Present on 429: how long to wait before retrying. */
  retryAfterMs?: number;
  now: number;
}

/** `GET /api/wallet?address=0x...` */
export interface WalletChallengeResponse {
  ok: boolean;
  error?: string;
  /** The exact text to sign (EIP-191 personal_sign). */
  message?: string;
  /** Lowercase address the message is bound to. */
  address?: string;
  expiresAt?: number;
  now: number;
}

// ---------------------------------------------------------------------------
// Market (GET /api/market)

/** One deposit's offer for a platform and currency. Amounts are decimal strings. */
export interface MarketOffer {
  /** Composite id, `${escrow}_${depositIdOnContract}`. */
  depositId: string;
  depositIdOnContract: string;
  escrow: string;
  platform: string;
  currency: string;
  /** Fiat per USDC the buyer pays. */
  rate: string;
  /** USDC available on the deposit. */
  available: string;
  /** Smallest USDC amount per order. */
  min: string;
  /** Largest USDC amount per order, capped at `available`. */
  max: string;
}

export interface MarketBook {
  platform: string;
  currency: string;
  /** Sum of available USDC across the book's deposits. */
  liquidity: string;
  depositCount: number;
  best: MarketOffer;
  /** Up to three best offers, best rate first. */
  offers: MarketOffer[];
}

export interface MarketCurrencySummary {
  currency: string;
  /** Available USDC across all platforms, each deposit counted once. */
  liquidity: string;
  depositCount: number;
  bestRate: string;
  /** Platforms with offers, most liquid first. */
  platforms: string[];
}

export interface MarketResponse {
  ok: boolean;
  error?: string;
  /** Server ms when the book was assembled. */
  generatedAt: number;
  /** True when some currencies could not be fetched this time. */
  partial: boolean;
  currencies: MarketCurrencySummary[];
  books: MarketBook[];
  now: number;
}
