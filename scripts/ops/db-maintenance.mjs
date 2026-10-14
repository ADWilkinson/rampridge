#!/usr/bin/env node
/**
 * Database housekeeping the cron does not do: old telemetry, test players and
 * stale guest profiles. Always prints an inventory first. A dry run unless
 * --apply is given; deletes go out in batches of 500 paths.
 *
 *   node scripts/ops/db-maintenance.mjs                          # inventory + default plan
 *   node scripts/ops/db-maintenance.mjs --name-pattern '^(qa|test|e2e)'   # find test players by name
 *   node scripts/ops/db-maintenance.mjs --pid abc...,def...      # remove these players entirely
 *   node scripts/ops/db-maintenance.mjs --stale-guests 30        # Guest#### profiles idle 30+ days, no wallet
 *   node scripts/ops/db-maintenance.mjs --orphans                # names and stall entries pointing at nobody
 *   node scripts/ops/db-maintenance.mjs --legacy                 # the single room from before worlds
 *   node scripts/ops/db-maintenance.mjs --keep-errors-days 14 --keep-metrics-days 0 --apply
 *
 * Removing a player deletes profiles/{pid}, their names/{key} claim, their
 * record in every world and presence/{pid}, stall index entry, chat lines and announcements in
 * every world, nonce, rate-limit buckets and moderation record. Share pages
 * (shares/{id}) are left alone: they are public links to real on-chain
 * trades. A removed player who comes back gets a profile rebuilt from their
 * session token.
 *
 * --legacy deletes what the single room left behind once worlds shipped:
 * `world/` (players, chat, events), `meta/room` and `meta/chatWindow`. Run it
 * once after the worlds deploy; nothing reads them any more.
 */

import { ago, fmt, numberFlag, openDatabase, parseArgs, PLAYER_TIMEOUT_MS, printTarget, read, WORLD_IDS } from "./_lib.mjs";

const BATCH = 500;
const DAY = 86_400_000;

const { flags } = parseArgs(process.argv.slice(2), ["apply", "orphans", "legacy"]);
const apply = flags.apply === true;
const keepErrorsDays = numberFlag(flags, "keep-errors-days", 14);
/** 0 keeps metrics forever (they are a few numbers a day). */
const keepMetricsDays = numberFlag(flags, "keep-metrics-days", 0);
const staleGuestDays = flags["stale-guests"] === undefined ? null : numberFlag(flags, "stale-guests", 30);
const pidList = typeof flags.pid === "string" ? flags.pid.split(",").map((p) => p.trim()).filter(Boolean) : [];
let namePattern = null;
if (typeof flags["name-pattern"] === "string") {
  try {
    namePattern = new RegExp(flags["name-pattern"], "i");
  } catch {
    console.error("--name-pattern is not a valid regular expression.");
    process.exit(1);
  }
}

const { db, target, live, close } = await openDatabase();
printTarget(target, apply ? "(APPLYING CHANGES)" : "(dry run: add --apply to delete)");

/** A node's children (downloaded whole: fine at launch scale; the Admin SDK has no shallow read). */
async function children(path) {
  return (await read(db, path)) ?? {};
}

async function removeAll(paths, label) {
  if (paths.length === 0) return;
  console.log(`  ${apply ? "Deleting" : "Would delete"} ${fmt(paths.length)} ${label}`);
  if (!apply) return;
  for (let i = 0; i < paths.length; i += BATCH) {
    const updates = {};
    for (const p of paths.slice(i, i + BATCH)) updates[p] = null;
    await db.ref().update(updates);
  }
}

try {
  const now = Date.now();

  // Inventory. Players, chat and events are per world (worlds/{id}/...); keys here are "{world}/{key}".
  const [profiles, names, worldNodes, legacyWorld, ops, stalls, shares, moderation] = await Promise.all([
    children("profiles"),
    children("names"),
    Promise.all(WORLD_IDS.map((world) => read(db, `worlds/${world}`))),
    read(db, "world"),
    children("ops"),
    children("stalls"),
    children("shares"),
    children("moderation"),
  ]);
  const players = {};
  const chat = {};
  const events = {};
  WORLD_IDS.forEach((world, i) => {
    const node = worldNodes[i] ?? {};
    for (const [pid, value] of Object.entries(node.players ?? {})) players[pid] = { ...value, world };
    for (const [key, value] of Object.entries(node.chat ?? {})) chat[`${world}/${key}`] = value;
    for (const [key, value] of Object.entries(node.events ?? {})) events[`${world}/${key}`] = value;
  });
  const count = (o) => Object.keys(o ?? {}).length;
  const online = Object.values(players).filter((p) => typeof p?.ls === "number" && now - p.ls <= PLAYER_TIMEOUT_MS).length;
  const worldsWithData = worldNodes.filter(Boolean).length;
  console.log("");
  console.log("Inventory");
  console.log(`  profiles ${fmt(count(profiles))}  names ${fmt(count(names))}  players ${fmt(count(players))} (${online} online) in ${worldsWithData} world(s)`);
  console.log(`  chat ${fmt(count(chat))}  events ${fmt(count(events))} (one per world each)  stalls ${fmt(count(stalls))}  shares ${fmt(count(shares))}  moderation ${fmt(count(moderation))}`);
  if (legacyWorld) console.log("  legacy single room (world/) still present: --legacy deletes it");
  console.log(
    `  ops: metrics ${count(ops.metrics)} day(s), agents ${count(ops.agents)} day(s), errors ${count(ops.errors)} day(s) (${fmt(
      Object.values(ops.errors ?? {}).reduce((sum, day) => sum + count(day), 0),
    )} records)`,
  );

  // 1. Old telemetry.
  console.log("");
  console.log(`Telemetry (errors kept ${keepErrorsDays} days, metrics ${keepMetricsDays ? `${keepMetricsDays} days` : "forever"})`);
  const dayOlderThan = (days) => (day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Date.parse(`${day}T00:00:00Z`) < now - days * DAY;
  const oldErrorDays = Object.keys(ops.errors ?? {}).filter(dayOlderThan(keepErrorsDays));
  const oldCountDays = Object.keys(ops.errorCount ?? {}).filter(dayOlderThan(keepErrorsDays));
  await removeAll([...oldErrorDays.map((d) => `ops/errors/${d}`), ...oldCountDays.map((d) => `ops/errorCount/${d}`)], "old error day(s)");
  if (keepMetricsDays > 0) {
    const old = dayOlderThan(keepMetricsDays);
    const paths = [
      ...Object.keys(ops.metrics ?? {}).filter(old).map((d) => `ops/metrics/${d}`),
      ...Object.keys(ops.agents ?? {}).filter(old).map((d) => `ops/agents/${d}`),
      ...Object.keys(ops.referrers ?? {}).filter(old).map((d) => `ops/referrers/${d}`),
    ];
    await removeAll(paths, "old metric day(s)");
  }
  if (!oldErrorDays.length && !oldCountDays.length) console.log("  nothing to prune");

  // 2. Players selected by pid or name.
  const selected = new Map();
  for (const pid of pidList) selected.set(pid, profiles[pid] ?? null);
  if (namePattern) {
    for (const [pid, profile] of Object.entries(profiles)) {
      if (typeof profile?.n === "string" && namePattern.test(profile.n)) selected.set(pid, profile);
    }
  }

  // 3. Stale guests: never named, never linked a wallet, not around, untouched for N days.
  if (staleGuestDays !== null) {
    const cutoff = now - staleGuestDays * DAY;
    let n = 0;
    for (const [pid, profile] of Object.entries(profiles)) {
      if (selected.has(pid)) continue;
      const guest = typeof profile?.n === "string" && /^Guest\d{4,6}$/.test(profile.n);
      const idle = typeof profile?.u === "number" ? profile.u < cutoff : true;
      if (guest && !profile.w && idle && !players[pid] && !stalls[pid]) {
        selected.set(pid, profile);
        n += 1;
      }
    }
    console.log("");
    console.log(`Stale guests (Guest#### with no wallet, idle ${staleGuestDays}+ days): ${fmt(n)}`);
  }

  if (selected.size > 0) {
    console.log("");
    console.log(`Players to remove: ${fmt(selected.size)}`);
    const shown = [...selected.entries()].slice(0, 25);
    for (const [pid, profile] of shown) {
      const wallet = profile?.w ? "wallet" : "no wallet";
      console.log(`  ${pid}  ${String(profile?.n ?? "(no profile)").padEnd(12)}  created ${ago(profile?.c, now)}, ${wallet}${players[pid] ? ", in the room" : ""}`);
    }
    if (selected.size > shown.length) console.log(`  ... and ${fmt(selected.size - shown.length)} more`);
    const withWallet = [...selected.values()].filter((p) => p?.w).length;
    if (withWallet && live) console.log(`  NOTE: ${withWallet} of these linked a wallet; check they are really test players.`);

    const pids = new Set(selected.keys());
    const paths = [];
    for (const pid of pids) {
      const profile = selected.get(pid);
      paths.push(`profiles/${pid}`, `stalls/${pid}`, `presence/${pid}`, `nonces/${pid}`, `moderation/${pid}`);
      if (players[pid]) paths.push(`worlds/${players[pid].world}/players/${pid}`);
      paths.push(`ratelimits/act/${pid}`, `ratelimits/chain/${pid}`);
      if (typeof profile?.k === "string" && names[profile.k] === pid) paths.push(`names/${profile.k}`);
    }
    // Name claims held by these pids under keys their profile no longer lists.
    for (const [key, owner] of Object.entries(names)) {
      if (pids.has(owner) && !paths.includes(`names/${key}`)) paths.push(`names/${key}`);
    }
    for (const [key, line] of Object.entries(chat)) if (pids.has(line?.pid)) paths.push(`worlds/${key.replace("/", "/chat/")}`);
    for (const [key, event] of Object.entries(events)) if (pids.has(event?.pid)) paths.push(`worlds/${key.replace("/", "/events/")}`);
    await removeAll(paths, "path(s) belonging to them");
  }

  // 4. Orphans.
  if (flags.orphans) {
    console.log("");
    console.log("Orphans");
    const orphanNames = Object.entries(names)
      .filter(([, owner]) => typeof owner !== "string" || !profiles[owner])
      .map(([key]) => `names/${key}`);
    const orphanStalls = Object.keys(stalls)
      .filter((pid) => !players[pid])
      .map((pid) => `stalls/${pid}`);
    await removeAll(orphanNames, "name claim(s) with no profile");
    await removeAll(orphanStalls, "stall index entr(y/ies) with no player (the hourly sweep also drops these)");
    if (!orphanNames.length && !orphanStalls.length) console.log("  none");
  }

  // 5. The single room from before worlds.
  if (flags.legacy) {
    console.log("");
    console.log("Legacy single room");
    const legacy = [];
    if (legacyWorld) legacy.push("world");
    for (const path of ["meta/room", "meta/chatWindow"]) if ((await read(db, path)) !== null) legacy.push(path);
    if (legacy.length) {
      console.log(`  ${legacy.join(", ")}`);
      await removeAll(legacy, "legacy path(s)");
    } else {
      console.log("  none");
    }
  }

  console.log("");
  console.log(apply ? "Done." : "Dry run only. Re-run with --apply to delete the above.");
} finally {
  await close();
}
process.exit(0);
