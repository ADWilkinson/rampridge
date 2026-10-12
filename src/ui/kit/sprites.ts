/**
 * Runtime sprite registry. Resolves the kit's named sprites (spriteIds.ts) to
 * files under the baked sprites directory, tolerating whatever shape the
 * bake's manifest takes, and degrades gracefully: a missing sprite resolves
 * to `missing` and components fall back to a flat fill in the sprite's average
 * colour (or a text label).
 *
 * Resolved URLs are also published as CSS custom properties on <html>
 * (`--spr-<name>: url(...)`), so stylesheets can use real sprites and fall
 * back to a gradient while the property is unset.
 *
 * Some cache sprites are exported with a zero alpha channel and black as the
 * transparent colour (the client's convention). A frame whose alpha is zero
 * everywhere is repaired here by treating pure black as transparent.
 */

import { useEffect, useSyncExternalStore } from "react";
import { SPRITES, spriteFileName, type SpriteDef, type SpriteName } from "./spriteIds";

export { SPRITES, UI_SPRITE_IDS, UI_SPRITE_REFS, coinsSpriteFor, spriteFileName, type SpriteDef, type SpriteName, type SpriteRef } from "./spriteIds";

export type SpriteStatus = "pending" | "ok" | "missing";

export interface SpriteState {
  status: SpriteStatus;
  /** URL to draw (a data URL when the frame needed its alpha repaired). */
  url: string | null;
  /** Natural size once decoded. */
  width: number;
  height: number;
}

const env = import.meta.env as Record<string, string | undefined>;

/** Directory holding the sprites and `manifest.json`. Ends with "/". */
export const SPRITE_BASE: string = withSlash(env.VITE_SPRITE_BASE ?? "/game/sprites/");

function withSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

const PENDING: SpriteState = { status: "pending", url: null, width: 0, height: 0 };
const MISSING: SpriteState = { status: "missing", url: null, width: 0, height: 0 };

/** Resolution by URL, shared by named and id lookups that land on the same file. */
const byUrl = new Map<string, Promise<SpriteState>>();
const named = new Map<SpriteName, SpriteState>();
const byId = new Map<string, SpriteState>();
const listeners = new Set<() => void>();
let version = 0;
let manifestPromise: Promise<SpriteManifest> | null = null;
let registryPromise: Promise<void> | null = null;
let registrySettled = false;

function idKey(id: number, frame: number): string {
  return `${id}_${frame}`;
}

function emit(): void {
  version++;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getVersion(): number {
  return version;
}

// ---------------------------------------------------------------------------
// Manifest parsing

export interface SpriteManifest {
  /** "<id>_<frame>" -> URL */
  byId: Map<string, string>;
  /** Manifest entry name -> URL */
  byName: Map<string, string>;
}

/** With a manifest, unlisted sprites are missing; without one, try `<id>_<frame>.png`. */
function pickUrl(m: SpriteManifest, candidates: (string | undefined)[], id: number, frame: number): string | null {
  for (const c of candidates) if (c) return c;
  return m.byId.size === 0 && m.byName.size === 0 ? SPRITE_BASE + spriteFileName(id, frame) : null;
}

const RL_TO_ID = new Map<string, number>();
for (const def of Object.values(SPRITES) as SpriteDef[]) RL_TO_ID.set(def.rl, def.id);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolveFile(file: string): string {
  if (/^(?:[a-z]+:|\/)/i.test(file)) return file;
  return SPRITE_BASE + file;
}

/**
 * Reads any manifest shape the bake has produced or may produce:
 * `{ "close_button": { id: 535, frame: 0, file } }`,
 * `{ "535": { frames: [{ file }] } }`, `{ "535_0": { file } }`,
 * `[{ id, frame, file }]`, or any of these under a top-level `sprites` key.
 */
export function parseSpriteManifest(json: unknown): SpriteManifest {
  const out: SpriteManifest = { byId: new Map(), byName: new Map() };
  const root = isRecord(json) && "sprites" in json ? json.sprites : json;
  const entries: [string, unknown][] = Array.isArray(root)
    ? root.map((v, i) => [isRecord(v) && typeof v.name === "string" ? v.name : String(i), v] as [string, unknown])
    : isRecord(root)
      ? Object.entries(root)
      : [];

  for (const [k, v] of entries) {
    const keyMatch = /^(\d+)(?:_(\d+))?$/.exec(k);
    if (typeof v === "string") {
      const url = resolveFile(v);
      out.byName.set(k, url);
      const id = keyMatch ? Number(keyMatch[1]) : RL_TO_ID.get(k);
      if (id !== undefined) out.byId.set(idKey(id, keyMatch?.[2] ? Number(keyMatch[2]) : 0), url);
      continue;
    }
    if (!isRecord(v)) continue;
    const id: number | undefined =
      typeof v.id === "number" ? v.id : keyMatch ? Number(keyMatch[1]) : (RL_TO_ID.get(k) ?? (typeof v.rl === "string" ? RL_TO_ID.get(v.rl) : undefined));

    if (Array.isArray(v.frames)) {
      v.frames.forEach((f, i) => {
        const file = isRecord(f) && typeof f.file === "string" ? f.file : typeof f === "string" ? f : null;
        if (!file) return;
        const frame = isRecord(f) && typeof f.frame === "number" ? f.frame : i;
        const url = resolveFile(file);
        if (i === 0 && !keyMatch) out.byName.set(k, url);
        if (id !== undefined) out.byId.set(idKey(id, frame), url);
      });
    } else if (typeof v.file === "string") {
      const url = resolveFile(v.file);
      if (!keyMatch) out.byName.set(k, url);
      const frame = typeof v.frame === "number" ? v.frame : keyMatch?.[2] ? Number(keyMatch[2]) : 0;
      if (id !== undefined) out.byId.set(idKey(id, frame), url);
    }
  }
  return out;
}

function loadManifest(): Promise<SpriteManifest> {
  manifestPromise ??= fetch(`${SPRITE_BASE}manifest.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((json: unknown) => parseSpriteManifest(json))
    .catch(() => parseSpriteManifest(null));
  return manifestPromise;
}

// ---------------------------------------------------------------------------
// Decoding and alpha repair

function decodeImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Returns a data URL with black made transparent when the frame has no alpha at all. */
function repairAlpha(img: HTMLImageElement): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  const px = data.data;
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return null;
  for (let i = 0; i < px.length; i += 4) {
    px[i + 3] = (px[i]! | px[i + 1]! | px[i + 2]!) !== 0 ? 255 : 0;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

function loadUrl(url: string): Promise<SpriteState> {
  let p = byUrl.get(url);
  if (!p) {
    p = decodeImage(url).then((img) =>
      img ? { status: "ok" as const, url: repairAlpha(img) ?? url, width: img.naturalWidth, height: img.naturalHeight } : MISSING,
    );
    byUrl.set(url, p);
  }
  return p;
}

const browser = typeof window !== "undefined" && typeof Image !== "undefined";

/** Loads one named sprite (bake name first, then id/frame, then the conventional file name). */
function loadNamed(name: SpriteName): Promise<SpriteState> {
  const known = named.get(name);
  if (known) return Promise.resolve(known);
  if (!browser) return Promise.resolve(MISSING);
  const def: SpriteDef = SPRITES[name];
  return loadManifest().then(async (m) => {
    const frame = def.frame ?? 0;
    const url = pickUrl(m, [def.bake ? m.byName.get(def.bake) : undefined, m.byName.get(name), m.byId.get(idKey(def.id, frame))], def.id, frame);
    const state = url ? await loadUrl(url) : MISSING;
    named.set(name, state);
    publishCssVar(name, state);
    emit();
    return state;
  });
}

/** Loads any cache sprite frame by archive id, for interfaces beyond the kit's registry. */
export function loadSprite(id: number, frame = 0): Promise<SpriteState> {
  const k = idKey(id, frame);
  const known = byId.get(k);
  if (known) return Promise.resolve(known);
  if (!browser) return Promise.resolve(MISSING);
  return loadManifest().then(async (m) => {
    const url = pickUrl(m, [m.byId.get(k)], id, frame);
    const state = url ? await loadUrl(url) : MISSING;
    byId.set(k, state);
    emit();
    return state;
  });
}

function publishCssVar(name: SpriteName, state: SpriteState): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  if (state.status === "ok" && state.url) style.setProperty(`--spr-${name}`, `url("${state.url}")`);
  else style.removeProperty(`--spr-${name}`);
}

/**
 * Loads every registered sprite once and publishes their CSS variables.
 * Safe to call repeatedly; call it at boot so sprites are ready by the time
 * the loading screen ends. Resolves when every sprite has loaded or been
 * found missing.
 */
export function ensureSprites(): Promise<void> {
  registryPromise ??= Promise.all((Object.keys(SPRITES) as SpriteName[]).map(loadNamed)).then(() => {
    registrySettled = true;
    emit();
  });
  return registryPromise;
}

/** Current state of a named sprite without triggering a load. */
export function spriteState(name: SpriteName): SpriteState {
  return named.get(name) ?? PENDING;
}

/** URL for a named sprite once loaded, else null. */
export function spriteUrl(name: SpriteName): string | null {
  return spriteState(name).url;
}

/** CSS `background-image` value for a named sprite, or undefined while missing. */
export function spriteBackground(name: SpriteName): string | undefined {
  const url = spriteUrl(name);
  return url ? `url("${url}")` : undefined;
}

/** True once every registered sprite has either loaded or been found missing. */
export function spritesSettled(): boolean {
  return registrySettled;
}

/** Subscribes a component to sprite resolution and starts the registry load. */
export function useSpriteRegistry(): number {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  useEffect(() => {
    void ensureSprites();
  }, []);
  return v;
}

export interface UseSpriteResult extends SpriteState {
  def: SpriteDef;
}

/** Resolution state for one named sprite. */
export function useSprite(name: SpriteName): UseSpriteResult {
  useSpriteRegistry();
  return { ...spriteState(name), def: SPRITES[name] };
}

/** Resolution state for any cache sprite archive frame (not in the registry). */
export function useSpriteById(id: number, frame = 0): SpriteState {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  useEffect(() => {
    void loadSprite(id, frame);
  }, [id, frame]);
  return byId.get(idKey(id, frame)) ?? PENDING;
}

/** True when the registry has settled (hold first paint of sprite-heavy screens on it). */
export function useSpritesReady(): boolean {
  useSpriteRegistry();
  return registrySettled;
}
