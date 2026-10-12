/**
 * The game assets RampRidge serves but keeps out of git, because they are
 * Jagex's: everything the bake decodes from the Old School RuneScape cache
 * into public/game (world model, sprites, sounds, fonts, actor data, coin
 * icons) and the link preview cards scripts/og captures from the running game.
 * scripts/bake/assets.lock.json records each file's size and SHA-256 and the
 * cache they were baked from, so a commit names the exact assets it ships.
 *
 *   bun scripts/assets.ts lock         rewrite the lock from the files on disk (keeps its cache)
 *   bun scripts/assets.ts verify       compare the files on disk with the lock
 *   bun scripts/assets.ts copy <dir>   for scripts/deploy.sh: check the lock in <dir> (a `git archive HEAD`
 *                                      export) against that export's code, then copy the locked files from
 *                                      this checkout into it; on any problem it copies nothing and exits 1
 *
 * `bun run bake` rewrites the lock. `bun run setup:assets` bakes a fresh clone
 * from the cache the lock pins and reports how its files compare.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCK_FILE = "scripts/bake/assets.lock.json";

/** Files under public/game that are RampRidge's own art (the Cinzel wordmark) and stay in git; see .gitignore. */
export const TRACKED_GAME_FILES: ReadonlySet<string> = new Set(["public/game/ui/logo.png", "public/game/ui/privy-logo.png"]);

/** Link preview images outside public/game: og-coins.png is baked, the rest are captured by scripts/og. */
export const PREVIEW_FILES: readonly string[] = ["public/og.png", "public/og-square.png", "public/og-bg.png", "public/og-coins.png"];

export interface LockedFile {
  bytes: number;
  sha256: string;
}

/** The archive.openrs2.org cache the assets were baked from. */
export interface LockedCache {
  openrs2: number;
  name: string;
  revision: number;
  timestamp: string;
  size: number;
}

export interface AssetLock {
  cache: LockedCache;
  files: Record<string, LockedFile>;
}

export interface Comparison {
  matched: string[];
  missing: string[];
  changed: { path: string; expected: LockedFile; actual: LockedFile }[];
  /** Asset files on disk that the lock does not list (never deployed). */
  unlocked: string[];
}

const LOCK_COMMENT = [
  "Game assets the site serves that are not in git (they are Jagex's): written by `bun run bake` and `bun run assets:lock`.",
  "scripts/deploy.sh copies exactly these files from the checkout and deploys nothing if one is missing or different.",
  "A fresh clone rebuilds them with `bun run setup:assets` from the cache below (scripts/bake/README.md); scripts/og captures og.png, og-square.png and og-bg.png.",
];

/** Whether a repository path is one of the untracked game assets. */
export function inAssetScope(file: string): boolean {
  return (file.startsWith("public/game/") && !TRACKED_GAME_FILES.has(file)) || PREVIEW_FILES.includes(file);
}

function walk(root: string, dir: string, out: string[]): void {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/** The untracked game assets present under `root`, sorted. */
export function listAssetFiles(root: string): string[] {
  const files: string[] = [];
  walk(root, "public/game", files);
  for (const file of PREVIEW_FILES) if (fs.existsSync(path.join(root, file))) files.push(file);
  return files.filter(inAssetScope).sort();
}

export function hashFile(file: string): LockedFile {
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function readLock(root: string): AssetLock {
  const file = path.join(root, LOCK_FILE);
  if (!fs.existsSync(file)) throw new Error(`${LOCK_FILE} is missing: \`bun run bake\` writes it.`);
  const lock = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AssetLock>;
  if (!lock.cache || typeof lock.cache.openrs2 !== "number" || !lock.cache.name || !lock.files) {
    throw new Error(`${LOCK_FILE} is malformed: it needs "cache" (with "openrs2" and "name") and "files".`);
  }
  return lock as AssetLock;
}

function serializeLock(lock: AssetLock): string {
  const paths = Object.keys(lock.files).sort();
  const files = paths.map((file, i) => {
    const f = lock.files[file]!;
    return `    ${JSON.stringify(file)}: { "bytes": ${f.bytes}, "sha256": "${f.sha256}" }${i < paths.length - 1 ? "," : ""}`;
  });
  const cache = (Object.keys(lock.cache) as (keyof LockedCache)[]).map((k) => `${JSON.stringify(k)}: ${JSON.stringify(lock.cache[k])}`);
  return [
    "{",
    '  "$comment": [',
    LOCK_COMMENT.map((line) => `    ${JSON.stringify(line)}`).join(",\n"),
    "  ],",
    `  "cache": { ${cache.join(", ")} },`,
    '  "files": {',
    ...files,
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Rewrites the lock from the asset files on disk. `cache` is the cache the
 * bake just used; without it the lock keeps the cache it already records.
 */
export function writeLock(root: string, cache?: LockedCache): { lock: AssetLock; added: string[]; removed: string[]; changed: string[] } {
  const previous = fs.existsSync(path.join(root, LOCK_FILE)) ? readLock(root) : null;
  const lockedCache = cache ?? previous?.cache;
  if (!lockedCache) throw new Error(`${LOCK_FILE} does not exist yet: run \`bun run bake\` to create it.`);
  const files: Record<string, LockedFile> = {};
  for (const file of listAssetFiles(root)) files[file] = hashFile(path.join(root, file));
  const lock: AssetLock = {
    cache: {
      openrs2: lockedCache.openrs2,
      name: lockedCache.name,
      revision: lockedCache.revision,
      timestamp: lockedCache.timestamp,
      size: lockedCache.size,
    },
    files,
  };
  const before = previous?.files ?? {};
  const added = Object.keys(files).filter((f) => !before[f]);
  const removed = Object.keys(before).filter((f) => !files[f]);
  const changed = Object.keys(files).filter((f) => before[f] && before[f].sha256 !== files[f]!.sha256);
  const text = serializeLock(lock);
  const target = path.join(root, LOCK_FILE);
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== text) fs.writeFileSync(target, text);
  return { lock, added, removed, changed };
}

export function compareWithLock(root: string, lock: AssetLock): Comparison {
  const result: Comparison = { matched: [], missing: [], changed: [], unlocked: [] };
  for (const [file, expected] of Object.entries(lock.files)) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) {
      result.missing.push(file);
      continue;
    }
    const actual = hashFile(abs);
    if (actual.sha256 === expected.sha256 && actual.bytes === expected.bytes) result.matched.push(file);
    else result.changed.push({ path: file, expected, actual });
  }
  result.unlocked = listAssetFiles(root).filter((f) => !lock.files[f]);
  return result;
}

/** Files whose asset references the deploy checks against the lock (what production loads by name). */
const REFERENCING_FILES = [
  "index.html",
  "public/manifest.webmanifest",
  "vercel.json",
  "src/styles/fonts.css",
  "api/_lib/shareCard.ts",
  "api/_lib/sharePage.ts",
];

/** `/game/...` and `og*.png` paths (relative to public/) in HTML, JSON, CSS or TS source. */
const ASSET_REFERENCE = /(?<![\w-])(game\/[\w./-]+?\.(?:png|ttf|glb|bin|wav|json|css)|og(?:-[a-z]+)?\.png)(?![\w.])/g;

/**
 * Where the code at `root` and the lock disagree: a referenced asset the lock
 * lacks, actor data other than catalog.generated.ts describes, a cache other
 * than the one shared/world-meta.json was baked from, or a lock entry outside
 * the untracked asset set. Empty when they agree. Needs no asset files.
 */
export function codeProblems(root: string, lock: AssetLock): string[] {
  const problems: string[] = [];
  const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

  for (const file of Object.keys(lock.files)) {
    if (!inAssetScope(file)) problems.push(`${LOCK_FILE} lists ${file}, which is not an untracked game asset`);
  }

  const referenced = new Map<string, string>();
  for (const source of REFERENCING_FILES) {
    for (const match of read(source).matchAll(ASSET_REFERENCE)) referenced.set(`public/${match[1]}`, source);
  }
  for (const match of read("src/ui/kit/spriteIds.ts").matchAll(/\bbake:\s*"([\w-]+)"/g)) {
    referenced.set(`public/game/sprites/${match[1]}.png`, "src/ui/kit/spriteIds.ts");
  }
  for (const [file, source] of referenced) {
    if (inAssetScope(file) ? !lock.files[file] : !fs.existsSync(path.join(root, file))) {
      problems.push(`${source} uses ${file}, which is neither in the repository nor in ${LOCK_FILE}`);
    }
  }

  const catalog = read("src/game/osrs/catalog.generated.ts");
  const hash = /ACTOR_DATA_HASH = "([0-9a-f]+)"/.exec(catalog)?.[1];
  const bytes = Number(/ACTOR_DATA_BYTES = (\d+)/.exec(catalog)?.[1]);
  const actors = lock.files["public/game/actors/actors.bin"];
  if (!hash || !bytes) problems.push("src/game/osrs/catalog.generated.ts has no ACTOR_DATA_HASH / ACTOR_DATA_BYTES");
  else if (!actors) problems.push(`${LOCK_FILE} has no public/game/actors/actors.bin`);
  else if (!actors.sha256.startsWith(hash) || actors.bytes !== bytes) {
    problems.push(
      `src/game/osrs/catalog.generated.ts describes actors.bin ${hash} (${bytes} bytes) but ${LOCK_FILE} has ${actors.sha256.slice(0, 12)} (${actors.bytes} bytes): bake again and commit both`,
    );
  }

  const meta = JSON.parse(read("shared/world-meta.json")) as { cache?: { name?: string } };
  if (meta.cache?.name !== lock.cache.name) {
    problems.push(`shared/world-meta.json was baked from cache ${meta.cache?.name ?? "(none)"} but ${LOCK_FILE} from ${lock.cache.name}: bake again and commit both`);
  }
  return problems;
}

function fileSummary(f: LockedFile): string {
  return `${f.bytes} bytes, sha256 ${f.sha256.slice(0, 12)}`;
}

/**
 * The deploy step: `dest` is a `git archive HEAD` export. Checks HEAD's lock
 * against HEAD's code and against the files in `root` (this checkout), then
 * copies the locked files into `dest`. Returns the problems; it copies only
 * when there are none.
 */
export function copyLockedAssets(root: string, dest: string): string[] {
  const lock = readLock(dest);
  const problems = codeProblems(dest, lock);
  for (const file of Object.keys(lock.files)) {
    if (fs.existsSync(path.join(dest, file))) problems.push(`${file} is committed to git; the game assets must stay out of the repository`);
  }
  const cmp = compareWithLock(root, lock);
  for (const file of cmp.missing) problems.push(`missing ${file}`);
  for (const c of cmp.changed) problems.push(`different ${c.path}: the lock has ${fileSummary(c.expected)}, this checkout ${fileSummary(c.actual)}`);
  if (problems.length > 0) return problems;

  for (const file of Object.keys(lock.files)) {
    fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dest, file));
  }
  const copied = compareWithLock(dest, lock);
  return [...copied.missing, ...copied.changed.map((c) => c.path)].map((file) => `copy of ${file} does not match the lock`);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function list(files: string[], limit = 12): string {
  const shown = files.slice(0, limit).map((f) => `  ${f}`);
  if (files.length > limit) shown.push(`  ... and ${files.length - limit} more`);
  return shown.join("\n");
}

function main(): number {
  const [command, arg] = process.argv.slice(2);
  if (command === "lock") {
    const { lock, added, removed, changed } = writeLock(REPO_ROOT);
    console.log(`${LOCK_FILE}: ${Object.keys(lock.files).length} files (cache ${lock.cache.name}); ${added.length} added, ${removed.length} removed, ${changed.length} changed`);
    if (removed.length > 0) console.log(`Removed (no longer on disk):\n${list(removed)}`);
    const problems = codeProblems(REPO_ROOT, lock);
    if (problems.length > 0) {
      console.error(`The code does not match the new lock:\n${list(problems, 50)}`);
      return 1;
    }
    return 0;
  }
  if (command === "verify") {
    const lock = readLock(REPO_ROOT);
    const cmp = compareWithLock(REPO_ROOT, lock);
    const total = Object.keys(lock.files).length;
    console.log(`${cmp.matched.length} of ${total} locked game assets match ${LOCK_FILE} (cache ${lock.cache.name}).`);
    if (cmp.missing.length > 0) console.log(`Missing:\n${list(cmp.missing)}`);
    if (cmp.changed.length > 0) console.log(`Different:\n${list(cmp.changed.map((c) => c.path))}`);
    if (cmp.unlocked.length > 0) console.log(`On disk but not locked (not deployed):\n${list(cmp.unlocked)}`);
    return cmp.missing.length + cmp.changed.length > 0 ? 1 : 0;
  }
  if (command === "copy" && arg) {
    const dest = path.resolve(arg);
    const problems = copyLockedAssets(REPO_ROOT, dest);
    if (problems.length > 0) {
      console.error(
        [
          `Not deploying: the game assets in this checkout do not match what HEAD expects (${LOCK_FILE}).`,
          list(problems, 40),
          "Rebuild them with `bun run bake` (`bun run setup:assets` on a new machine) and capture the link previews with scripts/og.",
          "If the files on disk are the ones to ship, run `bun run assets:lock` and commit the lock.",
        ].join("\n"),
      );
      return 1;
    }
    console.log(`Copied ${Object.keys(readLock(dest).files).length} game assets into the deploy (all match ${LOCK_FILE}).`);
    return 0;
  }
  console.error("usage: bun scripts/assets.ts lock | verify | copy <export-dir>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
