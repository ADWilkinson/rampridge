#!/usr/bin/env node
/**
 * Load test: N simulated players against the local dev API and the Firebase
 * database emulator. Each player behaves like a browser tab: it creates a
 * session, joins (the server assigns the world), opens its own realtime
 * connection to that world with the same subscriptions as
 * src/net/transport.ts, heartbeats every 15 s, walks legal random paths,
 * chats and emotes on randomised schedules, optionally hops worlds, then
 * leaves.
 *
 * Measured: API latency per action (p50/p95/p99), status codes and 429s,
 * realtime download per client overall and per world (bytes and frames
 * through one counting proxy per world), and, with --watch, CPU and memory
 * of other processes (the emulator and the Vite dev API) sampled with `ps`.
 *
 *   bash scripts/load/emulator.sh &
 *   FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9460 SESSION_SECRET=<throwaway> \
 *     bunx vite --port 5260 --strictPort &
 *   node scripts/load/swarm.mjs --players 150 --duration 180 \
 *     --watch emulator=<pid>,vite=<pid> --out /tmp/swarm-150.json
 *
 * Options (defaults in brackets): --players [50] --duration seconds of steady
 * play [120] --ramp seconds to bring everyone in [20] --workers processes
 * [ceil(players/50)] --api [http://localhost:5260] --emulator
 * [127.0.0.1:9460] --move-every mean seconds between moves [10]
 * --chat-every [60] --emote-every [120] --run fraction of runs [0.3]
 * --follow fraction of players who follow another player instead of walking
 * about, re-planning every 600 ms like the engine's Follow [0]
 * --worlds open worlds, written to meta/worlds in the emulator before the run
 * [server default] --world-cap players per world, written to meta/worldCap
 * [server default] --hop fraction of players who hop to another world about
 * once a minute through the World Switcher's join [0]
 * --watch name=pid,... --out file.json.
 */

import { fork } from "node:child_process";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  assertLocal,
  countingProxy,
  emulatorGet,
  emulatorPut,
  findPath,
  parseArgs,
  post,
  protocol,
  randomAppearance,
  reachableTiles,
  sleep,
  subscribeWorld,
  summarise,
  world,
  worlds,
} from "./lib.mjs";

const DEFAULTS = {
  players: 50,
  duration: 120,
  ramp: 20,
  workers: 0,
  api: "http://localhost:5260",
  emulator: "127.0.0.1:9460",
  "move-every": 10,
  "chat-every": 60,
  "emote-every": 120,
  run: 0.3,
  follow: 0,
  worlds: 0,
  "world-cap": 0,
  hop: 0,
  watch: "",
  out: "",
  worker: false,
  first: 0,
  count: 0,
  "steady-at": 0,
  "steady-end": 0,
};

const args = parseArgs(process.argv.slice(2), DEFAULTS);
assertLocal(args.api, "--api");
assertLocal(args.emulator, "--emulator");

const CHAT_LINES = [
  "selling usdc for gbp on revolut",
  "anyone buying?",
  "what's the rate on wise today",
  "gf",
  "buying 50 usdc with venmo",
  "lol",
  "wave:hello bank",
  "red:shake:selling!!",
  "how do i sell",
  "nice trade",
  "is zelle working?",
  "who's at the booth",
];

const EMOTES = protocol.EMOTES;

/** Exponential wait with the given mean, clamped so a player never stalls for minutes. */
function exp(meanSeconds) {
  return Math.min(meanSeconds * 4, -Math.log(1 - Math.random()) * meanSeconds) * 1000;
}

// ---------------------------------------------------------------------------
// Worker: a slice of the players, one realtime connection each.

async function runWorker() {
  // One counting proxy per world, so each world's realtime download is measured on its own.
  const proxies = new Map();
  const proxyFor = async (id) => {
    if (!proxies.has(id)) proxies.set(id, countingProxy(args.emulator));
    return proxies.get(id);
  };
  const resolved = new Map();
  const tiles = reachableTiles();
  const latencies = {};
  const statuses = {};
  const errors = {};
  const countersByWorld = {};
  const hops = { ok: 0, refused: 0 };
  const record = (type, result) => {
    (latencies[type] ??= []).push(Math.round(result.ms * 10) / 10);
    const byStatus = (statuses[type] ??= {});
    byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
    if (result.status !== 200) {
      const key = `${type} ${result.status} ${result.json?.code ?? ""} ${String(result.json?.error ?? "").slice(0, 60)}`;
      errors[key] = (errors[key] ?? 0) + 1;
    }
  };

  const steadyAt = args["steady-at"];
  const steadyEnd = args["steady-end"];
  const players = [];
  let steadyStart = null;
  const snapshot = () => {
    const byWorld = {};
    for (const [id, proxy] of resolved) {
      byWorld[id] = { down: proxy.totals.down, frames: proxy.totals.frames, counters: { ...(countersByWorld[id] ?? {}) }, clients: 0 };
    }
    for (const player of players) if (player.world && byWorld[player.world]) byWorld[player.world].clients++;
    return { at: Date.now(), byWorld };
  };
  const timers = [];
  timers.push(setTimeout(() => (steadyStart = snapshot()), steadyAt - Date.now()));
  let steadyStop = null;
  timers.push(setTimeout(() => (steadyStop = snapshot()), steadyEnd - Date.now()));

  const rampMs = args.ramp * 1000;
  const startAt = Date.now();
  const total = args.players;

  async function watch(player, id) {
    const proxy = await proxyFor(id);
    resolved.set(id, proxy);
    player.view = await subscribeWorld(`p${player.index}-${id}-${Date.now()}`, proxy.port, (countersByWorld[id] ??= {}), id);
  }

  async function play(index) {
    const globalIndex = args.first + index;
    await sleep(Math.max(0, startAt + (globalIndex / total) * rampMs - Date.now()));
    const ip = `10.${(globalIndex >> 16) & 255}.${(globalIndex >> 8) & 255}.${globalIndex & 255}`;
    const created = await post(args.api, "/api/session", {}, { ip });
    record("session", created);
    if (created.status !== 200) return null;
    const player = { index: globalIndex, pid: created.json.pid, token: created.json.token, ip, view: null, world: null, stopped: false, offset: 0 };

    const act = async (type, body) => {
      const result = await post(args.api, "/api/act", { type, ...body }, { token: player.token, ip });
      record(type === "join" && body.hop ? "hop" : type, result);
      if (result.json && typeof result.json.now === "number") player.offset = result.json.now - Date.now();
      return result;
    };
    /** Joins (or hops) and adopts the token for the world the server answers with, as the client does. */
    const join = async (target, hop = false) => {
      const result = await act("join", { appearance: randomAppearance(), world: target, ...(hop ? { hop: true } : {}) });
      if (result.status === 200 && result.json?.token) {
        player.token = result.json.token;
        player.world = result.json.world;
      }
      return result;
    };

    const joined = await join("auto");
    if (joined.status !== 200) return null;
    players.push(player);
    await watch(player, player.world);

    // Waits never run past the end of the steady window, so every loop stops on time.
    const pause = (ms) => sleep(Math.max(0, Math.min(ms, steadyEnd - Date.now())));
    const loop = async (firstDelay, nextDelay, fn) => {
      await pause(firstDelay);
      while (!player.stopped && Date.now() < steadyEnd) {
        await fn();
        await pause(nextDelay());
      }
    };

    const heartbeat = loop(Math.random() * protocol.HEARTBEAT_MS, () => protocol.HEARTBEAT_MS, async () => {
      const result = await act("heartbeat", {});
      if (result.json?.code === "not_joined") await join(player.world ?? "auto");
    });

    // Followers re-plan toward their target every tick it changes tile, like the engine's Follow.
    const follower = args.follow > 0 && globalIndex % Math.max(1, Math.round(1 / args.follow)) === 0;
    let lastTarget = "";
    const follows = !follower ? null : loop(2_000, () => protocol.TICK_MS, async () => {
      const view = player.view;
      const others = [...view.players.keys()].filter((key) => key !== player.pid).sort();
      const leader = others.length ? view.players.get(others[globalIndex % others.length]) : null;
      const mine = view.players.get(player.pid);
      if (!leader || !mine) return;
      const now = Date.now() + player.offset;
      const goal = world.currentTiles(leader, now).at(-1);
      const here = world.currentTiles(mine, now).at(-1);
      if (!goal || !here || `${goal.x},${goal.y}` === lastTarget || world.tileDistance(goal, here) <= 1) return;
      lastTarget = `${goal.x},${goal.y}`;
      const path = findPath(here, goal);
      if (!path || path.length < 2) return;
      // Stop one tile short, behind the leader.
      await act("move", { path: path.slice(0, -1).length >= 2 ? path.slice(0, -1) : path, run: leader.r === true });
    });

    const moves = follower ? null : loop(exp(args["move-every"]), () => exp(args["move-every"]), async () => {
      const mine = player.view.players.get(player.pid);
      if (!mine) return;
      const now = Date.now() + player.offset;
      const here = world.currentTiles(mine, now).at(-1);
      if (!here) return;
      const target = tiles[Math.floor(Math.random() * tiles.length)];
      const path = findPath(here, target);
      if (!path || path.length < 2) return;
      await act("move", { path, run: Math.random() < args.run });
    });

    // A person types for a couple of seconds; the server's own floor is 1.2 s per player.
    const chatGap = () => Math.max(2_000, exp(args["chat-every"]));
    const chats = loop(chatGap(), chatGap, async () => {
      await act("chat", { text: CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)] });
    });

    const emotes = loop(exp(args["emote-every"]), () => exp(args["emote-every"]), async () => {
      await act("emote", { emote: EMOTES[Math.floor(Math.random() * EMOTES.length)] });
    });

    // Hoppers open the World Switcher about once a minute and pick another open world.
    const hopper = args.hop > 0 && Math.random() < args.hop;
    const open = worlds.worldIds(args.worlds || worlds.DEFAULT_OPEN_WORLDS);
    const hopping = !hopper ? null : loop(exp(60), () => exp(60), async () => {
      const choices = open.filter((id) => id !== player.world);
      if (choices.length === 0) return;
      const target = choices[Math.floor(Math.random() * choices.length)];
      const result = await join(target, true);
      if (result.status !== 200) {
        hops.refused++;
        return;
      }
      hops.ok++;
      const old = player.view;
      await watch(player, target);
      await old.stop();
    });

    await Promise.all([heartbeat, moves, follows, chats, emotes, hopping]);
    return player;
  }

  await Promise.all(Array.from({ length: args.count }, (_, i) => play(i).catch((err) => {
    const key = `crash ${err instanceof Error ? err.message : String(err)}`;
    errors[key] = (errors[key] ?? 0) + 1;
  })));

  for (const timer of timers) clearTimeout(timer);
  steadyStop ??= snapshot();
  for (const player of players) {
    player.stopped = true;
    const result = await post(args.api, "/api/act", { type: "leave" }, { token: player.token, ip: player.ip });
    record("leave", result);
  }
  await sleep(500);
  for (const player of players) await player.view?.stop();
  const perSocketDown = [];
  let totalDown = 0;
  let totalUp = 0;
  let totalFrames = 0;
  for (const proxy of resolved.values()) {
    perSocketDown.push(...proxy.sockets.map((socket) => socket.down));
    totalDown += proxy.totals.down;
    totalUp += proxy.totals.up;
    totalFrames += proxy.totals.frames;
    await proxy.close();
  }

  const steadyWorlds = {};
  if (steadyStart && steadyStop) {
    for (const [id, end] of Object.entries(steadyStop.byWorld)) {
      const begin = steadyStart.byWorld[id] ?? { down: 0, frames: 0, counters: {}, clients: 0 };
      steadyWorlds[id] = {
        clients: end.clients,
        clientsAtStart: begin.clients,
        down: end.down - begin.down,
        frames: end.frames - begin.frames,
        counters: Object.fromEntries(Object.keys(end.counters).map((k) => [k, end.counters[k] - (begin.counters[k] ?? 0)])),
      };
    }
  }
  process.send({
    latencies,
    statuses,
    errors,
    hops,
    clients: players.length,
    steady: steadyStart && steadyStop ? { ms: steadyStop.at - steadyStart.at, worlds: steadyWorlds } : null,
    totalDown,
    totalUp,
    totalFrames,
    perSocketDown,
  });
}

// ---------------------------------------------------------------------------
// Parent: forks workers, samples processes, merges and reports.

function samplePs(watch) {
  const out = {};
  for (const [name, pid] of watch) {
    try {
      const line = execFileSync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
      const [cpu, rss] = line.split(/\s+/).map(Number);
      out[name] = { cpu, rssMb: Math.round(rss / 1024) };
    } catch {
      out[name] = null;
    }
  }
  return out;
}

async function runParent() {
  const workers = args.workers || Math.max(1, Math.ceil(args.players / 50));
  const watch = String(args.watch || "")
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("="))
    .filter(([, pid]) => /^\d+$/.test(pid ?? ""));
  // The operator's world settings, as the Firebase console would set them (emulator only).
  if (args.worlds > 0) await emulatorPut(args.emulator, "meta/worlds", args.worlds);
  if (args["world-cap"] > 0) await emulatorPut(args.emulator, "meta/worldCap", args["world-cap"]);
  const startAt = Date.now();
  const steadyAt = startAt + (args.ramp + 15) * 1000;
  const steadyEnd = steadyAt + args.duration * 1000;
  console.log(
    `[swarm] ${args.players} players over ${workers} workers; worlds ${args.worlds || "default"}, cap ${args["world-cap"] || "default"}; ` +
      `ramp ${args.ramp}s, steady ${args.duration}s; move every ~${args["move-every"]}s, chat ~${args["chat-every"]}s, emote ~${args["emote-every"]}s, hop ${args.hop}`,
  );

  const samples = [];
  const sampler = setInterval(() => {
    if (Date.now() < steadyAt || Date.now() > steadyEnd) return;
    samples.push(samplePs(watch));
  }, 2_000);
  const progress = setInterval(() => {
    const elapsed = Math.round((Date.now() - startAt) / 1000);
    console.log(`[swarm] t=${elapsed}s`);
  }, 30_000);

  const per = Math.ceil(args.players / workers);
  const self = fileURLToPath(import.meta.url);
  const results = await Promise.all(
    Array.from({ length: workers }, (_, w) => {
      const first = w * per;
      const count = Math.max(0, Math.min(per, args.players - first));
      if (count === 0) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const child = fork(
          self,
          [
            "--worker",
            "--first", String(first),
            "--count", String(count),
            "--players", String(args.players),
            "--ramp", String(args.ramp),
            "--api", args.api,
            "--emulator", args.emulator,
            "--move-every", String(args["move-every"]),
            "--chat-every", String(args["chat-every"]),
            "--emote-every", String(args["emote-every"]),
            "--run", String(args.run),
            "--follow", String(args.follow),
            "--worlds", String(args.worlds),
            "--hop", String(args.hop),
            "--steady-at", String(steadyAt),
            "--steady-end", String(steadyEnd),
          ],
          { stdio: ["ignore", "inherit", "inherit", "ipc"] },
        );
        let result = null;
        child.on("message", (message) => (result = message));
        child.on("exit", (code) => (result ? resolve(result) : reject(new Error(`worker ${w} exited ${code}`))));
      });
    }),
  );
  clearInterval(sampler);
  clearInterval(progress);

  const merged = { latencies: {}, statuses: {}, errors: {}, hops: { ok: 0, refused: 0 }, clients: 0, steady: { ms: 0, down: 0, frames: 0, counters: {}, worlds: {} } };
  let totalDown = 0;
  let totalUp = 0;
  const perSocket = [];
  for (const r of results.filter(Boolean)) {
    merged.clients += r.clients;
    for (const [type, list] of Object.entries(r.latencies)) (merged.latencies[type] ??= []).push(...list);
    for (const [type, byStatus] of Object.entries(r.statuses)) {
      const target = (merged.statuses[type] ??= {});
      for (const [status, n] of Object.entries(byStatus)) target[status] = (target[status] ?? 0) + n;
    }
    for (const [key, n] of Object.entries(r.errors)) merged.errors[key] = (merged.errors[key] ?? 0) + n;
    merged.hops.ok += r.hops.ok;
    merged.hops.refused += r.hops.refused;
    if (r.steady) {
      merged.steady.ms = Math.max(merged.steady.ms, r.steady.ms);
      for (const [id, w] of Object.entries(r.steady.worlds)) {
        const target = (merged.steady.worlds[id] ??= { clients: 0, down: 0, frames: 0, counters: {} });
        target.clients += w.clients;
        target.down += w.down;
        target.frames += w.frames;
        merged.steady.down += w.down;
        merged.steady.frames += w.frames;
        for (const [k, n] of Object.entries(w.counters)) {
          target.counters[k] = (target.counters[k] ?? 0) + n;
          merged.steady.counters[k] = (merged.steady.counters[k] ?? 0) + n;
        }
      }
    }
    totalDown += r.totalDown;
    totalUp += r.totalUp;
    perSocket.push(...r.perSocketDown);
  }

  const minutes = merged.steady.ms / 60_000;
  const clients = merged.clients || 1;
  const requests = Object.values(merged.statuses).reduce((sum, byStatus) => sum + Object.values(byStatus).reduce((a, b) => a + b, 0), 0);
  const failures = Object.values(merged.statuses).reduce(
    (sum, byStatus) => sum + Object.entries(byStatus).filter(([s]) => s !== "200").reduce((a, [, n]) => a + n, 0),
    0,
  );
  const limited = Object.values(merged.statuses).reduce((sum, byStatus) => sum + (byStatus["429"] ?? 0), 0);
  const steadyRequests = {};
  const actionTypes = Object.keys(merged.latencies);
  const latency = Object.fromEntries(actionTypes.map((type) => [type, summarise(merged.latencies[type])]));
  for (const type of actionTypes) steadyRequests[type] = merged.latencies[type].length;

  const resources = {};
  for (const [name] of watch) {
    const list = samples.map((s) => s[name]).filter(Boolean);
    resources[name] = list.length
      ? {
          cpuMean: Math.round(list.reduce((a, b) => a + b.cpu, 0) / list.length),
          cpuMax: Math.max(...list.map((s) => s.cpu)),
          rssMaxMb: Math.max(...list.map((s) => s.rssMb)),
        }
      : null;
  }

  const perWorld = Object.fromEntries(
    Object.entries(merged.steady.worlds)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([id, w]) => [
        id,
        {
          clients: w.clients,
          downBytesPerClientPerMinute: minutes && w.clients ? Math.round(w.down / w.clients / minutes) : null,
          framesPerClientPerMinute: minutes && w.clients ? Math.round(w.frames / w.clients / minutes) : null,
          messagesPerSecond: minutes ? Math.round(w.frames / (minutes * 60)) : null,
        },
      ]),
  );

  // Every player has left by now: each world's count (meta/worldPop) should be back to zero, with no records left.
  await sleep(1_000);
  const pops = (await emulatorGet(args.emulator, "meta/worldPop")) ?? {};
  const left = await Promise.all(worlds.worldIds().map(async (id) => Object.keys((await emulatorGet(args.emulator, `worlds/${id}/players`, { shallow: true })) ?? {}).length));
  const afterLeave = {
    counts: Object.fromEntries(Object.entries(pops).map(([id, w]) => [id, w?.n ?? null])),
    records: left.reduce((a, b) => a + b, 0),
  };

  const report = {
    label: `${args.players} players`,
    config: {
      players: args.players,
      worlds: args.worlds || null,
      worldCap: args["world-cap"] || null,
      hopFraction: args.hop,
      workers,
      rampSeconds: args.ramp,
      steadySeconds: args.duration,
      moveEverySeconds: args["move-every"],
      chatEverySeconds: args["chat-every"],
      emoteEverySeconds: args["emote-every"],
      followFraction: args.follow,
      host: `${os.cpus()[0]?.model ?? "cpu"} x${os.cpus().length}`,
    },
    clients: merged.clients,
    requests,
    failureRate: requests ? Math.round((failures / requests) * 10_000) / 100 : 0,
    rateLimitedRate: requests ? Math.round((limited / requests) * 10_000) / 100 : 0,
    latencyMs: latency,
    statuses: merged.statuses,
    errors: merged.errors,
    realtime: {
      steadyMinutes: Math.round(minutes * 100) / 100,
      downBytesPerClientPerMinute: minutes ? Math.round(merged.steady.down / clients / minutes) : null,
      framesPerClientPerMinute: minutes ? Math.round(merged.steady.frames / clients / minutes) : null,
      roomFramesPerSecond: minutes ? Math.round(merged.steady.frames / (minutes * 60)) : null,
      steadyEvents: merged.steady.counters,
      totalDownMb: Math.round(totalDown / 1e4) / 100,
      totalUpMb: Math.round(totalUp / 1e4) / 100,
      perConnectionDownKb: summarise(perSocket.map((b) => Math.round(b / 1024))),
      worlds: perWorld,
    },
    hops: merged.hops,
    afterLeave,
    resources,
  };
  console.log(JSON.stringify(report, null, 2));
  if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
}

if (args.worker) {
  runWorker().then(
    () => process.exit(0),
    (err) => {
      console.error("[worker]", err);
      process.exit(1);
    },
  );
} else {
  await runParent();
}
