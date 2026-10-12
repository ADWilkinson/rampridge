import type { Tile } from "@shared/protocol";
import type { CollisionMap } from "./collision";
import { tilesGoal, type PathGoal } from "./pathfinding";
import type { BankerMeta, BoothMeta } from "./worldMeta";

/**
 * Where the player must stand to interact with something, following the
 * original game: booths are used from their front tile, bankers are spoken
 * to across their booth, and people are approached on an orthogonally
 * adjacent tile with no wall in between (never diagonally).
 */

const ORTHOGONAL: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export function boothGoal(booth: BoothMeta): PathGoal {
  return tilesGoal([booth.useTile], { minX: booth.tile.x, minY: booth.tile.y, maxX: booth.tile.x, maxY: booth.tile.y });
}

/** Cardinal step for a yaw (0 = south, +pi/2 = east). */
function stepForYaw(yaw: number): [number, number] {
  const sx = Math.round(Math.sin(yaw));
  const sy = -Math.round(Math.cos(yaw));
  return Math.abs(sx) >= Math.abs(sy) ? [sx, 0] : [0, sy];
}

/**
 * The tile a player stands on to talk to a banker: the use tile of the booth
 * directly in front of them, otherwise the first walkable tile across the
 * counter in the direction the banker faces (or towards the nearest booth).
 */
export function bankerUseTile(map: CollisionMap, banker: BankerMeta, booths: readonly BoothMeta[]): Tile | null {
  const { tile } = banker;
  const facing = banker.faceYaw !== null ? stepForYaw(banker.faceYaw) : null;

  let adjacent: BoothMeta | null = null;
  for (const booth of booths) {
    const dx = booth.tile.x - tile.x;
    const dy = booth.tile.y - tile.y;
    if (Math.abs(dx) + Math.abs(dy) !== 1) continue;
    if (!adjacent || (facing && dx === facing[0] && dy === facing[1])) adjacent = booth;
  }
  if (adjacent) return adjacent.useTile;

  let step = facing;
  if (!step) {
    let nearest: BoothMeta | null = null;
    let best = Infinity;
    for (const booth of booths) {
      const d = Math.abs(booth.tile.x - tile.x) + Math.abs(booth.tile.y - tile.y);
      if (d < best) {
        best = d;
        nearest = booth;
      }
    }
    if (nearest) {
      const dx = nearest.tile.x - tile.x;
      const dy = nearest.tile.y - tile.y;
      step = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
    }
  }
  const tryDirs: [number, number][] = step ? [step] : [...ORTHOGONAL];
  for (const [sx, sy] of tryDirs) {
    for (let k = 1; k <= 3; k++) {
      const x = tile.x + sx * k;
      const y = tile.y + sy * k;
      if (map.isWalkable(x, y)) return { x, y };
    }
  }
  return null;
}

export function bankerGoal(map: CollisionMap, banker: BankerMeta, booths: readonly BoothMeta[]): PathGoal | null {
  const use = bankerUseTile(map, banker, booths);
  if (!use) return null;
  return tilesGoal([use], { minX: banker.tile.x, minY: banker.tile.y, maxX: banker.tile.x, maxY: banker.tile.y });
}

/** Orthogonal neighbours of `target` a player can stand on and interact across. */
export function adjacentTiles(map: CollisionMap, target: Tile): Tile[] {
  const out: Tile[] = [];
  for (const [dx, dy] of ORTHOGONAL) {
    const x = target.x + dx;
    const y = target.y + dy;
    if (map.isWalkable(x, y) && map.edgeOpen(x, y, -dx, -dy)) out.push({ x, y });
  }
  return out;
}

/** Goal for approaching a person standing on `target`. */
export function adjacentGoal(map: CollisionMap, target: Tile): PathGoal {
  return {
    reached: (x, y) => {
      const dx = target.x - x;
      const dy = target.y - y;
      if (Math.abs(dx) + Math.abs(dy) !== 1) return false;
      return map.edgeOpen(x, y, dx, dy);
    },
    rect: { minX: target.x, minY: target.y, maxX: target.x, maxY: target.y },
  };
}

/** Yaw that turns an actor on `from` to face `to`. */
export function yawTowards(from: { x: number; y: number }, to: { x: number; y: number }): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  return Math.atan2(dx, -dy);
}
