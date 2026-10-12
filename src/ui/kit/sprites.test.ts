import { describe, expect, it } from "vitest";
import { SPRITE_BASE, UI_SPRITE_IDS, UI_SPRITE_REFS, coinsSpriteFor, parseSpriteManifest } from "./sprites";

describe("parseSpriteManifest", () => {
  it("reads the bake's named manifest", () => {
    const m = parseSpriteManifest({
      close_button: { file: "close_button.png", w: 21, h: 21, id: 535, frame: 0 },
      item_coins_1000: { file: "item_coins_1000.png", id: 995, frame: 1000 },
    });
    expect(m.byName.get("close_button")).toBe(`${SPRITE_BASE}close_button.png`);
    expect(m.byId.get("535_0")).toBe(`${SPRITE_BASE}close_button.png`);
    expect(m.byId.get("995_1000")).toBe(`${SPRITE_BASE}item_coins_1000.png`);
  });

  it("reads the research manifest keyed by archive id with frames", () => {
    const m = parseSpriteManifest({ "299": { label: "cross_click", frames: [{ file: "299_0.png" }, { file: "299_1.png" }] } });
    expect(m.byId.get("299_0")).toBe(`${SPRITE_BASE}299_0.png`);
    expect(m.byId.get("299_1")).toBe(`${SPRITE_BASE}299_1.png`);
  });

  it("reads arrays, id_frame keys, RuneLite names and absolute paths", () => {
    expect(parseSpriteManifest([{ id: 1017, frame: 0, file: "/x/chat.png" }]).byId.get("1017_0")).toBe("/x/chat.png");
    expect(parseSpriteManifest({ "1031_0": { file: "side.png" } }).byId.get("1031_0")).toBe(`${SPRITE_BASE}side.png`);
    expect(parseSpriteManifest({ sprites: { "CloseButtons._1": "hover.png" } }).byId.get("536_0")).toBe(`${SPRITE_BASE}hover.png`);
  });

  it("tolerates junk", () => {
    expect(parseSpriteManifest(null).byId.size).toBe(0);
    expect(parseSpriteManifest({ a: 3, b: { nope: true } }).byName.size).toBe(0);
  });
});

describe("registry", () => {
  it("lists every referenced sprite once with unique names", () => {
    const names = UI_SPRITE_REFS.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(UI_SPRITE_IDS).toContain(535);
    expect(UI_SPRITE_IDS).not.toContain(995);
  });

  it("picks the coins pile the client draws for a stack", () => {
    expect(coinsSpriteFor(1)).toBe("itemCoins1");
    expect(coinsSpriteFor(4)).toBe("itemCoins4");
    expect(coinsSpriteFor(24)).toBe("itemCoins5");
    expect(coinsSpriteFor(25)).toBe("itemCoins25");
    expect(coinsSpriteFor(999)).toBe("itemCoins250");
    expect(coinsSpriteFor(9_999)).toBe("itemCoins1000");
    expect(coinsSpriteFor(1_000_000)).toBe("itemCoins10000");
    expect(coinsSpriteFor(0)).toBe("itemCoins1");
  });
});
