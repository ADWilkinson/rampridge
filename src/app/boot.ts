import { createStore } from "zustand/vanilla";
import type { Engine } from "@/game";
import type { OsrsCharacterFactory, renderCharacterPreview } from "@/game/osrs";
import { SPRITES, ensureSprites, spriteState, type SpriteName } from "@/ui/kit/sprites";
import { installMobileGuards } from "./mobile";

/**
 * Loads everything the game needs before the title screen: the engine and
 * three.js (a separate chunk, imported here so the loading screen paints
 * first), the world and character data, the interface sprites and the
 * RuneScape fonts. One engine exists for the whole session.
 */

export interface GameRuntime {
  engine: Engine;
  /** The character runtime the engine uses; also drives the design preview. */
  factory: OsrsCharacterFactory;
  renderPreview: typeof renderCharacterPreview;
  /** The element the engine renders into. It moves between screens without remounting. */
  host: HTMLDivElement;
  /** Mounts the engine into `host` once. */
  ensureMounted(): void;
}

export interface BootState {
  /** 0..1 across code, world, characters, sprites and fonts. */
  fraction: number;
  label: string;
  error: string | null;
  runtime: GameRuntime | null;
}

export const bootStore = createStore<BootState>(() => ({ fraction: 0, label: "Loading", error: null, runtime: null }));

const FONT_FACES = ['16px "RS Plain 11"', '16px "RS Plain 12"', '16px "RS Bold 12"', '16px "RS Quill 8"', '32px "RS Quill"'];
const FONT_TIMEOUT_MS = 8_000;

function withTimeout(task: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    task.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/** Fonts are never fatal: a missing face falls back after the timeout. */
function loadFonts(): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return Promise.resolve();
  return withTimeout(Promise.all(FONT_FACES.map((face) => document.fonts.load(face))), FONT_TIMEOUT_MS);
}

/** Loads every registered sprite, reporting the share settled (loaded or missing). */
function loadSprites(onProgress: (fraction: number) => void): Promise<void> {
  const names = Object.keys(SPRITES) as SpriteName[];
  const settled = () => names.reduce((n, name) => n + (spriteState(name).status === "pending" ? 0 : 1), 0) / Math.max(1, names.length);
  const timer = setInterval(() => onProgress(settled()), 120);
  return ensureSprites().finally(() => {
    clearInterval(timer);
    onProgress(1);
  });
}

let running: Promise<GameRuntime> | null = null;
let failedEngine: Engine | null = null;

async function boot(): Promise<GameRuntime> {
  const parts = { code: 0, engine: 0, sprites: 0, fonts: 0 };
  let engineLabel = "Loading world";
  const publish = () => {
    const fraction = parts.code * 0.06 + parts.engine * 0.74 + parts.sprites * 0.14 + parts.fonts * 0.06;
    const label =
      parts.code < 1 ? "Loading game" : parts.engine < 1 ? engineLabel : parts.sprites < 1 ? "Loading interfaces" : "Loading fonts";
    bootStore.setState({ fraction: Math.min(0.99, fraction), label, error: null });
  };
  publish();

  const fonts = loadFonts().then(() => {
    parts.fonts = 1;
    publish();
  });
  const sprites = loadSprites((f) => {
    parts.sprites = f;
    publish();
  });

  const [game, osrs] = await Promise.all([import("@/game"), import("@/game/osrs")]);
  parts.code = 1;
  publish();

  failedEngine?.destroy();
  failedEngine = null;
  const factory = osrs.createCharacterFactory();
  const engine = game.createEngine({ characters: factory });
  const off = engine.on("progress", ({ fraction, label }) => {
    parts.engine = Math.max(parts.engine, Math.min(1, fraction));
    if (label && label !== "Ready") engineLabel = label;
    publish();
  });
  try {
    await engine.load();
  } catch (err) {
    failedEngine = engine;
    throw err;
  } finally {
    off();
  }
  parts.engine = 1;
  publish();
  await Promise.all([sprites, fonts]);

  engine.setTitleMode(true);
  const host = document.createElement("div");
  host.className = "rr-engine-host";
  Object.assign(host.style, { position: "absolute", inset: "0" });
  let mounted = false;
  return {
    engine,
    factory,
    renderPreview: osrs.renderCharacterPreview,
    host,
    ensureMounted() {
      if (mounted) return;
      mounted = true;
      engine.mount(host);
    },
  };
}

/** Starts loading (once); safe to call again after a failure to retry. */
export function startBoot(): Promise<GameRuntime> {
  installMobileGuards();
  if (!running) {
    running = boot().then(
      (runtime) => {
        bootStore.setState({ fraction: 1, label: "Ready", error: null, runtime });
        return runtime;
      },
      (err: unknown) => {
        console.error("[boot] failed to load the game", err);
        running = null;
        bootStore.setState({
          error: "The bank could not be loaded. Check your connection and try again.",
        });
        throw err;
      },
    );
    // The error is shown on the loading screen; nothing else awaits this.
    running.catch(() => undefined);
  }
  return running;
}
