/**
 * The one room RampRidge renders: Varrock West Bank, map square (49, 53),
 * region 12597. All bake steps share these constants so the GLB, collision,
 * minimap and metadata agree on one coordinate frame.
 *
 * Frame: 1 unit = 1 tile, y up, north = -z. Origin = south-west corner of
 * tile (ORIGIN.x, ORIGIN.y). A tile (X, Y) has its centre at
 * x = X - ORIGIN.x + 0.5, z = -(Y - ORIGIN.y + 0.5).
 */
import type { Scene } from "../vendor/rs-map-viewer/src/rs/scene/Scene";
import { LocLoadType } from "../vendor/rs-map-viewer/src/rs/scene/SceneBuilder";
import type { BakeCache } from "./cache";

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const ORIGIN = { x: 3176, y: 3428 } as const;

/** Area the engine is built around: collision, metadata and full-detail geometry. */
export const CORE: Rect = { minX: 3176, minY: 3428, maxX: 3194, maxY: 3452 };

/**
 * Wider ring of street and neighbouring buildings exported around CORE so the
 * doorway and windows look out onto Varrock instead of the void. The 2007
 * client drew 25 tiles around the player; a player at the bank entrance
 * (3182, 3432) with the camera turned south sees roughly this far.
 */
export const SURROUNDINGS: Rect = { minX: 3164, minY: 3414, maxX: 3206, maxY: 3462 };

/** Tiles of padding around a built scene so floor blending and lighting see neighbours. */
export const SCENE_BORDER = 8;

/** RS units per tile. */
export const TILE = 128;

export interface AreaScene {
  scene: Scene;
  /** World tile of scene index (0, 0). */
  baseX: number;
  baseY: number;
}

export function buildAreaScene(cache: BakeCache, rect: Rect, models: boolean): AreaScene {
  const baseX = rect.minX - SCENE_BORDER;
  const baseY = rect.minY - SCENE_BORDER;
  const sizeX = rect.maxX - rect.minX + 1 + SCENE_BORDER * 2;
  const sizeY = rect.maxY - rect.minY + 1 + SCENE_BORDER * 2;
  const scene = cache.sceneBuilder.buildScene(
    baseX,
    baseY,
    sizeX,
    sizeY,
    false,
    models ? LocLoadType.MODELS : LocLoadType.NO_MODELS,
  );
  return { scene, baseX, baseY };
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

export function rectWidth(r: Rect): number {
  return r.maxX - r.minX + 1;
}

export function rectHeight(r: Rect): number {
  return r.maxY - r.minY + 1;
}
