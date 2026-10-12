import { describe, expect, it } from "vitest";
import { TICK_MS, positionAt, type Tile } from "@shared/protocol";
import { createSample, motionEnd, nextStop, sampleMotion, tileAt, type Motion } from "./motion";

const path: Tile[] = [
  { x: 10, y: 10 },
  { x: 11, y: 10 },
  { x: 12, y: 11 },
  { x: 12, y: 12 },
];

describe("path replay timing", () => {
  it("walks one tile per 600 ms tick", () => {
    const m: Motion = { path, startedAt: 1_000, run: false };
    const s = createSample();
    sampleMotion(m, 1_000, s);
    expect([s.x, s.y, s.moving]).toEqual([10, 10, true]);
    sampleMotion(m, 1_000 + TICK_MS / 2, s);
    expect(s.x).toBeCloseTo(10.5);
    expect(s.y).toBe(10);
    sampleMotion(m, 1_000 + TICK_MS * 1.5, s);
    expect(s.x).toBeCloseTo(11.5);
    expect(s.y).toBeCloseTo(10.5);
    expect([s.dirX, s.dirY]).toEqual([1, 1]);
    sampleMotion(m, 1_000 + TICK_MS * 3, s);
    expect([s.x, s.y, s.moving, s.done]).toEqual([12, 12, false, true]);
  });

  it("runs two tiles per tick", () => {
    const m: Motion = { path, startedAt: 0, run: true };
    const s = sampleMotion(m, TICK_MS, createSample());
    expect([s.x, s.y]).toEqual([12, 11]);
    expect(motionEnd(m)).toBe(TICK_MS * 1.5);
  });

  it("matches shared/protocol positionAt exactly", () => {
    const m: Motion = { path, startedAt: 5_000, run: false };
    const s = createSample();
    for (let now = 4_000; now < 8_000; now += 37) {
      const ref = positionAt(path, 5_000, false, now);
      sampleMotion(m, now, s);
      expect(s.index).toBe(ref.index);
      expect(s.done).toBe(ref.done);
    }
  });

  it("stands still before the path starts", () => {
    const m: Motion = { path, startedAt: 10_000, run: false };
    const s = sampleMotion(m, 9_000, createSample());
    expect([s.x, s.y, s.moving]).toEqual([10, 10, false]);
  });

  it("a new path mid-step starts from the next tile when it is reached", () => {
    const m: Motion = { path, startedAt: 0, run: false };
    const stop = nextStop(m, 900);
    expect(stop.tile).toEqual({ x: 12, y: 11 });
    expect(stop.at).toBe(1_200);
    const done = nextStop(m, 10_000);
    expect(done.tile).toEqual({ x: 12, y: 12 });
    expect(done.at).toBe(10_000);
  });

  it("reports the last reached tile", () => {
    const m: Motion = { path, startedAt: 0, run: false };
    expect(tileAt(m, 0)).toEqual({ x: 10, y: 10 });
    expect(tileAt(m, 650)).toEqual({ x: 11, y: 10 });
    expect(tileAt(m, 99_999)).toEqual({ x: 12, y: 12 });
  });
});
