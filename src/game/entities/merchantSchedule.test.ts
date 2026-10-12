import { describe, expect, it } from "vitest";
import collision from "@shared/collision.json";
import metaJson from "@shared/world-meta.json";
import { positionAt, type Tile } from "@shared/protocol";
import { CHAT_LIFETIME_MS } from "../overlay/chatEffects";
import { CollisionMap } from "../world/collision";
import { isValidPath } from "../world/pathfinding";
import { parseWorldMeta } from "../world/worldMeta";
import {
  MERCHANT_PITCHES,
  SEGMENT_MS,
  SHOUT_GAP_MS,
  SHOUT_LATE_MS,
  SHOUT_SLOT_MS,
  createSchedule,
  destinationAt,
  lastShoutSlot,
  merchantPitches,
  pitchHome,
  pitchPath,
  segmentAt,
  segmentMotion,
  shoutCadence,
  shoutSlotAt,
  shoutTime,
  takeShout,
  type MerchantSchedule,
} from "./merchantSchedule";

const map = CollisionMap.from(collision);
const meta = parseWorldMeta(metaJson);
map.setBounds(meta.bounds);
const area = meta.merchantArea.filter((t) => map.isWalkable(t.x, t.y));

function rect(x0: number, x1: number, y0: number, y1: number): Tile[] {
  const out: Tile[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (map.isWalkable(x, y)) out.push({ x, y });
  return out;
}

/** The baked strip and wider customer-side areas a re-bake may produce. */
const AREAS: Record<string, Tile[]> = {
  baked: area,
  aisle4: rect(3181, 3184, 3435, 3445),
  hall: rect(3180, 3185, 3434, 3446),
  eight: rect(3182, 3183, 3435, 3438),
};

const key = (t: Tile) => `${t.x},${t.y}`;
const chebyshev = (a: Tile, b: Tile) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function schedulesFor(tiles: readonly Tile[], count: number): MerchantSchedule[] {
  return merchantPitches(tiles, count, map).map((pitch, i) => createSchedule(`merchant-${i}`, pitch, shoutCadence(i, count)));
}

describe("merchant pitches", () => {
  it("cut the area into disjoint pitches, one per merchant, covering it", () => {
    for (const [name, tiles] of Object.entries(AREAS)) {
      for (const count of [1, 3, 6, 8, 12]) {
        const pitches = merchantPitches(tiles, count, map);
        expect(pitches, name).toHaveLength(count);
        const owner = new Map<string, number>();
        pitches.forEach((pitch, i) => {
          expect(pitch.length, `${name} ${count} #${i}`).toBeGreaterThan(0);
          for (const t of pitch) {
            const prev = owner.get(key(t));
            if (count <= tiles.length) expect(prev === undefined || prev === i, `${name} ${count} ${key(t)}`).toBe(true);
            owner.set(key(t), i);
          }
        });
        if (count >= MERCHANT_PITCHES && count <= tiles.length) expect(owner.size).toBe(tiles.length);
      }
    }
  });

  it("keep each merchant's pitch when the list is cut short (phones show fewer)", () => {
    for (const tiles of Object.values(AREAS)) {
      const eight = merchantPitches(tiles, 8, map);
      for (const count of [1, 3, 6, 7]) expect(merchantPitches(tiles, count, map)).toEqual(eight.slice(0, count));
    }
  });

  it("are near-equal in size", () => {
    for (const [name, tiles] of Object.entries(AREAS)) {
      const sizes = merchantPitches(tiles, 8, map).map((p) => p.length);
      expect(Math.max(...sizes) - Math.min(...sizes), name).toBeLessThanOrEqual(Math.ceil(tiles.length / 8) + 1);
    }
  });

  it("put homes at least two tiles apart when the area has room", () => {
    for (const [name, tiles] of Object.entries(AREAS)) {
      // Room: eight tiles no two of which touch.
      const apart: Tile[] = [];
      for (const t of tiles) if (apart.every((o) => chebyshev(o, t) >= 2)) apart.push(t);
      if (apart.length < 8) continue;
      const homes = merchantPitches(tiles, 8, map).map((p) => pitchHome(p)!);
      for (let a = 0; a < homes.length; a++) {
        for (let b = a + 1; b < homes.length; b++) expect(chebyshev(homes[a]!, homes[b]!), name).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("spread a short list over the hall, starting at the entrance end", () => {
    const homes = merchantPitches(area, 3, map).map((p) => pitchHome(p)!);
    const ys = area.map((t) => t.y);
    expect(homes[0]!.y - Math.min(...ys)).toBeLessThanOrEqual(1);
    expect(Math.max(...ys) - homes[1]!.y).toBeLessThanOrEqual(1);
    expect(Math.abs(homes[2]!.y - (Math.min(...ys) + Math.max(...ys)) / 2)).toBeLessThanOrEqual(2);
  });

  it("handles areas smaller than the merchant list and empty areas", () => {
    const tiny = AREAS.eight!.slice(0, 3);
    const pitches = merchantPitches(tiny, 5);
    expect(pitches).toHaveLength(5);
    expect(pitches.every((p) => p.length === 1)).toBe(true);
    expect(merchantPitches([], 2)).toEqual([[], []]);
    expect(merchantPitches(area, 0)).toEqual([]);
  });
});

describe("merchant schedule", () => {
  const pitch = merchantPitches(area, 8, map)[1]!;

  it("is identical on every client for the same seed and pitch", () => {
    const a = createSchedule("revolut:GBP", pitch);
    const b = createSchedule("revolut:GBP", pitch);
    for (let k = 100; k < 140; k++) expect(segmentMotion(map, a, k)).toEqual(segmentMotion(map, b, k));
  });

  it("differs between merchants", () => {
    const a = createSchedule("revolut:GBP", area);
    const b = createSchedule("venmo:USD", area);
    const da = Array.from({ length: 20 }, (_, k) => destinationAt(a, k));
    const db = Array.from({ length: 20 }, (_, k) => destinationAt(b, k));
    expect(da).not.toEqual(db);
  });

  it("only walks to tiles of its own pitch, on legal paths that finish within the segment", () => {
    for (const [i, p] of merchantPitches(AREAS.hall!, 8, map).entries()) {
      const s = createSchedule(`wise:EUR:${i}`, p);
      const own = new Set(p.map(key));
      for (let k = 1_000; k < 1_100; k++) {
        const m = segmentMotion(map, s, k);
        expect(own.has(key(m.path.at(-1)!))).toBe(true);
        expect(isValidPath(map, m.path)).toBe(true);
        const end = m.startedAt + (m.path.length - 1) * 600;
        expect(end).toBeLessThanOrEqual(s.phase + (k + 1) * SEGMENT_MS);
      }
    }
  });

  it("walks inside its pitch: every tile of a pitch reaches every other without leaving it", () => {
    for (const [name, tiles] of Object.entries(AREAS)) {
      for (const p of merchantPitches(tiles, 8, map)) {
        for (const a of p) {
          for (const b of p) {
            const path = pitchPath(map, p, a, b);
            expect(path, `${name} ${key(a)} -> ${key(b)}`).not.toBeNull();
            expect(isValidPath(map, path!)).toBe(true);
            for (const t of path!) expect(p.some((q) => q.x === t.x && q.y === t.y)).toBe(true);
          }
        }
      }
    }
    expect(pitchPath(map, [{ x: 3182, y: 3440 }], { x: 3182, y: 3440 }, { x: 3183, y: 3440 })).toBeNull();
  });

  it("is continuous: each walk starts where the previous one ended", () => {
    const s = createSchedule("cashapp:USD", pitch);
    for (let k = 50; k < 150; k++) {
      const prev = segmentMotion(map, s, k - 1);
      const next = segmentMotion(map, s, k);
      expect(next.path[0]).toEqual(prev.path.at(-1));
    }
  });

  it("idles some segments", () => {
    const s = createSchedule("zelle:USD", area);
    let idle = 0;
    for (let k = 0; k < 300; k++) if (segmentMotion(map, s, k).path.length === 1) idle++;
    expect(idle).toBeGreaterThan(50);
    expect(idle).toBeLessThan(250);
  });

  it("maps server time to segments", () => {
    const s = createSchedule("x", area);
    const t = s.phase + 42 * SEGMENT_MS + 5;
    expect(segmentAt(s, t)).toBe(42);
  });

  it("never puts two merchants on one tile (sampled like the audit, every 500 ms for an hour)", () => {
    for (const [name, tiles] of Object.entries(AREAS)) {
      if (tiles.length < 8) continue;
      const schedules = schedulesFor(tiles, 8);
      const t0 = 1_760_000_000_000;
      let shared = 0;
      for (let t = t0; t < t0 + 3_600_000; t += 500) {
        const seen = new Set<string>();
        for (const s of schedules) {
          const m = segmentMotion(map, s, segmentAt(s, t));
          const at = m.path[positionAt(m.path, m.startedAt, m.run, t).index]!;
          if (seen.has(key(at))) shared++;
          seen.add(key(at));
        }
      }
      expect(shared, name).toBe(0);
    }
  });
});

describe("merchant shouts", () => {
  it("take turns: at most three are up at once, whatever the merchant count", () => {
    for (let count = 1; count <= 12; count++) {
      const schedules = schedulesFor(area, count);
      const starts: number[] = [];
      const t0 = 1_760_000_000_000;
      for (const s of schedules) {
        for (let j = shoutSlotAt(s, t0); j < shoutSlotAt(s, t0 + 600_000); j++) starts.push(shoutTime(s, j));
      }
      starts.sort((a, b) => a - b);
      let worst = 0;
      for (let i = 0; i < starts.length; i++) {
        let live = 1;
        while (i + live < starts.length && starts[i + live]! - starts[i]! < CHAT_LIFETIME_MS) live++;
        worst = Math.max(worst, live);
      }
      expect(worst, `count ${count}`).toBeLessThanOrEqual(3);
    }
  });

  it("each merchant shouts once a period: every 6 to 10 s when there are few, rarer when the hall is busy", () => {
    for (const count of [1, 2, 6, 8]) {
      const c = shoutCadence(0, count);
      expect(c.period).toBe(Math.max(SHOUT_SLOT_MS, count * SHOUT_GAP_MS));
      const s = createSchedule("monzo:GBP", area, shoutCadence(count - 1, count));
      for (let j = 10; j < 400; j++) {
        const gap = shoutTime(s, j + 1) - shoutTime(s, j);
        expect(gap).toBeGreaterThanOrEqual(c.period - c.jitter);
        expect(gap).toBeLessThanOrEqual(c.period + c.jitter);
        // The shout lands inside its own slot.
        expect(shoutSlotAt(s, shoutTime(s, j))).toBe(j);
      }
    }
  });

  it("staggers merchants evenly through the period", () => {
    const phases = Array.from({ length: 8 }, (_, i) => shoutCadence(i, 8).phase);
    expect(phases).toEqual([0, 2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 14_000]);
    expect(shoutCadence(1, 3).phase).toBe(2_667);
  });

  it("plays only shouts still to come when a merchant appears", () => {
    const s = createSchedule("wise:USD", area, shoutCadence(2, 8));
    const t = shoutTime(s, 500);
    expect(lastShoutSlot(s, t - 1)).toBe(499);
    expect(lastShoutSlot(s, t)).toBe(500);
  });
});

/** A shout as the engine plays it: started on a frame, dated from its slot time (ends on schedule). */
interface Played {
  frame: number;
  at: number;
}

/**
 * Runs the engine's per-frame shout step (updateMerchants -> takeShout) for
 * `count` merchants over frames at `frames` (server ms), as merchants that
 * appeared at the first frame (setMerchants: lastShoutSlot).
 */
function playShouts(count: number, frames: readonly number[]): Played[] {
  const schedules = schedulesFor(area, count);
  const states = schedules.map((s) => ({ shoutSlot: lastShoutSlot(s, frames[0]!) }));
  const played: Played[] = [];
  for (const now of frames) {
    schedules.forEach((s, i) => {
      const late = takeShout(s, states[i]!, now);
      if (late >= 0) played.push({ frame: now, at: now - late });
    });
  }
  return played;
}

/** Frame times every `step` ms over [from, to). */
function frameTimes(from: number, to: number, step = 16): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += step) out.push(t);
  return out;
}

/** Most shouts up at once: each is up from its frame until CHAT_LIFETIME_MS after its slot time. */
function mostUpAtOnce(played: readonly Played[]): number {
  let worst = 0;
  for (const p of played) {
    const up = played.filter((q) => q.frame <= p.frame && q.at + CHAT_LIFETIME_MS > p.frame).length;
    worst = Math.max(worst, up);
  }
  return worst;
}

describe("merchant shouts after the frame loop pauses (hidden tab, app switch)", () => {
  const t0 = 1_760_000_000_000;

  it("re-anchor to now: no burst on the resume frame, then the staggered cadence", () => {
    for (const count of [2, 3, 6, 8, 12]) {
      const { period, jitter } = shoutCadence(0, count);
      const gapMs = period / count;
      for (const pause of [2_500, 5_000, 9_000, 17_000, 45_000, 10 * 60_000]) {
        for (const start of [0, 777, 5_432]) {
          const before = frameTimes(t0 + start, t0 + start + 30_000);
          const resume = before.at(-1)! + pause;
          const after = frameTimes(resume, resume + 60_000);
          const played = playShouts(count, [...before, ...after]);
          const label = `count ${count}, pause ${pause}, start ${start}`;

          // Every merchant whose turn passed during the pause would have shouted on the resume frame.
          const missed = schedulesFor(area, count).filter((s) => resume >= shoutTime(s, shoutSlotAt(s, resume))).length;
          if (pause > period) expect(missed, label).toBeGreaterThanOrEqual(count - 1);

          const onResume = played.filter((p) => p.frame === resume);
          expect(onResume.length, label).toBeLessThanOrEqual(1);
          for (const p of onResume) expect(resume - p.at, label).toBeLessThanOrEqual(SHOUT_LATE_MS);
          expect(mostUpAtOnce(played), label).toBeLessThanOrEqual(3);

          // The hall picks the cadence back up: the next shout comes within a turn, then one about every turn.
          const resumed = played.filter((p) => p.frame >= resume);
          expect(resumed[0]!.frame - resume, label).toBeLessThanOrEqual(gapMs + jitter + 16);
          expect(resumed.length, label).toBeGreaterThanOrEqual(Math.floor(60_000 / gapMs) - 1);
          expect(resumed.length, label).toBeLessThanOrEqual(Math.ceil(60_000 / gapMs) + 1);
        }
      }
    }
  });

  it("starts about every 2 s across a full hall once resumed", () => {
    const before = frameTimes(t0, t0 + 20_000);
    const resume = before.at(-1)! + 120_000;
    const played = playShouts(8, [...before, ...frameTimes(resume, resume + 120_000)]).filter((p) => p.frame >= resume);
    const spacing = played.slice(1).map((p, i) => p.frame - played[i]!.frame);
    const mean = spacing.reduce((a, b) => a + b, 0) / spacing.length;
    expect(mean).toBeGreaterThan(SHOUT_GAP_MS * 0.9);
    expect(mean).toBeLessThan(SHOUT_GAP_MS * 1.1);
    expect(Math.min(...spacing)).toBeGreaterThanOrEqual(SHOUT_GAP_MS * 0.7 - 16);
  });

  it("still plays a shout a slow frame reached late, dated from its time so it ends on schedule", () => {
    const s = createSchedule("revolut:GBP", area, shoutCadence(1, 6));
    const at = shoutTime(s, 900);
    const state = { shoutSlot: 899 };
    expect(takeShout(s, state, at - 1)).toBe(-1);
    expect(takeShout(s, state, at + 400)).toBe(400);
    expect(state.shoutSlot).toBe(900);
    // Once handled, the slot never plays again.
    expect(takeShout(s, state, at + 500)).toBe(-1);
  });

  it("skips a shout missed by more than SHOUT_LATE_MS and waits for the next turn", () => {
    const s = createSchedule("wise:EUR", area, shoutCadence(4, 8));
    const at = shoutTime(s, 900);
    const state = { shoutSlot: 899 };
    expect(takeShout(s, state, at + SHOUT_LATE_MS + 1)).toBe(-1);
    expect(state.shoutSlot).toBe(900);
    const next = shoutTime(s, 901);
    expect(takeShout(s, state, next - 1)).toBe(-1);
    expect(takeShout(s, state, next)).toBe(0);
  });
});
