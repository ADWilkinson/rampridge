/**
 * Headless screenshots of bake preview pages (dev/bake.html on the Vite dev
 * server). Pages set document.title to READY when their frame is final.
 *
 * Usage: tsx preview/shoot.ts [--size=1280x800] <url> <out.png> [<url> <out.png> ...]
 * Env: SHOOT_PROFILE_ROOT (directory for the temporary profile), CHROME_PATH.
 */
import fs from "node:fs";
import path from "node:path";

import { openChrome } from "../lib/chrome";

async function main() {
  const args = process.argv.slice(2);
  let width = 1280;
  let height = 800;
  const jobs: { url: string; out: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const size = /^--size=(\d+)x(\d+)$/.exec(a);
    if (size) {
      width = Number(size[1]);
      height = Number(size[2]);
      continue;
    }
    jobs.push({ url: a, out: args[++i]! });
  }
  if (jobs.length === 0) throw new Error("usage: shoot.ts [--size=WxH] <url> <out.png> ...");
  const chrome = await openChrome();
  try {
    for (const job of jobs) {
      const r = await chrome.capture(job.url, { width, height, strict: false });
      fs.mkdirSync(path.dirname(job.out), { recursive: true });
      fs.writeFileSync(job.out, r.png);
      console.log(`${r.title.padEnd(7)} ${(r.ms / 1000).toFixed(1)}s ${job.out}`);
    }
  } finally {
    chrome.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
