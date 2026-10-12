/** Small RGBA image helpers on top of pngjs (decoding) and png-encode (smallest lossless encoding). */
import { PNG } from "pngjs";

import { encodeSmallestPng } from "./png-encode";

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodePng(buf: Buffer): Rgba {
  const p = PNG.sync.read(buf);
  return { width: p.width, height: p.height, data: new Uint8Array(p.data) };
}

/** The smallest lossless PNG of the image (indexed when it has at most 256 colours). */
export function encodePng(img: Rgba): Buffer {
  return encodeSmallestPng(img);
}

export function blank(width: number, height: number, rgba: [number, number, number, number] = [0, 0, 0, 0]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

/** Bounding box of pixels with alpha > threshold. */
export function opaqueBounds(img: Rgba, threshold = 0): { x: number; y: number; w: number; h: number } {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > threshold) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("image is fully transparent");
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(img: Rgba, x: number, y: number, w: number, h: number): Rgba {
  const out = blank(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const sx = x + i, sy = y + j;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      out.data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (j * w + i) * 4);
    }
  }
  return out;
}

/** Crop to the opaque area plus `pad` transparent pixels on each side. */
export function trim(img: Rgba, pad = 0): Rgba {
  const b = opaqueBounds(img);
  return crop(img, b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
}

/** Nearest-neighbour integer upscale. */
export function scaleNearest(img: Rgba, k: number): Rgba {
  const out = blank(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const s = ((Math.floor(y / k) * img.width + Math.floor(x / k)) * 4);
      out.data.set(img.data.subarray(s, s + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

/** Source-over composite of `src` onto `dst` at (x, y). */
export function drawOver(dst: Rgba, src: Rgba, x: number, y: number): void {
  for (let j = 0; j < src.height; j++) {
    for (let i = 0; i < src.width; i++) {
      const dx = x + i, dy = y + j;
      if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height) continue;
      const s = (j * src.width + i) * 4;
      const d = (dy * dst.width + dx) * 4;
      const a = src.data[s + 3]! / 255;
      if (a === 0) continue;
      const da = dst.data[d + 3]! / 255;
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = Math.round((src.data[s + c]! * a + dst.data[d + c]! * da * (1 - a)) / oa);
      }
      dst.data[d + 3] = Math.round(oa * 255);
    }
  }
}

/** Client ARGB pixels (0xAARRGGBB) to RGBA. */
export function fromArgb(argb: Uint32Array, width: number, height: number): Rgba {
  const img = blank(width, height);
  for (let i = 0; i < argb.length; i++) {
    const c = argb[i]!;
    img.data[i * 4] = (c >>> 16) & 0xff;
    img.data[i * 4 + 1] = (c >>> 8) & 0xff;
    img.data[i * 4 + 2] = c & 0xff;
    img.data[i * 4 + 3] = (c >>> 24) & 0xff;
  }
  return img;
}
