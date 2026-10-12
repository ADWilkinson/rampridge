/**
 * HSL16 -> RGB palette, ported from rs-map-viewer's ColorUtil.buildPalette
 * (itself a port of the client's Rasterizer3D palette). Brightness 0.8 matches
 * the world bake, so actors and the bank share one colour response.
 *
 * Portions Copyright (c) 2022-2023, dennisdev (https://github.com/dennisdev/rs-map-viewer)
 * BSD 2-Clause License; see ./NOTICE.
 */

export const PALETTE_BRIGHTNESS = 0.8;

let rgbTable: Int32Array | null = null;
let linearTable: Float32Array | null = null;
let linearReady: Uint8Array | null = null;

function brighten(rgb: number, brightness: number): number {
  const r = Math.pow((rgb >> 16) / 256, brightness);
  const g = Math.pow(((rgb >> 8) & 0xff) / 256, brightness);
  const b = Math.pow((rgb & 0xff) / 256, brightness);
  return (((r * 256) | 0) << 16) | (((g * 256) | 0) << 8) | ((b * 256) | 0);
}

function buildPalette(brightness: number): Int32Array {
  const palette = new Int32Array(0x10000);
  let index = 0;
  for (let hs = 0; hs < 512; hs++) {
    const hue = (hs >> 3) / 64 + 0.0078125;
    const saturation = (hs & 7) / 8 + 0.0625;
    for (let l = 0; l < 128; l++) {
      const lightness = l / 128;
      let r = lightness;
      let g = lightness;
      let b = lightness;
      if (saturation !== 0) {
        const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
        const p = 2 * lightness - q;
        let tr = hue + 1 / 3;
        if (tr > 1) tr--;
        let tb = hue - 1 / 3;
        if (tb < 0) tb++;
        r = channel(p, q, tr);
        g = channel(p, q, hue);
        b = channel(p, q, tb);
      }
      const rgb = (((r * 256) | 0) << 16) + (((g * 256) | 0) << 8) + ((b * 256) | 0);
      palette[index++] = brighten(rgb, brightness);
    }
  }
  return palette;
}

function channel(p: number, q: number, t: number): number {
  if (6 * t < 1) return p + (q - p) * 6 * t;
  if (2 * t < 1) return q;
  if (3 * t < 2) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** Packed 0xRRGGBB (sRGB) for an HSL16 colour. */
export function hslToRgb(hsl: number): number {
  rgbTable ??= buildPalette(PALETTE_BRIGHTNESS);
  return rgbTable[hsl & 0xffff]!;
}

/** CSS hex for an HSL16 colour, e.g. for designer swatches. */
export function hslToCss(hsl: number): string {
  return `#${hslToRgb(hsl).toString(16).padStart(6, "0")}`;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Writes the linear-light RGB of an HSL16 colour into `out` at `offset`.
 * three.js treats vertex colours as linear and encodes to sRGB on output, so
 * this reproduces the client's on-screen colour exactly.
 */
export function writeLinearRgb(hsl: number, out: Float32Array, offset: number): void {
  const key = hsl & 0xffff;
  if (!linearTable || !linearReady) {
    linearTable = new Float32Array(0x10000 * 3);
    linearReady = new Uint8Array(0x10000);
  }
  if (!linearReady[key]) {
    const rgb = hslToRgb(key);
    linearTable[key * 3] = srgbToLinear(((rgb >> 16) & 0xff) / 255);
    linearTable[key * 3 + 1] = srgbToLinear(((rgb >> 8) & 0xff) / 255);
    linearTable[key * 3 + 2] = srgbToLinear((rgb & 0xff) / 255);
    linearReady[key] = 1;
  }
  out[offset] = linearTable[key * 3]!;
  out[offset + 1] = linearTable[key * 3 + 1]!;
  out[offset + 2] = linearTable[key * 3 + 2]!;
}
