/**
 * Minimap image in the 2007 client's style: every tile is 4x4 pixels of its
 * underlay/overlay minimap colour (with the client's tile shape masks),
 * walls drawn as white lines (doors red) and map scenes (trees, plants)
 * stamped in. Map function icons (the bank "$") are exported separately,
 * because the client drew them unrotated on top of the rotating map.
 *
 * Writes public/game/world/minimap.png, minimap.json and minimap-icons/*.png.
 */
import fs from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";

import { ConfigType } from "../vendor/rs-map-viewer/src/rs/cache/ConfigType";
import { IndexType } from "../vendor/rs-map-viewer/src/rs/cache/IndexType";
import { LocModelType } from "../vendor/rs-map-viewer/src/rs/config/loctype/LocModelType";
import { ArchiveMapElementTypeLoader } from "../vendor/rs-map-viewer/src/rs/config/meltype/MapElementTypeLoader";
import { MapImageRenderer } from "../vendor/rs-map-viewer/src/rs/map/MapImageRenderer";
import { IndexedSprite } from "../vendor/rs-map-viewer/src/rs/sprite/IndexedSprite";
import type { BakeCache } from "../lib/cache";
import { decodeLocsInRect } from "../lib/locs";
import { WORLD_DIR, rel, writeIfChanged, writeJson } from "../lib/paths";
import { encodePng } from "../lib/png";
import { SURROUNDINGS, buildAreaScene, rectHeight, rectWidth } from "../lib/region";
import { type SpriteFrame, decodeSpriteGroup, framePng } from "../lib/sprite-decode";

export const PIXELS_PER_TILE = 4;

/** Names for the map functions that occur around the bank (RuneLite SpriteID.Mapfunction). */
const MAP_FUNCTION_NAMES: Record<number, string> = {
  5: "bank",
  10: "anvil",
  15: "staff_shop",
  29: "clothes_shop",
  66: "poll_booth",
  721: "quest_start",
};

export interface MinimapMeta {
  $comment: string[];
  image: string;
  pixelsPerTile: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  icons: { name: string; mapFunction: number; file: string; w: number; h: number; tile: { x: number; y: number } }[];
}

export async function bakeMinimap(cache: BakeCache): Promise<MinimapMeta> {
  const area = SURROUNDINGS;
  const { scene, baseX, baseY } = buildAreaScene(cache, area, false);
  // Map scenes (stairs, plants, booth dividers) come from the "mapscene" sprite group. The
  // vendored loader finds none in 2026 caches, so decode them here and hand them over as
  // palette sprites.
  const spriteIndex = cache.system.getIndex(IndexType.DAT2.sprites);
  const mapSceneGroup = spriteIndex.getArchiveId("mapscene");
  if (mapSceneGroup === -1) throw new Error("mapscene sprite group not found");
  const mapScenes = decodeSpriteGroup(cache, mapSceneGroup).map(toIndexedSprite);
  const renderer = new MapImageRenderer(
    cache.factory.getTextureLoader(),
    cache.factory.getLocTypeLoader(),
    mapScenes,
    cache.factory.getMapFunctions(),
  );
  const full = renderer.renderMinimap(scene, 0);
  const fullW = scene.sizeX * PIXELS_PER_TILE;
  const width = rectWidth(area) * PIXELS_PER_TILE;
  const height = rectHeight(area) * PIXELS_PER_TILE;
  const x0 = (area.minX - baseX) * PIXELS_PER_TILE;
  const y0 = (baseY + scene.sizeY - 1 - area.maxY) * PIXELS_PER_TILE;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = full[(y0 + y) * fullW + x0 + x]!;
      const o = (y * width + x) * 4;
      png.data[o] = (p >> 16) & 0xff;
      png.data[o + 1] = (p >> 8) & 0xff;
      png.data[o + 2] = p & 0xff;
      png.data[o + 3] = p === 0 ? 0 : 0xff;
    }
  }
  writeIfChanged(path.join(WORLD_DIR, "minimap.png"), encodePng(png));

  // Map function icons from floor decorations, as the client places them.
  const locTypes = cache.factory.getLocTypeLoader();
  const configs = cache.system.getIndex(IndexType.DAT2.configs);
  const elements = new ArchiveMapElementTypeLoader(cache.info, configs.getArchive(ConfigType.OSRS.mapFunctions));
  const iconDir = path.join(WORLD_DIR, "minimap-icons");
  const icons: MinimapMeta["icons"] = [];
  const written = new Set<string>();
  for (const loc of decodeLocsInRect(cache, area.minX, area.minY, area.maxX, area.maxY)) {
    if (loc.level !== 0 || loc.type !== LocModelType.FLOOR_DECORATION) continue;
    const fn = locTypes.load(loc.id).mapFunctionId;
    if (fn === -1) continue;
    const spriteId = elements.load(fn).spriteId;
    if (spriteId === -1 || !elements.load(fn).minimapVisible) continue;
    const frame = decodeSpriteGroup(cache, spriteId)[0]!;
    const name = MAP_FUNCTION_NAMES[fn] ?? `function_${fn}`;
    const file = `minimap-icons/${name}.png`;
    if (!written.has(file)) {
      writeIfChanged(path.join(WORLD_DIR, file), framePng(frame));
      written.add(file);
    }
    icons.push({ name, mapFunction: fn, file, w: frame.width, h: frame.height, tile: { x: loc.x, y: loc.y } });
  }
  icons.sort((a, b) => a.tile.y - b.tile.y || a.tile.x - b.tile.x);
  // Remove icons from earlier bakes that no longer occur.
  if (fs.existsSync(iconDir)) {
    for (const f of fs.readdirSync(iconDir)) if (!written.has(`minimap-icons/${f}`)) fs.rmSync(path.join(iconDir, f));
  }

  const meta: MinimapMeta = {
    $comment: [
      "Generated by scripts/bake (steps/minimap.ts). North is up; 4 px per tile, as the client's minimap.",
      "World tile (x, y) covers pixels px = (x - minX) * 4 .. +3, py = (maxY - y) * 4 .. +3.",
      "A point at continuous tile coords (fx, fy), where tile centres are x + 0.5, maps to",
      "px = (fx - minX) * 4, py = (maxY + 1 - fy) * 4. Transparent pixels are outside the baked area.",
      "Icons are map functions: draw them unrotated, centred on their tile's centre, over the rotated map.",
    ],
    image: "minimap.png",
    pixelsPerTile: PIXELS_PER_TILE,
    minX: area.minX,
    minY: area.minY,
    maxX: area.maxX,
    maxY: area.maxY,
    width,
    height,
    icons,
  };
  writeJson(path.join(WORLD_DIR, "minimap.json"), meta);
  console.log(`  minimap ${width}x${height} px, icons: ${icons.map((i) => i.name).join(", ")} -> ${rel(path.join(WORLD_DIR, "minimap.png"))}`);
  return meta;
}

/** Palette sprite from decoded ARGB pixels; pixels under half alpha become transparent. */
function toIndexedSprite(frame: SpriteFrame): IndexedSprite {
  const sprite = new IndexedSprite();
  const colours = new Map<number, number>();
  const palette: number[] = [0];
  const pixels = new Uint8Array(frame.width * frame.height);
  frame.argb.forEach((c, i) => {
    if (c >>> 24 < 0x80) return;
    const rgb = c & 0xffffff || 1;
    let k = colours.get(rgb);
    if (k === undefined) {
      k = palette.length;
      if (k > 255) throw new Error(`map scene ${frame.frame} has more than 255 colours`);
      palette.push(rgb);
      colours.set(rgb, k);
    }
    pixels[i] = k;
  });
  sprite.width = frame.canvasWidth;
  sprite.height = frame.canvasHeight;
  sprite.xOffset = frame.offsetX;
  sprite.yOffset = frame.offsetY;
  sprite.subWidth = frame.width;
  sprite.subHeight = frame.height;
  sprite.palette = Int32Array.from(palette);
  sprite.pixels = pixels;
  return sprite;
}
