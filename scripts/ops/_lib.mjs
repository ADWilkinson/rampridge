/**
 * Shared plumbing for the launch-day ops scripts: argument parsing, server
 * env from .env.local (never printed), the Admin SDK database, and output
 * helpers. Plain ESM so `node scripts/ops/<script>.mjs` and `bun` both run
 * them without a build.
 *
 * Database target: the LIVE rampridge-world instance with the service
 * account from .env.local, unless FIREBASE_DATABASE_EMULATOR_HOST is set in
 * the shell (for example 127.0.0.1:9000), which uses the emulator and no
 * credentials. Every script prints its target first.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATABASE_URL = "https://rampridge-world.firebaseio.com";
export const SITE = "https://www.rampridge.xyz";
/** The Vercel team that owns the project (VERCEL_SCOPE), or null to use the linked project's (`vercel link`). */
export const VERCEL_SCOPE = process.env.VERCEL_SCOPE?.trim() || null;
export const VERCEL_PROJECT = "rampridge";
/** `--scope <team>` for a Vercel CLI call, when VERCEL_SCOPE is set. */
export const vercelScopeArgs = () => (VERCEL_SCOPE ? ["--scope", VERCEL_SCOPE] : []);
/** shared/protocol.ts PLAYER_TIMEOUT_MS: players silent this long are pruned. */
export const PLAYER_TIMEOUT_MS = 60_000;

/** shared/worlds.ts: world numbers 301..320, three open of 200 players unless `meta/worlds` and `meta/worldCap` say otherwise. */
export const FIRST_WORLD = 301;
export const MAX_WORLDS = 20;
export const DEFAULT_OPEN_WORLDS = 3;
export const DEFAULT_WORLD_CAP = 200;
/** Every world a record can be in. */
export const WORLD_IDS = Array.from({ length: MAX_WORLDS }, (_, i) => FIRST_WORLD + i);
export const playerPath = (world, pid) => `worlds/${world}/players/${pid}`;

const positiveInt = (v) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);

/**
 * The operator's world settings and counts: { open: [301, ...], cap, roomCap,
 * pop: Map(world -> soft count) }, as api/_lib/worlds.ts reads them.
 */
export async function worldSettings(db) {
  const [worlds, cap, roomCap, pops] = await Promise.all([
    read(db, "meta/worlds"),
    read(db, "meta/worldCap"),
    read(db, "meta/roomCap"),
    read(db, "meta/worldPop"),
  ]);
  const count = Math.min(positiveInt(worlds) ?? DEFAULT_OPEN_WORLDS, MAX_WORLDS);
  const pop = new Map();
  for (const [id, value] of Object.entries(pops ?? {})) if (typeof value?.n === "number") pop.set(Number(id), value.n);
  return { open: WORLD_IDS.slice(0, count), cap: positiveInt(cap) ?? DEFAULT_WORLD_CAP, roomCap: positiveInt(roomCap), pop };
}

/** Open worlds plus any closed one that still has a count: where players can be. */
export function liveWorlds(settings) {
  return [...new Set([...settings.open, ...settings.pop.keys()])].sort((a, b) => a - b);
}

/** Where `pid` stands: { world, record } in the first world that has them, or null. */
export async function findPresence(db, pid) {
  const records = await Promise.all(WORLD_IDS.map((world) => read(db, playerPath(world, pid))));
  const index = records.findIndex((r) => r !== null);
  return index < 0 ? null : { world: WORLD_IDS[index], record: records[index] };
}

/** A multi-path update that removes `pid` from every world (and their presence and stall index entry). */
export function kickUpdates(pid) {
  const updates = { [`stalls/${pid}`]: null, [`presence/${pid}`]: null };
  for (const world of WORLD_IDS) updates[playerPath(world, pid)] = null;
  return updates;
}

/**
 * Minimal flag parser: `--name value`, `--flag` (true), `--name=value`, and
 * positionals. Values that look like flags are not consumed.
 */
export function parseArgs(argv = process.argv.slice(2), booleans = []) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (booleans.includes(name) || next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { flags, positionals };
}

export function numberFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const value = Number(flags[name]);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a non-negative number.`);
  return value;
}

let fileEnv = null;

/** A server variable from the shell, else .env.local (`vercel env pull .env.local`). Never logged. */
export function serverEnv(name) {
  const fromShell = process.env[name]?.trim();
  if (fromShell) return fromShell;
  if (fileEnv === null) {
    const file = path.join(ROOT, ".env.local");
    fileEnv = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  }
  const value = fileEnv[name]?.trim();
  return value ? value : null;
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Opens the database. Returns { db, target, live, close }. The Admin SDK is
 * imported lazily so scripts that only need HTTP do not pay for it.
 */
export async function openDatabase() {
  const { cert, initializeApp } = await import("firebase-admin/app");
  const { getDatabase } = await import("firebase-admin/database");
  const emulator = process.env.FIREBASE_DATABASE_EMULATOR_HOST?.trim();
  let options;
  if (emulator) {
    options = { databaseURL: DATABASE_URL, projectId: "peerlyticsapp" };
  } else {
    const raw = serverEnv("FIREBASE_SERVICE_ACCOUNT");
    if (!raw) fail("FIREBASE_SERVICE_ACCOUNT is not set (run `vercel env pull .env.local` in the repo, or set it in the shell).");
    let sa;
    try {
      sa = JSON.parse(raw);
    } catch {
      fail("FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
    }
    options = {
      credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }),
      databaseURL: DATABASE_URL,
    };
  }
  const app = initializeApp(options, `rampridge-ops-${process.pid}`);
  const db = getDatabase(app);
  return {
    db,
    live: !emulator,
    target: emulator ? `emulator ${emulator}` : "LIVE rampridge-world",
    close: () => app.delete(),
  };
}

export async function read(db, refPath) {
  const snap = await db.ref(refPath).get();
  return snap.exists() ? snap.val() : null;
}

/** UTC calendar day, yyyy-mm-dd (the same keys api/_lib/log.ts writes). */
export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function hhmmss(ms) {
  return new Date(ms).toISOString().slice(11, 19);
}

export function ago(ms, now = Date.now()) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 90 * 60) return `${Math.round(s / 60)}m ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-GB") : "-");

export function pct(part, whole) {
  if (!whole || typeof part !== "number") return "";
  return `${Math.round((part / whole) * 100)}%`;
}

/** shared/chat.ts nameKey: case- and separator-insensitive. */
export function nameKey(name) {
  return name.toLowerCase().replace(/[ _-]+/g, "_");
}

export const PID_PATTERN = /^[0-9a-z]{16}$/;

/**
 * Resolves a pid or a display name to { pid, profile }. Names go through
 * names/{key}; a 16-character base36 string with a profile is taken as a pid.
 */
export async function resolvePlayer(db, who) {
  if (PID_PATTERN.test(who)) {
    const profile = await read(db, `profiles/${who}`);
    if (profile) return { pid: who, profile };
  }
  const pid = await read(db, `names/${nameKey(who.trim())}`);
  if (typeof pid !== "string") return null;
  return { pid, profile: await read(db, `profiles/${pid}`) };
}

export function printTarget(target, extra = "") {
  console.log(`Database: ${target}${extra ? `  ${extra}` : ""}`);
}

// ---------------------------------------------------------------------------
// Moderation buckets, enforced by today's /api/act rate limiter
// (api/_lib/ratelimit.ts). scripts/ops/moderation.test.ts pins these against
// the real takeAction and the cron prune.

/** api/_lib/ratelimit.ts ACTION_BUCKET.capacity. */
export const ACTION_CAPACITY = 10;
/**
 * A drained action bucket: refused with a retry-after of about 3.9 days,
 * under setTimeout's 24.8-day ceiling so clients back off instead of spinning.
 */
export const BANNED_TOKENS = -1_000_000;

/**
 * `ratelimits/act/{pid}` with the chat clock pushed to `until`: chat is
 * refused, everything else spends tokens as usual. A recent bucket keeps its
 * tokens; an old or missing one starts full.
 */
export function mutedBucket(current, until, now) {
  const live = current && typeof current.b === "number" && typeof current.u === "number" && current.u > now - 5 * 60_000;
  const base = live ? current : { b: ACTION_CAPACITY, u: now };
  return { ...base, cl: Math.max(until, typeof current?.cl === "number" ? current.cl : 0) };
}

/** Every action refused; `u` in the future keeps the cron from pruning it until about ten minutes after `until`. */
export function bannedBucket(until) {
  return { b: BANNED_TOKENS, u: until };
}

