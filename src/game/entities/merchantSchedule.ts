import type { Tile } from "@shared/protocol";
import type { CollisionMap } from "../world/collision";
import type { Motion } from "../world/motion";
import { findPath } from "../world/pathfinding";
import { hashString, mix } from "../util/hash";

/**
 * Merchant pitches, wandering and shouting, derived only from the merchant
 * list, each merchant's seed and the server clock, so every client sees the
 * same merchant on the same tile shouting at the same moment without any
 * network traffic.
 *
 * Pitches: the merchant area is cut into at least MERCHANT_PITCHES compact,
 * near-equal pitches grown from homes that keep a clear tile between them
 * where the area has room. The merchant at list index i takes the i-th
 * pitch of a spread order (each next home is the one farthest from those
 * before it), so a short list still spreads over the hall, and a phone that
 * shows only the first few merchants puts them where a desktop does. A
 * merchant only ever walks inside its own pitch, so no two merchants aim
 * for, or cross, the same tile.
 *
 * Wandering: time is cut into segments; in each one the merchant either
 * idles or walks to a tile of its pitch (its home half the time), starting
 * after a short seeded pause.
 *
 * Shouts: the merchants take turns. Merchant i of n shouts once per period
 * at offset i * period / n, with period = max(SHOUT_SLOT_MS, n * SHOUT_GAP_MS),
 * plus a little seeded jitter, so a new shout starts about every
 * SHOUT_GAP_MS and no more than three five-second shouts are up at once.
 * A shout the frame loop reaches more than SHOUT_LATE_MS after its time
 * (the loop was paused: a hidden tab, a phone switching apps) is skipped,
 * so after any gap the hall picks the cadence up from now instead of every
 * merchant whose turn passed shouting on the same frame.
 */

export const SEGMENT_MS = 12_000;
const START_DELAY_MAX_MS = 2_400;
/** Shortest time between one merchant's shouts. */
export const SHOUT_SLOT_MS = 8_000;
/** Time between consecutive shouts in the hall when every merchant takes a turn. */
export const SHOUT_GAP_MS = 2_000;
/** Longest seeded delay of a shout after its turn starts. */
const SHOUT_JITTER_MS = 2_000;
/** Share of the gap between turns that the delay may use. */
const SHOUT_JITTER_SHARE = 0.3;
/**
 * Latest a shout may still start after its time: a slow frame. Consecutive
 * shouts in the hall are at least (1 - SHOUT_JITTER_SHARE) * SHOUT_GAP_MS
 * apart, so at most one shout this late can be due on any one frame.
 */
export const SHOUT_LATE_MS = 1_000;
/**
 * The hall is cut into at least this many pitches whatever the merchant
 * count (the shell's desktop maximum), so merchant i keeps the same pitch on
 * a phone that shows fewer merchants.
 */
export const MERCHANT_PITCHES = 8;

/** When one merchant shouts: once per `period`, between `phase` and `phase + jitter` ms into it. */
export interface ShoutCadence {
  phase: number;
  period: number;
  jitter: number;
}

export interface MerchantSchedule {
  seed: number;
  /** Offset of segment boundaries from the epoch, so merchants do not move in lockstep. */
  phase: number;
  /** The merchant's pitch: the tiles it wanders between. */
  area: readonly Tile[];
  shout: ShoutCadence;
}

/** The shout cadence of the merchant at `index` in a list of `count`. */
export function shoutCadence(index: number, count: number): ShoutCadence {
  const n = Math.max(1, count);
  const period = Math.max(SHOUT_SLOT_MS, n * SHOUT_GAP_MS);
  const gap = period / n;
  const i = ((index % n) + n) % n;
  return {
    phase: Math.round(i * gap),
    period,
    jitter: Math.min(SHOUT_JITTER_MS, Math.floor(gap * SHOUT_JITTER_SHARE)),
  };
}

export function createSchedule(seed: string, pitch: readonly Tile[], cadence: ShoutCadence = shoutCadence(0, 1)): MerchantSchedule {
  const h = hashString(seed);
  return { seed: h, phase: mix(h, 1) % SEGMENT_MS, area: pitch, shout: cadence };
}

// ------------------------------------------------------------------ pitches

function byY(a: Tile, b: Tile): number {
  return a.y - b.y || a.x - b.x;
}

function distance2(a: Tile, b: Tile): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

/** Index of the tile farthest from every tile in `taken`; ties go to the earliest. */
function farthest(tiles: readonly Tile[], taken: readonly Tile[], skip: ReadonlySet<number>): number {
  let pick = -1;
  let pickD = -1;
  tiles.forEach((t, i) => {
    if (skip.has(i)) return;
    let d = Infinity;
    for (const h of taken) d = Math.min(d, distance2(t, h));
    if (d > pickD) {
      pick = i;
      pickD = d;
    }
  });
  return pick;
}

/**
 * `k` pitch homes, in hand-out order. Homes come from a packing of tiles no
 * two of which touch (Chebyshev distance >= 2), scanned from the south-west
 * and sampled evenly when it has more than `k`, so homes keep a clear tile
 * between them whenever the area has room; any still missing are the tiles
 * farthest from those chosen. The hand-out order starts at the entrance end
 * and each next home is the farthest from those before it, so a short list
 * still spreads over the hall.
 */
function pitchHomes(tiles: readonly Tile[], k: number): Tile[] {
  const packed: number[] = [];
  tiles.forEach((t, i) => {
    if (packed.every((j) => Math.max(Math.abs(tiles[j]!.x - t.x), Math.abs(tiles[j]!.y - t.y)) >= 2)) packed.push(i);
  });
  const chosen =
    packed.length <= k ? packed : Array.from({ length: k }, (_, n) => packed[k === 1 ? 0 : Math.round((n * (packed.length - 1)) / (k - 1))]!);
  const used = new Set(chosen);
  const homes = chosen.map((i) => tiles[i]!);
  while (homes.length < k) {
    const i = farthest(tiles, homes, used);
    used.add(i);
    homes.push(tiles[i]!);
  }
  const ordered: Tile[] = [homes[0]!];
  const taken = new Set([0]);
  while (ordered.length < homes.length) {
    const i = farthest(homes, ordered, taken);
    taken.add(i);
    ordered.push(homes[i]!);
  }
  return ordered;
}

const SIDES: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
/** Steps in the client's order: W, E, S, N, then the diagonals. */
const STEPS: readonly (readonly [number, number])[] = [...SIDES, [-1, -1], [1, -1], [-1, 1], [1, 1]];

/** Step legality between neighbouring tiles (CollisionMap#canStep). */
export interface StepRule {
  canStep(x: number, y: number, dx: number, dy: number): boolean;
}

const OPEN: StepRule = { canStep: () => true };

/**
 * Grows one pitch per home over `tiles`, a tile at a time: the smallest pitch
 * that can still grow takes the free tile beside it (sharing an edge, with
 * no wall between) nearest its home. Pitches stay in one walkable piece,
 * compact and near-equal in size. Tiles reached only diagonally join the
 * smallest pitch that can step to them.
 */
function growPitches(tiles: readonly Tile[], homes: readonly Tile[], rule: StepRule): Tile[][] {
  const index = new Map<string, number>();
  tiles.forEach((t, i) => index.set(`${t.x},${t.y}`, i));
  const owner = new Int32Array(tiles.length).fill(-1);
  const pitches: Tile[][] = homes.map((h, p) => {
    owner[index.get(`${h.x},${h.y}`)!] = p;
    return [h];
  });
  // The free tile pitch `p` can step onto that is nearest its home (ties: scan order).
  const next = (p: number, steps: typeof STEPS): number => {
    const home = homes[p]!;
    let best = -1;
    let bestD = Infinity;
    for (const t of pitches[p]!) {
      for (const [dx, dy] of steps) {
        const i = index.get(`${t.x + dx},${t.y + dy}`);
        if (i === undefined || owner[i] !== -1 || !rule.canStep(t.x, t.y, dx, dy)) continue;
        const d = distance2(tiles[i]!, home);
        if (d < bestD || (d === bestD && i < best)) {
          best = i;
          bestD = d;
        }
      }
    }
    return best;
  };
  for (const steps of [SIDES, STEPS]) {
    for (;;) {
      let grow = -1;
      let tile = -1;
      for (let p = 0; p < pitches.length; p++) {
        if (grow >= 0 && pitches[p]!.length >= pitches[grow]!.length) continue;
        const i = next(p, steps);
        if (i < 0) continue;
        grow = p;
        tile = i;
      }
      if (grow < 0) break;
      owner[tile] = grow;
      pitches[grow]!.push(tiles[tile]!);
    }
  }
  return pitches;
}

/**
 * Pitches for `count` merchants in list order: disjoint slices of the
 * merchant area, each grown from its home across steps `rule` allows (pass
 * the collision map). Only when there are more merchants than tiles do
 * merchants share a pitch. An empty area gives empty pitches; tiles no home
 * can walk to belong to no pitch.
 */
export function merchantPitches(area: readonly Tile[], count: number, rule: StepRule = OPEN): Tile[][] {
  if (count <= 0) return [];
  const seen = new Set<string>();
  const tiles: Tile[] = [];
  for (const t of area) {
    const key = `${t.x},${t.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tiles.push({ x: t.x, y: t.y });
  }
  if (tiles.length === 0) return Array.from({ length: count }, () => []);
  tiles.sort(byY);
  const k = Math.min(tiles.length, Math.max(count, MERCHANT_PITCHES));
  const pitches = growPitches(tiles, pitchHomes(tiles, k), rule);
  return Array.from({ length: count }, (_, i) => pitches[i % k]!);
}

/** A pitch's home: the tile the pitch was grown from (its first). */
export function pitchHome(pitch: readonly Tile[]): Tile | null {
  return pitch[0] ?? null;
}

// ------------------------------------------------------------------ wandering

export function segmentAt(s: MerchantSchedule, now: number): number {
  return Math.floor((now - s.phase) / SEGMENT_MS);
}

function moves(s: MerchantSchedule, k: number): boolean {
  // Two segments in three move; the third is an idle pause.
  return mix(s.seed, k, 3) % 3 !== 0;
}

/** The tile the merchant stands on at the end of segment `k`: its home half the time, else any tile of its pitch. */
export function destinationAt(s: MerchantSchedule, k: number): Tile {
  const n = s.area.length;
  if (n === 0) return { x: 0, y: 0 };
  let j = k;
  for (let guard = 0; guard < 32 && !moves(s, j); guard++) j--;
  const h = mix(s.seed, j, 5);
  return h % 2 === 0 ? s.area[0]! : s.area[(h >>> 1) % n]!;
}

/** Server time the walk in segment `k` starts. */
export function segmentStart(s: MerchantSchedule, k: number): number {
  return s.phase + k * SEGMENT_MS + (mix(s.seed, k, 7) % START_DELAY_MAX_MS);
}

/**
 * The shortest legal walk from `start` to `goal` over the tiles of `pitch`
 * only (steps tried in the client's order: W, E, S, N, then diagonals), so
 * a merchant never cuts across a neighbour's pitch; null when the pitch
 * does not connect them.
 */
export function pitchPath(map: CollisionMap, pitch: readonly Tile[], start: Tile, goal: Tile): Tile[] | null {
  const index = new Map<string, number>();
  pitch.forEach((t, i) => index.set(`${t.x},${t.y}`, i));
  const from = index.get(`${start.x},${start.y}`);
  const to = index.get(`${goal.x},${goal.y}`);
  if (from === undefined || to === undefined) return null;
  const prev = new Int32Array(pitch.length).fill(-1);
  prev[from] = from;
  const queue = [from];
  for (let head = 0; head < queue.length && prev[to] === -1; head++) {
    const i = queue[head]!;
    const t = pitch[i]!;
    for (const [dx, dy] of STEPS) {
      const j = index.get(`${t.x + dx},${t.y + dy}`);
      if (j === undefined || prev[j] !== -1 || !map.canStep(t.x, t.y, dx, dy)) continue;
      prev[j] = i;
      queue.push(j);
    }
  }
  if (prev[to] === -1) return null;
  const path: Tile[] = [];
  for (let i = to; ; i = prev[i]!) {
    path.push({ x: pitch[i]!.x, y: pitch[i]!.y });
    if (i === from) break;
  }
  return path.reverse();
}

/**
 * The motion for segment `k`: from the previous destination (or `from`, when
 * the merchant was held up by a trade or moved to a new pitch) to this
 * segment's destination, inside the pitch when it can be.
 */
export function segmentMotion(map: CollisionMap, s: MerchantSchedule, k: number, from?: Tile): Motion {
  const start = from ?? destinationAt(s, k - 1);
  const goal = destinationAt(s, k);
  const path = pitchPath(map, s.area, start, goal) ?? findPath(map, start, goal) ?? [{ x: start.x, y: start.y }];
  return { path, startedAt: segmentStart(s, k), run: false };
}

// ------------------------------------------------------------------ shouting

/** Shout slot index containing `now`. */
export function shoutSlotAt(s: MerchantSchedule, now: number): number {
  return Math.floor((now - s.shout.phase) / s.shout.period);
}

/** Server time of the shout in slot `j` (always inside the slot). */
export function shoutTime(s: MerchantSchedule, j: number): number {
  const { phase, period, jitter } = s.shout;
  return phase + j * period + (mix(s.seed, j, 11) % (jitter + 1));
}

/** The last slot whose shout has already happened at `now`, so only shouts still to come will play. */
export function lastShoutSlot(s: MerchantSchedule, now: number): number {
  const slot = shoutSlotAt(s, now);
  return now >= shoutTime(s, slot) ? slot : slot - 1;
}

/**
 * Advances a merchant's shouting to `now`, once per frame. `state.shoutSlot`
 * is the last slot already handled. When the merchant shouts on this frame
 * (its current slot's time has come, at most SHOUT_LATE_MS ago) returns how
 * many ms late the shout is, so the caller can date it from its slot time and
 * it ends on schedule; otherwise -1. A shout further past was missed while
 * the frame loop was paused: it is marked handled without playing, and the
 * merchant waits for its next turn on the shared cadence.
 */
export function takeShout(s: MerchantSchedule, state: { shoutSlot: number }, now: number): number {
  const slot = shoutSlotAt(s, now);
  if (slot <= state.shoutSlot) return -1;
  const at = shoutTime(s, slot);
  if (now < at) return -1;
  state.shoutSlot = slot;
  return now - at <= SHOUT_LATE_MS ? now - at : -1;
}
