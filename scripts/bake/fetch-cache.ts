/**
 * Downloads an Old School cache from archive.openrs2.org into
 * .cache/osrs/caches/<name>/ and registers it in caches.json (the format
 * rs-map-viewer's CacheInfo expects, plus its openrs2 id). The bake uses the
 * newest registered cache.
 *
 *   cd scripts/bake && bun run fetch-cache      # the cache assets.lock.json pins (production's)
 *   bun run fetch-cache -- --latest             # the newest live cache, to update the game data
 *   bun run fetch-cache -- --id=2735            # a specific openrs2 cache id
 *
 * A cache already on disk is registered without downloading it again. Needs
 * `unzip` on PATH. OPENRS2_URL overrides https://archive.openrs2.org.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { type LockedCache, readLock } from "../assets";
import { CACHE_DIR, REPO_DIR } from "./lib/paths";

const ARCHIVE = (process.env.OPENRS2_URL ?? "https://archive.openrs2.org").replace(/\/+$/, "");
/** openrs2's scope for Jagex's games. */
const SCOPE = "runescape";
/** Abort a download that receives nothing for this long. */
const IDLE_MS = 60_000;

interface OpenRs2Cache {
  id: number;
  scope: string;
  game: string;
  environment: string;
  language: string;
  builds: { major: number; minor: number | null }[];
  timestamp: string | null;
  size: number;
}

/** A caches.json entry: rs-map-viewer's CacheInfo plus the openrs2 id it came from. */
export interface CacheEntry {
  name: string;
  game: "oldschool";
  environment: string;
  revision: number;
  timestamp: string;
  size: number;
  openrs2Id?: number;
}

export type CacheTarget = { kind: "pinned" } | { kind: "latest" } | { kind: "id"; id: number };

/** A path for messages: relative inside the repository, absolute outside it (RAMPRIDGE_OSRS_CACHE_DIR). */
function shown(file: string): string {
  const rel = path.relative(REPO_DIR, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: string; message?: string } | undefined;
  return cause?.code ?? cause?.message ?? err.message;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(IDLE_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function resolveTarget(target: CacheTarget): Promise<LockedCache> {
  if (target.kind === "pinned") return readLock(REPO_DIR).cache;
  let list: OpenRs2Cache[];
  try {
    list = await getJson<OpenRs2Cache[]>(`${ARCHIVE}/caches.json`);
  } catch (err) {
    throw new Error(`Couldn't read the cache list at ${ARCHIVE}/caches.json (${reason(err)}). ${new URL(ARCHIVE).host} may be down: try again later.`);
  }
  const candidates = list
    .filter((c) => c.game === "oldschool" && c.environment === "live" && c.language === "en" && c.timestamp && c.builds.length > 0)
    .sort((a, b) => Date.parse(a.timestamp!) - Date.parse(b.timestamp!));
  const pick = target.kind === "id" ? candidates.find((c) => c.id === target.id) : candidates.at(-1);
  if (!pick) throw new Error(target.kind === "id" ? `openrs2 has no live English oldschool cache ${target.id}` : "no live oldschool cache on archive.openrs2.org");
  const revision = Math.max(...pick.builds.map((b) => b.major));
  return { openrs2: pick.id, name: `osrs-${revision}_${pick.timestamp!.slice(0, 10)}`, revision, timestamp: pick.timestamp!, size: pick.size };
}

/** Streams `url` to `file`, logging progress; throws on HTTP errors and on a stall longer than IDLE_MS. */
async function download(url: string, file: string): Promise<void> {
  const abort = new AbortController();
  let idle = setTimeout(() => abort.abort(new Error(`no data for ${IDLE_MS / 1000} s`)), IDLE_MS);
  try {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    let received = 0;
    let reported = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _enc, done) {
        clearTimeout(idle);
        idle = setTimeout(() => abort.abort(new Error(`no data for ${IDLE_MS / 1000} s`)), IDLE_MS);
        received += chunk.length;
        const step = total ? Math.floor((received / total) * 10) : Math.floor(received / 20e6);
        if (step > reported) {
          reported = step;
          console.log(total ? `  ${step * 10}% (${(received / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB)` : `  ${(received / 1e6).toFixed(0)} MB`);
        }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), progress, fs.createWriteStream(file));
  } finally {
    clearTimeout(idle);
  }
}

/** Downloads (unless present) and registers a cache; returns its caches.json entry. */
export async function fetchCache(target: CacheTarget): Promise<CacheEntry> {
  const pick = await resolveTarget(target);
  const dir = path.join(CACHE_DIR, pick.name);
  const where = shown(dir);
  const zipUrl = `${ARCHIVE}/caches/${SCOPE}/${pick.openrs2}/disk.zip`;
  const keysUrl = `${ARCHIVE}/caches/${SCOPE}/${pick.openrs2}/keys.json`;
  console.log(`OSRS cache ${pick.name} (build ${pick.revision}, openrs2 ${pick.openrs2}) -> ${where}`);

  if (fs.existsSync(path.join(dir, "main_file_cache.dat2"))) {
    console.log("  already on disk");
  } else {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const work = fs.mkdtempSync(path.join(CACHE_DIR, `.download-${pick.openrs2}-`));
    try {
      const zip = path.join(work, "disk.zip");
      console.log(`  downloading ${zipUrl} (about ${(pick.size / 1e6).toFixed(0)} MB)`);
      try {
        await download(zipUrl, zip);
      } catch (err) {
        throw new Error(
          [
            `Couldn't download the OSRS cache from ${zipUrl} (${reason(err)}).`,
            `${new URL(ARCHIVE).host} may be down or busy: try again later. To install it by hand, download that disk.zip,`,
            `unzip its cache/main_file_cache.* files into ${where}/, save ${keysUrl} beside them as keys.json`,
            "and run the command again.",
          ].join("\n"),
        );
      }
      // disk.zip holds cache/main_file_cache.*; flatten them into the cache directory.
      const r = spawnSync("unzip", ["-q", "-o", "-j", zip, "cache/*", "-d", path.join(work, "cache")], { stdio: "inherit" });
      if (r.error) throw new Error(`unzip failed (${r.error.message}); install unzip and run again`);
      if (r.status !== 0) throw new Error(`unzip exited with ${r.status}; ${zipUrl} may be damaged, run again`);
      if (!fs.existsSync(path.join(work, "cache/main_file_cache.dat2"))) throw new Error(`${zipUrl} has no cache/main_file_cache.dat2`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(path.join(work, "cache"), dir);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  const keysFile = path.join(dir, "keys.json");
  if (!fs.existsSync(keysFile)) {
    try {
      const res = await fetch(keysUrl, { signal: AbortSignal.timeout(IDLE_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(keysFile, await res.text());
    } catch (err) {
      throw new Error(`Couldn't download the map keys from ${keysUrl} (${reason(err)}). Save that file as ${shown(keysFile)} and run again.`);
    }
  }

  const infoFile = path.join(CACHE_DIR, "caches.json");
  const infos: CacheEntry[] = fs.existsSync(infoFile) ? (JSON.parse(fs.readFileSync(infoFile, "utf8")) as CacheEntry[]) : [];
  const entry: CacheEntry = {
    name: pick.name,
    game: "oldschool",
    environment: "live",
    revision: pick.revision,
    timestamp: pick.timestamp,
    size: pick.size,
    openrs2Id: pick.openrs2,
  };
  fs.writeFileSync(infoFile, JSON.stringify([...infos.filter((c) => c.name !== pick.name), entry]));
  console.log(`  registered in ${shown(infoFile)}`);
  return entry;
}

function parseTarget(argv: string[]): CacheTarget {
  const id = argv.find((a) => a.startsWith("--id="));
  if (id) {
    const n = Number(id.slice(5));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`bad --id: ${id}`);
    return { kind: "id", id: n };
  }
  return argv.includes("--latest") ? { kind: "latest" } : { kind: "pinned" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => fetchCache(parseTarget(process.argv.slice(2))))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
