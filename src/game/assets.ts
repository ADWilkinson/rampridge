/**
 * Asset locations and small loaders for the files under public/game. All
 * URLs derive from one base so the engine works under any deploy prefix.
 */

export function defaultAssetBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  return `${base.endsWith("/") ? base : `${base}/`}game/`;
}

export function joinUrl(base: string, path: string): string {
  return `${base.endsWith("/") ? base : `${base}/`}${path.replace(/^\/+/, "")}`;
}

export async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

/** Like fetchJson but resolves null when the file does not exist (or is the SPA fallback). */
export async function fetchJsonOptional(url: string, signal?: AbortSignal): Promise<unknown> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html")) return null;
    return await res.json();
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

export interface SpriteFrame {
  image: HTMLImageElement;
  w: number;
  h: number;
  offsetX: number;
  offsetY: number;
  maxWidth: number;
  maxHeight: number;
}

interface ManifestFrame {
  file: string;
  w: number;
  h: number;
  offsetX?: number;
  offsetY?: number;
  /** Full sprite canvas size (older manifests call it maxWidth/maxHeight). */
  canvasW?: number;
  canvasH?: number;
  maxWidth?: number;
  maxHeight?: number;
  id?: number;
  frame?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFrame(value: unknown): value is ManifestFrame {
  return isRecord(value) && typeof value.file === "string" && typeof value.w === "number" && typeof value.h === "number";
}

/**
 * Frames of a sprite from the bake's manifest. Accepts the name-keyed form
 * ({ name: { file, w, h, offsetX, offsetY, canvasW, canvasH, id, frame } })
 * looked up by cache id or name, and the id-keyed form ({ id: { frames } }).
 */
function manifestFrames(manifest: unknown, key: number | string): ManifestFrame[] {
  if (!isRecord(manifest)) throw new Error("Sprite manifest is not an object");
  const direct = manifest[String(key)];
  if (isRecord(direct) && Array.isArray(direct.frames)) return direct.frames.filter(isFrame);
  if (isFrame(direct)) return [direct];
  if (typeof key === "number") {
    const frames = Object.values(manifest).filter((e): e is ManifestFrame => isFrame(e) && e.id === key);
    frames.sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
    if (frames.length > 0) return frames;
  }
  throw new Error(`Sprite ${key} is missing from the manifest`);
}

/** Loads every frame of a sprite (by cache id or manifest name). */
export async function loadSprite(spritesBase: string, manifest: unknown, key: number | string): Promise<SpriteFrame[]> {
  const frames = manifestFrames(manifest, key);
  return Promise.all(
    frames.map(async (f) => ({
      image: await loadImage(joinUrl(spritesBase, f.file)),
      w: f.w,
      h: f.h,
      offsetX: f.offsetX ?? 0,
      offsetY: f.offsetY ?? 0,
      maxWidth: f.canvasW ?? f.maxWidth ?? f.w,
      maxHeight: f.canvasH ?? f.maxHeight ?? f.h,
    })),
  );
}

/** Font families the engine draws with. */
export const FONT_BOLD = "RS Bold 12";
export const FONT_PLAIN = "RS Plain 11";
/** The RuneScape TTFs are pixel fonts drawn crisply at 16 CSS px. */
export const FONT_PX = 16;

const loadedFonts = new Map<string, Promise<void>>();

/** Registers a TTF under `family` via the FontFace API, once per page. */
export function loadFont(family: string, url: string): Promise<void> {
  const key = `${family}|${url}`;
  let pending = loadedFonts.get(key);
  if (!pending) {
    pending = (async () => {
      if (typeof FontFace === "undefined" || typeof document === "undefined") return;
      const face = new FontFace(family, `url(${JSON.stringify(url)})`);
      await face.load();
      document.fonts.add(face);
    })();
    loadedFonts.set(key, pending);
    pending.catch(() => loadedFonts.delete(key));
  }
  return pending;
}

export function loadEngineFonts(assetBase: string): Promise<void> {
  return Promise.all([
    loadFont(FONT_BOLD, joinUrl(assetBase, "fonts/RuneScape-Bold-12.ttf")),
    loadFont(FONT_PLAIN, joinUrl(assetBase, "fonts/RuneScape-Plain-11.ttf")),
  ]).then(() => undefined);
}
