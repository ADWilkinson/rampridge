import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { type AssetLock, codeProblems, compareWithLock, copyLockedAssets, inAssetScope, LOCK_FILE, readLock, writeLock } from "./assets";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the committed asset lock", () => {
  it("covers every asset the code loads by name, from the cache the world data came from", () => {
    expect(codeProblems(ROOT, readLock(ROOT))).toEqual([]);
  });

  it("keeps the game assets out of git", () => {
    let tracked: string[];
    try {
      tracked = execFileSync("git", ["ls-files", "-z", "--", "public", "scripts/bake/vendor"], { cwd: ROOT, encoding: "utf8" }).split("\0");
    } catch {
      return; // not a git checkout (a source archive): nothing to check
    }
    expect(tracked.filter(inAssetScope)).toEqual([]);
    expect(tracked.filter((f) => /\.(ttf|otf)$/.test(f) && !f.startsWith("scripts/bake/vendor/cinzel/"))).toEqual([]);
  });
});

describe("lock, compare and copy", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A tiny repository: one baked file, one captured preview, a tracked logo and the code files codeProblems reads. */
  function fixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rampridge-assets-"));
    dirs.push(root);
    const files: Record<string, string> = {
      "public/game/world/minimap.png": "minimap",
      "public/game/actors/actors.bin": "actors",
      "public/game/ui/logo.png": "logo (tracked)",
      "public/og.png": "card",
      "public/game/.DS_Store": "junk",
      "index.html": '<link rel="icon" href="/game/world/minimap.png"><meta content="https://www.rampridge.xyz/og.png"><img src="/game/ui/logo.png">',
      "public/manifest.webmanifest": "{}",
      "vercel.json": "{}",
      "src/styles/fonts.css": "",
      "api/_lib/shareCard.ts": "",
      "api/_lib/sharePage.ts": "",
      "src/ui/kit/spriteIds.ts": "",
      "shared/world-meta.json": JSON.stringify({ cache: { name: "osrs-1_2000-01-01" } }),
      // sha256("actors") starts with 605b727d3f53 and is 6 bytes long.
      "src/game/osrs/catalog.generated.ts": 'export const ACTOR_DATA_HASH = "605b727d3f53";\nexport const ACTOR_DATA_BYTES = 6;\n',
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    fs.mkdirSync(path.join(root, "scripts/bake"), { recursive: true });
    writeLock(root, { openrs2: 1, name: "osrs-1_2000-01-01", revision: 1, timestamp: "2000-01-01T00:00:00Z", size: 1 });
    return root;
  }

  /** What `git archive HEAD` would hold: everything but the untracked assets. */
  function exportOf(root: string): string {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "rampridge-export-"));
    dirs.push(dest);
    const tracked = (src: string) => fs.statSync(src).isDirectory() || !inAssetScope(path.relative(root, src).split(path.sep).join("/"));
    fs.cpSync(root, dest, { recursive: true, filter: tracked });
    return dest;
  }

  it("locks the untracked assets only, skipping dotfiles and the committed logo", () => {
    const lock: AssetLock = readLock(fixture());
    expect(Object.keys(lock.files)).toEqual(["public/game/actors/actors.bin", "public/game/world/minimap.png", "public/og.png"]);
    expect(lock.files["public/og.png"]).toEqual({ bytes: 4, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("agrees with the fixture's code", () => {
    const root = fixture();
    expect(codeProblems(root, readLock(root))).toEqual([]);
  });

  it("reports missing and changed files", () => {
    const root = fixture();
    fs.rmSync(path.join(root, "public/og.png"));
    fs.writeFileSync(path.join(root, "public/game/world/minimap.png"), "minimap 2");
    fs.writeFileSync(path.join(root, "public/game/world/extra.png"), "x");
    const cmp = compareWithLock(root, readLock(root));
    expect(cmp.missing).toEqual(["public/og.png"]);
    expect(cmp.changed.map((c) => c.path)).toEqual(["public/game/world/minimap.png"]);
    expect(cmp.unlocked).toEqual(["public/game/world/extra.png"]);
  });

  it("copies the locked files into the export when everything matches", () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, "public/game/world/extra.png"), "not locked");
    const dest = exportOf(root);
    expect(copyLockedAssets(root, dest)).toEqual([]);
    expect(fs.readFileSync(path.join(dest, "public/og.png"), "utf8")).toBe("card");
    expect(fs.existsSync(path.join(dest, "public/game/world/extra.png"))).toBe(false);
  });

  it("copies nothing when a file is missing or different", () => {
    const root = fixture();
    const dest = exportOf(root);
    fs.writeFileSync(path.join(root, "public/game/world/minimap.png"), "minimap 2");
    fs.rmSync(path.join(root, "public/og.png"));
    const problems = copyLockedAssets(root, dest);
    expect(problems).toEqual([
      "missing public/og.png",
      expect.stringMatching(/^different public\/game\/world\/minimap\.png: the lock has 7 bytes/),
    ]);
    expect(fs.existsSync(path.join(dest, "public/game/actors/actors.bin"))).toBe(false);
  });

  it("refuses an export whose code expects other assets", () => {
    const root = fixture();
    const dest = exportOf(root);
    fs.writeFileSync(path.join(dest, "index.html"), '<link rel="preload" href="/game/world/new.glb">');
    fs.writeFileSync(path.join(dest, "src/game/osrs/catalog.generated.ts"), 'export const ACTOR_DATA_HASH = "000000000000";\nexport const ACTOR_DATA_BYTES = 6;\n');
    fs.writeFileSync(path.join(dest, "shared/world-meta.json"), JSON.stringify({ cache: { name: "osrs-2_2000-02-01" } }));
    const problems = copyLockedAssets(root, dest);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/index\.html uses public\/game\/world\/new\.glb/);
    expect(problems[1]).toMatch(/catalog\.generated\.ts describes actors\.bin 000000000000/);
    expect(problems[2]).toMatch(/world-meta\.json was baked from cache osrs-2_2000-02-01/);
  });

  it("refuses a lock entry that git tracks", () => {
    const root = fixture();
    const dest = exportOf(root);
    fs.copyFileSync(path.join(root, "public/og.png"), path.join(dest, "public/og.png"));
    expect(copyLockedAssets(root, dest)).toEqual([`public/og.png is committed to git; the game assets must stay out of the repository`]);
  });

  it("names the lock it needs", () => {
    expect(() => readLock(os.tmpdir())).toThrow(new RegExp(LOCK_FILE.replace(/[./]/g, "\\$&")));
  });
});
