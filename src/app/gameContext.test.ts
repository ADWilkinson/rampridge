import { describe, expect, it } from "vitest";
import type { Appearance } from "@shared/protocol";
import { bankerNpcIdFor, chatheadSource } from "./gameContext";

const LOOK: Appearance = { body: 0, kits: [0, 10, 18, 26, 33, 36, 42], colors: [0, 1, 2, 3, 4] } as Appearance;
const looks = {
  isValidAppearance: (a: Appearance) => a === LOOK,
  randomAppearance: (seed: string) => ({ ...LOOK, seedFor: seed }) as unknown as Appearance,
};

describe("dialogue chatheads", () => {
  it("draws a player from their look in the world, and nobody when it is unknown or invalid", () => {
    const players = { me: { a: LOOK }, odd: { a: { ...LOOK } as Appearance } };
    expect(chatheadSource({ pid: "me" }, looks, players, 2897)).toBe(LOOK);
    expect(chatheadSource({ pid: "odd" }, looks, players, 2897)).toBeNull();
    expect(chatheadSource({ pid: "gone" }, looks, players, 2897)).toBeNull();
  });

  it("draws a merchant in the look the engine seeds from its id", () => {
    expect(chatheadSource({ merchantId: "revolut:GBP" }, looks, {}, 2897)).toMatchObject({ seedFor: "revolut:GBP" });
  });

  it("draws a cache NPC by id, and the banker last used for the banker", () => {
    expect(chatheadSource({ npcId: 8666 }, looks, {}, 2897)).toEqual({ npcId: 8666 });
    expect(chatheadSource({ npc: "banker" }, looks, {}, 2898)).toEqual({ npcId: 2898 });
  });

  it("maps the banker last used to their NPC id, falling back to the first banker", () => {
    const ids = [2898, 2897, 2898, 2897, 8666];
    expect(bankerNpcIdFor(ids, 1)).toBe(2897);
    expect(bankerNpcIdFor(ids, 2)).toBe(2898);
    expect(bankerNpcIdFor(ids, null)).toBe(2898);
    expect(bankerNpcIdFor(ids, 40)).toBe(2898);
    // Before the world meta loads: a booth banker.
    expect(bankerNpcIdFor(null, 1)).toBe(2897);
  });
});
