/**
 * Actor bake: decodes the identity kits the character designer offers, the
 * bank's NPCs, the player/NPC/emote sequences and the designer colour tables
 * from the local OSRS cache and writes them as one compact binary
 * (public/game/actors/actors.bin) plus a small generated TS module with the
 * designer limits (src/game/osrs/catalog.generated.ts).
 *
 *   cd scripts/bake && bunx tsx actors/index.ts
 *
 * or `import { bakeActors } from "./actors/index.ts"` from a bake orchestrator.
 *
 * The runtime (src/game/osrs) merges, recolours, lights and animates these
 * models in the browser the way the client does, so nothing here is
 * appearance-specific.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

import type { ModelData } from "../vendor/rs-map-viewer/src/rs/model/ModelData";
import { SeqTransformType } from "../vendor/rs-map-viewer/src/rs/model/seq/SeqTransformType";
import {
  BODY_SLOTS,
  decodeActorData,
  encodeActorData,
  type ActorData,
  type FrameBase,
  type FrameSource,
  type KitSource,
  type ModelSource,
  type NpcSource,
  type SequenceSource,
} from "../../../src/game/osrs/format";
import { BAKED_PLAYER_SEQUENCES, BANKER_NPC_IDS } from "../../../src/game/osrs/sequences";
import { openCache, REPO_ROOT } from "./cache";
import { CLIENT_COLOR_CHANNELS, hsl16 } from "./palettes";

const OUT_BIN = path.join(REPO_ROOT, "public/game/actors/actors.bin");
const OUT_TS = path.join(REPO_ROOT, "src/game/osrs/catalog.generated.ts");
/** Uncompressed budget for the shipped file. */
const MAX_BYTES = 1_500_000;

/**
 * Kits moved to the front of a designer list so that option 0 of every slot
 * is the client's default look for that body (the first selectable kit, as
 * the 2007 client picks on a body switch). The 2007 client had no body-B jaw
 * at all; the current cache adds body-B jaws 292-306 that mirror the male
 * beards 10-17 and 111-117, so its clean-shaven chin 296 (the twin of male 14)
 * stands in for that missing jaw and has to come first, not the goatee 292.
 */
const DESIGNER_FIRST_KIT: Record<0 | 1, Partial<Record<number, number>>> = {
  0: {},
  1: { 1: 296 },
};

interface IdentityKit {
  id: number;
  bodyPart: number;
  models: number[];
  selectable: boolean;
  recolorFrom: number[];
  recolorTo: number[];
}

/**
 * Identity kits are decoded here rather than with the vendored IdkType: since
 * models moved to 32-bit ids the cache uses opcode 5 (int model list) and
 * 70-79 (int chathead models), which that decoder predates.
 */
function decodeIdentityKit(id: number, data: Int8Array): IdentityKit {
  const kit: IdentityKit = { id, bodyPart: -1, models: [], selectable: true, recolorFrom: [], recolorTo: [] };
  let o = 0;
  const u8 = () => data[o++]! & 0xff;
  const u16 = () => (u8() << 8) | u8();
  const i32 = () => ((u8() << 24) | (u8() << 16) | (u8() << 8) | u8()) >>> 0;
  for (;;) {
    if (o >= data.length) throw new Error(`idk ${id}: missing terminator`);
    const op = u8();
    if (op === 0) break;
    if (op === 1) kit.bodyPart = u8();
    else if (op === 2) {
      const n = u8();
      for (let i = 0; i < n; i++) kit.models.push(u16());
    } else if (op === 3) kit.selectable = false;
    else if (op === 5) {
      const n = u8();
      for (let i = 0; i < n; i++) kit.models.push(i32());
    } else if (op === 40) {
      const n = u8();
      for (let i = 0; i < n; i++) {
        kit.recolorFrom.push(u16());
        kit.recolorTo.push(u16());
      }
    } else if (op === 41) {
      const n = u8();
      for (let i = 0; i < n; i++) {
        const from = u16();
        const to = u16();
        throw new Error(`idk ${id}: retexture ${from}->${to} is not supported by the runtime`);
      }
    } else if (op >= 60 && op < 70) u16();
    else if (op >= 70 && op < 80) i32();
    else throw new Error(`idk ${id}: unknown opcode ${op}`);
  }
  return kit;
}

export interface ActorBakeSummary {
  bytes: number;
  gzip: number;
  hash: string;
  models: number;
  kits: number;
  sequences: number;
}

/** Bakes public/game/actors/actors.bin and src/game/osrs/catalog.generated.ts. */
export function bakeActors(): ActorBakeSummary {
  const started = Date.now();
  const cache = openCache();
  const { factory } = cache;
  const modelLoader = factory.getModelLoader();
  const npcLoader = factory.getNpcTypeLoader();
  const seqLoader = factory.getSeqTypeLoader();
  const frameLoader = factory.getSeqFrameLoader();

  // ---- identity kits
  const allKits: IdentityKit[] = [];
  for (let id = 0; id < cache.idkLoader.getCount(); id++) {
    const buf = cache.idkLoader.getDataBuffer(id);
    if (buf) allKits.push(decodeIdentityKit(id, buf.data));
  }

  // ---- models
  const models: ModelSource[] = [];
  const modelIndex = new Map<number, number>();
  const addModel = (id: number): number => {
    const known = modelIndex.get(id);
    if (known !== undefined) return known;
    const m: ModelData | undefined = modelLoader.getModel(id);
    if (!m) throw new Error(`model ${id} missing from cache`);
    models.push(toModelSource(id, m));
    modelIndex.set(id, models.length - 1);
    return models.length - 1;
  };

  // ---- designer: selectable kits per body type and slot, in cache id order (the client's order),
  // except that each list starts with the client's default for that slot (see DESIGNER_FIRST_KIT).
  const kits: KitSource[] = [];
  const designer: [number[][], number[][]] = [[], []];
  for (const body of [0, 1] as const) {
    for (let slot = 0; slot < BODY_SLOTS.length; slot++) {
      const part = slot + body * 7;
      const choices = allKits.filter((k) => k.bodyPart === part && k.selectable && k.models.length > 0);
      if (choices.length === 0) throw new Error(`no selectable kits for body ${body} slot ${BODY_SLOTS[slot]}`);
      const first = DESIGNER_FIRST_KIT[body][slot];
      if (first !== undefined) {
        const at = choices.findIndex((k) => k.id === first);
        if (at < 0) throw new Error(`default kit ${first} is not selectable for body ${body} slot ${BODY_SLOTS[slot]}`);
        choices.unshift(...choices.splice(at, 1));
      }
      designer[body].push(
        choices.map((k) => {
          kits.push({
            id: k.id,
            bodyPart: k.bodyPart,
            models: k.models.map(addModel),
            recolorFrom: k.recolorFrom,
            recolorTo: k.recolorTo,
          });
          return kits.length - 1;
        }),
      );
    }
  }

  // ---- NPCs
  const npcs: NpcSource[] = [];
  for (const id of BANKER_NPC_IDS) {
    const t = npcLoader.load(id);
    if (!t.modelIds?.length) throw new Error(`npc ${id} has no models`);
    if (t.transforms) throw new Error(`npc ${id} is a multi-npc; resolve its transform first`);
    if (t.retextureFrom?.length) throw new Error(`npc ${id} retextures, unsupported`);
    npcs.push({
      id,
      name: t.name,
      models: t.modelIds.map(addModel),
      recolorFrom: (t.recolorFrom ?? []).map(hsl16),
      recolorTo: (t.recolorTo ?? []).map(hsl16),
      widthScale: t.widthScale,
      heightScale: t.heightScale,
      ambient: t.ambient,
      contrast: t.contrast,
      idle: t.idleSeqId,
      walk: t.walkSeqId,
      walkBack: t.walkBackSeqId,
      walkLeft: t.walkLeftSeqId,
      walkRight: t.walkRightSeqId,
      turnLeft: t.turnLeftSeqId,
      turnRight: t.turnRightSeqId,
      run: t.runSeqId,
    });
  }

  // ---- sequences, frames and frame bases
  const seqIds = new Set<number>(BAKED_PLAYER_SEQUENCES);
  for (const n of npcs) {
    for (const s of [n.idle, n.walk, n.walkBack, n.walkLeft, n.walkRight, n.turnLeft, n.turnRight, n.run]) {
      if (s >= 0) seqIds.add(s);
    }
  }
  const bases: FrameBase[] = [];
  const baseIndex = new Map<number, number>();
  const frames: FrameSource[] = [];
  const frameIndex = new Map<number, number>();
  const sequences: SequenceSource[] = [];
  for (const seqId of [...seqIds].sort((a, b) => a - b)) {
    const seq = seqLoader.load(seqId);
    if (seq.isSkeletalSeq()) throw new Error(`sequence ${seqId} is skeletal; the runtime plays frame sequences only`);
    if (!seq.frameIds?.length) throw new Error(`sequence ${seqId} has no frames`);
    if (seq.masks) throw new Error(`sequence ${seqId} interleaves (masks); not supported`);
    const idx = seq.frameIds.map((frameId) => {
      const known = frameIndex.get(frameId);
      if (known !== undefined) return known;
      const f = frameLoader.load(frameId);
      if (!f) throw new Error(`sequence ${seqId}: frame ${frameId} missing`);
      let b = baseIndex.get(f.base.id);
      if (b === undefined) {
        bases.push({
          id: f.base.id,
          types: Uint8Array.from(f.base.types),
          labels: f.base.labels.map((l) => Uint8Array.from(l)),
        });
        b = bases.length - 1;
        baseIndex.set(f.base.id, b);
      }
      for (let i = 0; i < f.transformCount; i++) {
        const type = f.base.types[f.transformGroups[i]!]!;
        if (type === SeqTransformType.ALPHA || type === SeqTransformType.LIGHT) {
          throw new Error(`sequence ${seqId}: alpha/colour transforms are not supported`);
        }
      }
      frames.push({
        base: b,
        groups: Uint8Array.from(f.transformGroups),
        x: Int16Array.from(f.transformX),
        y: Int16Array.from(f.transformY),
        z: Int16Array.from(f.transformZ),
      });
      frameIndex.set(frameId, frames.length - 1);
      return frames.length - 1;
    });
    sequences.push({
      id: seqId,
      frames: Uint16Array.from(idx),
      lengths: Uint16Array.from(seq.frameLengths.map((l) => Math.max(1, l))),
      frameStep: seq.frameStep,
      maxLoops: seq.maxLoops,
      precedenceAnimating: seq.precedenceAnimating,
      priority: seq.priority,
    });
  }

  // ---- designer colour tables
  const colors = CLIENT_COLOR_CHANNELS.map((ch) => ({
    source: hsl16(ch.source),
    colors: ch.colors.map(hsl16),
    source2: ch.source2 === -1 ? -1 : hsl16(ch.source2),
    colors2: ch.colors2.map(hsl16),
    designerCount: ch.designerCount,
  }));
  checkPaletteSources(kits, models, colors);

  const data: ActorData = { models, kits, designer, colors, npcs, bases, frames, sequences };
  const bytes = encodeActorData(data);
  // Round-trip before writing so a format bug never ships.
  const back = decodeActorData(bytes);
  if (back.models.length !== models.length || back.sequences.length !== sequences.length) {
    throw new Error("actor data round trip mismatch");
  }
  if (bytes.length > MAX_BYTES) throw new Error(`actor data is ${bytes.length} bytes, over the ${MAX_BYTES} budget`);

  fs.mkdirSync(path.dirname(OUT_BIN), { recursive: true });
  fs.writeFileSync(OUT_BIN, bytes);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  fs.writeFileSync(OUT_TS, generatedModule(data, hash, bytes.length, cache.info.name));

  const gz = zlib.gzipSync(bytes, { level: 9 }).length;
  const br = zlib.brotliCompressSync(bytes).length;
  const kitCounts = designer.map((body) => body.map((s) => s.length).join("/")).join(" | ");
  console.log(
    JSON.stringify(
      {
        cache: cache.info.name,
        out: path.relative(REPO_ROOT, OUT_BIN),
        bytes: bytes.length,
        gzip: gz,
        brotli: br,
        hash,
        models: models.length,
        vertices: models.reduce((s, m) => s + m.vertexCount, 0),
        faces: models.reduce((s, m) => s + m.faceCount, 0),
        kits: kits.length,
        designerKits: kitCounts,
        npcs: npcs.map((n) => `${n.id} ${n.name}`),
        sequences: sequences.length,
        frames: frames.length,
        bases: bases.length,
        ms: Date.now() - started,
      },
      null,
      2,
    ),
  );
  return { bytes: bytes.length, gzip: gz, hash, models: models.length, kits: kits.length, sequences: sequences.length };
}

function toModelSource(id: number, m: ModelData): ModelSource {
  const v = m.verticesCount;
  const f = m.faceCount;
  if (m.faceTextures && m.faceTextures.some((t) => t !== -1)) {
    throw new Error(`model ${id} has textured faces; the actor runtime renders vertex colours only`);
  }
  const toI16 = (src: Int32Array, axis: string) => {
    const out = new Int16Array(v);
    for (let i = 0; i < v; i++) {
      const value = src[i]!;
      if (value < -0x8000 || value > 0x7fff) throw new Error(`model ${id}: ${axis} ${value} exceeds int16`);
      out[i] = value;
    }
    return out;
  };
  const skins = new Uint8Array(v);
  if (!m.vertexSkins) throw new Error(`model ${id} has no vertex skins; it cannot animate`);
  for (let i = 0; i < v; i++) {
    const s = m.vertexSkins[i]!;
    if (s < 0 || s > 255) throw new Error(`model ${id}: vertex skin ${s}`);
    skins[i] = s;
  }
  const alphas = m.faceAlphas && m.faceAlphas.some((a) => a !== 0) ? Uint8Array.from(m.faceAlphas, (a) => a & 0xff) : null;
  const renderTypes =
    m.faceRenderTypes && m.faceRenderTypes.some((t) => t !== 0) ? Uint8Array.from(m.faceRenderTypes, (t) => t & 0xff) : null;
  return {
    id,
    vertexCount: v,
    faceCount: f,
    x: toI16(m.verticesX, "x"),
    y: toI16(m.verticesY, "y"),
    z: toI16(m.verticesZ, "z"),
    skins,
    a: Uint16Array.from(m.indices1.subarray(0, f)),
    b: Uint16Array.from(m.indices2.subarray(0, f)),
    c: Uint16Array.from(m.indices3.subarray(0, f)),
    colors: Uint16Array.from(m.faceColors.subarray(0, f)),
    renderTypes,
    alphas,
  };
}

/** Every recolour source must exist somewhere in the kits, or the table is wrong for this cache. */
function checkPaletteSources(kits: KitSource[], models: ModelSource[], colors: ActorData["colors"]): void {
  const present = new Set<number>();
  for (const k of kits) for (const m of k.models) for (const c of models[m]!.colors) present.add(c);
  for (const ch of colors) {
    if (!present.has(ch.source)) throw new Error(`palette source ${ch.source} is not used by any kit`);
    if (ch.source2 >= 0 && !present.has(ch.source2)) throw new Error(`palette source2 ${ch.source2} unused`);
  }
}

function generatedModule(data: ActorData, hash: string, bytes: number, cacheName: string): string {
  const kitCounts = data.designer.map((body) => `[${body.map((s) => s.length).join(", ")}]`).join(", ");
  const colorCounts = data.colors.map((c) => c.designerCount).join(", ");
  return `// Generated by scripts/bake/actors/index.ts from ${cacheName}. Do not edit.

/** Content hash of public/game/actors/actors.bin, used to bust caches. */
export const ACTOR_DATA_HASH = "${hash}";
export const ACTOR_DATA_BYTES = ${bytes};

/** Designer kit choices per body type (0 male, 1 female) and slot: hair, jaw, torso, arms, hands, legs, feet. */
export const DESIGNER_KIT_COUNTS: readonly [readonly number[], readonly number[]] = [${kitCounts}];

/** Designer colour choices per channel: hair, torso, legs, feet, skin. */
export const DESIGNER_COLOR_COUNTS: readonly number[] = [${colorCounts}];
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) bakeActors();
