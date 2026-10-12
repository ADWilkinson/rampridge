/**
 * Baked actor data: the identity-kit and NPC models, frame bases, frames,
 * sequences and designer colour tables decoded from the OSRS cache by
 * scripts/bake/actors. One little-endian binary file, read once at load.
 *
 * The bake imports `encodeActorData` from this file and the runtime imports
 * `decodeActorData`, so the layout has a single definition. Keep this module
 * free of DOM, three.js and path aliases: it also runs under Node (tsx and
 * vitest).
 */

/** "RRAC" as a little-endian u32. */
export const ACTOR_DATA_MAGIC = 0x43415252;
export const ACTOR_DATA_VERSION = 1;

/** Identity-kit body slots in Appearance order. */
export const BODY_SLOTS = ["hair", "jaw", "torso", "arms", "hands", "legs", "feet"] as const;
export const COLOR_CHANNELS = ["hair", "torso", "legs", "feet", "skin"] as const;

/** One cache model, unlit, in model units (128 per tile, y down). */
export interface ModelSource {
  /** Cache model id (informational). */
  id: number;
  vertexCount: number;
  faceCount: number;
  x: Int16Array;
  y: Int16Array;
  z: Int16Array;
  /** Vertex skin (animation label) per vertex. */
  skins: Uint8Array;
  a: Uint16Array;
  b: Uint16Array;
  c: Uint16Array;
  /** HSL16 colour per face. */
  colors: Uint16Array;
  /** 0 smooth, 1 flat, 2 hidden, 3 black; null when every face is smooth. */
  renderTypes: Uint8Array | null;
  /** Signed transparency bytes stored unsigned (0 opaque); null when opaque. */
  alphas: Uint8Array | null;
}

export interface KitSource {
  /** Cache identity-kit id. */
  id: number;
  /** 0-6 male hair..feet, 7-13 female hair..feet. */
  bodyPart: number;
  /** Indices into ActorData.models. */
  models: number[];
  recolorFrom: number[];
  recolorTo: number[];
}

export interface ColorChannel {
  /** HSL16 colour in the kit models that the palette replaces. */
  source: number;
  /** HSL16 replacement per colour index. */
  colors: number[];
  /** Secondary source colour (two-tone hair, torso trim); -1 when none. */
  source2: number;
  colors2: number[];
  /** How many leading entries the character designer offers. */
  designerCount: number;
}

export interface NpcSource {
  id: number;
  name: string;
  /** Indices into ActorData.models. */
  models: number[];
  recolorFrom: number[];
  recolorTo: number[];
  widthScale: number;
  heightScale: number;
  ambient: number;
  /** Already multiplied by 5, as the client decodes it. */
  contrast: number;
  idle: number;
  walk: number;
  walkBack: number;
  walkLeft: number;
  walkRight: number;
  turnLeft: number;
  turnRight: number;
  run: number;
}

/** A frame base (framemap / skeleton): transform type and vertex labels per group. */
export interface FrameBase {
  id: number;
  types: Uint8Array;
  labels: Uint8Array[];
}

/** One animation frame: the groups it transforms and their x/y/z values. */
export interface FrameSource {
  /** Index into ActorData.bases. */
  base: number;
  groups: Uint8Array;
  x: Int16Array;
  y: Int16Array;
  z: Int16Array;
}

export interface SequenceSource {
  id: number;
  /** Indices into ActorData.frames. */
  frames: Uint16Array;
  /** Frame durations in client cycles (20 ms). */
  lengths: Uint16Array;
  /** Loop-back offset; -1 ends a one-shot sequence after its last frame. */
  frameStep: number;
  maxLoops: number;
  /**
   * SeqType opcode 9. While the actor moves: 0 stalls the movement, 1 pauses
   * this sequence and shows the movement animation, 2 interleaves; -1 default.
   */
  precedenceAnimating: number;
  /** SeqType opcode 10. 1 cancels the sequence when the actor starts a new step; -1 default. */
  priority: number;
}

export interface ActorData {
  models: ModelSource[];
  kits: KitSource[];
  /** designer[body][slot] = indices into `kits`, in designer order. */
  designer: [number[][], number[][]];
  colors: ColorChannel[];
  npcs: NpcSource[];
  bases: FrameBase[];
  frames: FrameSource[];
  sequences: SequenceSource[];
}

const MODEL_FLAG_RENDER_TYPES = 1;
const MODEL_FLAG_ALPHAS = 2;
const NONE_U16 = 0xffff;

// ---------------------------------------------------------------- writing

class Writer {
  private buf = new Uint8Array(1 << 16);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private reserve(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    checkRange(v, 0, 0xff);
    this.reserve(1);
    this.view.setUint8(this.length, v);
    this.length += 1;
  }

  i8(v: number): void {
    checkRange(v, -0x80, 0x7f);
    this.reserve(1);
    this.view.setInt8(this.length, v);
    this.length += 1;
  }

  u16(v: number): void {
    checkRange(v, 0, 0xffff);
    this.reserve(2);
    this.view.setUint16(this.length, v, true);
    this.length += 2;
  }

  i16(v: number): void {
    checkRange(v, -0x8000, 0x7fff);
    this.reserve(2);
    this.view.setInt16(this.length, v, true);
    this.length += 2;
  }

  u32(v: number): void {
    checkRange(v, 0, 0xffffffff);
    this.reserve(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
  }

  /** Signed sequence/animation id where -1 means none. */
  optU16(v: number): void {
    this.u16(v < 0 ? NONE_U16 : v);
  }

  str(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.u8(bytes.length);
    this.bytes(bytes);
  }

  bytes(b: Uint8Array): void {
    this.reserve(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  u16s(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.u16(values[i]!);
  }

  i16s(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.i16(values[i]!);
  }

  u8s(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.u8(values[i]!);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function checkRange(v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`actor data value ${v} outside [${min}, ${max}]`);
  }
}

export function encodeActorData(data: ActorData): Uint8Array {
  const w = new Writer();
  w.u32(ACTOR_DATA_MAGIC);
  w.u16(ACTOR_DATA_VERSION);
  w.u16(0);

  w.u16(data.models.length);
  for (const m of data.models) {
    w.u32(m.id);
    w.u16(m.vertexCount);
    w.u16(m.faceCount);
    w.u8((m.renderTypes ? MODEL_FLAG_RENDER_TYPES : 0) | (m.alphas ? MODEL_FLAG_ALPHAS : 0));
    w.i16s(m.x);
    w.i16s(m.y);
    w.i16s(m.z);
    w.u8s(m.skins);
    w.u16s(m.a);
    w.u16s(m.b);
    w.u16s(m.c);
    w.u16s(m.colors);
    if (m.renderTypes) w.u8s(m.renderTypes);
    if (m.alphas) w.u8s(m.alphas);
  }

  w.u16(data.kits.length);
  for (const k of data.kits) {
    w.u16(k.id);
    w.u8(k.bodyPart);
    w.u8(k.models.length);
    w.u16s(k.models);
    writeRecolors(w, k.recolorFrom, k.recolorTo);
  }

  for (const body of data.designer) {
    if (body.length !== BODY_SLOTS.length) throw new Error("designer needs 7 slots per body");
    for (const slot of body) {
      w.u8(slot.length);
      w.u16s(slot);
    }
  }

  w.u8(data.colors.length);
  for (const ch of data.colors) {
    w.u16(ch.source);
    w.u8(ch.colors.length);
    w.u16s(ch.colors);
    w.optU16(ch.source2);
    w.u8(ch.colors2.length);
    w.u16s(ch.colors2);
    w.u8(ch.designerCount);
  }

  w.u16(data.npcs.length);
  for (const n of data.npcs) {
    w.u32(n.id);
    w.str(n.name);
    w.u8(n.models.length);
    w.u16s(n.models);
    writeRecolors(w, n.recolorFrom, n.recolorTo);
    w.u16(n.widthScale);
    w.u16(n.heightScale);
    w.i8(n.ambient);
    w.i16(n.contrast);
    for (const s of [n.idle, n.walk, n.walkBack, n.walkLeft, n.walkRight, n.turnLeft, n.turnRight, n.run]) {
      w.optU16(s);
    }
  }

  w.u16(data.bases.length);
  for (const b of data.bases) {
    w.u16(b.id);
    w.u16(b.types.length);
    w.u8s(b.types);
    for (const labels of b.labels) {
      w.u8(labels.length);
      w.u8s(labels);
    }
  }

  w.u32(data.frames.length);
  for (const f of data.frames) {
    w.u16(f.base);
    w.u8(f.groups.length);
    w.u8s(f.groups);
    w.i16s(f.x);
    w.i16s(f.y);
    w.i16s(f.z);
  }

  w.u16(data.sequences.length);
  for (const s of data.sequences) {
    w.u16(s.id);
    w.u16(s.frames.length);
    w.u16s(s.frames);
    w.u16s(s.lengths);
    w.i16(s.frameStep);
    w.u8(s.maxLoops);
    w.i8(s.precedenceAnimating);
    w.i8(s.priority);
  }

  return w.finish();
}

function writeRecolors(w: Writer, from: number[], to: number[]): void {
  if (from.length !== to.length) throw new Error("recolour arrays differ in length");
  w.u8(from.length);
  for (let i = 0; i < from.length; i++) {
    w.u16(from[i]!);
    w.u16(to[i]!);
  }
}

// ---------------------------------------------------------------- reading

class Reader {
  private readonly view: DataView;
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number): void {
    if (this.offset + n > this.bytes.byteLength) {
      throw new RangeError(`actor data truncated at byte ${this.offset}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  i8(): number {
    this.need(1);
    return this.view.getInt8(this.offset++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  optU16(): number {
    const v = this.u16();
    return v === NONE_U16 ? -1 : v;
  }

  str(): string {
    const n = this.u8();
    this.need(n);
    const s = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + n));
    this.offset += n;
    return s;
  }

  u8Array(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u16Array(n: number): Uint16Array {
    this.need(n * 2);
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = this.view.getUint16(this.offset + i * 2, true);
    this.offset += n * 2;
    return out;
  }

  i16Array(n: number): Int16Array {
    this.need(n * 2);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = this.view.getInt16(this.offset + i * 2, true);
    this.offset += n * 2;
    return out;
  }

  done(): boolean {
    return this.offset === this.bytes.byteLength;
  }
}

export function decodeActorData(input: ArrayBuffer | Uint8Array): ActorData {
  const r = new Reader(input instanceof Uint8Array ? input : new Uint8Array(input));
  if (r.u32() !== ACTOR_DATA_MAGIC) throw new Error("not a RampRidge actor data file");
  const version = r.u16();
  if (version !== ACTOR_DATA_VERSION) {
    throw new Error(`actor data version ${version}, expected ${ACTOR_DATA_VERSION}`);
  }
  r.u16();

  const models: ModelSource[] = [];
  const modelCount = r.u16();
  for (let i = 0; i < modelCount; i++) {
    const id = r.u32();
    const vertexCount = r.u16();
    const faceCount = r.u16();
    const flags = r.u8();
    const x = r.i16Array(vertexCount);
    const y = r.i16Array(vertexCount);
    const z = r.i16Array(vertexCount);
    const skins = r.u8Array(vertexCount);
    const a = r.u16Array(faceCount);
    const b = r.u16Array(faceCount);
    const c = r.u16Array(faceCount);
    const colors = r.u16Array(faceCount);
    const renderTypes = flags & MODEL_FLAG_RENDER_TYPES ? r.u8Array(faceCount) : null;
    const alphas = flags & MODEL_FLAG_ALPHAS ? r.u8Array(faceCount) : null;
    for (const idx of [a, b, c]) {
      for (let f = 0; f < faceCount; f++) {
        if (idx[f]! >= vertexCount) throw new Error(`model ${id}: face index out of range`);
      }
    }
    models.push({ id, vertexCount, faceCount, x, y, z, skins, a, b, c, colors, renderTypes, alphas });
  }

  const kits: KitSource[] = [];
  const kitCount = r.u16();
  for (let i = 0; i < kitCount; i++) {
    const id = r.u16();
    const bodyPart = r.u8();
    const kitModels = Array.from(r.u16Array(r.u8()));
    for (const m of kitModels) if (m >= models.length) throw new Error(`kit ${id}: bad model index`);
    const [recolorFrom, recolorTo] = readRecolors(r);
    kits.push({ id, bodyPart, models: kitModels, recolorFrom, recolorTo });
  }

  const designer: [number[][], number[][]] = [[], []];
  for (const body of designer) {
    for (let s = 0; s < BODY_SLOTS.length; s++) {
      const slot = Array.from(r.u16Array(r.u8()));
      for (const k of slot) if (k >= kits.length) throw new Error("designer: bad kit index");
      body.push(slot);
    }
  }

  const colors: ColorChannel[] = [];
  const channelCount = r.u8();
  for (let i = 0; i < channelCount; i++) {
    const source = r.u16();
    const list = Array.from(r.u16Array(r.u8()));
    const source2 = r.optU16();
    const list2 = Array.from(r.u16Array(r.u8()));
    const designerCount = r.u8();
    colors.push({ source, colors: list, source2, colors2: list2, designerCount });
  }

  const npcs: NpcSource[] = [];
  const npcCount = r.u16();
  for (let i = 0; i < npcCount; i++) {
    const id = r.u32();
    const name = r.str();
    const npcModels = Array.from(r.u16Array(r.u8()));
    for (const m of npcModels) if (m >= models.length) throw new Error(`npc ${id}: bad model index`);
    const [recolorFrom, recolorTo] = readRecolors(r);
    const widthScale = r.u16();
    const heightScale = r.u16();
    const ambient = r.i8();
    const contrast = r.i16();
    const [idle, walk, walkBack, walkLeft, walkRight, turnLeft, turnRight, run] = [
      r.optU16(),
      r.optU16(),
      r.optU16(),
      r.optU16(),
      r.optU16(),
      r.optU16(),
      r.optU16(),
      r.optU16(),
    ] as const;
    npcs.push({
      id,
      name,
      models: npcModels,
      recolorFrom,
      recolorTo,
      widthScale,
      heightScale,
      ambient,
      contrast,
      idle,
      walk,
      walkBack,
      walkLeft,
      walkRight,
      turnLeft,
      turnRight,
      run,
    });
  }

  const bases: FrameBase[] = [];
  const baseCount = r.u16();
  for (let i = 0; i < baseCount; i++) {
    const id = r.u16();
    const count = r.u16();
    const types = r.u8Array(count);
    const labels: Uint8Array[] = [];
    for (let g = 0; g < count; g++) labels.push(r.u8Array(r.u8()));
    bases.push({ id, types, labels });
  }

  const frames: FrameSource[] = [];
  const frameCount = r.u32();
  for (let i = 0; i < frameCount; i++) {
    const base = r.u16();
    const baseDef = bases[base];
    if (!baseDef) throw new Error(`frame ${i}: bad base index`);
    const n = r.u8();
    const groups = r.u8Array(n);
    for (const g of groups) if (g >= baseDef.types.length) throw new Error(`frame ${i}: bad group`);
    frames.push({ base, groups, x: r.i16Array(n), y: r.i16Array(n), z: r.i16Array(n) });
  }

  const sequences: SequenceSource[] = [];
  const seqCount = r.u16();
  for (let i = 0; i < seqCount; i++) {
    const id = r.u16();
    const n = r.u16();
    const seqFrames = r.u16Array(n);
    for (const f of seqFrames) if (f >= frames.length) throw new Error(`seq ${id}: bad frame index`);
    const lengths = r.u16Array(n);
    const frameStep = r.i16();
    const maxLoops = r.u8();
    const precedenceAnimating = r.i8();
    const priority = r.i8();
    sequences.push({ id, frames: seqFrames, lengths, frameStep, maxLoops, precedenceAnimating, priority });
  }

  if (!r.done()) throw new Error("actor data has trailing bytes");
  return { models, kits, designer, colors, npcs, bases, frames, sequences };
}

function readRecolors(r: Reader): [number[], number[]] {
  const n = r.u8();
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < n; i++) {
    from.push(r.u16());
    to.push(r.u16());
  }
  return [from, to];
}
