import { create } from "zustand";
import type { Appearance } from "@shared/protocol";
import { validateAppearance } from "@shared/validate";
import type { GameSettings } from "@/ui/frame/panels/SettingsPanel";
import { readStored, removeStored, writeStored } from "./storage";

/**
 * Per-device preferences: the Settings tab, the run toggle, the character's
 * look and whether the first-visit intro has been seen. Stored in
 * localStorage; a blocked store simply means defaults next visit.
 */

export interface ShellSettings extends GameSettings {
  /** Run orb state (two tiles per tick). */
  running: boolean;
}

export const SETTINGS_KEY = "rampridge.settings";
export const APPEARANCE_KEY = "rampridge.appearance";
export const INTRO_SEEN_KEY = "rampridge.introSeen";
export const TOUCH_HINT_KEY = "rampridge.touchHintSeen";

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A new visitor runs: walking from the door to a booth takes several seconds. A saved choice keeps its value. */
export function defaultSettings(): ShellSettings {
  return { soundVolume: 3, musicVolume: 0, chatEffects: true, reducedMotion: prefersReducedMotion(), running: true };
}

function volume(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4 ? value : fallback;
}

/** Validates a stored settings object field by field, keeping defaults for anything malformed. */
export function parseSettings(value: unknown, defaults: ShellSettings = defaultSettings()): ShellSettings {
  if (typeof value !== "object" || value === null) return defaults;
  const v = value as Record<string, unknown>;
  return {
    soundVolume: volume(v.soundVolume, defaults.soundVolume),
    musicVolume: volume(v.musicVolume, defaults.musicVolume),
    chatEffects: typeof v.chatEffects === "boolean" ? v.chatEffects : defaults.chatEffects,
    reducedMotion: typeof v.reducedMotion === "boolean" ? v.reducedMotion : defaults.reducedMotion,
    running: typeof v.running === "boolean" ? v.running : defaults.running,
  };
}

interface SettingsStore {
  settings: ShellSettings;
  update(patch: Partial<ShellSettings>): void;
}

export const useSettingsStore = create<SettingsStore>()((set, get) => ({
  settings: readStored(SETTINGS_KEY, (v) => parseSettings(v)) ?? defaultSettings(),
  update(patch) {
    const settings = { ...get().settings, ...patch };
    writeStored(SETTINGS_KEY, settings);
    set({ settings });
  },
}));

export function loadAppearance(): Appearance | null {
  return readStored(APPEARANCE_KEY, (v) => {
    const parsed = validateAppearance(v);
    return parsed.ok ? parsed.value : null;
  });
}

export function saveAppearance(appearance: Appearance): void {
  writeStored(APPEARANCE_KEY, appearance);
}

export function forgetAppearance(): void {
  removeStored(APPEARANCE_KEY);
}

export function introSeen(): boolean {
  return readStored(INTRO_SEEN_KEY, (v) => v === true) === true;
}

export function markIntroSeen(): void {
  writeStored(INTRO_SEEN_KEY, true);
}

/** The touch controls hint, shown once per device on a touch screen. */
export const TOUCH_HINT = "Tap to walk. Hold for options. Pinch to zoom.";

/** True on a phone or tablet (the primary pointer is a finger). */
export function isTouchScreen(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** Whether to show TOUCH_HINT now; marks it shown. */
export function takeTouchHint(): boolean {
  if (!isTouchScreen() || readStored(TOUCH_HINT_KEY, (v) => v === true) === true) return false;
  writeStored(TOUCH_HINT_KEY, true);
  return true;
}
