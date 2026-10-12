#!/usr/bin/env node
/**
 * Turns swarm.mjs reports into the tables in README.md: measured numbers per
 * run, then a fit of realtime traffic against world size extrapolated to
 * production prices and limits. Arrivals are placed as the server places
 * them (api/_lib/worlds.ts: fill the busiest world to 70% of `--cap`, then
 * spill) across `--open` open worlds under `--room-cap`, beside the same
 * players with only the default 3 worlds open and in one room.
 *
 *   node scripts/load/summarise.mjs --label worlds w-600.json w-1200.json [--cap 200] [--open 14] [--room-cap 2000]
 *
 * Each player hears every other player in their own world, so traffic per
 * client grows linearly with the size of its world. It is fitted as b*n by
 * least squares through the origin, with one point per world in each run
 * (reports from before worlds count as one world). N players in worlds of n
 * download N*b*n; the same N in one room download N*b*N. Billing adds TLS
 * framing to every message and a handshake per connection (Firebase's
 * figures: ~3.5 KB, tens of bytes per message).
 */

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const files = argv.filter((a) => a.endsWith(".json"));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const label = flag("label", "run");
const cap = Number(flag("cap", "200"));
/** The launch settings in docs/runbook.md: meta/worlds 14, meta/roomCap 2000. */
const openWorlds = Number(flag("open", "14"));
const roomCap = Number(flag("room-cap", "2000"));
const DEFAULT_OPEN = 3;
const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8"))).sort((a, b) => a.clients - b.clients);

/** Firebase RTDB Blaze: $1 per GB downloaded (first 10 GB a month free); ~100,000 responses/s and 1,000 writes/s per database. */
const PRICE_PER_GB = 1;
const TLS_BYTES_PER_MESSAGE = 29;
const HANDSHAKE_BYTES = 3_500;
/** A visitor reconnects (new page load) about every 15 minutes. */
const CONNECTIONS_PER_PLAYER_HOUR = 4;
const RESPONSES_LIMIT = 100_000;
const WRITES_LIMIT = 1_000;
/** Vercel Pro, iad1: $0.60 per million invocations, $0.128 per Active CPU hour. */
const VERCEL_PER_MILLION = 0.6;
const VERCEL_CPU_HOUR = 0.128;

/** Least-squares slope through the origin. */
function fit(points) {
  const sxx = points.reduce((s, [x]) => s + x * x, 0);
  const sxy = points.reduce((s, [x, y]) => s + x * y, 0);
  return sxx ? sxy / sxx : 0;
}

const fmt = (n, digits = 0) => (n === null || n === undefined ? "-" : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));

/** The run's worlds: { clients, downBytesPerClientPerMinute, framesPerClientPerMinute, messagesPerSecond } each. */
function worldsOf(run) {
  const worlds = run.realtime.worlds;
  if (worlds && Object.keys(worlds).length) return Object.values(worlds).filter((w) => w.clients > 0);
  return [
    {
      clients: run.clients,
      downBytesPerClientPerMinute: run.realtime.downBytesPerClientPerMinute,
      framesPerClientPerMinute: run.realtime.framesPerClientPerMinute,
      messagesPerSecond: run.realtime.roomFramesPerSecond,
    },
  ];
}

/** Requests per player per minute while playing (ramp counted at half). */
function perPlayerMinute(run) {
  const minutes = (run.config.rampSeconds / 2 + 15 + run.config.steadySeconds) / 60;
  const out = {};
  for (const [type, s] of Object.entries(run.latencyMs)) out[type] = s.n / run.clients / minutes;
  return out;
}

console.log(`### ${label}: measured\n`);
console.log(
  "| Players | Worlds (players each) | Requests | Errors | 429s | join p50/p95/p99 ms | move p50/p95/p99 ms | heartbeat p50/p95/p99 ms | chat p50/p95/p99 ms | Down per client per min | Messages per client per min | Messages/s per world | All worlds messages/s | Emulator CPU mean/max | Dev API CPU mean/max, RSS |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  const l = (t) => (r.latencyMs[t] ? `${fmt(r.latencyMs[t].p50, 1)} / ${fmt(r.latencyMs[t].p95, 1)} / ${fmt(r.latencyMs[t].p99, 1)}` : "-");
  const e = r.resources.emulator;
  const v = r.resources.vite;
  const worlds = worldsOf(r);
  const sizes = worlds.map((w) => w.clients).join(", ");
  const perWorld = worlds.map((w) => w.messagesPerSecond ?? 0);
  console.log(
    `| ${r.clients} | ${worlds.length} (${sizes}) | ${fmt(r.requests)} | ${r.failureRate}% | ${r.rateLimitedRate}% | ${l("join")} | ${l("move")} | ${l("heartbeat")} | ${l("chat")} | ${fmt(r.realtime.downBytesPerClientPerMinute / 1024, 1)} KB | ${fmt(r.realtime.framesPerClientPerMinute)} | ${fmt(Math.min(...perWorld))}-${fmt(Math.max(...perWorld))} | ${fmt(r.realtime.roomFramesPerSecond)} | ${e ? `${e.cpuMean}% / ${e.cpuMax}%` : "-"} | ${v ? `${v.cpuMean}% / ${v.cpuMax}%, ${v.rssMaxMb} MB` : "-"} |`,
  );
}

// One point per world: (players in that world, what each of its clients downloaded).
const points = runs.flatMap(worldsOf);
const bytes = fit(points.map((w) => [w.clients, w.downBytesPerClientPerMinute]));
const frames = fit(points.map((w) => [w.clients, w.framesPerClientPerMinute]));
const rates = runs.map(perPlayerMinute);
const avg = (key) => rates.reduce((s, r) => s + (r[key] ?? 0), 0) / rates.length;
const requestsPerPlayerMinute = ["heartbeat", "move", "chat", "emote"].reduce((s, k) => s + avg(k), 0);
// Writes: every request spends a rate-limit transaction; moves, chat, emotes and joins write to the player's world,
// and only every other heartbeat writes `ls`.
const worldWritesPerPlayerMinute = avg("move") + avg("chat") + avg("emote") + avg("heartbeat") * 0.5;
const writesPerPlayerMinute = worldWritesPerPlayerMinute + requestsPerPlayerMinute;
const cpuRun = runs.at(-1);
const cpuMsPerRequest =
  cpuRun.resources.vite && cpuRun.requests
    ? ((cpuRun.resources.vite.cpuMean / 100) * 1000) / (cpuRun.requests / (cpuRun.config.rampSeconds / 2 + 15 + cpuRun.config.steadySeconds))
    : null;

console.log(`\nPer client per minute: ${fmt(bytes, 1)} B and ${fmt(frames, 2)} messages for each player in the same world (${points.length} worlds measured).`);
console.log(`Per player per minute: ${fmt(requestsPerPlayerMinute, 1)} API requests (heartbeat ${fmt(avg("heartbeat"), 1)}, move ${fmt(avg("move"), 1)}, chat ${fmt(avg("chat"), 1)}, emote ${fmt(avg("emote"), 1)}).`);
if (cpuMsPerRequest !== null) console.log(`Dev API CPU: ~${fmt(cpuMsPerRequest, 2)} ms per request (Vite SSR, one process).`);

/**
 * How N arrivals spread over `open` worlds of `cap`, one at a time, as api/_lib/worlds.ts places them: the
 * busiest world below 70% of the cap first, then the quietest with room.
 */
function placeArrivals(n, open) {
  const sizes = Array(open).fill(0);
  const target = Math.max(1, Math.floor(cap * 0.7));
  for (let i = 0; i < n; i++) {
    const withRoom = sizes.map((size, w) => [size, w]).filter(([size]) => size < cap);
    if (withRoom.length === 0) break;
    const filling = withRoom.filter(([size]) => size < target).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const spilling = withRoom.filter(([size]) => size >= target).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    sizes[[...filling, ...spilling][0][1]]++;
  }
  return sizes.filter((size) => size > 0);
}

/** Production cost of rooms of these sizes: each client downloads b per minute for every player in its room. */
function cost(sizes) {
  const n = sizes.reduce((a, b) => a + b, 0);
  const sumSquares = sizes.reduce((a, size) => a + size * size, 0);
  const payloadPerHour = bytes * sumSquares * 60;
  const tlsPerHour = frames * sumSquares * 60 * TLS_BYTES_PER_MESSAGE + n * CONNECTIONS_PER_PLAYER_HOUR * HANDSHAKE_BYTES;
  const gbPerHour = (payloadPerHour + tlsPerHour) / 1e9;
  return {
    perClientMinute: (bytes * sumSquares) / n,
    gbPerHour,
    dollars: gbPerHour * PRICE_PER_GB,
    responses: (frames * sumSquares) / 60,
    perWorld: (frames * Math.max(...sizes) ** 2) / 60,
  };
}

const flag70 = (value, limit) => `${fmt(value)}${value > limit ? " (over)" : value > limit * 0.7 ? " (near)" : ""}`;
const sizesText = (sizes) => {
  if (sizes.length === 0) return "-";
  const counts = new Map();
  for (const size of sizes) counts.set(size, (counts.get(size) ?? 0) + 1);
  return [...counts].map(([size, k]) => (k > 1 ? `${k} x ${size}` : String(size))).join(", ");
};
const placed = (sizes) => sizes.reduce((a, b) => a + b, 0);
console.log(`\n### ${label}: extrapolated to production, ${openWorlds} worlds open of up to ${cap}, meta/roomCap ${roomCap}\n`);
console.log(
  `| Players | Worlds (players each) | Turned away | Down per client per min | Firebase $/hour | With ${DEFAULT_OPEN} open: $/hour, turned away | One room $/hour | Responses/s, all worlds (limit ~100k) | Messages/s, busiest world | Writes/s (limit 1k) | Vercel $/hour |`,
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
for (const n of [300, 600, 800, 1000, 1200, 2000, 2500]) {
  const sizes = placeArrivals(Math.min(n, roomCap), openWorlds);
  const inside = placed(sizes);
  const split = cost(sizes);
  const few = placeArrivals(Math.min(n, roomCap), DEFAULT_OPEN);
  const fewCost = cost(few);
  const single = cost([n]);
  const writes = (inside * writesPerPlayerMinute) / 60;
  const invocations = inside * requestsPerPlayerMinute * 60;
  const cpuHours = cpuMsPerRequest === null ? 0 : (invocations * cpuMsPerRequest) / 3_600_000;
  const vercel = (invocations / 1e6) * VERCEL_PER_MILLION + cpuHours * VERCEL_CPU_HOUR;
  console.log(
    `| ${fmt(n)} | ${sizesText(sizes)} | ${fmt(n - inside)} | ${fmt(split.perClientMinute / 1024, 0)} KB | $${fmt(split.dollars, 2)} | $${fmt(fewCost.dollars, 2)}, ${fmt(n - placed(few))} | $${fmt(single.dollars, 2)} | ${flag70(split.responses, RESPONSES_LIMIT)} | ${fmt(split.perWorld)} | ${flag70(writes, WRITES_LIMIT)} | $${fmt(vercel, 2)} |`,
  );
}
