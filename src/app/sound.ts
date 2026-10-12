import type { SoundName } from "@/ui/interfaces/context";

/**
 * Interface sound effects (bank open and close, offer placed, coins, level
 * up...) from the baked cache sounds, played with WebAudio. The engine plays
 * its own world sounds; this covers everything the interfaces ask for. The
 * audio context starts on the first click or key press (autoplay rules).
 */

const SOUND_BASE = `${import.meta.env.BASE_URL}game/sounds/`;
const NAMES: readonly SoundName[] = ["click", "offer", "collect", "coins", "levelup", "trade", "error", "open", "close"];

/** Settings volume 0-4 to output gain. */
export function gainForVolume(volume: number): number {
  const v = Math.max(0, Math.min(4, Math.round(volume)));
  return (v / 4) * 0.6;
}

class UiSounds {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private level = gainForVolume(3);
  private urls: Map<SoundName, string> | null = null;
  private manifest: Promise<void> | null = null;
  private readonly buffers = new Map<SoundName, Promise<AudioBuffer | null>>();
  private listening = false;

  /** Starts the audio context on the first user gesture. Call once at startup. */
  listen(): void {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    const unlock = () => {
      this.unlock();
      if (this.ctx?.state === "running") {
        window.removeEventListener("pointerdown", unlock, true);
        window.removeEventListener("keydown", unlock, true);
      }
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
  }

  setVolume(volume: number): void {
    this.level = gainForVolume(volume);
    if (this.gain) this.gain.gain.value = this.level;
  }

  private unlock(): void {
    if (typeof AudioContext === "undefined") return;
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.level;
        this.gain.connect(this.ctx.destination);
      }
      if (this.ctx.state === "suspended") void this.ctx.resume();
    } catch {
      // Audio unavailable (some embedded browsers): stay silent.
    }
  }

  private loadManifest(): Promise<void> {
    this.manifest ??= fetch(`${SOUND_BASE}manifest.json`)
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((raw) => {
        const urls = new Map<SoundName, string>();
        if (raw && typeof raw === "object") {
          const map = raw as Record<string, unknown>;
          for (const name of NAMES) {
            const file = map[name];
            if (typeof file === "string") urls.set(name, `${SOUND_BASE}${file}`);
          }
        }
        this.urls = urls;
      })
      .catch(() => {
        this.urls = new Map();
      });
    return this.manifest;
  }

  private buffer(name: SoundName, ctx: AudioContext): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(name);
    if (!pending) {
      pending = this.loadManifest()
        .then(() => {
          const url = this.urls?.get(name);
          if (!url) return null;
          return fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${url}: ${r.status}`))))
            .then((data) => ctx.decodeAudioData(data));
        })
        .catch(() => null);
      this.buffers.set(name, pending);
    }
    return pending;
  }

  play(name: SoundName): void {
    const ctx = this.ctx;
    const out = this.gain;
    if (!ctx || !out || ctx.state !== "running" || this.level <= 0) return;
    void this.buffer(name, ctx).then((buffer) => {
      if (!buffer || ctx.state !== "running" || this.level <= 0) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(out);
      source.start();
    });
  }
}

export const uiSounds = new UiSounds();
