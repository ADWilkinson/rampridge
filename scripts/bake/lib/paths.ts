import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** scripts/bake */
export const BAKE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Repository root. */
export const REPO_DIR = path.resolve(BAKE_DIR, "../..");
/** Cache store: `<CACHE_DIR>/caches.json` plus one directory per cache name. */
export const CACHE_DIR = process.env.RAMPRIDGE_OSRS_CACHE_DIR
  ? path.resolve(process.env.RAMPRIDGE_OSRS_CACHE_DIR)
  : path.join(REPO_DIR, ".cache/osrs/caches");

export const PUBLIC_DIR = path.join(REPO_DIR, "public");
export const GAME_DIR = path.join(PUBLIC_DIR, "game");
export const WORLD_DIR = path.join(GAME_DIR, "world");
export const SPRITES_DIR = path.join(GAME_DIR, "sprites");
export const FONTS_DIR = path.join(GAME_DIR, "fonts");
export const SOUNDS_DIR = path.join(GAME_DIR, "sounds");
export const MUSIC_DIR = path.join(GAME_DIR, "music");
export const UI_DIR = path.join(GAME_DIR, "ui");
export const SHARED_DIR = path.join(REPO_DIR, "shared");

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a file only when its bytes changed, so re-running the bake leaves mtimes alone. */
export function writeIfChanged(file: string, data: Uint8Array | string): boolean {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  ensureDir(path.dirname(file));
  if (fs.existsSync(file)) {
    const prev = fs.readFileSync(file);
    if (prev.equals(bytes)) return false;
  }
  fs.writeFileSync(file, bytes);
  return true;
}

/** Stable JSON: two-space indent, trailing newline. */
export function writeJson(file: string, value: unknown): boolean {
  return writeIfChanged(file, JSON.stringify(value, null, 2) + "\n");
}

export function rel(file: string): string {
  return path.relative(REPO_DIR, file);
}
