import { describe, expect, it } from "vitest";
import metaJson from "@shared/world-meta.json";
import { parseWorldMeta } from "../world/worldMeta";
import {
  HINT_ARROW_HEIGHT,
  HINT_ARROW_WIDTH,
  HINT_STORAGE_KEY,
  HintMemory,
  hintArrowPixels,
  hintBob,
  nearestBanker,
  type HintStorage,
} from "./hintArrow";

const meta = parseWorldMeta(metaJson);

function memoryStorage(): HintStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("nearestBanker", () => {
  it("marks the serving banker nearest the spawn inside the door", () => {
    const i = nearestBanker(meta.bankers, { x: 3182, y: 3435 });
    expect(meta.bankers[i]!.tile).toEqual({ x: 3187, y: 3438 });
    expect(nearestBanker(meta.bankers, { x: 3182, y: 3433 })).toBe(i);
  });

  it("follows the player up the hall, and never marks the guard who serves no booth", () => {
    expect(meta.bankers[nearestBanker(meta.bankers, { x: 3185, y: 3442 })]!.tile).toEqual({ x: 3187, y: 3442 });
    const guard = meta.bankers.findIndex((b) => !b.serves);
    expect(guard).toBeGreaterThanOrEqual(0);
    const fromGuard = nearestBanker(meta.bankers, meta.bankers[guard]!.tile);
    expect(fromGuard).not.toBe(guard);
    expect(meta.bankers[fromGuard]!.serves).toBe(true);
  });

  it("stays on the banker it marks until another is a tile closer", () => {
    const bankers = [
      { tile: { x: 10, y: 0 }, serves: true },
      { tile: { x: 10, y: 4 }, serves: true },
    ];
    // Just past halfway: the second is nearer, but not by a tile.
    expect(nearestBanker(bankers, { x: 8, y: 2.4 })).toBe(1);
    expect(nearestBanker(bankers, { x: 8, y: 2.4 }, 0)).toBe(0);
    // Well past: it moves.
    expect(nearestBanker(bankers, { x: 8, y: 3.5 }, 0)).toBe(1);
  });

  it("returns -1 when no banker serves", () => {
    expect(nearestBanker([{ tile: { x: 0, y: 0 }, serves: false }], { x: 0, y: 1 })).toBe(-1);
    expect(nearestBanker([], { x: 0, y: 0 }, 0)).toBe(-1);
  });
});

describe("HintMemory", () => {
  it("shows until dismissed, and remembers the dismissal on the device", () => {
    const storage = memoryStorage();
    const first = new HintMemory(() => storage);
    expect(first.dismissed).toBe(false);
    first.dismiss();
    expect(first.dismissed).toBe(true);
    expect(storage.data.get(HINT_STORAGE_KEY)).toBe("1");
    expect(new HintMemory(() => storage).dismissed).toBe(true);
  });

  it("shows when storage is missing or throws, and still dismisses for the session", () => {
    expect(new HintMemory(() => null).dismissed).toBe(false);
    const throwing: HintStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const memory = new HintMemory(() => throwing);
    expect(memory.dismissed).toBe(false);
    expect(() => memory.dismiss()).not.toThrow();
    expect(memory.dismissed).toBe(true);
    const blocked = new HintMemory(() => {
      throw new Error("localStorage is blocked");
    });
    expect(blocked.dismissed).toBe(false);
    expect(() => blocked.dismiss()).not.toThrow();
  });
});

describe("hint arrow drawing", () => {
  it("bobs a few pixels, and holds still under reduced motion", () => {
    const heights = Array.from({ length: 24 }, (_, i) => hintBob(i * 50, false));
    expect(Math.min(...heights)).toBe(0);
    expect(Math.max(...heights)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...heights)).toBeLessThanOrEqual(6);
    for (let t = 0; t < 2_000; t += 100) expect(hintBob(t, true)).toBe(0);
  });

  it("is a yellow downward arrow with a black outline and its tip at the bottom centre", () => {
    const px = hintArrowPixels();
    expect(px).toHaveLength(HINT_ARROW_WIDTH * HINT_ARROW_HEIGHT);
    const at = (x: number, y: number) => px[y * HINT_ARROW_WIDTH + x];
    const mid = (HINT_ARROW_WIDTH - 1) / 2;
    // Tip: the lowest coloured pixel, outlined below.
    expect(at(mid, HINT_ARROW_HEIGHT - 2)).not.toBe("#000000");
    expect(at(mid, HINT_ARROW_HEIGHT - 2)).not.toBeNull();
    expect(at(mid, HINT_ARROW_HEIGHT - 1)).toBe("#000000");
    expect(at(mid - 1, HINT_ARROW_HEIGHT - 2)).toBe("#000000");
    // Corners are clear; the shaft top is outlined.
    expect(at(0, 0)).toBeNull();
    expect(at(HINT_ARROW_WIDTH - 1, 0)).toBeNull();
    expect(at(mid, 0)).toBe("#000000");
    expect(at(mid, 1)).toMatch(/^#ff/);
    // The silhouette is symmetric.
    for (let y = 0; y < HINT_ARROW_HEIGHT; y++) {
      for (let x = 0; x < HINT_ARROW_WIDTH; x++) {
        expect(at(x, y) === null).toBe(at(HINT_ARROW_WIDTH - 1 - x, y) === null);
      }
    }
  });
});
