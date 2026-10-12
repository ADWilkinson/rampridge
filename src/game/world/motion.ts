import { TICK_MS, positionAt, type Tile } from "@shared/protocol";

/**
 * Deterministic tile movement: a path, the server time it started and the
 * run flag. Every client replays it with shared/protocol.ts#positionAt, so
 * the local view and everyone else's agree to the tick.
 */
export interface Motion {
  path: Tile[];
  startedAt: number;
  run: boolean;
}

/** Scratch output for `sampleMotion`; reuse one per actor to avoid allocation. */
export interface MotionSample {
  /** Fractional world tile coordinates. */
  x: number;
  y: number;
  /** Direction of the current step (tile units), 0/0 when standing. */
  dirX: number;
  dirY: number;
  moving: boolean;
  /** Index of the last reached tile. */
  index: number;
  done: boolean;
}

export function createSample(): MotionSample {
  return { x: 0, y: 0, dirX: 0, dirY: 0, moving: false, index: 0, done: true };
}

export function msPerTile(run: boolean): number {
  return run ? TICK_MS / 2 : TICK_MS;
}

export function standingMotion(tile: Tile, at = 0): Motion {
  return { path: [{ x: tile.x, y: tile.y }], startedAt: at, run: false };
}

/** Samples a motion at `now` into `out`. */
export function sampleMotion(motion: Motion, now: number, out: MotionSample): MotionSample {
  const { path } = motion;
  const first = path[0];
  if (!first) {
    out.moving = false;
    out.done = true;
    out.dirX = 0;
    out.dirY = 0;
    return out;
  }
  const pos = positionAt(path, motion.startedAt, motion.run, now);
  const a = path[pos.index]!;
  const b = pos.done ? undefined : path[pos.index + 1];
  out.index = pos.index;
  out.done = pos.done;
  if (b) {
    out.x = a.x + (b.x - a.x) * pos.progress;
    out.y = a.y + (b.y - a.y) * pos.progress;
    out.dirX = b.x - a.x;
    out.dirY = b.y - a.y;
    out.moving = true;
  } else {
    out.x = a.x;
    out.y = a.y;
    out.dirX = 0;
    out.dirY = 0;
    out.moving = false;
  }
  // Moving until the instant the last tile is reached.
  if (now < motion.startedAt) out.moving = false;
  return out;
}

/** Server time at which the motion reaches its last tile. */
export function motionEnd(motion: Motion): number {
  return motion.startedAt + Math.max(0, motion.path.length - 1) * msPerTile(motion.run);
}

/**
 * Where a new path should start so the walker never jumps: the tile it is
 * stepping towards (or standing on), and the time it gets there.
 */
export function nextStop(motion: Motion, now: number): { tile: Tile; at: number } {
  const { path } = motion;
  const pos = positionAt(path, motion.startedAt, motion.run, now);
  if (pos.done || path.length <= 1) {
    const last = path[path.length - 1] ?? { x: 0, y: 0 };
    return { tile: { x: last.x, y: last.y }, at: now };
  }
  if (now < motion.startedAt) {
    const first = path[0]!;
    return { tile: { x: first.x, y: first.y }, at: now };
  }
  const next = path[pos.index + 1]!;
  const at = motion.startedAt + (pos.index + 1) * msPerTile(motion.run);
  return { tile: { x: next.x, y: next.y }, at: Math.max(now, at) };
}

/** The tile the walker occupies at `now` (the last tile reached). */
export function tileAt(motion: Motion, now: number): Tile {
  const pos = positionAt(motion.path, motion.startedAt, motion.run, now);
  const t = motion.path[pos.index] ?? motion.path[0] ?? { x: 0, y: 0 };
  return { x: t.x, y: t.y };
}
