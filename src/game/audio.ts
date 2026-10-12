import { fetchJsonOptional, joinUrl } from "./assets";

/**
 * World sound effects from the cache, played with WebAudio. The context is
 * created on the first user gesture (browser autoplay rules) and buffers are
 * decoded on first use.
 */

export type SoundName = "click" | "coins" | "levelup";

const ALIASES: Record<SoundName, readonly string[]> = {
  click: ["click", "interact", "select", "button"],
  coins: ["coins", "coin", "coins_jingle", "money", "trade"],
  // The level-up fireworks the bake already exports; silent when a bake has none.
  levelup: ["levelup", "level_up", "level_up_fireworks", "fireworks"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileOf(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!isRecord(entry)) return null;
  for (const key of ["file", "url", "src", "path"]) {
    const v = entry[key];
    if (typeof v === "string") return v;
  }
  return null;
}

/** Maps sound names to files from the bake's manifest (object, list, or { sounds }). */
export function parseSoundManifest(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!isRecord(entry)) continue;
        const file = fileOf(entry);
        const name = entry.name ?? entry.key ?? entry.label ?? entry.id;
        if (file && (typeof name === "string" || typeof name === "number")) out.set(String(name).toLowerCase(), file);
      }
      return;
    }
    if (!isRecord(value)) return;
    if ("sounds" in value) return visit(value.sounds);
    for (const [name, entry] of Object.entries(value)) {
      const file = fileOf(entry);
      if (file) out.set(name.toLowerCase(), file);
    }
  };
  visit(raw);
  return out;
}

export class SoundBoard {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private readonly urls = new Map<SoundName, string>();
  private readonly buffers = new Map<SoundName, Promise<AudioBuffer | null>>();
  private enabled = true;

  async load(assetBase: string): Promise<void> {
    const soundsBase = joinUrl(assetBase, "sounds/");
    const manifest = parseSoundManifest(await fetchJsonOptional(joinUrl(soundsBase, "manifest.json")));
    for (const name of Object.keys(ALIASES) as SoundName[]) {
      for (const alias of ALIASES[name]) {
        const file = manifest.get(alias);
        if (!file) continue;
        this.urls.set(name, /^(?:[a-z]+:|\/)/i.test(file) ? file : joinUrl(soundsBase, file));
        break;
      }
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Call from a user gesture: creates or resumes the audio context. */
  unlock(): void {
    if (typeof AudioContext === "undefined") return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.5;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  private buffer(name: SoundName): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(name);
    if (!pending) {
      const url = this.urls.get(name);
      const ctx = this.ctx;
      pending =
        url && ctx
          ? fetch(url)
              .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${url} returned ${r.status}`))))
              .then((data) => ctx.decodeAudioData(data))
              .catch(() => null)
          : Promise.resolve(null);
      if (url && ctx) this.buffers.set(name, pending);
    }
    return pending;
  }

  play(name: SoundName, volume = 1): void {
    if (!this.enabled || !this.ctx || !this.gain || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const out = this.gain;
    void this.buffer(name).then((buffer) => {
      if (!buffer || !this.enabled || ctx.state !== "running") return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      if (volume !== 1) {
        const g = ctx.createGain();
        g.gain.value = volume;
        source.connect(g).connect(out);
      } else {
        source.connect(out);
      }
      source.start();
    });
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.gain = null;
    this.buffers.clear();
  }
}
