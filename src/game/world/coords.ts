import type { Tile } from "@shared/protocol";
import type { HeightMap } from "./heightMap";

/**
 * Scene coordinates: 1 unit = 1 tile, y up, north = -z, origin at the
 * south-west corner of the exported area. A tile's centre sits at
 * (x - originX + 0.5, floorHeight, -(y - originY + 0.5)).
 */
export interface WorldFrame {
  originX: number;
  originY: number;
  floorHeight: number;
  /** Floor heights where the ground is not flat (the street); null = flat at floorHeight. */
  heights: HeightMap | null;
}

/** Ground height under fractional tile coordinates (integer = tile centre). */
export function groundHeight(frame: WorldFrame, tileX: number, tileY: number): number {
  return frame.heights ? frame.heights.at(tileX, tileY) : frame.floorHeight;
}

export function sceneX(frame: WorldFrame, tileX: number): number {
  return tileX - frame.originX + 0.5;
}

export function sceneZ(frame: WorldFrame, tileY: number): number {
  return -(tileY - frame.originY + 0.5);
}

/** The tile containing a scene point. */
export function tileAtScene(frame: WorldFrame, x: number, z: number): Tile {
  return { x: Math.floor(x) + frame.originX, y: Math.floor(-z) + frame.originY };
}
