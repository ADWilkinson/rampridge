/**
 * Parity between the browser runtime (src/game/osrs) and the vendored
 * rs-map-viewer decoder the bake uses: merged geometry, lighting and frame
 * animation of real kits must match. Needs the OSRS cache, the baked
 * actors.bin and the bake's own dependencies, none of which is committed
 * (`bun run setup:assets` provides all three); skipped without them.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { applyPose, densify } from "../../../src/game/osrs/animation";
import { OsrsCharacterFactory, provideActors } from "../../../src/game/osrs/factory";
import { decodeActorData } from "../../../src/game/osrs/format";
import { EMOTE_SEQUENCES, PLAYER_ANIMS } from "../../../src/game/osrs/sequences";
import { BAKE_DIR, CACHE_DIR, REPO_DIR } from "../lib/paths";

const BIN = path.join(REPO_DIR, "public/game/actors/actors.bin");
const ready = [path.join(CACHE_DIR, "caches.json"), BIN, path.join(BAKE_DIR, "node_modules/gl-matrix")].every((p) => fs.existsSync(p));

/** The vendored decoder imports the bake's dependencies, so it is loaded only when everything is in place. */
async function loadReference() {
  const [{ NpcModelLoader }, { NpcType }, { VarManager }, { openCache }] = await Promise.all([
    import("../vendor/rs-map-viewer/src/rs/config/npctype/NpcModelLoader"),
    import("../vendor/rs-map-viewer/src/rs/config/npctype/NpcType"),
    import("../vendor/rs-map-viewer/src/rs/config/vartype/VarManager"),
    import("./cache"),
  ]);
  return { NpcModelLoader, NpcType, VarManager, cache: openCache() };
}
const reference = ready ? await loadReference() : null;

/** Equipment merge order: torso, arms, legs, hair, hands, feet, jaw. */
const MERGE_ORDER = [2, 3, 5, 0, 4, 6, 1];

describe.skipIf(!reference)("runtime parity with rs-map-viewer", () => {
  const { NpcModelLoader, NpcType, VarManager, cache } = reference ?? ({} as NonNullable<typeof reference>);
  const data = reference ? decodeActorData(fs.readFileSync(BIN)) : null!;
  const factory = new OsrsCharacterFactory();
  if (reference) factory.attach(provideActors(data));
  const f = cache?.factory;
  const npcModels = reference
    ? new NpcModelLoader(
        f.getNpcTypeLoader(),
        f.getModelLoader(),
        f.getTextureLoader(),
        f.getSeqTypeLoader(),
        f.getSeqFrameLoader(),
        f.getSkeletalSeqLoader(),
        new VarManager(f.getVarBitTypeLoader()),
      )
    : null!;

  /** The reference player: a synthetic NPC with the kit models, lit with the player constants (64, 850). */
  function referencePlayer(body: 0 | 1, kits: number[], recolors: [number, number][]) {
    const npc = new NpcType(-1, cache.info);
    npc.modelIds = MERGE_ORDER.flatMap((slot) => {
      const kit = data.kits[data.designer[body][slot]![kits[slot]!]!]!;
      return kit.models.map((m) => data.models[m]!.id);
    });
    if (recolors.length) {
      npc.recolorFrom = recolors.map((r) => r[0]);
      npc.recolorTo = recolors.map((r) => r[1]);
    }
    return npc;
  }

  const lightness = (hsl: number) => hsl & 127;
  const cases: { body: 0 | 1; kits: number[]; colors: number[] }[] = [
    { body: 0, kits: [0, 0, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] },
    { body: 1, kits: [3, 4, 5, 2, 1, 6, 1], colors: [10, 4, 7, 2, 5] },
    { body: 0, kits: [60, 9, 14, 11, 1, 17, 1], colors: [20, 25, 3, 5, 7] },
  ];

  for (const c of cases) {
    it(`matches merge and lighting for body ${c.body} kits ${c.kits.join(".")}`, () => {
      const appearance = { body: c.body, kits: c.kits, colors: c.colors } as Parameters<typeof factory.playerModel>[0];
      const mine = factory.playerModel(appearance);
      // The same recolours the runtime applies, in the same order, as an NPC recolour list.
      const recolors: [number, number][] = [];
      data.colors.forEach((ch, i) => {
        const idx = c.colors[i]!;
        if (idx < ch.colors.length) recolors.push([ch.source, ch.colors[idx]!]);
        if (ch.source2 >= 0 && idx < ch.colors2.length) recolors.push([ch.source2, ch.colors2[idx]!]);
      });
      const npc = referencePlayer(c.body, c.kits, recolors);
      npcModels.clearCache();
      const ref = npcModels.getModel(npc, -1, -1)!;

      expect(mine.vertexCount).toBe(ref.verticesCount);
      expect(mine.faceCount).toBe(ref.faceCount);
      expect(Array.from(mine.x)).toEqual(Array.from(ref.verticesX.subarray(0, ref.verticesCount)));
      expect(Array.from(mine.y)).toEqual(Array.from(ref.verticesY.subarray(0, ref.verticesCount)));
      expect(Array.from(mine.a)).toEqual(Array.from(ref.indices1.subarray(0, ref.faceCount)));

      let exact = 0;
      for (let i = 0; i < mine.faceCount; i++) {
        expect(mine.color3[i] === -2).toBe(ref.faceColors3[i] === -2);
        expect(mine.color3[i] === -1).toBe(ref.faceColors3[i] === -1);
        if (mine.color3[i] === -2) continue;
        for (const [m, r] of [
          [mine.color1[i]!, ref.faceColors1[i]!],
          [mine.color2[i]!, ref.faceColors2[i]!],
          [mine.color3[i]!, ref.faceColors3[i]!],
        ] as const) {
          if (m === -1) continue;
          const rh = r & 0xffff;
          // Same hue/saturation; lightness may differ by one where rs-map-viewer truncates after
          // adding ambient (JS) and the client truncates the division first (Java).
          expect(m & 0xff80).toBe(rh & 0xff80);
          expect(Math.abs(lightness(m) - lightness(rh))).toBeLessThanOrEqual(1);
          if (m === rh) exact++;
        }
      }
      expect(exact).toBeGreaterThan(mine.faceCount * 2);
    });
  }

  const seqs = [PLAYER_ANIMS.idle, PLAYER_ANIMS.walk, PLAYER_ANIMS.run, PLAYER_ANIMS.walkLeft, ...Object.values(EMOTE_SEQUENCES)];
  it("applies every baked frame exactly like the reference animator", () => {
    const appearance = { body: 0, kits: [0, 0, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] } as const;
    const mine = factory.playerModel({ ...appearance, kits: [...appearance.kits], colors: [...appearance.colors] } as never);
    const npc = referencePlayer(0, [0, 0, 0, 0, 0, 0, 0], []);
    let worst = 0;
    let total = 0;
    let samples = 0;
    for (const seqId of seqs) {
      const seq = data.sequences.find((s) => s.id === seqId)!;
      for (let frame = 0; frame < seq.frames.length; frame++) {
        npcModels.clearCache();
        const ref = npcModels.getModel(npc, seqId, frame)!;
        const src = data.frames[seq.frames[frame]!]!;
        const pose = densify(src, data.bases[src.base]!);
        const px = Float32Array.from(mine.x);
        const py = Float32Array.from(mine.y);
        const pz = Float32Array.from(mine.z);
        applyPose(pose, data.bases[src.base]!, mine.vertexLabels, px, py, pz);
        const ex = Float32Array.from(mine.x);
        const ey = Float32Array.from(mine.y);
        const ez = Float32Array.from(mine.z);
        applyPose(pose, data.bases[src.base]!, mine.vertexLabels, ex, ey, ez, true);
        expect(Array.from(ex)).toEqual(Array.from(ref.verticesX.subarray(0, mine.vertexCount)));
        expect(Array.from(ey)).toEqual(Array.from(ref.verticesY.subarray(0, mine.vertexCount)));
        expect(Array.from(ez)).toEqual(Array.from(ref.verticesZ.subarray(0, mine.vertexCount)));
        for (let v = 0; v < mine.vertexCount; v++) {
          const d = Math.max(
            Math.abs(px[v]! - ref.verticesX[v]!),
            Math.abs(py[v]! - ref.verticesY[v]!),
            Math.abs(pz[v]! - ref.verticesZ[v]!),
          );
          worst = Math.max(worst, d);
          total += d;
          samples++;
        }
      }
    }
    // The smooth (float) path differs from the client's fixed point only by rounding: a few model units at worst.
    expect(worst).toBeLessThan(6);
    expect(total / samples).toBeLessThan(1.5);
  });
});
