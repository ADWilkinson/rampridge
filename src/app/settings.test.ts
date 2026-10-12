import { afterEach, describe, expect, it, vi } from "vitest";
import { gainForVolume } from "./sound";
import { defaultSettings, parseSettings, takeTouchHint } from "./settings";

describe("parseSettings", () => {
  const defaults = { soundVolume: 3, musicVolume: 0, chatEffects: true, reducedMotion: false, running: false };

  it("keeps valid stored values", () => {
    expect(parseSettings({ soundVolume: 0, musicVolume: 4, chatEffects: false, reducedMotion: true, running: true }, defaults)).toEqual({
      soundVolume: 0,
      musicVolume: 4,
      chatEffects: false,
      reducedMotion: true,
      running: true,
    });
  });

  it("falls back field by field for anything malformed", () => {
    expect(parseSettings({ soundVolume: 9, musicVolume: 1.5, chatEffects: "yes", running: 1 }, defaults)).toEqual(defaults);
    expect(parseSettings(null, defaults)).toEqual(defaults);
    expect(parseSettings("x", defaults)).toEqual(defaults);
  });

  it("defaults to sound on, effects on and running", () => {
    const d = defaultSettings();
    expect(d.soundVolume).toBeGreaterThan(0);
    expect(d.chatEffects).toBe(true);
    expect(d.running).toBe(true);
  });

  it("keeps a saved walk choice over the running default", () => {
    expect(parseSettings({ running: false }).running).toBe(false);
    expect(parseSettings({}).running).toBe(true);
  });
});

describe("gainForVolume", () => {
  it("maps the 0-4 volume bar to a gain, silent at 0", () => {
    expect(gainForVolume(0)).toBe(0);
    expect(gainForVolume(4)).toBeCloseTo(0.6);
    expect(gainForVolume(2)).toBeCloseTo(0.3);
    expect(gainForVolume(9)).toBeCloseTo(0.6);
  });
});

describe("takeTouchHint", () => {
  const stubStorage = () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the hint once on a touch screen", () => {
    stubStorage();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)" }));
    expect(takeTouchHint()).toBe(true);
    expect(takeTouchHint()).toBe(false);
  });

  it("never shows it with a mouse", () => {
    stubStorage();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(takeTouchHint()).toBe(false);
  });
});
