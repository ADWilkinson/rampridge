/**
 * RampRidge asset bake: regenerates every world asset from the OSRS cache on
 * disk (see README.md), then runs the actor bake (actors/index.ts) when it is
 * present, so one command bakes everything.
 *
 *   cd scripts/bake && bun run bake                 # everything
 *   bun run bake -- --only=world,collision          # selected steps
 *   bun run bake -- --skip=ui                       # all but some steps
 *   bun run bake -- --no-actors                     # skip actors/index.ts
 *   bun run bake -- --no-lock                       # leave assets.lock.json alone
 *
 * Steps (in order): collision, world, minimap, sprites, fonts, sounds, ui,
 * then actors. ui renders the wordmark with headless Chrome (CHROME_PATH).
 * Finally it records every untracked output in assets.lock.json (see
 * ../assets.ts), the list scripts/deploy.sh ships.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { type LockedCache, LOCK_FILE, readLock, writeLock } from "../assets";
import { openCache } from "./lib/cache";
import { BAKE_DIR, ensureDir, FONTS_DIR, REPO_DIR, SOUNDS_DIR, SPRITES_DIR, UI_DIR, WORLD_DIR } from "./lib/paths";
import { bakeCollision } from "./steps/collision";
import { bakeFonts } from "./steps/fonts";
import { bakeMinimap } from "./steps/minimap";
import { bakeSounds } from "./steps/sounds";
import { bakeSprites } from "./steps/sprites";
import { bakeUi } from "./steps/ui";
import { bakeWorld } from "./steps/world";

type Cache = Awaited<ReturnType<typeof openCache>>;
const STEPS: [string, (cache: Cache) => Promise<unknown>][] = [
  ["collision", bakeCollision],
  ["world", bakeWorld],
  ["minimap", bakeMinimap],
  ["sprites", bakeSprites],
  ["fonts", () => bakeFonts()],
  ["sounds", bakeSounds],
  ["ui", bakeUi],
];

function parseList(flag: string): Set<string> | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!arg) return undefined;
  const names = arg.slice(flag.length + 3).split(",").filter(Boolean);
  for (const n of names) {
    if (!STEPS.some(([s]) => s === n)) throw new Error(`unknown step "${n}" (steps: ${STEPS.map(([s]) => s).join(", ")})`);
  }
  return new Set(names);
}

/** The lock's record of the cache: caches.json carries the openrs2 id when fetch-cache registered it. */
function lockedCache(info: Cache["info"]): LockedCache {
  let openrs2 = (info as { openrs2Id?: number }).openrs2Id;
  if (openrs2 === undefined && fs.existsSync(path.join(REPO_DIR, LOCK_FILE))) {
    const previous = readLock(REPO_DIR).cache;
    if (previous.name === info.name) openrs2 = previous.openrs2;
  }
  if (openrs2 === undefined) {
    throw new Error(`caches.json does not say which openrs2 cache ${info.name} is: register it with \`bun run fetch-cache -- --id=<openrs2 id>\``);
  }
  return { openrs2, name: info.name, revision: info.revision, timestamp: info.timestamp, size: info.size };
}

async function main() {
  const only = parseList("only");
  const skip = parseList("skip") ?? new Set<string>();
  const runActors = !process.argv.includes("--no-actors") && !only;
  for (const dir of [WORLD_DIR, SPRITES_DIR, FONTS_DIR, SOUNDS_DIR, UI_DIR]) ensureDir(dir);

  const t0 = Date.now();
  const cache = await openCache();
  console.log(`cache ${cache.info.name} (build ${cache.info.revision}, ${cache.info.timestamp}) opened in ${Date.now() - t0} ms`);
  for (const [name, run] of STEPS) {
    if ((only && !only.has(name)) || skip.has(name)) continue;
    const t = Date.now();
    console.log(`[${name}]`);
    await run(cache);
    console.log(`  done in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }

  const actors = path.join(BAKE_DIR, "actors/index.ts");
  if (runActors && fs.existsSync(actors)) {
    console.log("[actors] actors/index.ts");
    const tsx = path.join(BAKE_DIR, "node_modules/.bin/tsx");
    const r = spawnSync(fs.existsSync(tsx) ? tsx : "tsx", [actors, ...process.argv.slice(2).filter((a) => !a.startsWith("--"))], {
      cwd: BAKE_DIR,
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`actors/index.ts exited with ${r.status ?? r.signal}`);
  } else if (runActors) {
    console.log("[actors] actors/index.ts not present, skipped");
  }
  if (!process.argv.includes("--no-lock")) {
    const { lock, added, removed, changed } = writeLock(REPO_DIR, lockedCache(cache.info));
    const n = Object.keys(lock.files).length;
    console.log(`[lock] ${LOCK_FILE}: ${n} files; ${added.length} added, ${removed.length} removed, ${changed.length} changed`);
    for (const f of removed) console.log(`  removed ${f} (no longer on disk)`);
  }
  console.log(`bake finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
