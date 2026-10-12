/**
 * Test helper: the baked public/game/actors/actors.bin. It is decoded from
 * the Old School RuneScape cache (Jagex's models and animations) and is not
 * in the repository; `bun run setup:assets` bakes it. Tests about the real
 * kits, colours and animations skip without it; the format's own logic is
 * tested on synthetic data.
 */
import { decodeActorData, type ActorData } from "./format";

// Node-only file access without pulling node types into the browser tsconfig.
const fsModule = "node:fs";

/** The baked actors.bin bytes, or null in a checkout that has not baked the game assets. */
export async function readBakedActors(): Promise<Uint8Array | null> {
  const { existsSync, readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
    existsSync(path: URL): boolean;
    readFileSync(path: URL): Uint8Array;
  };
  const url = new URL("../../../public/game/actors/actors.bin", import.meta.url);
  return existsSync(url) ? new Uint8Array(readFileSync(url)) : null;
}

/** The decoded baked actor data, or null without it. */
export async function loadBakedActors(): Promise<ActorData | null> {
  const bin = await readBakedActors();
  return bin ? decodeActorData(bin) : null;
}
