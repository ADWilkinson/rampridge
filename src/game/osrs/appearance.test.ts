import { describe, expect, it } from "vitest";
import type { Appearance } from "@shared/protocol";

import { isValidAppearance } from "./appearance";
import { DESIGNER_COLOR_COUNTS, DESIGNER_KIT_COUNTS } from "./catalog.generated";
import { OsrsCharacterFactory, provideActors } from "./factory";
import { loadBakedActors } from "./testing";

// The baked actors.bin is not committed (it is Jagex's data): everything below isValidAppearance
// reads the real kits and skips until `bun run setup:assets` has baked it.
const baked = await loadBakedActors();
const data = baked!;
const factory = new OsrsCharacterFactory();
if (baked) factory.attach(provideActors(baked));

const base: Appearance = { body: 0, kits: [0, 0, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] };

describe("isValidAppearance", () => {
  it("accepts in-range appearances for both bodies", () => {
    expect(isValidAppearance(base)).toBe(true);
    const female: Appearance = {
      body: 1,
      kits: DESIGNER_KIT_COUNTS[1].map((n) => n - 1) as Appearance["kits"],
      colors: DESIGNER_COLOR_COUNTS.map((n) => n - 1) as Appearance["colors"],
    };
    expect(isValidAppearance(female)).toBe(true);
  });

  it("rejects out-of-range, malformed and hostile values", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "appearance",
      { ...base, body: 2 },
      { ...base, kits: [0, 0, 0, 0, 0, 0] },
      { ...base, kits: [0, 0, 0, 0, 0, 0, 0, 0] },
      { ...base, kits: [DESIGNER_KIT_COUNTS[0][0], 0, 0, 0, 0, 0, 0] },
      { ...base, kits: [-1, 0, 0, 0, 0, 0, 0] },
      { ...base, kits: [0.5, 0, 0, 0, 0, 0, 0] },
      { ...base, kits: ["0", 0, 0, 0, 0, 0, 0] },
      // Skin 8+ are unlockable reward colours, not designer choices.
      { ...base, colors: [0, 0, 0, 0, 8] },
      { ...base, colors: [25, 0, 0, 0, 0] },
      { ...base, colors: [0, 0, 0, 0] },
      { body: 0, kits: base.kits },
    ];
    for (const a of bad) expect(isValidAppearance(a)).toBe(false);
  });

  it("checks kit ranges per body type", () => {
    // Male and female hair lists differ in length.
    const maleOnly = DESIGNER_KIT_COUNTS[0][0]! - 1;
    const female = { ...base, body: 1 as const, kits: [maleOnly, 0, 0, 0, 0, 0, 0] as Appearance["kits"] };
    expect(isValidAppearance(female)).toBe(maleOnly < DESIGNER_KIT_COUNTS[1][0]!);
  });
});

describe.skipIf(!baked)("randomAppearance", () => {
  it("is deterministic per seed and always valid", () => {
    const bodies = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const a = factory.randomAppearance(`merchant-${i}`);
      expect(isValidAppearance(a)).toBe(true);
      expect(factory.randomAppearance(`merchant-${i}`)).toEqual(a);
      bodies.add(a.body);
      // Torso and legs never share a colour.
      expect(a.colors[1]).not.toBe(a.colors[2]);
    }
    expect(bodies).toEqual(new Set([0, 1]));
    expect(factory.randomAppearance("a")).not.toEqual(factory.randomAppearance("b"));
  });

  it("never gives a woman a beard", () => {
    let women = 0;
    for (let i = 0; i < 1000; i++) {
      const a = factory.randomAppearance(`guest-${i}`);
      if (a.body !== 1) continue;
      women++;
      expect(jawKit(1, a.kits[1])).toBe(CLEAN_FEMALE_JAW);
    }
    expect(women).toBeGreaterThan(400);
  });
});

/** Cache id of the kit behind a designer jaw option. */
function jawKit(body: 0 | 1, option: number): number {
  return data.kits[data.designer[body][1]![option]!]!.id;
}
const CLEAN_FEMALE_JAW = 296;

describe.skipIf(!baked)("designer catalog", () => {
  it("lists every kit and colour with CSS swatches", () => {
    const catalog = factory.designer();
    for (const body of [0, 1] as const) {
      expect(catalog.kits[body].map((s) => s.length)).toEqual([...DESIGNER_KIT_COUNTS[body]]);
      catalog.kits[body].forEach((slot) => slot.forEach((o, i) => expect(o.index).toBe(i)));
    }
    expect(catalog.colors.map((c) => c.length)).toEqual([...DESIGNER_COLOR_COUNTS]);
    for (const channel of catalog.colors) for (const o of channel) expect(o.swatch).toMatch(/^#[0-9a-f]{6}$/);
    // Hair 0 is the original dark brown; skin 0 the original light tone.
    expect(catalog.colors[0]![0]!.swatch).not.toBe(catalog.colors[0]![1]!.swatch);
  });

  it("starts each list with the client default, so body B's first jaw is clean-shaven", () => {
    // The 2007 client gave body B no jaw; the clean chin 296 stands in for it, then the rest in cache order.
    expect(data.designer[1][1]!.map((k) => data.kits[k]!.id)).toEqual([296, 292, 293, 294, 295, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306]);
    // Body A keeps the client's own order: the first selectable kit of every slot.
    expect(data.designer[0].map((slot) => data.kits[slot[0]!]!.id)).toEqual([0, 10, 18, 26, 33, 36, 42]);
    expect(data.designer[1].map((slot) => data.kits[slot[0]!]!.id)).toEqual([45, 296, 56, 61, 67, 70, 79]);
  });

  it("exposes the default kits per body as valid appearances", () => {
    const { defaults } = factory.designer();
    expect(defaults).toEqual({ 0: [0, 0, 0, 0, 0, 0, 0], 1: [0, 0, 0, 0, 0, 0, 0] });
    for (const body of [0, 1] as const) {
      expect(isValidAppearance({ body, kits: defaults![body], colors: [0, 0, 0, 0, 0] })).toBe(true);
    }
    expect(jawKit(1, defaults![1][1])).toBe(CLEAN_FEMALE_JAW);
  });
});

describe.skipIf(!baked)("playerModel", () => {
  const faces = (a: Appearance) => factory.playerModel(a).faceCount;
  const female: Appearance = { body: 1, kits: [0, 0, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] };
  const kitFaces = (body: 0 | 1, slot: number, option: number) =>
    data.kits[data.designer[body][slot]![option]!]!.models.reduce((n, m) => n + data.models[m]!.faceCount, 0);

  it("renders a negative kit (the client's -1) as the slot's default, so body B gets the clean chin", () => {
    expect(factory.playerModel({ ...female, kits: [0, -1, 0, 0, 0, 0, 0] })).toBe(factory.playerModel(female));
    expect(factory.playerModel({ ...female, kits: [0, -7, 0, 0, 0, 0, 0] })).toBe(factory.playerModel(female));
    // The clean chin is the smallest jaw kit; the goatee that used to be option 0 is larger.
    expect(kitFaces(1, 1, 0)).toBeLessThan(kitFaces(1, 1, 1));
  });

  it("clamps out-of-range and non-integer kits instead of throwing", () => {
    const last = DESIGNER_KIT_COUNTS[1][0]! - 1;
    expect(faces({ ...female, kits: [999, 0, 0, 0, 0, 0, 0] })).toBe(faces({ ...female, kits: [last, 0, 0, 0, 0, 0, 0] }));
    expect(faces({ ...female, kits: [0.5, 0, 0, 0, 0, 0, 0] })).toBe(faces(female));
  });
});
