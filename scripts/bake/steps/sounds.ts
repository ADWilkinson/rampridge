/**
 * Original OSRS sound effects, synthesised from the cache (index 4) with the
 * client's synth (lib/synth.ts) and written as mono 8-bit 22050 Hz WAV (what
 * the client itself plays; plays everywhere, including iOS Safari).
 *
 * IDs and config names come from the OSRS Wiki "List of sound IDs" (the
 * names Jagex transmitted in Feb 2025) and RuneLite's SoundEffectID.
 * public/game/sounds/manifest.json maps the UI's logical names to files.
 */
import fs from "node:fs";
import path from "node:path";

import type { BakeCache } from "../lib/cache";
import { SOUNDS_DIR, rel, writeIfChanged, writeJson } from "../lib/paths";
import { loadSoundEffect, mixSoundEffect, toWav } from "../lib/synth";

/** [file stem, sound effect id, wiki config name]. */
export const EFFECTS = [
  ["interface_select", 2266, "interface_select1"],
  ["ge_offer_placed", 3925, "ge_trade_ok"],
  ["ge_offer_error", 3926, "ge_trade_error"],
  ["ge_place_item", 3927, "ge_place_item"],
  ["ge_collect_items", 3928, "ge_collect_items"],
  ["ge_collect_coins", 3924, "ge_collect_coins"],
  ["ge_increment", 3929, "ge_up_amount"],
  ["ge_decrement", 3930, "ge_down_amount"],
  ["interface_wrong", 2268, "interface_wrong"],
  ["error", 2394, "errorsound"],
  ["bank_unlocking", 2027, "bank_unlocking"],
  ["bank_locking", 2024, "bank_locking"],
  ["coins", 2115, "coins"],
  ["coins_pickup", 2582, "pick2"],
  ["coins_drop", 2739, "put_down"],
  ["level_up_fireworks", 2396, "firework"],
] as const;

type Stem = (typeof EFFECTS)[number][0];

/** Logical names the UI plays -> effect. */
export const LOGICAL: Record<string, Stem> = {
  click: "interface_select",
  offer: "ge_offer_placed",
  collect: "ge_collect_items",
  coins: "ge_collect_coins",
  levelup: "level_up_fireworks",
  trade: "ge_place_item",
  error: "interface_wrong",
  open: "bank_unlocking",
  close: "bank_locking",
  // extras
  tradeError: "ge_offer_error",
  increment: "ge_increment",
  decrement: "ge_decrement",
  coinsPickup: "coins_pickup",
  coinsDrop: "coins_drop",
};

export async function bakeSounds(cache: BakeCache): Promise<Record<string, string>> {
  const written = new Set<string>();
  const sources: Record<string, { id: number; name: string; ms: number }> = {};
  for (const [stem, id, name] of EFFECTS) {
    const pcm = mixSoundEffect(loadSoundEffect(cache, id));
    if (pcm.length === 0) throw new Error(`sound effect ${id} (${name}) is empty`);
    const file = `${stem}.wav`;
    writeIfChanged(path.join(SOUNDS_DIR, file), toWav(pcm));
    written.add(file);
    sources[file] = { id, name, ms: Math.round((pcm.length * 1000) / 22050) };
  }
  const manifest: Record<string, string> = {};
  for (const [logical, stem] of Object.entries(LOGICAL)) manifest[logical] = `${stem}.wav`;
  for (const f of fs.readdirSync(SOUNDS_DIR)) {
    if (f === "manifest.json" || f === "sources.json" || written.has(f)) continue;
    fs.rmSync(path.join(SOUNDS_DIR, f));
  }
  writeJson(path.join(SOUNDS_DIR, "manifest.json"), manifest);
  writeJson(path.join(SOUNDS_DIR, "sources.json"), sources);
  console.log(`  sounds: ${EFFECTS.length} effects, ${Object.keys(manifest).length} logical names -> ${rel(SOUNDS_DIR)}`);
  return manifest;
}
