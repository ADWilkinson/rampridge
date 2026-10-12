// Scratch: client-style minimap (4px per tile) for one map square -> PNG. Usage: npx tsx scripts/cache/export-minimap.ts 49 53 0 out.png
import fs from "fs";
import { PNG } from "pngjs";
import { CacheSystem } from "../../src/rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../../src/rs/cache/loader/CacheLoaderFactory";
import { LocModelLoader } from "../../src/rs/config/loctype/LocModelLoader";
import { MapImageRenderer } from "../../src/rs/map/MapImageRenderer";
import { LocLoadType, SceneBuilder } from "../../src/rs/scene/SceneBuilder";
import { loadCache, loadCacheInfos, loadCacheList } from "./load-util";

const [mapX, mapY, level] = process.argv.slice(2, 5).map(Number);
const outPath = process.argv[5];
const info = loadCacheList(loadCacheInfos()).latest;
const lc = loadCache(info);
const f = getCacheLoaderFactory(info, CacheSystem.fromFiles(lc.type, lc.files));
const textureLoader = f.getTextureLoader();
const locTypeLoader = f.getLocTypeLoader();
const locModelLoader = new LocModelLoader(locTypeLoader, f.getModelLoader(), textureLoader, f.getSeqTypeLoader(), f.getSeqFrameLoader(), f.getSkeletalSeqLoader());
const sb = new SceneBuilder(info, f.getMapFileLoader(), f.getUnderlayTypeLoader(), f.getOverlayTypeLoader(), locTypeLoader, locModelLoader, lc.xteas);
const border = 6;
const scene = sb.buildScene(mapX * 64 - border, mapY * 64 - border, 64 + border * 2, 64 + border * 2, false, LocLoadType.NO_MODELS);
const r = new MapImageRenderer(textureLoader, locTypeLoader, f.getMapScenes(), f.getMapFunctions());
const px = r.renderMinimapHd(scene, level, true);
const W = scene.sizeX * 4, crop = border * 4, size = 64 * 4;
const png = new PNG({ width: size, height: size });
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = px[(y + crop) * W + (x + crop)];
    const o = (y * size + x) * 4;
    png.data[o] = (p >> 16) & 0xff; png.data[o + 1] = (p >> 8) & 0xff; png.data[o + 2] = p & 0xff; png.data[o + 3] = p === 0 ? 0 : 0xff;
}
fs.writeFileSync(outPath, PNG.sync.write(png));
console.log(JSON.stringify({ out: outPath, size, bytes: fs.statSync(outPath).size }));
