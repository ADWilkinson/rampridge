/**
 * Character-designer colour tables. These live in the game client, not the
 * cache: they are the static arrays PlayerComposition recolours with
 * (open-osrs runescape-client class292, the same values the 2007 client used
 * for its first 12/16/16/6/8 entries). Values are HSL16 as signed shorts,
 * exactly as the client declares them; the bake stores them unsigned.
 *
 * Merge-then-recolour order (PlayerComposition.getModel): for each channel,
 * recolour source -> colors[i] when i < colors.length, then source2 ->
 * colors2[i] when i < colors2.length. The model is then lit with
 * (64, 850, -30, -50, -30).
 */

export interface ClientColorChannel {
  name: "hair" | "torso" | "legs" | "feet" | "skin";
  source: number;
  colors: number[];
  source2: number;
  colors2: number[];
  /**
   * Entries the character designer offers. Skin colours 8+ (green, black,
   * white, blue, purple) are unlockable rewards, not designer choices.
   */
  designerCount: number;
}

export const CLIENT_COLOR_CHANNELS: ClientColorChannel[] = [
  {
    name: "hair",
    source: 6798,
    colors: [
      6798, 107, 10283, 16, 4797, 7744, 5799, 4634, -31839, 22433, 2983, -11343, 8, 5281, 10438, 3650, -27322, -21845,
      200, 571, 908, 21830, 28946, -15701, -14010,
    ],
    source2: -10304,
    colors2: [
      6554, 115, 10304, 28, 5702, 7756, 5681, 4510, -31835, 22437, 2859, -11339, 16, 5157, 10446, 3658, -27314, -21965,
      472, 580, 784, 21966, 28950, -15697, -14002,
    ],
    designerCount: 25,
  },
  {
    name: "torso",
    source: 8741,
    colors: [
      8741, 12, -1506, -22374, 7735, 8404, 1701, -27106, 24094, 10153, -8915, 4783, 1341, 16578, -30533, 25239, 8, 5281,
      10438, 3650, -27322, -21845, 200, 571, 908, 21830, 28946, -15701, -14010,
    ],
    source2: 9104,
    colors2: [
      9104, 10275, 7595, 3610, 7975, 8526, 918, -26734, 24466, 10145, -6882, 5027, 1457, 16565, -30545, 25486, 24, 5392,
      10429, 3673, -27335, -21957, 192, 687, 412, 21821, 28835, -15460, -14019,
    ],
    designerCount: 29,
  },
  {
    name: "legs",
    source: 25238,
    colors: [
      25238, 8742, 12, -1506, -22374, 7735, 8404, 1701, -27106, 24094, 10153, -8915, 4783, 1341, 16578, -30533, 8, 5281,
      10438, 3650, -27322, -21845, 200, 571, 908, 21830, 28946, -15701, -14010,
    ],
    source2: -1,
    colors2: [],
    designerCount: 29,
  },
  {
    name: "feet",
    source: 4626,
    colors: [4626, 11146, 6439, 12, 4758, 10270],
    source2: -1,
    colors2: [],
    designerCount: 6,
  },
  {
    name: "skin",
    source: 4550,
    colors: [4550, 4537, 5681, 5673, 5790, 6806, 8076, 4574, 17050, 0, 127, -31821, -17991],
    source2: -1,
    colors2: [],
    designerCount: 8,
  },
];

/** Signed short to unsigned HSL16. */
export function hsl16(v: number): number {
  return v & 0xffff;
}
