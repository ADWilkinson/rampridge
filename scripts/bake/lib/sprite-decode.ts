/**
 * Cache sprite decoding (index 8), following the client's SpriteLoader,
 * including the per-frame alpha channel (flag bit 2) that newer interface
 * sprites use and the vendored rs-map-viewer decoder ignores.
 */
import { PNG } from "pngjs";

import { IndexType } from "../vendor/rs-map-viewer/src/rs/cache/IndexType";
import type { BakeCache } from "./cache";
import { encodePng } from "./png";

export interface SpriteFrame {
  /** Group (archive) id and frame index. */
  id: number;
  frame: number;
  /** Size of the drawn pixels. */
  width: number;
  height: number;
  /** Offset of the pixels inside the group canvas (the client's xOffset/yOffset). */
  offsetX: number;
  offsetY: number;
  /** Group canvas size. */
  canvasWidth: number;
  canvasHeight: number;
  /** ARGB, 0 = transparent. */
  argb: Uint32Array;
}

const FLAG_VERTICAL = 0b01;
const FLAG_ALPHA = 0b10;

export function decodeSpriteGroup(cache: BakeCache, id: number): SpriteFrame[] {
  const index = cache.system.getIndex(IndexType.DAT2.sprites);
  const file = index.getFile(id, 0);
  if (!file) throw new Error(`sprite group ${id} not found`);
  const data = file.data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u8 = (o: number) => view.getUint8(o);
  const u16 = (o: number) => view.getUint16(o);

  const count = u16(data.length - 2);
  let p = data.length - 7 - count * 8;
  const canvasWidth = u16(p);
  const canvasHeight = u16(p + 2);
  const paletteSize = u8(p + 4) + 1;
  p += 5;
  const offX: number[] = [];
  const offY: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  for (let i = 0; i < count; i++) offX.push(u16(p + i * 2));
  p += count * 2;
  for (let i = 0; i < count; i++) offY.push(u16(p + i * 2));
  p += count * 2;
  for (let i = 0; i < count; i++) widths.push(u16(p + i * 2));
  p += count * 2;
  for (let i = 0; i < count; i++) heights.push(u16(p + i * 2));

  p = data.length - 7 - count * 8 - (paletteSize - 1) * 3;
  const palette = new Uint32Array(paletteSize);
  for (let i = 1; i < paletteSize; i++) {
    let rgb = (u8(p) << 16) | (u8(p + 1) << 8) | u8(p + 2);
    if (rgb === 0) rgb = 1;
    palette[i] = rgb;
    p += 3;
  }

  const frames: SpriteFrame[] = [];
  p = 0;
  for (let f = 0; f < count; f++) {
    const w = widths[f]!;
    const h = heights[f]!;
    const n = w * h;
    const flags = u8(p++);
    const indices = new Uint8Array(n);
    if ((flags & FLAG_VERTICAL) === 0) {
      for (let i = 0; i < n; i++) indices[i] = u8(p++);
    } else {
      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) indices[w * y + x] = u8(p++);
    }
    const argb = new Uint32Array(n);
    if (flags & FLAG_ALPHA) {
      const alpha = new Uint8Array(n);
      if ((flags & FLAG_VERTICAL) === 0) {
        for (let i = 0; i < n; i++) alpha[i] = u8(p++);
      } else {
        for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) alpha[w * y + x] = u8(p++);
      }
      // A few legacy sprites (the fixed-mode tab highlights) ship an all-zero alpha channel over
      // intact pixels; the client draws those with palette transparency, so do the same.
      const blankAlpha = alpha.every((a) => a === 0) && indices.some((k) => k !== 0);
      for (let i = 0; i < n; i++) {
        const k = indices[i]!;
        argb[i] = blankAlpha ? (k === 0 ? 0 : (0xff000000 | palette[k]!) >>> 0) : ((alpha[i]! << 24) | palette[k]!) >>> 0;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const k = indices[i]!;
        argb[i] = k === 0 ? 0 : (0xff000000 | palette[k]!) >>> 0;
      }
    }
    frames.push({
      id,
      frame: f,
      width: w,
      height: h,
      offsetX: offX[f]!,
      offsetY: offY[f]!,
      canvasWidth,
      canvasHeight,
      argb,
    });
  }
  return frames;
}

/** PNG of the frame's drawn pixels (not padded to the canvas). */
export function framePng(frame: { width: number; height: number; argb: Uint32Array }): Buffer {
  const png = new PNG({ width: frame.width, height: frame.height });
  for (let i = 0; i < frame.argb.length; i++) {
    const c = frame.argb[i]!;
    png.data[i * 4] = (c >>> 16) & 0xff;
    png.data[i * 4 + 1] = (c >>> 8) & 0xff;
    png.data[i * 4 + 2] = c & 0xff;
    png.data[i * 4 + 3] = (c >>> 24) & 0xff;
  }
  return encodePng(png);
}
