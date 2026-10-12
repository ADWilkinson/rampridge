import { describe, expect, it } from "vitest";

import { ACTOR_DATA_BYTES, DESIGNER_COLOR_COUNTS, DESIGNER_KIT_COUNTS } from "./catalog.generated";
import {
  ACTOR_DATA_MAGIC,
  ACTOR_DATA_VERSION,
  BODY_SLOTS,
  COLOR_CHANNELS,
  decodeActorData,
  encodeActorData,
  type ActorData,
  type ModelSource,
} from "./format";
import { BANKER_NPC_IDS, EMOTE_SEQUENCES, PLAYER_ANIMS } from "./sequences";
import { readBakedActors } from "./testing";

/** A made-up actor file that uses every field of the format, including the optional ones. */
function syntheticActors(): ActorData {
  const triangle = (id: number, extra: Partial<ModelSource> = {}): ModelSource => ({
    id,
    vertexCount: 3,
    faceCount: 1,
    x: Int16Array.from([0, 64, -64]),
    y: Int16Array.from([-200, 0, 0]),
    z: Int16Array.from([0, 32, -32]),
    skins: Uint8Array.from([0, 1, 1]),
    a: Uint16Array.from([0]),
    b: Uint16Array.from([1]),
    c: Uint16Array.from([2]),
    colors: Uint16Array.from([1234]),
    renderTypes: null,
    alphas: null,
    ...extra,
  });
  return {
    models: [triangle(10), triangle(11, { renderTypes: Uint8Array.from([1]) }), triangle(12, { alphas: Uint8Array.from([200]) })],
    kits: [
      { id: 1, bodyPart: 0, models: [0], recolorFrom: [], recolorTo: [] },
      { id: 2, bodyPart: 7, models: [1, 2], recolorFrom: [1234], recolorTo: [4321] },
    ],
    designer: [BODY_SLOTS.map(() => [0]), BODY_SLOTS.map(() => [1, 0])],
    colors: COLOR_CHANNELS.map((_, i) => ({
      source: 100 + i,
      colors: [100 + i, 200 + i, 300 + i],
      source2: i === 0 ? 400 : -1,
      colors2: i === 0 ? [401, 402] : [],
      designerCount: 2,
    })),
    npcs: [
      {
        id: 70_000,
        name: "Synthetic",
        models: [0, 2],
        recolorFrom: [1234],
        recolorTo: [999],
        widthScale: 128,
        heightScale: 120,
        ambient: -10,
        contrast: 250,
        idle: 5,
        walk: 6,
        walkBack: -1,
        walkLeft: 7,
        walkRight: 8,
        turnLeft: -1,
        turnRight: -1,
        run: 9,
      },
    ],
    bases: [{ id: 3, types: Uint8Array.from([0, 1]), labels: [Uint8Array.from([0]), Uint8Array.from([1, 2])] }],
    frames: [{ base: 0, groups: Uint8Array.from([0, 1]), x: Int16Array.from([0, 4]), y: Int16Array.from([0, -8]), z: Int16Array.from([0, 2]) }],
    sequences: [
      { id: 5, frames: Uint16Array.from([0, 0]), lengths: Uint16Array.from([12, 8]), frameStep: -1, maxLoops: 99, precedenceAnimating: 1, priority: 1 },
    ],
  };
}

describe("actor data format", () => {
  const data = syntheticActors();
  const bin = encodeActorData(data);

  it("round-trips every field through the encoder byte for byte", () => {
    const view = new DataView(bin.buffer, bin.byteOffset);
    expect(view.getUint32(0, true)).toBe(ACTOR_DATA_MAGIC);
    expect(view.getUint16(4, true)).toBe(ACTOR_DATA_VERSION);
    const decoded = decodeActorData(bin);
    expect(decoded).toEqual(data);
    expect(encodeActorData(decoded)).toEqual(bin);
  });

  it("rejects corrupt input", () => {
    expect(() => decodeActorData(bin.slice(0, bin.length - 3))).toThrow();
    const bad = bin.slice();
    bad[0] = 0;
    expect(() => decodeActorData(bad)).toThrow(/not a RampRidge actor/);
    const extra = new Uint8Array(bin.length + 1);
    extra.set(bin);
    expect(() => decodeActorData(extra)).toThrow(/trailing/);
  });

  it("refuses values the layout cannot hold", () => {
    expect(() => encodeActorData({ ...data, kits: [{ ...data.kits[0]!, id: 0x10000 }, data.kits[1]!] })).toThrow(RangeError);
    expect(() => encodeActorData({ ...data, designer: [data.designer[0].slice(1), data.designer[1]] })).toThrow(/7 slots/);
  });
});

// The real file is decoded from the OSRS cache and is not committed: these checks need `bun run setup:assets`.
const baked = await readBakedActors();

describe.skipIf(!baked)("baked actors.bin", () => {
  const bin = baked ?? new Uint8Array();
  const data = baked ? decodeActorData(baked) : null!;

  it("is the baked file the generated module describes", () => {
    expect(bin.length).toBe(ACTOR_DATA_BYTES);
    const view = new DataView(bin.buffer, bin.byteOffset);
    expect(view.getUint32(0, true)).toBe(ACTOR_DATA_MAGIC);
    expect(view.getUint16(4, true)).toBe(ACTOR_DATA_VERSION);
    expect(bin.length).toBeLessThan(1_500_000);
  });

  it("round-trips through the encoder byte for byte", () => {
    expect(encodeActorData(data)).toEqual(bin);
  });

  it("offers selectable kits for every slot of both body types", () => {
    for (const body of [0, 1] as const) {
      expect(data.designer[body]).toHaveLength(BODY_SLOTS.length);
      data.designer[body].forEach((slot, s) => {
        expect(slot.length).toBe(DESIGNER_KIT_COUNTS[body][s]);
        expect(slot.length).toBeGreaterThan(0);
        for (const k of slot) expect(data.kits[k]!.bodyPart).toBe(s + body * 7);
      });
    }
    // The 2007 defaults are each slot's first option (male kits 0,10,18,26,33,36,42).
    expect(data.designer[0].map((slot) => data.kits[slot[0]!]!.id)).toEqual([0, 10, 18, 26, 33, 36, 42]);
  });

  it("carries the designer colour tables with their secondary recolours", () => {
    expect(data.colors.map((c) => c.designerCount)).toEqual([...DESIGNER_COLOR_COUNTS]);
    expect(data.colors.map((c) => c.source)).toEqual([6798, 8741, 25238, 4626, 4550]);
    expect(data.colors[0]!.source2).toBe(-10304 & 0xffff);
    expect(data.colors[1]!.source2).toBe(9104);
    expect(data.colors[2]!.source2).toBe(-1);
    for (const c of data.colors) {
      expect(c.colors[0]).toBe(c.source);
      expect(c.designerCount).toBeLessThanOrEqual(c.colors.length);
    }
  });

  it("models are well formed and animatable", () => {
    for (const m of data.models) {
      expect(m.x).toHaveLength(m.vertexCount);
      expect(m.skins).toHaveLength(m.vertexCount);
      expect(m.colors).toHaveLength(m.faceCount);
      for (const idx of [m.a, m.b, m.c]) for (const v of idx) expect(v).toBeLessThan(m.vertexCount);
    }
  });

  it("includes locomotion, every emote and the bank NPCs", () => {
    const seqIds = new Set(data.sequences.map((s) => s.id));
    for (const id of [...Object.values(PLAYER_ANIMS), ...Object.values(EMOTE_SEQUENCES)]) expect(seqIds.has(id)).toBe(true);
    for (const s of data.sequences) {
      expect(s.frames.length).toBeGreaterThan(0);
      expect(s.lengths).toHaveLength(s.frames.length);
    }
    // Emotes play once (frameStep -1), pause while moving (precedenceAnimating 1) and a step cancels them (priority 1).
    for (const id of Object.values(EMOTE_SEQUENCES)) {
      const s = data.sequences.find((q) => q.id === id)!;
      expect(s.frameStep).toBe(-1);
      expect(s.precedenceAnimating).toBe(1);
      expect(s.priority).toBe(1);
    }
    const idle = data.sequences.find((s) => s.id === PLAYER_ANIMS.idle)!;
    expect(Array.from(idle.lengths).reduce((a, b) => a + b, 0) * 20).toBe(5040);
    for (const id of BANKER_NPC_IDS) {
      const npc = data.npcs.find((n) => n.id === id)!;
      expect(npc.name).toBe("Banker");
      expect(npc.models.length).toBeGreaterThan(0);
      expect(npc.idle).toBe(PLAYER_ANIMS.idle);
    }
    expect(data.npcs.find((n) => n.id === 2897)!.heightScale).toBe(124);
  });
});
