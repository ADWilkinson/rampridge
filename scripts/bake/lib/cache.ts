/**
 * Opens the OSRS cache on disk with the vendored rs-map-viewer decoder and
 * exposes the loaders every bake step needs. One instance per process.
 */
import fs from "node:fs";
import path from "node:path";

import type { XteaMap } from "../vendor/rs-map-viewer/src/mapviewer/Caches";
import { CacheFiles } from "../vendor/rs-map-viewer/src/rs/cache/CacheFiles";
import { type CacheInfo, getLatestCache } from "../vendor/rs-map-viewer/src/rs/cache/CacheInfo";
import { CacheSystem } from "../vendor/rs-map-viewer/src/rs/cache/CacheSystem";
import { detectCacheType } from "../vendor/rs-map-viewer/src/rs/cache/CacheType";
import {
  type CacheLoaderFactory,
  getCacheLoaderFactory,
} from "../vendor/rs-map-viewer/src/rs/cache/loader/CacheLoaderFactory";
import { LocModelLoader } from "../vendor/rs-map-viewer/src/rs/config/loctype/LocModelLoader";
import { ObjModelLoader } from "../vendor/rs-map-viewer/src/rs/config/objtype/ObjModelLoader";
import { VarManager } from "../vendor/rs-map-viewer/src/rs/config/vartype/VarManager";
import { SceneBuilder } from "../vendor/rs-map-viewer/src/rs/scene/SceneBuilder";
import { CACHE_DIR } from "./paths";

export interface BakeCache {
  info: CacheInfo;
  dir: string;
  system: CacheSystem;
  factory: CacheLoaderFactory;
  xteas: XteaMap;
  locModelLoader: LocModelLoader;
  objModelLoader: ObjModelLoader;
  sceneBuilder: SceneBuilder;
  varManager: VarManager;
}

let opened: BakeCache | undefined;

export function readCacheInfos(): CacheInfo[] {
  const file = path.join(CACHE_DIR, "caches.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `No OSRS cache at ${CACHE_DIR}. Run \`bun run setup:assets\` from the repository root (or \`bun run fetch-cache\` here), see README.`,
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as CacheInfo[];
}

export async function openCache(): Promise<BakeCache> {
  if (opened) return opened;
  const infos = readCacheInfos();
  const info = getLatestCache(infos);
  if (!info) throw new Error(`${CACHE_DIR}/caches.json lists no caches`);
  const dir = path.join(CACHE_DIR, info.name);

  const files = new Map<string, ArrayBuffer>();
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.startsWith("main_file_cache")) continue;
    const buf = fs.readFileSync(path.join(dir, name));
    files.set(name, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  }
  const keysFile = path.join(dir, "keys.json");
  const xteas: XteaMap = new Map();
  if (fs.existsSync(keysFile)) {
    const raw = JSON.parse(fs.readFileSync(keysFile, "utf8")) as
      | Record<string, number[]>
      | { mapsquare?: number; archive?: number; group?: number; key: number[] }[];
    if (Array.isArray(raw)) {
      // archive.openrs2.org format: [{ archive: 5, group, name_hash, name, mapsquare, key: [4 ints] }]
      for (const entry of raw) {
        const group = entry.group ?? entry.mapsquare;
        if (group !== undefined) xteas.set(group, entry.key);
      }
    } else {
      for (const [k, v] of Object.entries(raw)) xteas.set(Number(k), v);
    }
  }

  const system = CacheSystem.fromFiles(detectCacheType(info), new CacheFiles(files));
  const factory = getCacheLoaderFactory(info, system);
  const textureLoader = factory.getTextureLoader();
  const locTypeLoader = factory.getLocTypeLoader();
  const modelLoader = factory.getModelLoader();
  const locModelLoader = new LocModelLoader(
    locTypeLoader,
    modelLoader,
    textureLoader,
    factory.getSeqTypeLoader(),
    factory.getSeqFrameLoader(),
    factory.getSkeletalSeqLoader(),
  );
  const objModelLoader = new ObjModelLoader(factory.getObjTypeLoader(), modelLoader, textureLoader);
  const sceneBuilder = new SceneBuilder(
    info,
    factory.getMapFileLoader(),
    factory.getUnderlayTypeLoader(),
    factory.getOverlayTypeLoader(),
    locTypeLoader,
    locModelLoader,
    xteas,
  );
  opened = {
    info,
    dir,
    system,
    factory,
    xteas,
    locModelLoader,
    objModelLoader,
    sceneBuilder,
    varManager: new VarManager(factory.getVarBitTypeLoader()),
  };
  return opened;
}
