/**
 * Raw map-square loc decoding (same format the client reads from index 5,
 * file 1 of each region archive since build 237). Used to derive gameplay
 * metadata (booths, doors, spawn) from the cache instead of by hand.
 */
import { ByteBuffer } from "../vendor/rs-map-viewer/src/rs/io/ByteBuffer";
import type { BakeCache } from "./cache";

export interface RawLoc {
  id: number;
  /** Absolute world tile. */
  x: number;
  y: number;
  /** Map level as stored (before bridge adjustment). */
  level: number;
  /** LocModelType (0 = wall ... 10 = normal, 22 = floor decoration). */
  type: number;
  /** 0 = west, 1 = north, 2 = east, 3 = south (client loc rotation). */
  rotation: number;
}

export function decodeMapSquareLocs(cache: BakeCache, mapX: number, mapY: number): RawLoc[] {
  const data = cache.sceneBuilder.getLocData(mapX, mapY);
  if (!data) return [];
  const buffer = new ByteBuffer(data);
  const out: RawLoc[] = [];
  let id = -1;
  let idDelta: number;
  while ((idDelta = buffer.readSmart3()) !== 0) {
    id += idDelta;
    let pos = 0;
    let posDelta: number;
    while ((posDelta = buffer.readUnsignedSmart()) !== 0) {
      pos += posDelta - 1;
      const localX = (pos >> 6) & 0x3f;
      const localY = pos & 0x3f;
      const level = pos >> 12;
      const attributes = buffer.readUnsignedByte();
      out.push({
        id,
        x: mapX * 64 + localX,
        y: mapY * 64 + localY,
        level,
        type: attributes >> 2,
        rotation: attributes & 0x3,
      });
    }
  }
  return out;
}

/** All locs whose origin tile lies inside the world rectangle (inclusive). */
export function decodeLocsInRect(
  cache: BakeCache,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): RawLoc[] {
  const out: RawLoc[] = [];
  for (let mx = minX >> 6; mx <= maxX >> 6; mx++) {
    for (let my = minY >> 6; my <= maxY >> 6; my++) {
      for (const loc of decodeMapSquareLocs(cache, mx, my)) {
        if (loc.x >= minX && loc.x <= maxX && loc.y >= minY && loc.y <= maxY) out.push(loc);
      }
    }
  }
  out.sort((a, b) => a.level - b.level || a.y - b.y || a.x - b.x || a.type - b.type || a.id - b.id);
  return out;
}
