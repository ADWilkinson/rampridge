/**
 * OSRS synthesised sound effects (cache index 4), ported from the client's
 * SoundEffect / Instrument / SoundEnvelope / AudioFilter classes.
 *
 * Structure follows osrscachereader (BSD-2-Clause, (c) 2023 Dezinater), with
 * the client's exact arithmetic restored: Java int overflow and truncating
 * division, float filter maths, long multiplies in the filter, and the noise
 * table generated from java.util.Random(0) as the client does (osrscachereader
 * used Math.random, which is neither faithful nor deterministic).
 */
import JavaRandom from "java-random";

import { IndexType } from "../vendor/rs-map-viewer/src/rs/cache/IndexType";
import type { BakeCache } from "./cache";

export const SAMPLE_RATE = 22050;

const f = Math.fround;
const idiv = (a: number, b: number) => Math.trunc(a / b) | 0;

const NOISE = (() => {
  const rnd = new JavaRandom(0);
  const t = new Int32Array(32768);
  for (let i = 0; i < 32768; i++) t[i] = (rnd.nextInt() & 2) - 1;
  return t;
})();
const SINE = (() => {
  const t = new Int32Array(32768);
  for (let i = 0; i < 32768; i++) t[i] = Math.trunc(Math.sin(i / 5215.1903) * 16384.0);
  return t;
})();

class Reader {
  pos = 0;
  constructor(private readonly v: DataView) {}
  u8() {
    return this.v.getUint8(this.pos++);
  }
  u16() {
    const x = this.v.getUint16(this.pos);
    this.pos += 2;
    return x;
  }
  i32() {
    const x = this.v.getInt32(this.pos);
    this.pos += 4;
    return x;
  }
  peek() {
    return this.v.getUint8(this.pos);
  }
  uSmart() {
    return this.peek() < 128 ? this.u8() : this.u16() - 0x8000;
  }
  sSmart() {
    return this.peek() < 128 ? this.u8() - 64 : this.u16() - 0xc000;
  }
}

class Envelope {
  segments = 2;
  durations: number[] = [0, 65535];
  phases: number[] = [0, 65535];
  start = 0;
  end = 0;
  form = 0;
  private ticks = 0;
  private phaseIndex = 0;
  private step = 0;
  private amplitude = 0;
  private max = 0;

  decode(r: Reader) {
    this.form = r.u8();
    this.start = r.i32();
    this.end = r.i32();
    this.decodeSegments(r);
  }
  decodeSegments(r: Reader) {
    this.segments = r.u8();
    this.durations = [];
    this.phases = [];
    for (let i = 0; i < this.segments; i++) {
      this.durations.push(r.u16());
      this.phases.push(r.u16());
    }
  }
  reset() {
    this.ticks = 0;
    this.phaseIndex = 0;
    this.step = 0;
    this.amplitude = 0;
    this.max = 0;
  }
  doStep(n: number): number {
    if (this.max >= this.ticks) {
      this.amplitude = (this.phases[this.phaseIndex++]! << 15) | 0;
      if (this.phaseIndex >= this.segments) this.phaseIndex = this.segments - 1;
      this.ticks = Math.trunc((this.durations[this.phaseIndex]! / 65536.0) * n);
      if (this.ticks > this.max) this.step = idiv(((this.phases[this.phaseIndex]! << 15) | 0) - this.amplitude, this.ticks - this.max);
    }
    this.amplitude = (this.amplitude + this.step) | 0;
    this.max++;
    return ((this.amplitude - this.step) | 0) >> 15;
  }
}

/** Shared like the client's statics. */
const filterState = {
  field305: [new Float32Array(8), new Float32Array(8)],
  coefficients: [new Int32Array(8), new Int32Array(8)],
  field309: 0,
  forwardMultiplier: 0,
};

class Filter {
  pairs = [0, 0];
  field304 = [0, 1].map(() => [new Int32Array(4), new Int32Array(4)]);
  field306 = [0, 1].map(() => [new Int32Array(4), new Int32Array(4)]);
  field307 = [0, 0];

  decode(r: Reader, env: Envelope) {
    const v = r.u8();
    this.pairs[0] = v >> 4;
    this.pairs[1] = v & 15;
    if (v !== 0) {
      this.field307[0] = r.u16();
      this.field307[1] = r.u16();
      const mask = r.u8();
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < this.pairs[a]!; b++) {
          this.field304[a]![0]![b] = r.u16();
          this.field306[a]![0]![b] = r.u16();
        }
      }
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < this.pairs[a]!; b++) {
          if (mask & ((1 << (a * 4)) << b)) {
            this.field304[a]![1]![b] = r.u16();
            this.field306[a]![1]![b] = r.u16();
          } else {
            this.field304[a]![1]![b] = this.field304[a]![0]![b]!;
            this.field306[a]![1]![b] = this.field306[a]![0]![b]!;
          }
        }
      }
      if (mask !== 0 || this.field307[1] !== this.field307[0]) env.decodeSegments(r);
    } else {
      this.field307[0] = this.field307[1] = 0;
    }
  }

  private gain(a: number, b: number, t: number): number {
    let x = f(this.field306[a]![0]![b]! + f(t * (this.field306[a]![1]![b]! - this.field306[a]![0]![b]!)));
    x = f(x * f(0.0015258789));
    return f(1.0 - f(Math.pow(10.0, f(-x / 20.0))));
  }

  private freq(a: number, b: number, t: number): number {
    let x = f(this.field304[a]![0]![b]! + f(t * (this.field304[a]![1]![b]! - this.field304[a]![0]![b]!)));
    x = f(x * f(1.2207031e-4));
    const hz = f(f(32.703197) * f(Math.pow(2.0, x)));
    return f(f(hz * f(3.1415927)) / f(11025.0));
  }

  compute(a: number, t: number): number {
    const s = filterState;
    if (a === 0) {
      let x = f(this.field307[0]! + f((this.field307[1]! - this.field307[0]!) * t));
      x = f(x * f(0.0030517578));
      s.field309 = f(Math.pow(0.1, f(x / 20.0)));
      s.forwardMultiplier = Math.trunc(f(s.field309 * 65536.0));
    }
    const n = this.pairs[a]!;
    if (n === 0) return 0;
    const c = s.field305[a]!;
    let g = this.gain(a, 0, t);
    c[0] = f(f(f(-2.0 * g) * f(Math.cos(this.freq(a, 0, t)))));
    c[1] = f(g * g);
    for (let i = 1; i < n; i++) {
      g = this.gain(a, i, t);
      const p = f(f(-2.0 * g) * f(Math.cos(this.freq(a, i, t))));
      const q = f(g * g);
      c[i * 2 + 1] = f(c[i * 2 - 1]! * q);
      c[i * 2] = f(f(c[i * 2 - 1]! * p) + f(c[i * 2 - 2]! * q));
      for (let k = i * 2 - 1; k >= 2; k--) c[k] = f(c[k]! + f(f(c[k - 1]! * p) + f(c[k - 2]! * q)));
      c[1] = f(c[1]! + f(f(c[0]! * p) + q));
      c[0] = f(c[0]! + p);
    }
    if (a === 0) for (let i = 0; i < n * 2; i++) c[i] = f(c[i]! * s.field309);
    for (let i = 0; i < n * 2; i++) s.coefficients[a]![i] = Math.trunc(f(c[i]! * 65536.0));
    return n * 2;
  }
}

const SAMPLES = new Int32Array(220500);

class Instrument {
  pitch = new Envelope();
  volume = new Envelope();
  pitchModifier?: Envelope;
  pitchModifierAmplitude?: Envelope;
  volumeMultiplier?: Envelope;
  volumeMultiplierAmplitude?: Envelope;
  release?: Envelope;
  attack?: Envelope;
  oscillatorVolume = [0, 0, 0, 0, 0];
  oscillatorPitch = [0, 0, 0, 0, 0];
  oscillatorDelays = [0, 0, 0, 0, 0];
  delayTime = 0;
  delayDecay = 100;
  duration = 500;
  offset = 0;
  filter = new Filter();
  filterEnvelope = new Envelope();

  private phases = new Int32Array(5);
  private delays = new Int32Array(5);
  private volumeSteps = new Int32Array(5);
  private pitchSteps = new Int32Array(5);
  private pitchBaseSteps = new Int32Array(5);

  decode(r: Reader) {
    this.pitch.decode(r);
    this.volume.decode(r);
    if (r.peek() !== 0) {
      this.pitchModifier = new Envelope();
      this.pitchModifier.decode(r);
      this.pitchModifierAmplitude = new Envelope();
      this.pitchModifierAmplitude.decode(r);
    } else r.u8();
    if (r.peek() !== 0) {
      this.volumeMultiplier = new Envelope();
      this.volumeMultiplier.decode(r);
      this.volumeMultiplierAmplitude = new Envelope();
      this.volumeMultiplierAmplitude.decode(r);
    } else r.u8();
    if (r.peek() !== 0) {
      this.release = new Envelope();
      this.release.decode(r);
      this.attack = new Envelope();
      this.attack.decode(r);
    } else r.u8();
    for (let i = 0; i < 10; i++) {
      const vol = r.uSmart();
      if (vol === 0) break;
      this.oscillatorVolume[i] = vol;
      this.oscillatorPitch[i] = r.sSmart();
      this.oscillatorDelays[i] = r.uSmart();
    }
    this.delayTime = r.uSmart();
    this.delayDecay = r.uSmart();
    this.duration = r.u16();
    this.offset = r.u16();
    this.filter.decode(r, this.filterEnvelope);
  }

  private wave(phase: number, amp: number, form: number): number {
    if (form === 1) return (phase & 32767) < 16384 ? amp : -amp;
    if (form === 2) return Math.imul(SINE[phase & 32767]!, amp) >> 14;
    if (form === 3) return (Math.imul(amp, phase & 32767) >> 14) - amp;
    if (form === 4) return Math.imul(amp, NOISE[idiv(phase, 2607) & 32767]!);
    return 0;
  }

  synthesize(n: number, ms: number): Int32Array {
    const s = SAMPLES;
    s.fill(0, 0, n);
    if (ms < 10) return s;
    const rate = n / (ms + 0.0);
    this.pitch.reset();
    this.volume.reset();
    let pmStep = 0, pmBase = 0, pmPhase = 0;
    if (this.pitchModifier) {
      this.pitchModifier.reset();
      this.pitchModifierAmplitude!.reset();
      pmStep = Math.trunc(((this.pitchModifier.end - this.pitchModifier.start) * 32.768) / rate);
      pmBase = Math.trunc((this.pitchModifier.start * 32.768) / rate);
    }
    let vmStep = 0, vmBase = 0, vmPhase = 0;
    if (this.volumeMultiplier) {
      this.volumeMultiplier.reset();
      this.volumeMultiplierAmplitude!.reset();
      vmStep = Math.trunc(((this.volumeMultiplier.end - this.volumeMultiplier.start) * 32.768) / rate);
      vmBase = Math.trunc((this.volumeMultiplier.start * 32.768) / rate);
    }
    for (let o = 0; o < 5; o++) {
      if (this.oscillatorVolume[o] === 0) continue;
      this.phases[o] = 0;
      this.delays[o] = Math.trunc(this.oscillatorDelays[o]! * rate);
      this.volumeSteps[o] = idiv(this.oscillatorVolume[o]! << 14, 100);
      this.pitchSteps[o] = Math.trunc(((this.pitch.end - this.pitch.start) * 32.768 * Math.pow(1.0057929410678534, this.oscillatorPitch[o]!)) / rate);
      this.pitchBaseSteps[o] = Math.trunc((this.pitch.start * 32.768) / rate);
    }
    for (let i = 0; i < n; i++) {
      let p = this.pitch.doStep(n);
      let v = this.volume.doStep(n);
      if (this.pitchModifier) {
        const a = this.pitchModifier.doStep(n);
        const b = this.pitchModifierAmplitude!.doStep(n);
        p = (p + (this.wave(pmPhase, b, this.pitchModifier.form) >> 1)) | 0;
        pmPhase = (pmPhase + pmBase + (Math.imul(a, pmStep) >> 16)) | 0;
      }
      if (this.volumeMultiplier) {
        const a = this.volumeMultiplier.doStep(n);
        const b = this.volumeMultiplierAmplitude!.doStep(n);
        v = Math.imul(v, (this.wave(vmPhase, b, this.volumeMultiplier.form) >> 1) + 32768) >> 15;
        vmPhase = (vmPhase + vmBase + (Math.imul(a, vmStep) >> 16)) | 0;
      }
      for (let o = 0; o < 5; o++) {
        if (this.oscillatorVolume[o] === 0) continue;
        const k = this.delays[o]! + i;
        if (k < n) {
          s[k] = (s[k]! + this.wave(this.phases[o]!, Math.imul(v, this.volumeSteps[o]!) >> 15, this.pitch.form)) | 0;
          this.phases[o] = (this.phases[o]! + (Math.imul(p, this.pitchSteps[o]!) >> 16) + this.pitchBaseSteps[o]!) | 0;
        }
      }
    }
    if (this.release) {
      this.release.reset();
      this.attack!.reset();
      let counter = 0;
      let gate = true;
      for (let i = 0; i < n; i++) {
        const a = this.release.doStep(n);
        const b = this.attack!.doStep(n);
        const span = this.release.end - this.release.start;
        const limit = gate ? (Math.imul(a, span) >> 8) + this.release.start : (Math.imul(b, span) >> 8) + this.release.start;
        counter += 256;
        if (counter >= limit) {
          counter = 0;
          gate = !gate;
        }
        if (gate) s[i] = 0;
      }
    }
    if (this.delayTime > 0 && this.delayDecay > 0) {
      const d = Math.trunc(this.delayTime * rate);
      for (let i = d; i < n; i++) s[i] = (s[i]! + idiv(Math.imul(s[i - d]!, this.delayDecay), 100)) | 0;
    }
    if (this.filter.pairs[0]! > 0 || this.filter.pairs[1]! > 0) this.applyFilter(n);
    for (let i = 0; i < n; i++) {
      if (s[i]! < -32768) s[i] = -32768;
      if (s[i]! > 32767) s[i] = 32767;
    }
    return s;
  }

  private applyFilter(n: number) {
    const s = SAMPLES;
    const st = filterState;
    const mul = (a: number, b: number) => Math.floor((a * b) / 65536);
    this.filterEnvelope.reset();
    let env = this.filterEnvelope.doStep(n + 1);
    let fwd = this.filter.compute(0, f(env / 65536.0));
    let back = this.filter.compute(1, f(env / 65536.0));
    if (n < fwd + back) return;
    let i = 0;
    let end = back;
    if (back > n - fwd) end = n - fwd;
    while (i < end) {
      let acc = mul(s[i + fwd]!, st.forwardMultiplier);
      for (let k = 0; k < fwd; k++) acc += mul(s[i + fwd - 1 - k]!, st.coefficients[0]![k]!);
      for (let k = 0; k < i; k++) acc -= mul(s[i - 1 - k]!, st.coefficients[1]![k]!);
      s[i] = acc | 0;
      env = this.filterEnvelope.doStep(n + 1);
      i++;
    }
    end = 128;
    for (;;) {
      if (end > n - fwd) end = n - fwd;
      while (i < end) {
        let acc = mul(s[i + fwd]!, st.forwardMultiplier);
        for (let k = 0; k < fwd; k++) acc += mul(s[i + fwd - 1 - k]!, st.coefficients[0]![k]!);
        for (let k = 0; k < back; k++) acc -= mul(s[i - 1 - k]!, st.coefficients[1]![k]!);
        s[i] = acc | 0;
        env = this.filterEnvelope.doStep(n + 1);
        i++;
      }
      if (i >= n - fwd) {
        while (i < n) {
          let acc = 0;
          for (let k = i + fwd - n; k < fwd; k++) acc += mul(s[i + fwd - 1 - k]!, st.coefficients[0]![k]!);
          for (let k = 0; k < back; k++) acc -= mul(s[i - 1 - k]!, st.coefficients[1]![k]!);
          s[i] = acc | 0;
          this.filterEnvelope.doStep(n + 1);
          i++;
        }
        break;
      }
      fwd = this.filter.compute(0, f(env / 65536.0));
      back = this.filter.compute(1, f(env / 65536.0));
      end += 128;
    }
  }
}

export interface SoundEffect {
  id: number;
  instruments: (Instrument | undefined)[];
  /** Loop points in ms (unused for one-shot effects). */
  start: number;
  end: number;
}

export function loadSoundEffect(cache: BakeCache, id: number): SoundEffect {
  const file = cache.system.getIndex(IndexType.DAT2.soundEffects).getFile(id, 0);
  if (!file) throw new Error(`sound effect ${id} not found`);
  const r = new Reader(new DataView(file.data.buffer, file.data.byteOffset, file.data.byteLength));
  const instruments: (Instrument | undefined)[] = [];
  for (let i = 0; i < 10; i++) {
    if (r.peek() !== 0) {
      const ins = new Instrument();
      ins.decode(r);
      instruments.push(ins);
    } else {
      r.u8();
      instruments.push(undefined);
    }
  }
  const start = r.u16();
  const end = r.u16();
  return { id, instruments, start, end };
}

/** SoundEffect.mix: signed 8-bit PCM at 22050 Hz. */
export function mixSoundEffect(fx: SoundEffect): Int8Array {
  let ms = 0;
  for (const ins of fx.instruments) if (ins && ins.duration + ins.offset > ms) ms = ins.duration + ins.offset;
  if (ms === 0) return new Int8Array(0);
  const out = new Int8Array(idiv(ms * SAMPLE_RATE, 1000));
  for (const ins of fx.instruments) {
    if (!ins) continue;
    const n = idiv(ins.duration * SAMPLE_RATE, 1000);
    const off = idiv(ins.offset * SAMPLE_RATE, 1000);
    const samples = ins.synthesize(n, ins.duration);
    for (let i = 0; i < n; i++) {
      let v = (samples[i]! >> 8) + out[i + off]!;
      if ((v + 128) & -256) v = (v >> 31) ^ 127;
      out[i + off] = v;
    }
  }
  return out;
}

/** Mono 8-bit unsigned PCM WAV. */
export function toWav(pcm: Int8Array, rate = SAMPLE_RATE): Buffer {
  const b = Buffer.alloc(44 + pcm.length);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + pcm.length, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28); // byte rate
  b.writeUInt16LE(1, 32); // block align
  b.writeUInt16LE(8, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(pcm.length, 40);
  for (let i = 0; i < pcm.length; i++) b[44 + i] = (pcm[i]! + 128) & 0xff;
  return b;
}
