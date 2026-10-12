/**
 * Builds the game assets in a fresh clone (`bun run setup:assets` from the
 * repository root). They are decoded from Jagex's Old School RuneScape cache,
 * so the repository does not contain them:
 *
 *   1. fetches the cache production was baked from (pinned in assets.lock.json)
 *      from archive.openrs2.org into .cache/osrs, unless it is already there;
 *   2. fetches RuneStar's fonts (fetch-fonts.ts) into .cache/runestar-fonts;
 *   3. runs the bake (index.ts) without rewriting the lock;
 *   4. reports how the files compare with the ones production serves.
 *
 * Downloads about 190 MB once; later runs reuse .cache.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { compareWithLock, LOCK_FILE, readLock } from "../assets";
import { fetchCache } from "./fetch-cache";
import { ensureRuneStarFonts, RUNESTAR_RELEASE } from "./fetch-fonts";
import { BAKE_DIR, REPO_DIR } from "./lib/paths";

function list(files: string[], limit = 8): string {
  const shown = files.slice(0, limit).map((f) => `    ${f}`);
  if (files.length > limit) shown.push(`    ... and ${files.length - limit} more`);
  return shown.join("\n");
}

async function main() {
  const lock = readLock(REPO_DIR);

  console.log("[1/4] OSRS cache");
  await fetchCache({ kind: "pinned" });

  console.log(`[2/4] RuneStar fonts ${RUNESTAR_RELEASE}`);
  const fonts = await ensureRuneStarFonts();
  console.log(`  ready in ${path.relative(REPO_DIR, fonts)}`);

  console.log("[3/4] bake");
  const tsx = path.join(BAKE_DIR, "node_modules/.bin/tsx");
  const r = spawnSync(fs.existsSync(tsx) ? tsx : "tsx", ["index.ts", "--no-lock"], { cwd: BAKE_DIR, stdio: "inherit" });
  if (r.error) throw new Error(`could not start the bake: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`the bake failed (exit ${r.status ?? r.signal}); see the output above`);

  console.log("[4/4] compare with production");
  const cmp = compareWithLock(REPO_DIR, lock);
  const total = Object.keys(lock.files).length;
  console.log(`  ${cmp.matched.length} of ${total} files are byte-identical to production (${LOCK_FILE}).`);
  const captured = cmp.missing.filter((f) => /^public\/og(-square|-bg)?\.png$/.test(f));
  const missing = cmp.missing.filter((f) => !captured.includes(f));
  if (captured.length > 0) {
    console.log(`  Not built here: the link preview cards, which scripts/og captures from the running game (the game works without them):\n${list(captured)}`);
  }
  if (missing.length > 0) console.log(`  Missing after the bake:\n${list(missing)}`);
  if (cmp.changed.length > 0) {
    console.log(
      `  ${cmp.changed.length} files differ in bytes from production's. That is fine for development; only a production deploy needs them identical:\n${list(cmp.changed.map((c) => c.path))}`,
    );
  }
  if (missing.length > 0) throw new Error("the bake did not produce every asset; see the list above");
  console.log("Game assets ready. `bun run dev` serves the game at http://localhost:5173.");
}

main().catch((err: unknown) => {
  console.error(`\nsetup:assets failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
