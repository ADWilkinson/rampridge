import { MAX_PATH_STEPS, type Tile } from "@shared/protocol";
import type { CollisionMap, TileRect } from "./collision";

/**
 * The original client's walk routing: a breadth-first search over a square
 * window centred on the walker, expanding W, E, S, N, SW, SE, NW, NE in that
 * order, so every client derives the same path from the same click. When the
 * goal cannot be reached it walks to the reachable tile closest to it
 * (within 10 tiles of the target, by straight-line distance, ties broken by
 * the shorter walk), exactly like clicking on a wall or a booth.
 */

/** Search window: 128 x 128 tiles centred on the start. */
const SEARCH_SIZE = 128;
const HALF = SEARCH_SIZE >> 1;
/** The client ignores fallback tiles further than this many steps away. */
const MAX_FALLBACK_COST = 100;
/** Fallback search radius around the target. */
const FALLBACK_RADIUS = 10;

const directions = new Uint8Array(SEARCH_SIZE * SEARCH_SIZE);
const distances = new Int32Array(SEARCH_SIZE * SEARCH_SIZE);
const queue = new Int32Array(SEARCH_SIZE * SEARCH_SIZE);

// Direction bits record how a tile was entered so the route can be traced
// back: bit 2 = moved west (came from the east), 8 = moved east, 1 = moved
// south, 4 = moved north.
const CAME_FROM_EAST = 2;
const CAME_FROM_WEST = 8;
const CAME_FROM_NORTH = 1;
const CAME_FROM_SOUTH = 4;
const START = 99;

export interface PathGoal {
  /** True when standing on (x, y) satisfies the goal. */
  reached(x: number, y: number): boolean;
  /** Rectangle the closest-reachable fallback measures distance to. */
  rect: TileRect;
}

export function tileGoal(tile: Tile): PathGoal {
  return {
    reached: (x, y) => x === tile.x && y === tile.y,
    rect: { minX: tile.x, minY: tile.y, maxX: tile.x, maxY: tile.y },
  };
}

/** Any of `tiles` satisfies the goal; the fallback measures to `rect`. */
export function tilesGoal(tiles: readonly Tile[], rect: TileRect): PathGoal {
  return {
    reached: (x, y) => {
      for (const t of tiles) if (t.x === x && t.y === y) return true;
      return false;
    },
    rect,
  };
}

export interface FindPathOptions {
  /** Walk to the closest reachable tile when the goal is unreachable (default true). */
  nearest?: boolean;
  /** Maximum path length in tiles, including the start (default MAX_PATH_STEPS). */
  maxTiles?: number;
}

/**
 * Finds a tile-by-tile path from `start` to `goal`, including `start` as the
 * first element. Returns `[start]` when the start already satisfies the
 * goal, and null when no movement is possible (unreachable and either the
 * fallback is disabled or the walker already stands on the closest tile).
 */
export function findPath(
  map: CollisionMap,
  start: Tile,
  goal: PathGoal | Tile,
  options: FindPathOptions = {},
): Tile[] | null {
  const target: PathGoal = "reached" in goal ? goal : tileGoal(goal);
  const nearest = options.nearest ?? true;
  const maxTiles = Math.max(1, options.maxTiles ?? MAX_PATH_STEPS);

  if (target.reached(start.x, start.y)) return [{ x: start.x, y: start.y }];

  const baseX = start.x - HALF;
  const baseY = start.y - HALF;
  directions.fill(0);
  distances.fill(0x7fffffff);

  let head = 0;
  let tail = 0;
  const startIndex = HALF * SEARCH_SIZE + HALF;
  directions[startIndex] = START;
  distances[startIndex] = 0;
  queue[tail++] = startIndex;

  let endX = start.x;
  let endY = start.y;
  let found = false;

  while (head < tail) {
    const index = queue[head++]!;
    const lx = index % SEARCH_SIZE;
    const ly = (index - lx) / SEARCH_SIZE;
    const x = baseX + lx;
    const y = baseY + ly;
    if (target.reached(x, y)) {
      endX = x;
      endY = y;
      found = true;
      break;
    }
    const cost = distances[index]! + 1;

    if (lx > 0 && directions[index - 1] === 0 && map.canStep(x, y, -1, 0)) {
      directions[index - 1] = CAME_FROM_EAST;
      distances[index - 1] = cost;
      queue[tail++] = index - 1;
    }
    if (lx < SEARCH_SIZE - 1 && directions[index + 1] === 0 && map.canStep(x, y, 1, 0)) {
      directions[index + 1] = CAME_FROM_WEST;
      distances[index + 1] = cost;
      queue[tail++] = index + 1;
    }
    if (ly > 0 && directions[index - SEARCH_SIZE] === 0 && map.canStep(x, y, 0, -1)) {
      directions[index - SEARCH_SIZE] = CAME_FROM_NORTH;
      distances[index - SEARCH_SIZE] = cost;
      queue[tail++] = index - SEARCH_SIZE;
    }
    if (ly < SEARCH_SIZE - 1 && directions[index + SEARCH_SIZE] === 0 && map.canStep(x, y, 0, 1)) {
      directions[index + SEARCH_SIZE] = CAME_FROM_SOUTH;
      distances[index + SEARCH_SIZE] = cost;
      queue[tail++] = index + SEARCH_SIZE;
    }
    const sw = index - SEARCH_SIZE - 1;
    if (lx > 0 && ly > 0 && directions[sw] === 0 && map.canStep(x, y, -1, -1)) {
      directions[sw] = CAME_FROM_EAST | CAME_FROM_NORTH;
      distances[sw] = cost;
      queue[tail++] = sw;
    }
    const se = index - SEARCH_SIZE + 1;
    if (lx < SEARCH_SIZE - 1 && ly > 0 && directions[se] === 0 && map.canStep(x, y, 1, -1)) {
      directions[se] = CAME_FROM_WEST | CAME_FROM_NORTH;
      distances[se] = cost;
      queue[tail++] = se;
    }
    const nw = index + SEARCH_SIZE - 1;
    if (lx > 0 && ly < SEARCH_SIZE - 1 && directions[nw] === 0 && map.canStep(x, y, -1, 1)) {
      directions[nw] = CAME_FROM_EAST | CAME_FROM_SOUTH;
      distances[nw] = cost;
      queue[tail++] = nw;
    }
    const ne = index + SEARCH_SIZE + 1;
    if (lx < SEARCH_SIZE - 1 && ly < SEARCH_SIZE - 1 && directions[ne] === 0 && map.canStep(x, y, 1, 1)) {
      directions[ne] = CAME_FROM_WEST | CAME_FROM_SOUTH;
      distances[ne] = cost;
      queue[tail++] = ne;
    }
  }

  if (!found) {
    if (!nearest) return null;
    const { rect } = target;
    let bestDistSq = Infinity;
    let bestCost = MAX_FALLBACK_COST;
    for (let x = rect.minX - FALLBACK_RADIUS; x <= rect.maxX + FALLBACK_RADIUS; x++) {
      const lx = x - baseX;
      if (lx < 0 || lx >= SEARCH_SIZE) continue;
      for (let y = rect.minY - FALLBACK_RADIUS; y <= rect.maxY + FALLBACK_RADIUS; y++) {
        const ly = y - baseY;
        if (ly < 0 || ly >= SEARCH_SIZE) continue;
        const cost = distances[ly * SEARCH_SIZE + lx]!;
        if (cost >= MAX_FALLBACK_COST) continue;
        const dx = x < rect.minX ? rect.minX - x : x > rect.maxX ? x - rect.maxX : 0;
        const dy = y < rect.minY ? rect.minY - y : y > rect.maxY ? y - rect.maxY : 0;
        const distSq = dx * dx + dy * dy;
        if (distSq < bestDistSq || (distSq === bestDistSq && cost < bestCost)) {
          bestDistSq = distSq;
          bestCost = cost;
          endX = x;
          endY = y;
        }
      }
    }
    if (bestDistSq === Infinity) return null;
    if (endX === start.x && endY === start.y) return null;
  }

  // Trace back from the end to the start.
  const reversed: Tile[] = [];
  let x = endX;
  let y = endY;
  for (let guard = 0; guard < SEARCH_SIZE * SEARCH_SIZE; guard++) {
    reversed.push({ x, y });
    const dir = directions[(y - baseY) * SEARCH_SIZE + (x - baseX)]!;
    if (dir === START) break;
    if (dir & CAME_FROM_EAST) x++;
    else if (dir & CAME_FROM_WEST) x--;
    if (dir & CAME_FROM_NORTH) y++;
    else if (dir & CAME_FROM_SOUTH) y--;
  }
  reversed.reverse();
  return reversed.length > maxTiles ? reversed.slice(0, maxTiles) : reversed;
}

/** True when every consecutive pair in `path` is a legal step on `map`. */
export function isValidPath(map: CollisionMap, path: readonly Tile[]): boolean {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return false;
    if (!map.canStep(a.x, a.y, dx, dy)) return false;
  }
  return true;
}
