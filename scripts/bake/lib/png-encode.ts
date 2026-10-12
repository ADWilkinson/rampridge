/**
 * Smallest lossless PNG for an RGBA image, deterministic for the same pixels.
 *
 * Cache sprites, item icons and textures use at most 256 colours, so they fit
 * an indexed PNG (palette plus tRNS) at 1, 2, 4 or 8 bits per pixel, usually a
 * fraction of the RGBA file. Everything else is written as RGB (when opaque)
 * or RGBA. Each candidate is compressed with the row filter choices and zlib
 * strategies below and the smallest wins, roughly what optipng does. Every
 * pixel is kept exactly, including the colour of fully transparent pixels
 * (the client's alpha repair treats black as transparent in some frames).
 */
import { constants, deflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([head.subarray(4), data]), 0);
  return Buffer.concat([head, data, crc]);
}

function ihdr(width: number, height: number, bitDepth: number, colourType: number): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = bitDepth;
  b[9] = colourType;
  // compression, filter method, interlace: all 0
  return chunk("IHDR", b);
}

/** Raw scanlines (no filter bytes) and bytes per pixel (at least 1, as the PNG filters use). */
interface Scanlines {
  rows: Uint8Array[];
  bpp: number;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

function filterRow(type: number, row: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  out[0] = type;
  for (let i = 0; i < row.length; i++) {
    const x = row[i]!;
    const a = i >= bpp ? row[i - bpp]! : 0;
    const b = prev ? prev[i]! : 0;
    const c = prev && i >= bpp ? prev[i - bpp]! : 0;
    let v: number;
    switch (type) {
      case 1:
        v = x - a;
        break;
      case 2:
        v = x - b;
        break;
      case 3:
        v = x - ((a + b) >> 1);
        break;
      case 4:
        v = x - paeth(a, b, c);
        break;
      default:
        v = x;
    }
    out[i + 1] = v & 0xff;
  }
}

/** Filtered image data: one fixed filter for every row (0-4), or -1 for the per-row minimum-sum heuristic. */
function filtered({ rows, bpp }: Scanlines, mode: number): Uint8Array {
  const stride = (rows[0]?.length ?? 0) + 1;
  const out = new Uint8Array(stride * rows.length);
  const trial = new Uint8Array(stride);
  rows.forEach((row, y) => {
    const prev = y > 0 ? rows[y - 1]! : null;
    const target = out.subarray(y * stride, (y + 1) * stride);
    if (mode >= 0) {
      filterRow(mode, row, prev, bpp, target);
      return;
    }
    let best = Infinity;
    for (let type = 0; type <= 4; type++) {
      filterRow(type, row, prev, bpp, trial);
      let sum = 0;
      for (let i = 1; i < stride; i++) sum += trial[i]! < 128 ? trial[i]! : 256 - trial[i]!;
      if (sum < best) {
        best = sum;
        target.set(trial);
      }
    }
  });
  return out;
}

function smallestDeflate(data: Uint8Array): Buffer {
  let best: Buffer | null = null;
  for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
    const z = deflateSync(data, { level: 9, memLevel: 9, strategy });
    if (!best || z.length < best.length) best = z;
  }
  return best!;
}

function smallestIdat(lines: Scanlines, modes: readonly number[]): Buffer {
  let best: Buffer | null = null;
  for (const mode of modes) {
    const z = smallestDeflate(filtered(lines, mode));
    if (!best || z.length < best.length) best = z;
  }
  return best!;
}

/** The indexed encoding, or null when the image has more than 256 colours. */
function indexed(img: RgbaImage): Buffer | null {
  const { width, height, data } = img;
  // One key per pixel: R | G << 8 | B << 16 | A << 24 (so A is the high byte).
  const px = new Uint32Array(width * height);
  for (let i = 0; i < px.length; i++) px[i] = (data[i * 4]! | (data[i * 4 + 1]! << 8) | (data[i * 4 + 2]! << 16) | (data[i * 4 + 3]! << 24)) >>> 0;
  const counts = new Map<number, number>();
  for (const p of px) {
    counts.set(p, (counts.get(p) ?? 0) + 1);
    if (counts.size > 256) return null;
  }
  // Translucent entries first so tRNS can stop after them; then by frequency, then value (deterministic).
  const alphaOf = (p: number) => (p >>> 24) & 0xff;
  const palette = [...counts.entries()]
    .sort(([pa, ca], [pb, cb]) => Number(alphaOf(pa) === 255) - Number(alphaOf(pb) === 255) || cb - ca || pa - pb)
    .map(([p]) => p);
  const index = new Map(palette.map((p, i) => [p, i]));
  const bitDepth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
  const perByte = 8 / bitDepth;
  const rowBytes = Math.ceil(width / perByte);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(rowBytes);
    for (let x = 0; x < width; x++) {
      const i = index.get(px[y * width + x]!)!;
      const byte = Math.floor(x / perByte);
      const shift = 8 - bitDepth * ((x % perByte) + 1);
      row[byte]! |= i << shift;
    }
    rows.push(row);
  }
  const plte = new Uint8Array(palette.length * 3);
  const trns: number[] = [];
  palette.forEach((p, i) => {
    plte[i * 3] = p & 0xff;
    plte[i * 3 + 1] = (p >>> 8) & 0xff;
    plte[i * 3 + 2] = (p >>> 16) & 0xff;
    if (alphaOf(p) !== 255) trns.push(alphaOf(p));
  });
  // Palette images compress best unfiltered; the heuristic occasionally wins on 8-bit ones.
  const idat = smallestIdat({ rows, bpp: 1 }, bitDepth === 8 ? [0, -1] : [0]);
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height, bitDepth, 3),
    chunk("PLTE", plte),
    ...(trns.length > 0 ? [chunk("tRNS", Uint8Array.from(trns))] : []),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** RGB when every pixel is opaque, else RGBA. */
function truecolour(img: RgbaImage): Buffer {
  const { width, height, data } = img;
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) opaque = false;
  const channels = opaque ? 3 : 4;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width * channels);
    for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) row[x * channels + c] = data[(y * width + x) * 4 + c]!;
    rows.push(row);
  }
  const idat = smallestIdat({ rows, bpp: channels }, [-1, 0, 1, 2, 4]);
  return Buffer.concat([SIGNATURE, ihdr(width, height, 8, opaque ? 2 : 6), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

/** The smallest lossless PNG of `img` this encoder can make. */
export function encodeSmallestPng(img: RgbaImage): Buffer {
  if (img.data.length !== img.width * img.height * 4) throw new Error(`expected ${img.width}x${img.height} RGBA pixels`);
  const candidates = [indexed(img), truecolour(img)].filter((b): b is Buffer => b !== null);
  return candidates.reduce((a, b) => (b.length < a.length ? b : a));
}
