/**
 * Model merging, recolouring and Gouraud lighting, ported from rs-map-viewer's
 * ModelData (merge, copyVertex, recolor, calculateVertexNormals, light,
 * computeAnimationTables) and checked against the client's ModelData.toModel.
 * Integer arithmetic follows the client (Java int division truncates before
 * the ambient term is added).
 *
 * Portions Copyright (c) 2022-2023, dennisdev (https://github.com/dennisdev/rs-map-viewer)
 * BSD 2-Clause License; see ./NOTICE.
 */
import type { ModelSource } from "./format";

/** Player light: PlayerComposition.getModel -> toModel(64, 850, -30, -50, -30). */
export const PLAYER_LIGHT = { ambient: 64, contrast: 850, x: -30, y: -50, z: -30 } as const;
/** NPC light: toModel(ambient + 64, contrast + 850, -30, -50, -30). */
export const NPC_LIGHT_BASE = { ambient: 64, contrast: 850, x: -30, y: -50, z: -30 } as const;

export interface MergePart {
  model: ModelSource;
  recolorFrom?: readonly number[];
  recolorTo?: readonly number[];
}

/** Unlit merged model in model units (128 per tile, y down). */
export class ModelData {
  vertexCount = 0;
  faceCount = 0;
  x: Int32Array;
  y: Int32Array;
  z: Int32Array;
  skins: Int32Array;
  a: Int32Array;
  b: Int32Array;
  c: Int32Array;
  colors: Uint16Array;
  renderTypes: Int8Array | null;
  alphas: Int8Array | null;

  private constructor(vertexCapacity: number, faceCount: number, renderTypes: boolean, alphas: boolean) {
    this.x = new Int32Array(vertexCapacity);
    this.y = new Int32Array(vertexCapacity);
    this.z = new Int32Array(vertexCapacity);
    this.skins = new Int32Array(vertexCapacity);
    this.a = new Int32Array(faceCount);
    this.b = new Int32Array(faceCount);
    this.c = new Int32Array(faceCount);
    this.colors = new Uint16Array(faceCount);
    this.renderTypes = renderTypes ? new Int8Array(faceCount) : null;
    this.alphas = alphas ? new Int8Array(faceCount) : null;
  }

  /**
   * Concatenates models in order, welding vertices that share a position
   * with any earlier vertex (the first copy keeps its skin), exactly as the
   * client's ModelData(ModelData[], int) constructor does.
   */
  static merge(parts: readonly MergePart[]): ModelData {
    let vertices = 0;
    let faces = 0;
    let renderTypes = false;
    let alphas = false;
    for (const p of parts) {
      vertices += p.model.vertexCount;
      faces += p.model.faceCount;
      renderTypes ||= p.model.renderTypes !== null;
      alphas ||= p.model.alphas !== null;
    }
    const out = new ModelData(vertices, faces, renderTypes, alphas);
    const welded = new Map<number, number>();
    const copyVertex = (m: ModelSource, v: number): number => {
      const x = m.x[v]!;
      const y = m.y[v]!;
      const z = m.z[v]!;
      const key = ((x + 0x8000) * 0x10000 + (y + 0x8000)) * 0x10000 + (z + 0x8000);
      const known = welded.get(key);
      if (known !== undefined) return known;
      const index = out.vertexCount++;
      out.x[index] = x;
      out.y[index] = y;
      out.z[index] = z;
      out.skins[index] = m.skins[v]!;
      welded.set(key, index);
      return index;
    };
    for (const p of parts) {
      const m = p.model;
      const first = out.faceCount;
      for (let f = 0; f < m.faceCount; f++) {
        const i = out.faceCount++;
        if (out.renderTypes && m.renderTypes) out.renderTypes[i] = m.renderTypes[f]!;
        if (out.alphas && m.alphas) out.alphas[i] = (m.alphas[f]! << 24) >> 24;
        out.colors[i] = m.colors[f]!;
        out.a[i] = copyVertex(m, m.a[f]!);
        out.b[i] = copyVertex(m, m.b[f]!);
        out.c[i] = copyVertex(m, m.c[f]!);
      }
      // Kit/NPC recolours apply to that part only, before the global merge.
      const from = p.recolorFrom ?? [];
      const to = p.recolorTo ?? [];
      for (let r = 0; r < from.length; r++) {
        const src = from[r]! & 0xffff;
        const dst = to[r]! & 0xffff;
        for (let i = first; i < out.faceCount; i++) if (out.colors[i] === src) out.colors[i] = dst;
      }
    }
    return out;
  }

  recolor(from: number, to: number): void {
    const src = from & 0xffff;
    const dst = to & 0xffff;
    for (let i = 0; i < this.faceCount; i++) if (this.colors[i] === src) this.colors[i] = dst;
  }

  /** Gouraud-lights the model (ModelData.toModel). Colours are fixed for the model's lifetime. */
  light(ambient: number, contrast: number, lightX: number, lightY: number, lightZ: number): LitModel {
    const v = this.vertexCount;
    const nx = new Int32Array(v);
    const ny = new Int32Array(v);
    const nz = new Int32Array(v);
    const mag = new Int32Array(v);
    const flat = new Map<number, [number, number, number]>();
    const { x, y, z, a, b, c } = this;

    for (let f = 0; f < this.faceCount; f++) {
      const i1 = a[f]!;
      const i2 = b[f]!;
      const i3 = c[f]!;
      const dx1 = x[i2]! - x[i1]!;
      const dy1 = y[i2]! - y[i1]!;
      const dz1 = z[i2]! - z[i1]!;
      const dx2 = x[i3]! - x[i1]!;
      const dy2 = y[i3]! - y[i1]!;
      const dz2 = z[i3]! - z[i1]!;
      let cx = dy1 * dz2 - dy2 * dz1;
      let cy = dz1 * dx2 - dz2 * dx1;
      let cz = dx1 * dy2 - dx2 * dy1;
      while (cx > 8192 || cy > 8192 || cz > 8192 || cx < -8192 || cy < -8192 || cz < -8192) {
        cx >>= 1;
        cy >>= 1;
        cz >>= 1;
      }
      let length = Math.sqrt(cx * cx + cy * cy + cz * cz) | 0;
      if (length <= 0) length = 1;
      cx = ((cx * 256) / length) | 0;
      cy = ((cy * 256) / length) | 0;
      cz = ((cz * 256) / length) | 0;
      const type = this.renderTypes ? this.renderTypes[f]! : 0;
      if (type === 0) {
        for (const vi of [i1, i2, i3]) {
          nx[vi]! += cx;
          ny[vi]! += cy;
          nz[vi]! += cz;
          mag[vi]! += 1;
        }
      } else if (type === 1) {
        flat.set(f, [cx, cy, cz]);
      }
    }

    const magnitude = Math.sqrt(lightX * lightX + lightY * lightY + lightZ * lightZ) | 0;
    const intensity = (magnitude * contrast) >> 8;
    const color1 = new Int32Array(this.faceCount);
    const color2 = new Int32Array(this.faceCount);
    const color3 = new Int32Array(this.faceCount);
    const smooth = (hsl: number, vi: number): number => {
      const dot = lightX * nx[vi]! + lightY * ny[vi]! + lightZ * nz[vi]!;
      return adjustLightness(hsl, (((dot / (intensity * mag[vi]!)) | 0) + ambient) | 0);
    };

    for (let f = 0; f < this.faceCount; f++) {
      let type = this.renderTypes ? this.renderTypes[f]! : 0;
      const alpha = this.alphas ? this.alphas[f]! : 0;
      if (alpha === -2) type = 3;
      if (alpha === -1) type = 2;
      const hsl = this.colors[f]!;
      if (type === 0) {
        color1[f] = smooth(hsl, a[f]!);
        color2[f] = smooth(hsl, b[f]!);
        color3[f] = smooth(hsl, c[f]!);
      } else if (type === 1) {
        const n = flat.get(f)!;
        const dot = lightX * n[0] + lightY * n[1] + lightZ * n[2];
        color1[f] = adjustLightness(hsl, (((dot / ((intensity >> 1) + intensity)) | 0) + ambient) | 0);
        color3[f] = -1;
      } else if (type === 3) {
        color1[f] = 128;
        color3[f] = -1;
      } else {
        color3[f] = -2;
      }
    }

    let alphas: Uint8Array | null = null;
    if (this.alphas) {
      alphas = new Uint8Array(this.faceCount);
      for (let f = 0; f < this.faceCount; f++) alphas[f] = this.alphas[f]! & 0xff;
    }

    let height = 0;
    for (let i = 0; i < v; i++) if (-y[i]! > height) height = -y[i]!;

    return {
      vertexCount: v,
      faceCount: this.faceCount,
      x: x.slice(0, v),
      y: y.slice(0, v),
      z: z.slice(0, v),
      a: a.slice(),
      b: b.slice(),
      c: c.slice(),
      color1,
      color2,
      color3,
      alphas,
      vertexLabels: buildVertexLabels(this.skins, v),
      height,
    };
  }
}

/** A lit model: positions still in model units, colours as per-corner HSL16. */
export interface LitModel {
  vertexCount: number;
  faceCount: number;
  x: Int32Array;
  y: Int32Array;
  z: Int32Array;
  a: Int32Array;
  b: Int32Array;
  c: Int32Array;
  /** HSL16 per face corner; color3 is -1 for flat faces (use color1) and -2 for hidden faces. */
  color1: Int32Array;
  color2: Int32Array;
  color3: Int32Array;
  /** Transparency 0 (opaque) .. 255; null when every face is opaque. */
  alphas: Uint8Array | null;
  /** Vertex indices per animation label (vertex skin). */
  vertexLabels: Int32Array[];
  /** Highest point above the model origin, model units. */
  height: number;
}

export function adjustLightness(hsl: number, lightness: number): number {
  let l = ((hsl & 127) * lightness) >> 7;
  if (l < 2) l = 2;
  else if (l > 126) l = 126;
  return (hsl & 0xff80) + l;
}

function buildVertexLabels(skins: Int32Array, vertexCount: number): Int32Array[] {
  let highest = -1;
  const counts = new Int32Array(256);
  for (let i = 0; i < vertexCount; i++) {
    const s = skins[i]!;
    if (s >= 0) {
      counts[s]!++;
      if (s > highest) highest = s;
    }
  }
  const labels: Int32Array[] = [];
  for (let s = 0; s <= highest; s++) labels.push(new Int32Array(counts[s]!));
  counts.fill(0);
  for (let i = 0; i < vertexCount; i++) {
    const s = skins[i]!;
    if (s >= 0) labels[s]![counts[s]!++] = i;
  }
  return labels;
}
