/**
 * Opens the local OSRS cache (the newest one registered under .cache/osrs, as
 * the main bake does) with the vendored rs-map-viewer decoders. Bake-only;
 * never shipped.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CacheFiles } from "../vendor/rs-map-viewer/src/rs/cache/CacheFiles";
import { type CacheInfo, getLatestCache } from "../vendor/rs-map-viewer/src/rs/cache/CacheInfo";
import { CacheSystem } from "../vendor/rs-map-viewer/src/rs/cache/CacheSystem";
import { ConfigType } from "../vendor/rs-map-viewer/src/rs/cache/ConfigType";
import { IndexType } from "../vendor/rs-map-viewer/src/rs/cache/IndexType";
import { getCacheLoaderFactory } from "../vendor/rs-map-viewer/src/rs/cache/loader/CacheLoaderFactory";
import type { CacheLoaderFactory } from "../vendor/rs-map-viewer/src/rs/cache/loader/CacheLoaderFactory";
import { detectCacheType } from "../vendor/rs-map-viewer/src/rs/cache/CacheType";
import { ArchiveTypeLoader } from "../vendor/rs-map-viewer/src/rs/config/TypeLoader";
import { IdkType } from "../vendor/rs-map-viewer/src/rs/config/idktype/IdkType";

import { CACHE_DIR } from "../lib/paths";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
/** Cache store (RAMPRIDGE_OSRS_CACHE_DIR or .cache/osrs/caches), shared with the main bake. */
export const CACHE_ROOT = CACHE_DIR;

export interface OpenedCache {
  info: CacheInfo;
  system: CacheSystem;
  factory: CacheLoaderFactory;
  idkLoader: ArchiveTypeLoader<IdkType>;
}

export function openCache(): OpenedCache {
  const infos = JSON.parse(fs.readFileSync(path.join(CACHE_ROOT, "caches.json"), "utf8")) as CacheInfo[];
  const info = getLatestCache(infos.filter((c) => c.game === "oldschool"));
  if (!info) throw new Error(`no oldschool cache listed in ${CACHE_ROOT}/caches.json`);
  const dir = path.join(CACHE_ROOT, info.name);
  const files = new Map<string, ArrayBuffer>();
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("main_file_cache")) continue;
    const buf = fs.readFileSync(path.join(dir, name));
    files.set(name, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  }
  const system = CacheSystem.fromFiles(detectCacheType(info), new CacheFiles(files));
  const factory = getCacheLoaderFactory(info, system);
  const configIndex = system.getIndex(IndexType.DAT2.configs);
  const idkLoader = new ArchiveTypeLoader(IdkType, info, configIndex.getArchive(ConfigType.DAT2.identkits));
  return { info, system, factory, idkLoader };
}
