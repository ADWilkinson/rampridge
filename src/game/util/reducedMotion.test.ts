import { describe, expect, it } from "vitest";
import { ReducedMotion, type MotionQuery } from "./reducedMotion";

function fakeQuery(matches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query: MotionQuery & { matches: boolean; fire(matches: boolean): void; listeners: typeof listeners } = {
    matches,
    listeners,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    fire(next) {
      this.matches = next;
      for (const fn of listeners) fn({ matches: next });
    },
  };
  return query;
}

describe("ReducedMotion", () => {
  it("is the setting OR the system preference", () => {
    const query = fakeQuery(false);
    const changes: boolean[] = [];
    const motion = new ReducedMotion((reduced) => changes.push(reduced), query);
    expect(motion.reduced).toBe(false);

    motion.setSetting(true);
    expect(motion.reduced).toBe(true);
    query.fire(true);
    expect(motion.reduced).toBe(true);
    motion.setSetting(false);
    expect(motion.reduced).toBe(true);
    query.fire(false);
    expect(motion.reduced).toBe(false);
    // Only flips of the combined value are reported.
    expect(changes).toEqual([true, false]);
  });

  it("starts from the system preference", () => {
    const motion = new ReducedMotion(() => undefined, fakeQuery(true));
    expect(motion.reduced).toBe(true);
    motion.setSetting(false);
    expect(motion.reduced).toBe(true);
  });

  it("works without matchMedia and stops listening when disposed", () => {
    const bare = new ReducedMotion(() => undefined, null);
    bare.setSetting(true);
    expect(bare.reduced).toBe(true);

    const query = fakeQuery(false);
    const motion = new ReducedMotion(() => undefined, query);
    expect(query.listeners.size).toBe(1);
    motion.dispose();
    expect(query.listeners.size).toBe(0);
  });
});
