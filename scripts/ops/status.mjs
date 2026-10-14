#!/usr/bin/env node
/**
 * Launch-day status in one screen: which deployment is live, /api/health,
 * players online in each world against its cap, today's funnel (UTC) against
 * yesterday, browser mix, and the latest client errors. Read-only.
 *
 *   node scripts/ops/status.mjs                 # once
 *   node scripts/ops/status.mjs --watch 30      # refresh every 30 s
 *   node scripts/ops/status.mjs --errors 50 --no-vercel --site http://localhost:5173
 *   node scripts/ops/status.mjs --json          # machine-readable
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ago,
  dayKey,
  fmt,
  hhmmss,
  numberFlag,
  openDatabase,
  parseArgs,
  pct,
  liveWorlds,
  PLAYER_TIMEOUT_MS,
  read,
  ROOT,
  SITE,
  VERCEL_PROJECT,
  vercelScopeArgs,
  worldSettings,
} from "./_lib.mjs";

const run = promisify(execFile);
const { flags } = parseArgs(process.argv.slice(2), ["json", "no-vercel"]);
const site = String(flags.site ?? SITE).replace(/\/+$/, "");
const errorLimit = numberFlag(flags, "errors", 20);
const watchSeconds = numberFlag(flags, "watch", 0);

/** Funnel rows: event, and the step its conversion is measured against. */
const FUNNEL = [
  ["page_view", null],
  ["play", "page_view"],
  ["design_done", "play"],
  ["login", "play"],
  ["quote", "play"],
  ["signal_ok", "quote"],
  ["signal_fail", "quote"],
  ["verify_start", "signal_ok"],
  ["fulfil_ok", "verify_start"],
  ["fulfil_fail", "verify_start"],
  ["sell_start", "play"],
  ["deposit_ok", "sell_start"],
  ["deposit_fail", "sell_start"],
  ["share_click", "play"],
  ["practice_start", "play"],
  ["practice_done", "practice_start"],
  ["send_ok", "login"],
  ["send_fail", "login"],
  ["send_unconfirmed", "login"],
  ["gas_fail", null],
  ["client_error", null],
];

async function health() {
  const started = Date.now();
  try {
    const response = await fetch(`${site}/api/health`, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
    const body = await response.json().catch(() => null);
    return { status: response.status, ms: Date.now() - started, body };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, error: err instanceof Error ? err.name : "error" };
  }
}

let vercelCache = { at: 0, value: null };

/** The deployment www.rampridge.xyz points at, via the Vercel CLI (cached 5 minutes in watch mode). */
async function servingDeployment() {
  if (flags["no-vercel"]) return null;
  if (vercelCache.value && Date.now() - vercelCache.at < 5 * 60_000) return vercelCache.value;
  const options = { cwd: ROOT, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 };
  let value;
  try {
    const { stdout } = await run("vercel", ["inspect", "www.rampridge.xyz", ...vercelScopeArgs(), "--format=json"], options);
    const json = JSON.parse(stdout);
    value = { id: json.id ?? json.uid ?? null, url: json.url ?? null, createdAt: json.createdAt ?? json.created ?? null, via: "inspect" };
  } catch {
    try {
      const { stdout } = await run(
        "vercel",
        ["ls", VERCEL_PROJECT, "--environment", "production", "--format", "json", ...vercelScopeArgs()],
        options,
      );
      const latest = JSON.parse(stdout).deployments?.[0];
      value = latest ? { id: null, url: latest.url, createdAt: latest.createdAt, via: "ls (latest, may not be the aliased one)" } : null;
    } catch (err) {
      value = { error: err instanceof Error ? err.message.split("\n")[0] : "vercel CLI failed" };
    }
  }
  vercelCache = { at: Date.now(), value };
  return value;
}

async function snapshot() {
  const { db, target, close } = await openDatabase();
  const warnings = [];
  /** One failed read shows as a warning instead of hiding the rest of the screen. */
  const safe = (label, promise) =>
    promise.catch((err) => {
      warnings.push(`${label}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      return null;
    });
  try {
    const now = Date.now();
    const today = dayKey(now);
    const yesterday = dayKey(now - 86_400_000);
    const settings = await safe("worlds", worldSettings(db));
    const worlds = settings ? liveWorlds(settings) : [];
    /** Per world: [players, chat lines in 10 min, event keys in the last hour]. */
    const perWorld = (world) =>
      Promise.all([
        read(db, `worlds/${world}/players`),
        db.ref(`worlds/${world}/chat`).orderByChild("t").startAt(now - 10 * 60_000).get().then((s) => s.numChildren()),
        db.ref(`worlds/${world}/events`).orderByChild("t").startAt(now - 60 * 60_000).get().then((s) => Object.keys(s.val() ?? {})),
      ]);
    const [healthResult, deployment, worldReads, stalls, metricsToday, metricsYesterday, agents, referrers, errorCount, errorsToday, errorsYesterday, moderation] =
      await Promise.all([
        health(),
        servingDeployment(),
        safe("worlds", Promise.all(worlds.map(perWorld))),
        safe("stalls", read(db, "stalls")),
        safe("metrics", read(db, `ops/metrics/${today}`)),
        safe("metrics", read(db, `ops/metrics/${yesterday}`)),
        safe("agents", read(db, `ops/agents/${today}`)),
        safe("referrers", read(db, `ops/referrers/${today}`)),
        safe("errors", read(db, `ops/errorCount/${today}`)),
        safe("errors", db.ref(`ops/errors/${today}`).orderByKey().limitToLast(errorLimit).get().then((s) => s.val())),
        safe("errors", db.ref(`ops/errors/${yesterday}`).orderByKey().limitToLast(errorLimit).get().then((s) => s.val())),
        safe("moderation", read(db, "moderation")),
      ]);
    const byWorld = worlds.map((id, i) => {
      const records = Object.values(worldReads?.[i]?.[0] ?? {});
      const online = records.filter((p) => typeof p?.ls === "number" && now - p.ls <= PLAYER_TIMEOUT_MS).length;
      return { id, online, listed: records.length, counted: settings?.pop.get(id) ?? null, open: settings?.open.includes(id) ?? false };
    });
    const online = byWorld.reduce((sum, w) => sum + w.online, 0);
    const listed = byWorld.reduce((sum, w) => sum + w.listed, 0);
    const chatRecent = worldReads ? worldReads.reduce((sum, r) => sum + r[1], 0) : null;
    // World news is written to every world under one key: count each once.
    const eventsRecent = worldReads ? new Set(worldReads.flatMap((r) => r[2])).size : null;
    const errors = [...Object.values(errorsYesterday ?? {}), ...Object.values(errorsToday ?? {})]
      .filter((e) => e && typeof e.t === "number")
      .sort((a, b) => a.t - b.t)
      .slice(-errorLimit);
    const activeModeration = Object.entries(moderation ?? {}).filter(([, m]) => Math.max(m?.m ?? 0, m?.b ?? 0) > now).length;
    return {
      now,
      target,
      site,
      today,
      yesterday,
      health: healthResult,
      deployment,
      world: {
        online,
        listed,
        worlds: byWorld,
        cap: settings?.cap ?? null,
        roomCap: settings?.roomCap ?? null,
        chatLast10m: chatRecent ?? "?",
        eventsLastHour: eventsRecent ?? "?",
        stalls: Object.keys(stalls ?? {}).length,
        moderated: activeModeration,
      },
      metrics: { today: metricsToday ?? {}, yesterday: metricsYesterday ?? {} },
      agents: agents ?? {},
      referrers: referrers ?? {},
      errorsStoredToday: errorCount ?? 0,
      errors,
      warnings,
    };
  } finally {
    await close();
  }
}

function describeHealth(h) {
  if (h.status === 0) return `UNREACHABLE (${h.error})`;
  if (h.status === 404) return "not deployed on this site yet (404)";
  const b = h.body;
  if (!b?.checks) return `HTTP ${h.status}`;
  const c = b.checks;
  const part = (name, check, extra = "") =>
    `${name} ${check.ok ? "ok" : `FAIL(${check.error})`} ${check.ms}ms${extra}`;
  const rtdbExtra = c.rtdb.ok ? ` (sweep ${c.rtdb.sweepAgeS ?? "-"}s, market ${c.rtdb.marketAgeS ?? "-"}s)` : "";
  const baseExtra = c.base.block ? ` block ${c.base.block} (${c.base.blockAgeS}s old)` : "";
  const flagsText = [b.telemetry === "off" ? "TELEMETRY OFF" : "", b.missingConfig?.length ? `MISSING ${b.missingConfig.join(",")}` : ""]
    .filter(Boolean)
    .join("  ");
  return `${b.ok ? "OK" : "DEGRADED"} [${h.status}]  ${part("rtdb", c.rtdb, rtdbExtra)}  ${part("curator", c.curator)}  ${part("base", c.base, baseExtra)}${flagsText ? `  ${flagsText}` : ""}`;
}

function render(s) {
  const lines = [];
  lines.push(`RampRidge status  ${new Date(s.now).toISOString().replace("T", " ").slice(0, 19)} UTC   database: ${s.target}`);
  const d = s.deployment;
  if (d?.error) lines.push(`Serving   (vercel CLI failed: ${d.error})`);
  else if (d) lines.push(`Serving   ${d.id ?? "?"}  ${d.url ?? ""}  created ${ago(d.createdAt, s.now)}  [${d.via}]`);
  const healthDeployment = s.health.body?.deployment?.id;
  if (d?.id && healthDeployment && healthDeployment !== d.id) {
    lines.push(`          NOTE: /api/health answered from ${healthDeployment} (promotion or rollback in progress?)`);
  }
  lines.push(`Health    ${describeHealth(s.health)}  (${s.site}, ${s.health.ms}ms)`);
  for (const warning of s.warnings) lines.push(`WARNING   database read failed, ${warning}`);
  lines.push(
    `World     ${s.world.online} online (${s.world.listed} listed)  chat ${s.world.chatLast10m} lines/10m  trades announced ${s.world.eventsLastHour}/1h  stalls ${s.world.stalls}  moderated ${s.world.moderated}`,
  );
  // One line of worlds: online/cap each (count is the server's soft count used for assignment), closed ones marked.
  const worldText = s.world.worlds
    .map((w) => `${w.id} ${w.online}/${s.world.cap ?? "?"}${w.counted !== null && w.counted !== w.online ? ` (counted ${w.counted})` : ""}${w.open ? "" : " closed"}`)
    .join("   ");
  lines.push(`Worlds    ${worldText || "-"}${s.world.roomCap ? `   room cap ${s.world.roomCap}` : ""}`);

  lines.push("");
  lines.push(`Funnel    ${s.today} (UTC, so far)          ${s.yesterday}`);
  const t = s.metrics.today;
  const y = s.metrics.yesterday;
  for (const [event, base] of FUNNEL) {
    const conv = base ? pct(t[event], t[base]) : "";
    const convText = conv ? `${conv.padStart(4)} of ${base}` : "";
    const yConv = base ? pct(y[event], y[base]) : "";
    const alert = (event === "gas_fail" || event.endsWith("_fail")) && (t[event] ?? 0) > 0 ? "  <-- check" : "";
    lines.push(`  ${event.padEnd(13)} ${fmt(t[event] ?? 0).padStart(7)}  ${convText.padEnd(22)} ${fmt(y[event] ?? 0).padStart(7)} ${yConv.padStart(4)}${alert}`);
  }

  const agents = Object.entries(s.agents).sort((a, b) => b[1] - a[1]);
  if (agents.length) {
    const total = agents.reduce((sum, [, n]) => sum + (n ?? 0), 0);
    lines.push("");
    lines.push(`Browsers  ${agents.map(([k, n]) => `${k} ${fmt(n)} (${pct(n, total)})`).join(", ")}`);
  }
  const sources = Object.entries(s.referrers).sort((a, b) => b[1] - a[1]);
  if (sources.length) {
    const total = sources.reduce((sum, [, n]) => sum + (n ?? 0), 0);
    lines.push(`Sources   ${sources.map(([k, n]) => `${k} ${fmt(n)} (${pct(n, total)})`).join(", ")}`);
  }

  lines.push("");
  lines.push(`Errors    ${fmt(t.client_error ?? 0)} reported today, ${fmt(s.errorsStoredToday)} stored (cap 500/day)`);
  const groups = new Map();
  for (const e of s.errors) {
    const g = groups.get(e.fp) ?? { n: 0, last: e, uas: new Set() };
    g.n += 1;
    g.last = e;
    g.uas.add(e.ua);
    groups.set(e.fp, g);
  }
  const top = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 5);
  if (top.length) {
    lines.push(`  Top groups in the last ${s.errors.length}:`);
    for (const g of top) {
      lines.push(`  x${g.n}  ${g.last.m.slice(0, 110)}  [${g.last.c ?? g.last.k}; ${[...g.uas].join(",")}; last ${hhmmss(g.last.t)}]`);
    }
  }
  if (s.errors.length) {
    lines.push(`  Latest ${s.errors.length}:`);
    for (const e of s.errors.slice().reverse()) {
      lines.push(`  ${hhmmss(e.t)}  ${(e.c ? `${e.k}/${e.c}` : e.k).padEnd(16)} ${String(e.ua).padEnd(14)} ${String(e.b).padEnd(20)} ${e.p}  ${e.m.slice(0, 120)}`);
      const frame = e.s?.split("\n")[0];
      if (frame) lines.push(`            ${frame.slice(0, 140)}`);
    }
  } else {
    lines.push("  none stored today or yesterday");
  }
  return lines.join("\n");
}

async function once() {
  const s = await snapshot();
  if (flags.json) console.log(JSON.stringify(s, null, 2));
  else console.log(render(s));
}

if (watchSeconds > 0) {
  for (;;) {
    try {
      const s = await snapshot();
      process.stdout.write("\x1b[2J\x1b[H");
      console.log(render(s));
    } catch (err) {
      console.error(`status failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, watchSeconds * 1000));
  }
} else {
  await once();
  process.exit(0);
}
