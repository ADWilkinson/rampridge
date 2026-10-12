/**
 * Where people stand in the bank: the spawn tiles new players join on and the
 * tiles the merchant NPCs wander between. Pure functions of the collision grid
 * and the derived layout (booths, doors, entrance), so the rules are tested on
 * synthetic grids as well as on the baked bank.
 */
import { type CollisionGrid, DELTA, DIRS, type Dir, FLAG, type Tile, flagAt, tileKey, walkable } from "./grid";

/** Clear tiles (Chebyshev distance) merchants keep from the spawn tiles and the entrance players use. */
export const ENTRY_CLEARANCE = 2;

const byRowThenColumn = (a: Tile, b: Tile) => a.y - b.y || a.x - b.x;

/**
 * Spawn tiles: floor tiles on the south entrance's inside row and the row
 * behind it, within one column of the opening. Tiles with a wall on their
 * south edge are skipped: the default camera looks north from the south, so a
 * player standing right behind the façade either side of the doorway is
 * hidden by the wall until they move.
 *
 * @param floor tiles players can reach inside the hall
 * @param entrance the south entrance's inside tiles (the opening)
 */
export function spawnTiles(grid: CollisionGrid, floor: Iterable<Tile>, entrance: readonly Tile[]): Tile[] {
  const out: Tile[] = [];
  for (const t of floor) {
    const near = entrance.some((e) => Math.abs(e.x - t.x) <= 1 && t.y >= e.y && t.y - e.y <= 1);
    if (!near || !walkable(grid, t.x, t.y)) continue;
    if (flagAt(grid, t.x, t.y) & FLAG.WALL_SOUTH) continue;
    out.push({ x: t.x, y: t.y });
  }
  return out.sort(byRowThenColumn);
}

export interface MerchantLayout {
  /** Tiles players can reach inside the hall. */
  floor: Iterable<Tile>;
  spawn: readonly Tile[];
  /** Inside tiles of the entrance players come in through. */
  entrance: readonly Tile[];
  /** faceDir is the side of the booth customers stand on; useTile is the tile on that side. */
  booths: readonly { useTile: Tile; faceDir: Dir }[];
  /** Every entrance and door: the tiles on both sides of the opening. */
  doors: readonly { tiles: readonly Tile[]; outside: readonly Tile[] }[];
}

/**
 * Booth queues: each booth's use tile and the tile behind it, where the next
 * customer waits. Merchants never stand there, so a player walking up to a
 * booth always finds it free.
 */
export function boothQueueTiles(booths: MerchantLayout["booths"]): Tile[] {
  return booths.flatMap((b) => [b.useTile, { x: b.useTile.x + DELTA[b.faceDir][0], y: b.useTile.y + DELTA[b.faceDir][1] }]);
}

/**
 * Merchant roaming tiles: walkable floor tiles that are not in a booth queue,
 * not beside (4-neighbour) an entrance or door, at least ENTRY_CLEARANCE + 1
 * tiles from every spawn and entrance tile, and not beside (4-neighbour) a
 * solid object (deposit box, poll booth, chairs, tables, the counter), so a
 * merchant never wedges against furniture or blocks a doorway. Floor
 * decorations (rugs, debris) do not count: players walk over them.
 */
export function merchantTiles(grid: CollisionGrid, layout: MerchantLayout): Tile[] {
  const queue = new Set(boothQueueTiles(layout.booths).map((t) => tileKey(t.x, t.y)));
  const doorTiles = layout.doors.flatMap((d) => [...d.tiles, ...d.outside]);
  const entry = [...layout.spawn, ...layout.entrance];
  const out: Tile[] = [];
  for (const t of layout.floor) {
    if (!walkable(grid, t.x, t.y) || queue.has(tileKey(t.x, t.y))) continue;
    if (doorTiles.some((d) => Math.abs(d.x - t.x) + Math.abs(d.y - t.y) <= 1)) continue;
    if (entry.some((e) => Math.max(Math.abs(e.x - t.x), Math.abs(e.y - t.y)) <= ENTRY_CLEARANCE)) continue;
    if (DIRS.some((d) => flagAt(grid, t.x + DELTA[d][0], t.y + DELTA[d][1]) & FLAG.OBJECT)) continue;
    out.push({ x: t.x, y: t.y });
  }
  return out.sort(byRowThenColumn);
}
