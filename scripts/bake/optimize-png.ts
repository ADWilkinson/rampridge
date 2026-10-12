/**
 * Re-encodes PNGs with the bake's smallest lossless encoder (lib/png-encode),
 * for images the bake steps don't regenerate on every run (the Chrome-rendered
 * wordmarks and the app icons), so they ship as small as baked ones without a
 * re-render. Every file is decoded again and compared pixel for pixel before
 * it is replaced; a file only changes when the new encoding is smaller.
 *
 *   cd scripts/bake && bun run optimize-png                 # public/game/ui
 *   bun run optimize-png -- ../../public/game/sprites       # any directories
 */
import fs from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";

import { encodeSmallestPng } from "./lib/png-encode";
import { UI_DIR, rel } from "./lib/paths";

const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let before = 0;
let after = 0;
for (const dir of dirs.length > 0 ? dirs.map((d) => path.resolve(d)) : [UI_DIR]) {
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort()) {
    const file = path.join(dir, name);
    const original = fs.readFileSync(file);
    const img = PNG.sync.read(original);
    const encoded = encodeSmallestPng({ width: img.width, height: img.height, data: img.data });
    const check = PNG.sync.read(encoded);
    if (check.width !== img.width || check.height !== img.height || !Buffer.from(check.data).equals(Buffer.from(img.data))) {
      throw new Error(`${rel(file)}: re-encoding changed pixels`);
    }
    before += original.length;
    if (encoded.length < original.length) {
      fs.writeFileSync(file, encoded);
      after += encoded.length;
      console.log(`  ${rel(file)}: ${original.length} -> ${encoded.length} bytes`);
    } else {
      after += original.length;
    }
  }
}
console.log(`png: ${before} -> ${after} bytes`);
