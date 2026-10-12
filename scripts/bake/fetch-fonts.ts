/**
 * RuneStar's TrueType conversions of the Old School RuneScape fonts
 * (https://github.com/RuneStar/fonts), downloaded from a pinned release into
 * .cache/runestar-fonts/<release>/ and checked byte for byte. RuneStar
 * dedicates its conversion to the public domain (CC0 1.0, the repository's
 * LICENSE); the glyph designs are Jagex Ltd's, so the files are fetched at
 * bake time rather than committed. steps/fonts.ts copies them to
 * public/game/fonts and fetches them first when they are missing.
 *
 *   cd scripts/bake && bun run fetch-fonts
 *
 * Needs `unzip` on PATH.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_DIR } from "./lib/paths";

export const RUNESTAR_RELEASE = "1.103-0";
const ZIP_URL = `https://github.com/RuneStar/fonts/releases/download/${RUNESTAR_RELEASE}/RuneScape-Fonts.zip`;
/** SHA-256 of RuneScape-Fonts.zip (127,033 bytes) as published with the release. */
const ZIP_SHA256 = "aebff4ab4633aad9552e6ba7df5f85466707be673760613daa7a2463f3981c5d";

/** The faces RampRidge uses, from the zip's ttf/ directory, with their SHA-256. */
export const RUNESTAR_FONTS: Readonly<Record<string, string>> = {
  "RuneScape-Barbarian-Assault.ttf": "3d0616cafb6186347bdd9cc3754e77f785fa5ae55d76256ca6e9c5e5362adb9c",
  "RuneScape-Bold-12.ttf": "923b3dfad56e554859e9d0dde111956ff767ed38f20dba58cf6ce36694493ba6",
  "RuneScape-Fairy-Large.ttf": "6f4edb51c5890d572c013302c350f18f84f8bc23c5d1819f049947f12022f40c",
  "RuneScape-Fairy.ttf": "cfe7a6b8c4103e51869a1e3ae8dec831d3808bbdebd07d1ffc4e1c110ff1a49b",
  "RuneScape-Plain-11.ttf": "347b37ae9947ba8fcaba4dbc759f294531ea79ca65186768fc7babd3d46d5af0",
  "RuneScape-Plain-12.ttf": "a4bb4b07cbbad7a25d8f4b801882dcd9a01a156c8eb1c1da068d8700077ad90c",
  "RuneScape-Quill-8.ttf": "aeee13731f38975b47ef286a592fead443fde5b779542482de81ccccaeb9dc52",
  "RuneScape-Quill-Caps.ttf": "b1a12808cf7cb04d06bfb9251eadd60bf17e7ce5de1710c5bbf908b8f76ecf80",
  "RuneScape-Quill.ttf": "44a5bdbeb3236e9266e183c65b1344f4be6cf950956877382d3cb022fa072c35",
  "RuneScape-Surok.ttf": "258d2d74e224522e04632039c62769c487f3274b6bd45e5b982a28c11e43f078",
};

export const RUNESTAR_FONTS_DIR = path.join(REPO_DIR, ".cache/runestar-fonts", RUNESTAR_RELEASE);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fontsInPlace(): boolean {
  return Object.entries(RUNESTAR_FONTS).every(([file, hash]) => {
    const abs = path.join(RUNESTAR_FONTS_DIR, file);
    return fs.existsSync(abs) && sha256(fs.readFileSync(abs)) === hash;
  });
}

/** Returns the directory holding the pinned TTFs, downloading the release first when any is missing or altered. */
export async function ensureRuneStarFonts(): Promise<string> {
  if (fontsInPlace()) return RUNESTAR_FONTS_DIR;
  console.log(`  fonts: downloading RuneStar fonts ${RUNESTAR_RELEASE} from ${ZIP_URL}`);
  let zip: Uint8Array;
  try {
    const res = await fetch(ZIP_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    zip = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    const cause = err instanceof Error ? ((err.cause as { code?: string } | undefined)?.code ?? err.message) : String(err);
    throw new Error(
      `Couldn't download the RuneStar fonts (${cause}). Download ${ZIP_URL} by hand and unzip its ttf/*.ttf files into ${path.relative(REPO_DIR, RUNESTAR_FONTS_DIR)}/.`,
    );
  }
  if (sha256(zip) !== ZIP_SHA256) throw new Error(`${ZIP_URL} is not the pinned release (SHA-256 ${sha256(zip)}, expected ${ZIP_SHA256})`);

  const parent = path.dirname(RUNESTAR_FONTS_DIR);
  fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, `.download-${RUNESTAR_RELEASE}-`));
  try {
    const zipFile = path.join(work, "RuneScape-Fonts.zip");
    fs.writeFileSync(zipFile, zip);
    const members = Object.keys(RUNESTAR_FONTS).map((f) => `ttf/${f}`);
    const r = spawnSync("unzip", ["-q", "-o", "-j", zipFile, ...members, "-d", path.join(work, "ttf")], { stdio: "inherit" });
    if (r.error) throw new Error(`unzip failed (${r.error.message}); install unzip and run again`);
    if (r.status !== 0) throw new Error(`unzip exited with ${r.status}`);
    for (const [file, hash] of Object.entries(RUNESTAR_FONTS)) {
      const got = sha256(fs.readFileSync(path.join(work, "ttf", file)));
      if (got !== hash) throw new Error(`${file} in ${ZIP_URL} has SHA-256 ${got}, expected ${hash}`);
    }
    fs.rmSync(RUNESTAR_FONTS_DIR, { recursive: true, force: true });
    fs.renameSync(path.join(work, "ttf"), RUNESTAR_FONTS_DIR);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`  fonts: ${Object.keys(RUNESTAR_FONTS).length} faces -> ${path.relative(REPO_DIR, RUNESTAR_FONTS_DIR)}`);
  return RUNESTAR_FONTS_DIR;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureRuneStarFonts()
    .then((dir) => console.log(`RuneStar fonts ${RUNESTAR_RELEASE} ready in ${path.relative(REPO_DIR, dir)}`))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
