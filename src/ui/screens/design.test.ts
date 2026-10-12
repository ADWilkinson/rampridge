import { describe, expect, it } from "vitest";
import type { Appearance } from "@shared/protocol";
import { OsrsCharacterFactory, provideActors } from "@/game/osrs/factory";
import { loadBakedActors } from "@/game/osrs/testing";
import type { DesignerCatalog } from "@/game/osrs/types";
import { JAW_SLOT, cycleOption, kitSlotEditable, switchBody } from "./design";

// The catalog comes from the baked actors.bin, which is not committed (it is Jagex's data): the
// tests that use it skip until `bun run setup:assets` has baked it.
const baked = await loadBakedActors();
const data = baked!;
const factory = new OsrsCharacterFactory();
if (baked) factory.attach(provideActors(baked));
const catalog = baked ? factory.designer() : null!;

/** Cache id of the kit behind a designer option. */
const kitId = (body: 0 | 1, slot: number, option: number) => data.kits[data.designer[body][slot]![option]!]!.id;
const CLEAN_FEMALE_JAW = 296;

describe.skipIf(!baked)("switchBody", () => {
  it("resets every kit to the new body's defaults and keeps the colours, like the 2007 designer", () => {
    const bearded: Appearance = { body: 0, kits: [5, 7, 3, 2, 1, 4, 1], colors: [3, 9, 2, 4, 1] };
    const female = switchBody(bearded, catalog, 1);
    expect(female).toEqual({ body: 1, kits: catalog.defaults![1], colors: bearded.colors });
    expect(kitId(1, JAW_SLOT, female.kits[JAW_SLOT])).toBe(CLEAN_FEMALE_JAW);
    expect(factory.isValidAppearance(female)).toBe(true);

    const male = switchBody(female, catalog, 0);
    expect(male.kits).toEqual(catalog.defaults![0]);
    expect(male.colors).toEqual(bearded.colors);
  });

  it("returns the same appearance when the body does not change", () => {
    const a: Appearance = { body: 1, kits: [2, 0, 1, 1, 0, 3, 0], colors: [0, 0, 0, 0, 0] };
    expect(switchBody(a, catalog, 1)).toBe(a);
  });

  it("does not share the defaults array with the catalog", () => {
    const a = switchBody({ body: 0, kits: [1, 1, 1, 1, 1, 1, 1], colors: [0, 0, 0, 0, 0] }, catalog, 1);
    expect(a.kits).not.toBe(catalog.defaults![1]);
  });
});

describe("switchBody without catalog defaults", () => {
  it("falls back to each list's first option when a catalog has no defaults", () => {
    const bare: DesignerCatalog = {
      kits: { 0: [[{ index: 0 }, { index: 1 }]], 1: [[{ index: 4 }, { index: 5 }]] } as unknown as DesignerCatalog["kits"],
      colors: [],
    };
    const a = switchBody({ body: 0, kits: [1, 0, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] }, bare, 1);
    expect(a.kits).toEqual([4]);
  });
});

describe.skipIf(!baked)("kitSlotEditable", () => {
  it("locks body B's jaw (the 2007 designer had none) and leaves every other slot editable", () => {
    for (let slot = 0; slot < 7; slot++) {
      expect(kitSlotEditable(catalog, 0, slot)).toBe(true);
      expect(kitSlotEditable(catalog, 1, slot)).toBe(slot !== JAW_SLOT);
    }
  });
});

describe("cycleOption", () => {
  const opts = [{ index: 0 }, { index: 1 }, { index: 2 }];
  it("wraps both ways and recovers from an unknown index", () => {
    expect(cycleOption(opts, 2, 1)).toBe(0);
    expect(cycleOption(opts, 0, -1)).toBe(2);
    expect(cycleOption(opts, 9, 1)).toBe(0);
    expect(cycleOption(opts, 9, -1)).toBe(2);
    expect(cycleOption([], 4, 1)).toBe(4);
  });
});
