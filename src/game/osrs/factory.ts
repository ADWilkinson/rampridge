import { MeshBasicMaterial, type Material } from "three";
import type { Appearance } from "@shared/protocol";

import { buildDesignerCatalog, isValidAppearance, randomAppearanceFrom } from "./appearance";
import { ACTOR_DATA_BYTES, ACTOR_DATA_HASH, DESIGNER_COLOR_COUNTS, DESIGNER_KIT_COUNTS } from "./catalog.generated";
import { OsrsCharacter, type MovementSet } from "./character";
import { decodeActorData, type ActorData } from "./format";
import { ModelData, NPC_LIGHT_BASE, PLAYER_LIGHT, type LitModel, type MergePart } from "./model";
import { PLAYER_ANIMS } from "./sequences";
import { buildClips, type SequenceClip } from "./track";
import type { CharacterFactory, CharacterHandle, DesignerCatalog } from "./types";

export interface CharacterFactoryOptions {
  /** Tween frames and cross-fade sequence changes (default true). False plays frames exactly like the 2007 client. */
  smoothing?: boolean;
  /** Cross-fade between sequences (walk to idle, emote start/end) in ms when smoothing; default 120, 0 cuts. */
  sequenceBlendMs?: number;
  /** Override where actors.bin is fetched from. */
  url?: string;
}

export interface LoadedActors {
  data: ActorData;
  clips: Map<number, SequenceClip>;
}

export const ACTOR_DATA_URL = `${import.meta.env.BASE_URL}game/actors/actors.bin?v=${ACTOR_DATA_HASH}`;

let shared: Promise<LoadedActors> | null = null;
let settled = false;
const progressListeners = new Set<(fraction: number) => void>();

/**
 * Fetches and decodes actors.bin once per page; every factory and preview
 * shares the result. Progress is reported against the known uncompressed
 * size, so it is accurate whether or not the host compresses the file.
 */
export function loadActors(onProgress?: (fraction: number) => void, url = ACTOR_DATA_URL): Promise<LoadedActors> {
  if (onProgress && !settled) progressListeners.add(onProgress);
  shared ??= fetchActors(url)
    .then((bytes) => {
      const data = decodeActorData(bytes);
      settled = true;
      return { data, clips: buildClips(data) };
    })
    .catch((err: unknown) => {
      shared = null;
      throw err;
    })
    .finally(() => progressListeners.clear());
  return shared;
}

/** Injects already-decoded data (tests, tools); later loads resolve to it. */
export function provideActors(data: ActorData): LoadedActors {
  const loaded = { data, clips: buildClips(data) };
  shared = Promise.resolve(loaded);
  settled = true;
  progressListeners.clear();
  return loaded;
}

async function fetchActors(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`actors.bin: HTTP ${res.status}`);
  const report = (n: number) => {
    const fraction = Math.min(1, n / ACTOR_DATA_BYTES);
    for (const fn of progressListeners) fn(fraction);
  };
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    report(buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    report(received);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  report(received);
  return out;
}

/** Equipment-slot merge order: torso, arms, legs, hair, hands, feet, jaw (PlayerComposition). */
const MERGE_ORDER = [2, 3, 5, 0, 4, 6, 1] as const;
const LIT_CACHE_LIMIT = 96;

export class OsrsCharacterFactory implements CharacterFactory {
  private loaded: LoadedActors | null = null;
  private catalog: DesignerCatalog | null = null;
  private readonly litCache = new Map<string, LitModel>();
  private readonly npcCache = new Map<number, LitModel>();
  readonly materials: [Material, Material] = [
    new MeshBasicMaterial({ vertexColors: true }),
    new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
  ];
  private readonly smoothing: boolean;
  private readonly blendMs: number;

  constructor(private readonly options: CharacterFactoryOptions = {}) {
    this.smoothing = options.smoothing ?? true;
    this.blendMs = Math.max(0, options.sequenceBlendMs ?? 120);
    this.materials[0].name = "osrs-actor-opaque";
    this.materials[1].name = "osrs-actor-translucent";
  }

  async load(onProgress?: (fraction: number) => void): Promise<void> {
    if (this.loaded) {
      onProgress?.(1);
      return;
    }
    this.loaded = await loadActors(onProgress, this.options.url);
    onProgress?.(1);
  }

  /** Synchronous variant for data already provided via provideActors/loadActors. */
  attach(loaded: LoadedActors): void {
    this.loaded = loaded;
  }

  get isLoaded(): boolean {
    return this.loaded !== null;
  }

  createPlayer(appearance: Appearance): CharacterHandle {
    const { data, clips } = this.require();
    return new OsrsCharacter({
      lit: this.playerModel(appearance),
      scale: { x: 1, y: 1, z: 1 },
      movement: { ...PLAYER_ANIMS },
      clips,
      bases: data.bases,
      materials: this.materials,
      relight: (a) => this.playerModel(a),
      smoothing: this.smoothing,
      blendMs: this.blendMs,
    });
  }

  createNpc(npcId: number): CharacterHandle {
    const { data, clips } = this.require();
    const npc = data.npcs.find((n) => n.id === npcId);
    if (!npc) throw new Error(`NPC ${npcId} is not in the actor bake`);
    let lit = this.npcCache.get(npcId);
    if (!lit) {
      const merged = ModelData.merge(
        npc.models.map((m): MergePart => ({ model: data.models[m]! })),
      );
      for (let i = 0; i < npc.recolorFrom.length; i++) merged.recolor(npc.recolorFrom[i]!, npc.recolorTo[i]!);
      lit = merged.light(
        npc.ambient + NPC_LIGHT_BASE.ambient,
        npc.contrast + NPC_LIGHT_BASE.contrast,
        NPC_LIGHT_BASE.x,
        NPC_LIGHT_BASE.y,
        NPC_LIGHT_BASE.z,
      );
      this.npcCache.set(npcId, lit);
    }
    const movement: MovementSet = {
      idle: npc.idle >= 0 ? npc.idle : PLAYER_ANIMS.idle,
      walk: npc.walk,
      walkBack: npc.walkBack,
      walkLeft: npc.walkLeft,
      walkRight: npc.walkRight,
      turn: npc.turnLeft >= 0 ? npc.turnLeft : npc.turnRight,
      run: npc.run,
    };
    return new OsrsCharacter({
      lit,
      scale: { x: npc.widthScale / 128, y: npc.heightScale / 128, z: npc.widthScale / 128 },
      movement,
      clips,
      bases: data.bases,
      materials: this.materials,
      smoothing: this.smoothing,
      blendMs: this.blendMs,
    });
  }

  randomAppearance(seed: string): Appearance {
    return randomAppearanceFrom(this.require().data, seed);
  }

  designer(): DesignerCatalog {
    this.catalog ??= buildDesignerCatalog(this.require().data);
    return this.catalog;
  }

  isValidAppearance(appearance: Appearance): boolean {
    return isValidAppearance(appearance);
  }

  /** NPC name from the cache definition (e.g. "Banker"). */
  npcName(npcId: number): string | undefined {
    return this.loaded?.data.npcs.find((n) => n.id === npcId)?.name;
  }

  /** Merged, recoloured and lit player model for an appearance (cached). */
  playerModel(appearance: Appearance): LitModel {
    const a = sanitize(appearance);
    const key = `${a.body}:${a.kits.join(",")}:${a.colors.join(",")}`;
    const hit = this.litCache.get(key);
    if (hit) {
      this.litCache.delete(key);
      this.litCache.set(key, hit);
      return hit;
    }
    const { data } = this.require();
    const parts: MergePart[] = [];
    for (const slot of MERGE_ORDER) {
      const kit = data.kits[data.designer[a.body][slot]![a.kits[slot]]!]!;
      for (const m of kit.models) {
        parts.push({ model: data.models[m]!, recolorFrom: kit.recolorFrom, recolorTo: kit.recolorTo });
      }
    }
    const merged = ModelData.merge(parts);
    for (let ch = 0; ch < data.colors.length; ch++) {
      const channel = data.colors[ch]!;
      const index = a.colors[ch]!;
      if (index < channel.colors.length) merged.recolor(channel.source, channel.colors[index]!);
      if (channel.source2 >= 0 && index < channel.colors2.length) merged.recolor(channel.source2, channel.colors2[index]!);
    }
    const lit = merged.light(PLAYER_LIGHT.ambient, PLAYER_LIGHT.contrast, PLAYER_LIGHT.x, PLAYER_LIGHT.y, PLAYER_LIGHT.z);
    this.litCache.set(key, lit);
    if (this.litCache.size > LIT_CACHE_LIMIT) {
      const oldest = this.litCache.keys().next().value;
      if (oldest !== undefined) this.litCache.delete(oldest);
    }
    return lit;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.litCache.clear();
    this.npcCache.clear();
  }

  private require(): LoadedActors {
    if (!this.loaded) throw new Error("CharacterFactory.load() must resolve before creating characters");
    return this.loaded;
  }
}

/**
 * Brings an appearance into the designer's ranges so bad remote data never
 * breaks rendering: an index past the end clamps to the last option, and a
 * negative (the client's -1, "no kit"), missing or non-integer one falls back
 * to option 0, the client default. Every slot always gets a kit: the current
 * cache's heads are built around their jaw kit (body B's clean chin 296 stands
 * in for the 2007 client's missing body-B jaw), so leaving one out would open
 * a hole in the face.
 */
function sanitize(input: Appearance): Appearance {
  const a = input as unknown as Partial<Appearance> | null | undefined;
  if (isValidAppearance(a)) return a;
  const body: 0 | 1 = a?.body === 1 ? 1 : 0;
  const clamp = (v: unknown, n: number) => (Number.isInteger(v) ? Math.min(Math.max(v as number, 0), n - 1) : 0);
  const kitCounts = DESIGNER_KIT_COUNTS[body];
  return {
    body,
    kits: kitCounts.map((n, i) => clamp(a?.kits?.[i], n)) as Appearance["kits"],
    colors: DESIGNER_COLOR_COUNTS.map((n, i) => clamp(a?.colors?.[i], n)) as Appearance["colors"],
  };
}

export function createCharacterFactory(options?: CharacterFactoryOptions): OsrsCharacterFactory {
  return new OsrsCharacterFactory(options);
}
