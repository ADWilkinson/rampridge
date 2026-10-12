/**
 * The bake's smallest lossless PNG encoder (lib/png-encode.ts): every pixel
 * survives exactly, including the colour of fully transparent pixels, in each
 * mode it can pick, and the same pixels always give the same bytes.
 */
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { encodeSmallestPng, type RgbaImage } from "../lib/png-encode";

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}

/** Deterministic pseudo-random value per pixel, so the palette modes win over RGBA. */
function noise(x: number, y: number): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function roundTrip(img: RgbaImage): { colourType: number; bitDepth: number } {
  const png = encodeSmallestPng(img);
  const back = PNG.sync.read(png);
  expect(back.width).toBe(img.width);
  expect(back.height).toBe(img.height);
  expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true);
  return { bitDepth: png[24]!, colourType: png[25]! };
}

describe("encodeSmallestPng", () => {
  it("keeps every pixel of a few-colour sprite, packing the palette", () => {
    // Two colours plus transparent pixels whose RGB differs (black and white, both alpha 0).
    const mode = roundTrip(image(64, 64, (x, y) => (noise(x, y) % 3 === 0 ? [0, 0, 0, 0] : noise(x, y) % 3 === 1 ? [255, 255, 255, 0] : [90, 60, 20, 255])));
    expect(mode).toEqual({ colourType: 3, bitDepth: 2 });
  });

  it("keeps an image whose alpha is zero everywhere (the client's black-is-transparent frames)", () => {
    roundTrip(image(9, 9, (x, y) => (x === y ? [0, 0, 0, 0] : [200, 10 * x, 10 * y, 0])));
  });

  it("uses an 8-bit palette for up to 256 colours with translucent entries", () => {
    const mode = roundTrip(image(128, 128, (x, y) => {
      const c = noise(x, y) % 200;
      return [c, (c * 7) % 256, (c * 13) % 256, c % 5 === 0 ? 128 : 255];
    }));
    expect(mode).toEqual({ colourType: 3, bitDepth: 8 });
  });

  it("falls back to RGB or RGBA for richer images", () => {
    expect(roundTrip(image(40, 40, (x, y) => [x * 6, y * 6, (x * y) % 256, 255])).colourType).toBe(2);
    expect(roundTrip(image(40, 40, (x, y) => [x * 6, y * 6, (x * y) % 256, (x + y) % 256])).colourType).toBe(6);
  });

  it("is deterministic and never larger than pngjs at level 9", () => {
    const img = image(64, 48, (x, y) => [(x * 37) % 256, (y * 53) % 256, (x ^ y) % 256, x < 4 ? 0 : 255]);
    const a = encodeSmallestPng(img);
    expect(encodeSmallestPng(img).equals(a)).toBe(true);
    const reference = new PNG({ width: img.width, height: img.height });
    reference.data = Buffer.from(img.data);
    expect(a.length).toBeLessThanOrEqual(PNG.sync.write(reference, { deflateLevel: 9 }).length);
  });
});
