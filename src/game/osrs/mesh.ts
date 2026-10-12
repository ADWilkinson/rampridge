import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Sphere, Vector3 } from "three";

import { writeLinearRgb } from "./color";
import type { LitModel } from "./model";

/** 128 model units per tile. */
export const MODEL_UNITS_PER_TILE = 128;

/**
 * Builds and updates the three.js geometry of a lit OSRS model.
 *
 * Face corners that share a vertex, colour and transparency become one
 * indexed vertex (as a client vertex buffer would), so an animation update
 * only rewrites positions: colours are lit once, like the client, which
 * never relights an animated model. Hidden faces (render type 2, alpha -1)
 * and fully transparent faces are dropped. Opaque faces form geometry group
 * 0, translucent faces group 1.
 */
export class ModelGeometry {
  readonly geometry = new BufferGeometry();
  /** Model vertex for each geometry vertex. */
  private readonly source: Uint16Array;
  private readonly positions: Float32Array;
  private readonly positionAttr: BufferAttribute;
  readonly hasTransparency: boolean;

  constructor(
    lit: LitModel,
    private readonly scaleX = 1,
    private readonly scaleY = 1,
    private readonly scaleZ = 1,
  ) {
    const keys = new Map<number, number>();
    const source: number[] = [];
    const colors: number[] = [];
    const alphas: number[] = [];
    const opaque: number[] = [];
    const translucent: number[] = [];
    const rgb = new Float32Array(3);

    const corner = (vertex: number, hsl: number, alpha: number): number => {
      const key = (vertex * 0x10000 + (hsl & 0xffff)) * 0x100 + alpha;
      let index = keys.get(key);
      if (index === undefined) {
        index = source.length;
        keys.set(key, index);
        source.push(vertex);
        writeLinearRgb(hsl, rgb, 0);
        colors.push(rgb[0]!, rgb[1]!, rgb[2]!);
        alphas.push(alpha / 255);
      }
      return index;
    };

    for (let f = 0; f < lit.faceCount; f++) {
      const c3 = lit.color3[f]!;
      if (c3 === -2) continue;
      // Client transparency: 0 opaque .. 255 invisible.
      const alpha = lit.alphas ? 0xff - lit.alphas[f]! : 0xff;
      if (alpha <= 1) continue;
      const c1 = lit.color1[f]!;
      const flat = c3 === -1;
      const ia = corner(lit.a[f]!, c1, alpha);
      const ib = corner(lit.b[f]!, flat ? c1 : lit.color2[f]!, alpha);
      const ic = corner(lit.c[f]!, flat ? c1 : c3, alpha);
      // (x, -y, -z) is a proper rotation of model space, so the client's winding is kept: counter-clockwise front faces.
      (alpha < 0xff ? translucent : opaque).push(ia, ib, ic);
    }

    this.hasTransparency = translucent.length > 0;
    this.source = Uint16Array.from(source);
    this.positions = new Float32Array(source.length * 3);
    this.positionAttr = new BufferAttribute(this.positions, 3);
    this.positionAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("position", this.positionAttr);

    if (this.hasTransparency) {
      const rgba = new Float32Array(source.length * 4);
      for (let i = 0; i < source.length; i++) {
        rgba[i * 4] = colors[i * 3]!;
        rgba[i * 4 + 1] = colors[i * 3 + 1]!;
        rgba[i * 4 + 2] = colors[i * 3 + 2]!;
        rgba[i * 4 + 3] = alphas[i]!;
      }
      this.geometry.setAttribute("color", new BufferAttribute(rgba, 4));
    } else {
      this.geometry.setAttribute("color", new BufferAttribute(Float32Array.from(colors), 3));
    }

    const indexCount = opaque.length + translucent.length;
    const index = source.length > 0xffff ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    index.set(opaque, 0);
    index.set(translucent, opaque.length);
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.addGroup(0, opaque.length, 0);
    if (translucent.length > 0) this.geometry.addGroup(opaque.length, translucent.length, 1);

    // Bind pose, and a generous fixed bound so emotes never get frustum-culled.
    this.write(Float32Array.from(lit.x), Float32Array.from(lit.y), Float32Array.from(lit.z));
    let radius = 0;
    const height = (lit.height / MODEL_UNITS_PER_TILE) * scaleY;
    for (let i = 0; i < source.length; i++) {
      const x = this.positions[i * 3]!;
      const y = this.positions[i * 3 + 1]! - height / 2;
      const z = this.positions[i * 3 + 2]!;
      radius = Math.max(radius, Math.hypot(x, y, z));
    }
    this.geometry.boundingSphere = new Sphere(new Vector3(0, height / 2, 0), radius * 1.6 + 0.25);
  }

  /** Copies model-space vertex positions (y down) into the geometry, in tiles with y up and north = -z. */
  write(px: Float32Array, py: Float32Array, pz: Float32Array): void {
    const { source, positions } = this;
    const sx = this.scaleX / MODEL_UNITS_PER_TILE;
    const sy = -this.scaleY / MODEL_UNITS_PER_TILE;
    const sz = -this.scaleZ / MODEL_UNITS_PER_TILE;
    for (let i = 0, o = 0; i < source.length; i++, o += 3) {
      const v = source[i]!;
      positions[o] = px[v]! * sx;
      positions[o + 1] = py[v]! * sy;
      positions[o + 2] = pz[v]! * sz;
    }
    this.positionAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
