#!/usr/bin/env node
/**
 * Abuse checks against the local dev API and the database emulator: session
 * farming, chat spam and floods, oversized and malformed payloads, teleport
 * moves, name squatting and impersonation, join/leave churn, stale players,
 * stall and announcement forgery, token replay and tampering, and worlds:
 * the database rules, builds from before worlds, hops and per-world writes,
 * joins replayed with old tokens, and the world counts under concurrent
 * leaves and hops. Each check prints PASS (handled), GAP (not handled) or INFO
 * (measured, no verdict).
 *
 *   SESSION_SECRET=<the dev API's throwaway secret> CRON_SECRET=<its cron secret> \
 *     node scripts/load/abuse.mjs [--api http://localhost:5260] [--emulator 127.0.0.1:9460] [--only name,...]
 *
 * SESSION_SECRET lets the script mint expired and forged tokens; without it
 * those checks are skipped. It must be the local throwaway value the dev API
 * was started with, never production's. Inspection reads the emulator with
 * its owner credential, which only the emulator accepts.
 */

import http from "node:http";
import { SignJWT } from "jose";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { assertLocal, countingProxy, findPath, NAMESPACE, parseArgs, post, protocol, randomAppearance, rules, sleep, subscribeWorld, world, worlds } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), {
  api: "http://localhost:5260",
  emulator: "127.0.0.1:9460",
  only: "",
  out: "",
});
assertLocal(args.api, "--api");
assertLocal(args.emulator, "--emulator");
const SECRET = process.env.SESSION_SECRET ? new TextEncoder().encode(process.env.SESSION_SECRET) : null;
const CRON = process.env.CRON_SECRET ?? null;
const NS = NAMESPACE;

// ---------------------------------------------------------------------------
// Helpers

// Random start so a rerun doesn't inherit the previous run's per-address buckets.
let ipCounter = 1 + Math.floor(Math.random() * 60_000);
/** A fresh documentation-range address per caller, so checks don't share IP buckets. */
const freshIp = () => {
  const n = ipCounter++;
  return `198.18.${(n >> 8) & 255}.${n & 255}`;
};

async function emu(path, init = {}) {
  const response = await fetch(`http://${args.emulator}/${path}.json?ns=${NS}`, {
    ...init,
    headers: { Authorization: "Bearer owner", ...init.headers },
  });
  return response.json();
}

const read = (path) => emu(path);
const patch = (path, value) => emu(path, { method: "PATCH", body: JSON.stringify(value) });
const playerAt = (p) => `worlds/${p.world}/players/${p.pid}`;
/** Chat lines and world news across every world (news is written to each world under one key). */
async function allOf(stream) {
  const nodes = await Promise.all(worlds.worldIds().map((id) => read(`worlds/${id}/${stream}`)));
  return Object.assign({}, ...nodes.map((n) => n ?? {}));
}

/** Each player's address, so their actions come from where their session did (as in a browser). */
const ipOfToken = new Map();

async function session(ip = freshIp(), body = {}, options = {}) {
  const result = await post(args.api, "/api/session", body, { ip, ...options });
  if (result.json?.token) ipOfToken.set(result.json.token, ip);
  return result;
}

async function player(ip = freshIp(), name) {
  const created = await session(ip, name ? { name } : {});
  if (created.status !== 200) throw new Error(`session failed: ${created.status} ${JSON.stringify(created.json)}`);
  return { ...created.json, ip };
}

const act = (token, body, options = {}) => post(args.api, "/api/act", body, { token, ip: ipOfToken.get(token), ...options });

/** Joins (or hops) and adopts the token for the world the server answers with, as the client does. */
async function join(p, target = "auto", hop = false) {
  const result = await act(p.token, { type: "join", appearance: randomAppearance(), world: target, ...(hop ? { hop: true } : {}) });
  if (result.status === 200 && result.json?.token) {
    ipOfToken.set(result.json.token, ipOfToken.get(p.token));
    p.token = result.json.token;
    p.world = result.json.world;
  }
  return result;
}

async function joined(ip) {
  const p = await player(ip);
  const result = await join(p);
  if (result.status !== 200) throw new Error(`join failed: ${result.status}`);
  return p;
}

function countStatuses(results) {
  const out = {};
  for (const r of results) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

const results = [];
function report(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(4)} ${name}: ${detail}`);
}

// ---------------------------------------------------------------------------
// Checks

const checks = {
  async sessionFarmingIpv4() {
    const ip = freshIp();
    const out = [];
    for (let i = 0; i < 70; i++) out.push(await session(ip));
    const ok = out.filter((r) => r.status === 200).length;
    report("session farming, one IPv4", ok <= 60 ? "PASS" : "GAP", `${ok} of 70 sessions created (bucket: burst 60, then 1 per 10 s); ${JSON.stringify(countStatuses(out))}`);
  },

  async sessionFarmingIpv6() {
    // One attacker owns a /64 and rotates the interface id on every request.
    const prefix = `2001:db8:${(ipCounter++).toString(16)}:1`;
    const out = [];
    for (let i = 0; i < 80; i++) out.push(await session(`${prefix}:${(i + 1).toString(16)}:0:0:1`));
    const ok = out.filter((r) => r.status === 200).length;
    report("session farming, rotating IPv6 inside one /64", ok <= 60 ? "PASS" : "GAP", `${ok} of 80 sessions created`);
  },

  async crossSiteSession() {
    const evil = await session(freshIp(), {}, { headers: { origin: "https://evil.example" } });
    const fetchSite = await session(freshIp(), {}, { headers: { "sec-fetch-site": "cross-site" } });
    const textPlain = await session(freshIp(), {}, { contentType: "text/plain" });
    const ok = evil.status === 403 && fetchSite.status === 403 && textPlain.status === 415;
    report("cross-site session creation", ok ? "PASS" : "GAP", `origin evil ${evil.status}, sec-fetch-site cross-site ${fetchSite.status}, text/plain ${textPlain.status}`);
  },

  async chatSpamOneSession() {
    const p = await joined();
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => act(p.token, { type: "chat", text: `spam ${i}` })));
    const ok = out.filter((r) => r.status === 200).length;
    report("chat spam from one session (20 at once)", ok <= 2 ? "PASS" : "GAP", `${ok} accepted; ${JSON.stringify(countStatuses(out))}`);
  },

  async chatFloodManySessions() {
    // 20 sessions behind one IP (as many as may stand in the bank), each chatting as fast as its own limit allows, for 10 s.
    const ip = freshIp();
    const bots = [];
    for (let i = 0; i < 20; i++) bots.push(await joined(ip));
    const chatBefore = Object.keys(await allOf("chat")).length;
    const started = Date.now();
    const out = [];
    await Promise.all(
      bots.map(async (bot, i) => {
        await sleep(i * 25);
        while (Date.now() - started < 10_000) {
          out.push(await act(bot.token, { type: "chat", text: `flood ${i}` }));
          await sleep(1_250);
        }
      }),
    );
    const accepted = out.filter((r) => r.status === 200).length;
    const perSecond = accepted / 10;
    report(
      "chat flood, 20 sessions behind one IP",
      perSecond <= 2.5 ? "PASS" : "GAP",
      `${accepted} messages in 10 s (${perSecond.toFixed(1)}/s; room cap 20/s); ${JSON.stringify(countStatuses(out))}; chat had ${chatBefore} lines before`,
    );
    for (const bot of bots) await act(bot.token, { type: "leave" });
  },

  async botsPerAddress() {
    const ip = freshIp();
    const out = [];
    const bots = [];
    for (let i = 0; i < 25; i++) {
      const bot = await player(ip);
      bots.push(bot);
      out.push(await join(bot));
    }
    const admitted = out.filter((r) => r.status === 200).length;
    const refusal = out.find((r) => r.status !== 200);
    report(
      "bots joining from one address",
      admitted <= 20 ? "PASS" : "GAP",
      `${admitted} of 25 admitted; refusal: ${refusal ? `${refusal.status} ${refusal.json?.error}` : "none"}`,
    );
    for (const bot of bots) await act(bot.token, { type: "leave" });
  },

  async sameplayerConcurrency() {
    // One player's heartbeat, moves and emotes landing together on one instance (Fluid compute).
    const p = await joined();
    const out = [];
    for (let round = 0; round < 15; round++) {
      const record = await read(playerAt(p));
      const here = world.currentTiles(record, Date.now()).at(-1);
      const next = [{ x: here.x + 1, y: here.y }, { x: here.x - 1, y: here.y }, { x: here.x, y: here.y + 1 }, { x: here.x, y: here.y - 1 }]
        .find((t) => world.canStep(rules.grid, here, t));
      const batch = await Promise.all([
        act(p.token, { type: "heartbeat" }),
        next ? act(p.token, { type: "move", path: [here, next], run: false }) : Promise.resolve({ status: 200 }),
        act(p.token, { type: "emote", emote: "wave" }),
      ]);
      out.push(...batch);
      await sleep(1_100);
    }
    const spurious = out.filter((r) => r.json?.code === "not_joined").length;
    report("same player's actions in parallel", spurious === 0 ? "PASS" : "GAP", `${spurious} spurious not_joined of ${out.length}; ${JSON.stringify(countStatuses(out))}`);
  },

  async roomCap() {
    if (!CRON) return report("operator room cap", "INFO", "skipped: set CRON_SECRET");
    const cron = () => fetch(`${args.api}/api/cron/prune`, { headers: { Authorization: `Bearer ${CRON}` } });
    const inside = await joined();
    await cron();
    const pops = (await read("meta/worldPop")) ?? {};
    const counted = Object.values(pops).reduce((sum, w) => sum + (w?.n ?? 0), 0);
    await emu("meta/roomCap", { method: "PUT", body: JSON.stringify(counted + 1) });
    const a = await player();
    const b = await player();
    const first = await join(a);
    const second = await join(b);
    const rejoin = await join(inside);
    await emu("meta/roomCap", { method: "DELETE" });
    const afterLift = await join(b);
    report(
      "operator room cap across every world (meta/roomCap)",
      first.status === 200 && second.status === 429 && rejoin.status === 200 && afterLift.status === 200 ? "PASS" : "GAP",
      `counted ${counted}; next newcomer ${first.status}, the one after ${second.status} "${second.json?.error}", rejoin by a player inside ${rejoin.status}, after removing the cap ${afterLift.status}`,
    );
    for (const p of [inside, a, b]) await act(p.token, { type: "leave" });
  },

  async moderation() {
    const p = await joined();
    await emu(`moderation/${p.pid}`, { method: "PUT", body: JSON.stringify({ m: Date.now() + 3_600_000, r: "test", at: Date.now() }) });
    // The cron drops idle buckets; the record must hold on its own.
    await emu(`ratelimits/act/${p.pid}`, { method: "DELETE" });
    const muted = await act(p.token, { type: "chat", text: "still here" });
    await emu(`moderation/${p.pid}`, { method: "PUT", body: JSON.stringify({ b: Date.now() + 86_400_000, m: Date.now() + 86_400_000 }) });
    await act(p.token, { type: "leave" });
    const banned = await join(p);
    report(
      "mute and ban records (moderation/{pid})",
      muted.status === 429 && banned.status === 429 ? "PASS" : "GAP",
      `muted chat ${muted.status} "${muted.json?.error}" (retry in ${Math.round((muted.json?.retryAfterMs ?? 0) / 60_000)} min); banned join ${banned.status}`,
    );
    await emu(`moderation/${p.pid}`, { method: "DELETE" });
  },

  async oldClientCompat() {
    // Clients deployed before this change hide a player whose ls is 45 s old and drop records their validator rejects.
    const validate = await import("../../shared/validate.ts");
    const proxy = await countingProxy(args.emulator);
    const counters = {};
    const players = [];
    for (let i = 0; i < 4; i++) players.push(await joined());
    const view = await subscribeWorld("compat-watch", proxy.port, counters, players[0].world);
    for (const p of players.slice(1)) if (p.world !== players[0].world) await join(p, players[0].world, true);
    const pids = new Set(players.map((p) => p.pid));
    let maxAge = 0;
    let invalid = 0;
    let seen = 0;
    const started = Date.now();
    const beats = players.map(async (p, i) => {
      await sleep(i * 3_000);
      while (Date.now() - started < 70_000) {
        await act(p.token, { type: "heartbeat" });
        const record = view.players.get(p.pid);
        const here = record ? world.currentTiles(record, Date.now()).at(-1) : null;
        const next = here && [{ x: here.x + 1, y: here.y }, { x: here.x - 1, y: here.y }].find((t) => world.canStep(rules.grid, here, t));
        if (next) await act(p.token, { type: "move", path: [here, next], run: false });
        await sleep(protocol.HEARTBEAT_MS);
      }
    });
    const sampler = setInterval(() => {
      for (const pid of pids) {
        const record = view.players.get(pid);
        if (!record) continue;
        seen++;
        if (!validate.parsePlayerRecord(record)) invalid++;
        maxAge = Math.max(maxAge, view.serverNow() - record.ls);
      }
    }, 500);
    await Promise.all(beats);
    clearInterval(sampler);
    await view.stop();
    await proxy.close();
    for (const p of players) await act(p.token, { type: "leave" });
    report(
      "clients deployed before this change",
      invalid === 0 && maxAge < 45_000 ? "PASS" : "GAP",
      `${seen} samples, ${invalid} records an old client would drop, oldest ls seen ${(maxAge / 1000).toFixed(1)} s (old clients hide at 45 s)`,
    );
  },

  async fragments() {
    if (!CRON) return report("fragments", "INFO", "skipped: set CRON_SECRET");
    const p = await joined();
    // What a move leaves when a leave lands between its read and its write: no name, look or ls.
    await act(p.token, { type: "leave" });
    await patch(playerAt(p), { p: "3185,3438", t: Date.now(), r: false });
    const beat = await act(p.token, { type: "heartbeat" });
    await fetch(`${args.api}/api/cron/prune`, { headers: { Authorization: `Bearer ${CRON}` } });
    const after = await read(playerAt(p));
    report(
      "fragment left by a move racing a leave",
      beat.status === 409 && after === null ? "PASS" : "GAP",
      `heartbeat on the fragment ${beat.status}; after the prune ${JSON.stringify(after)}`,
    );
  },

  async oversizedAndMalformed() {
    const p = await joined();
    const cases = {
      "9 KB body": await act(p.token, { type: "chat", text: "x".repeat(9_000) }),
      "chat 200 chars": await act(p.token, { type: "chat", text: "y".repeat(200) }),
      "not JSON": await post(args.api, "/api/act", null, { token: p.token, raw: "{type:chat" }),
      "array body": await act(p.token, [1, 2, 3]),
      "unknown type": await act(p.token, { type: "teleport", x: 1 }),
      "move with strings": await act(p.token, { type: "move", path: [{ x: "1", y: "2" }], run: false }),
      "move float coords": await act(p.token, { type: "move", path: [{ x: 3185.5, y: 3438 }], run: false }),
      "move 65 tiles": await act(p.token, { type: "move", path: Array.from({ length: 65 }, (_, i) => ({ x: 3180 + (i % 5), y: 3438 })), run: false }),
      "appearance out of range": await act(p.token, { type: "appearance", appearance: { body: 0, kits: [999, 0, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] } }),
      "emote unknown": await act(p.token, { type: "emote", emote: "dab" }),
      "stall bad id": await act(p.token, { type: "stall", depositId: "../../profiles" }),
      "announce bad tx": await act(p.token, { type: "announce", kind: "bought", tx: "0x1234" }),
      "__proto__ smuggling": await act(p.token, JSON.parse('{"type":"heartbeat","__proto__":{"admin":true}}')),
    };
    const bad = Object.entries(cases).filter(([name, r]) => {
      if (name === "__proto__ smuggling") return r.status !== 200;
      return !(r.status === 400 || r.status === 413);
    });
    report(
      "oversized and malformed payloads",
      bad.length === 0 ? "PASS" : "GAP",
      Object.entries(cases).map(([k, r]) => `${k} ${r.status}`).join(", "),
    );
    // On its own connection: the dev server drops it mid-body, which would poison a pooled one.
    const big = await new Promise((resolve) => {
      const request = http.request(`${args.api}/api/act`, {
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", authorization: `Bearer ${p.token}` },
      }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      request.on("error", () => resolve({ status: 0 }));
      request.end("z".repeat(2 * 1024 * 1024));
    });
    report("2 MB body", big.status === 413 || big.status === 500 ? "INFO" : "GAP", `status ${big.status} (Vercel caps bodies at 4.5 MB; the handler refuses over 8 KB)`);
  },

  async chatFilterEvasion() {
    const p = await joined();
    const samples = [
      "venmo me @bob-smith22",
      "dm me on t.me/scammer",
      "send to 0x5555 5555 5555 5555 5555 5555 5555 5555 5555 5555",
      "f​u​c​k",
      "scаm.cоm", // Cyrillic a and o
      "h̶e̶l̶l̶o̶",
      "ź́́́́́́algo",
      "‮moc.mac‬",
    ];
    const seen = [];
    for (const text of samples) {
      await sleep(1_300);
      const r = await act(p.token, { type: "chat", text });
      seen.push([text, r.status]);
    }
    await sleep(500);
    const chat = Object.values(await allOf("chat")).filter((c) => c.pid === p.pid).map((c) => c.m);
    report("chat filter evasion", "INFO", chat.map((m) => JSON.stringify(m)).join(" | "));
  },

  async teleportMoves() {
    const p = await joined();
    const record = await read(playerAt(p));
    const here = world.currentTiles(record, Date.now()).at(-1);
    const far = { x: 3192, y: 3446 };
    const farPath = findPath(far, { x: far.x - 1, y: far.y }) ?? [far, { x: far.x - 1, y: far.y }];
    const cases = {
      "start far away": await act(p.token, { type: "move", path: farPath, run: false }),
      "outside the map": await act(p.token, { type: "move", path: [here, { x: 1, y: 1 }], run: false }),
      "skips tiles": await act(p.token, { type: "move", path: [here, { x: here.x + 3, y: here.y }], run: false }),
      "through a wall": await act(p.token, { type: "move", path: [here, { x: 3176, y: 3438 }], run: false }),
    };
    const ok = Object.values(cases).every((r) => r.status === 400);
    report("teleport and wall-walk moves", ok ? "PASS" : "GAP", Object.entries(cases).map(([k, r]) => `${k} ${r.status} ${r.json?.error ?? ""}`).join("; "));

    // Speed: one-tile "paths" that start two tiles ahead, as fast as the action bucket allows.
    const q = await joined();
    let pos = world.currentTiles(await read(playerAt(q)), Date.now()).at(-1);
    const started = Date.now();
    let accepted = 0;
    let travelled = 0;
    while (Date.now() - started < 4_000) {
      const targets = [{ x: pos.x + 2, y: pos.y }, { x: pos.x - 2, y: pos.y }, { x: pos.x, y: pos.y + 2 }, { x: pos.x, y: pos.y - 2 }]
        .filter((t) => world.isWalkable(rules.grid, t));
      let moved = false;
      for (const target of targets) {
        const r = await act(q.token, { type: "move", path: [target], run: true });
        if (r.status === 200) {
          accepted++;
          travelled += 2;
          pos = target;
          moved = true;
          break;
        }
        if (r.status === 429) await sleep(r.json?.retryAfterMs ?? 300);
      }
      if (!moved) break;
    }
    const tilesPerSecond = travelled / ((Date.now() - started) / 1000);
    report(
      "speed hack with one-tile moves",
      tilesPerSecond <= 3.4 ? "PASS" : "GAP",
      `${accepted} moves accepted, ${tilesPerSecond.toFixed(1)} tiles/s (running is 3.3 tiles/s)`,
    );
  },

  async names() {
    const owner = await player(freshIp(), "Zezima");
    const tries = {
      "same name": "Zezima",
      "other case": "ZEZIMA",
      "separator": "Ze_zima",
      "Cyrillic e": "Zеzima",
      "reserved Mod": "Mod Ash",
      "reserved leet": "Ga11eon",
      "reserved banker": "Banker",
      "reserved suffix": "Wise trader",
      "offensive": "fuckface",
      "13 chars": "abcdefghijklm",
      "zero width": "Ze​zima",
      "leading space": " Zezima",
    };
    const out = {};
    for (const [label, name] of Object.entries(tries)) out[label] = await session(freshIp(), { name });
    // Separators are significant, as in the original ("Ze zima" and "Zezima" are different players).
    const accepted = Object.entries(out)
      .filter(([label, r]) => r.status === 200 && label !== "separator")
      .map(([k, r]) => `${k} -> ${r.json.name}`);
    report("name squatting and impersonation (ASCII and Unicode)", accepted.length === 0 ? "PASS" : "GAP", accepted.length ? `accepted: ${accepted.join(", ")}` : Object.entries(out).map(([k, r]) => `${k} ${r.status}`).join(", "));
    // Look-alikes the OSRS font draws (nearly) the same: capital I for lowercase l, zero for O.
    const lookalikes = {};
    const base = await player(freshIp(), "Wilkinson");
    const bob = await player(freshIp(), "Bob Lol");
    for (const name of ["WiIkinson", "Wi1kinson", "B0b Lol", "Bob LoI"]) lookalikes[name] = await session(freshIp(), { name });
    const taken = Object.entries(lookalikes).filter(([, r]) => r.status === 200).map(([k]) => k);
    report(
      "look-alike names (I/l/1, O/0)",
      taken.length === 0 ? "PASS" : "GAP",
      taken.length ? `accepted while ${base.name} and ${bob.name} exist: ${taken.join(", ")}` : "all refused",
    );
    void owner;
  },

  async joinLeaveChurn() {
    const p = await player();
    const proxy = await countingProxy(args.emulator);
    // Watch the world an arrival lands in now.
    const probe = await joined();
    await act(probe.token, { type: "leave" });
    const view = await subscribeWorld("churn-watch", proxy.port, {}, probe.world);
    await sleep(1_000);
    const before = proxy.totals.down;
    const out = [];
    const started = Date.now();
    for (let i = 0; i < 60; i++) {
      out.push(await join(p, probe.world));
      out.push(await act(p.token, { type: "leave" }));
    }
    const seconds = (Date.now() - started) / 1000;
    await sleep(1_000);
    const bytes = proxy.totals.down - before;
    const left = await read(`worlds/${probe.world}/players/${p.pid}`);
    await view.stop();
    await proxy.close();
    const accepted = out.filter((r) => r.status === 200).length;
    report(
      "join/leave churn from one session",
      left === null ? "PASS" : "GAP",
      `${accepted}/${out.length} accepted in ${seconds.toFixed(1)} s (${(accepted / seconds).toFixed(1)}/s); each watcher downloaded ${bytes} B; record afterwards: ${JSON.stringify(left)}`,
    );
  },

  async stalePlayers() {
    if (!CRON) return report("stale players", "INFO", "skipped: set CRON_SECRET to the dev API's throwaway value");
    const p = await joined();
    // Age the heartbeat directly in the emulator instead of waiting.
    await patch(playerAt(p), { ls: Date.now() - 10 * 60_000 });
    const cron = await fetch(`${args.api}/api/cron/prune`, { headers: { Authorization: `Bearer ${CRON}` } });
    const pruned = (await read(playerAt(p))) === null;
    const lateBeat = await act(p.token, { type: "heartbeat" });
    const lateMove = await act(p.token, { type: "move", path: [{ x: 3185, y: 3438 }, { x: 3185, y: 3439 }], run: false });
    const lateEmote = await act(p.token, { type: "emote", emote: "wave" });
    await sleep(300);
    const after = await read(playerAt(p));
    report(
      "stale players and late writes",
      pruned && after === null && lateBeat.status === 409 ? "PASS" : "GAP",
      `cron ${cron.status}, pruned ${pruned}, late heartbeat ${lateBeat.status}, late move ${lateMove.status}, late emote ${lateEmote.status}, record afterwards ${JSON.stringify(after)}`,
    );
  },

  async forgery() {
    const p = await joined();
    const noWallet = {
      stall: await act(p.token, { type: "stall", depositId: "5559" }),
      announce: await act(p.token, { type: "announce", kind: "bought", tx: `0x${"ab".repeat(32)}` }),
    };
    report(
      "stall and announce without a verified wallet",
      noWallet.stall.status === 403 && noWallet.announce.status === 403 ? "PASS" : "GAP",
      `stall ${noWallet.stall.status}, announce ${noWallet.announce.status}`,
    );
    // Pretend the player proved a throwaway wallet (emulator only) and claim other people's on-chain activity.
    const wallet = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    await patch(`profiles/${p.pid}`, { w: wallet });
    const stall = await act(p.token, { type: "stall", depositId: "5559" });
    const fakeTx = await act(p.token, { type: "announce", kind: "bought", tx: `0x${"cd".repeat(32)}` });
    report(
      "stall of someone else's deposit, announce of a missing tx",
      stall.status >= 400 && fakeTx.status >= 400 && stall.status !== 500 && fakeTx.status !== 500 ? "PASS" : "GAP",
      `stall ${stall.status} ${stall.json?.error ?? ""}; announce ${fakeTx.status} ${fakeTx.json?.error ?? ""}`,
    );
    const events = Object.values(await allOf("events")).filter((e) => e.pid === p.pid);
    report("no forged world events", events.length === 0 ? "PASS" : "GAP", `${events.length} events for the forger`);
  },

  async walletProofForgery() {
    const p = await player();
    const victim = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const challenge = await fetch(`${args.api}/api/wallet?address=${victim.address}`, { headers: { Authorization: `Bearer ${p.token}` } }).then((r) => r.json());
    if (!challenge.ok) return report("wallet proof forgery", "INFO", `no challenge: ${JSON.stringify(challenge)}`);
    const forged = await attacker.signMessage({ message: challenge.message });
    const wrong = await post(args.api, "/api/wallet", { token: p.token, address: victim.address, message: challenge.message, signature: forged }, { ip: p.ip });
    const replay = await post(args.api, "/api/wallet", { token: p.token, address: victim.address, message: challenge.message, signature: await victim.signMessage({ message: challenge.message }) }, { ip: p.ip });
    report(
      "wallet proof signed by another key, then reuse of the consumed challenge",
      wrong.status === 403 && replay.status === 400 ? "PASS" : wrong.status === 502 ? "INFO" : "GAP",
      `forged ${wrong.status} ${wrong.json?.error ?? ""}; replay ${replay.status} ${replay.json?.error ?? ""}`,
    );
  },

  async tokens() {
    const p = await joined();
    const renamed = await session(p.ip, { token: p.token, name: `Rn${Date.now() % 100000}` });
    // The old token still acts (30-day bearer token), but as the profile's current name.
    const oldTokenChat = await act(p.token, { type: "chat", text: "old token" });
    await sleep(300);
    const line = Object.values(await allOf("chat")).filter((c) => c.pid === p.pid).at(-1);
    report(
      "old token after a rename",
      oldTokenChat.status === 200 && line?.n === renamed.json?.name ? "INFO" : "GAP",
      `old token still accepted (${oldTokenChat.status}); chat shows ${line?.n} (current name ${renamed.json?.name}); tokens are 30-day bearer tokens, revocable only all at once with SESSION_NOT_BEFORE`,
    );
    const [h, payload, sig] = p.token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, pid: "aaaaaaaaaaaaaaaa", sub: "aaaaaaaaaaaaaaaa" })).toString("base64url");
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
    const cases = {
      tampered: await act(`${h}.${tamperedPayload}.${sig}`, { type: "heartbeat" }),
      "alg none": await act(none, { type: "heartbeat" }),
      "wrong secret": await act(await new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("not-the-secret-not-the-secret-!!")), { type: "heartbeat" }),
      "token in body for a move": await post(args.api, "/api/act", { type: "move", token: p.token, path: [{ x: 3185, y: 3438 }], run: false }, {}),
    };
    if (SECRET) {
      const now = Math.floor(Date.now() / 1000);
      cases.expired = await act(
        await new SignJWT({ pid: p.pid, name: p.name, wallet: null })
          .setProtectedHeader({ alg: "HS256", typ: "JWT" })
          .setIssuer("rampridge")
          .setAudience("rampridge-world")
          .setSubject(p.pid)
          .setIssuedAt(now - 40 * 86_400)
          .setExpirationTime(now - 10 * 86_400)
          .sign(SECRET),
        { type: "heartbeat" },
      );
    }
    const ok = Object.values(cases).every((r) => r.status === 401);
    report("forged, tampered and expired tokens", ok ? "PASS" : "GAP", Object.entries(cases).map(([k, r]) => `${k} ${r.status}`).join(", "));
  },

  async rules() {
    // What a browser (no credential) may read and write, straight against the emulator's rules.
    const anon = (path, init = {}) => fetch(`http://${args.emulator}/${path}.json?ns=${NS}`, init).then((r) => r.status);
    const p = await joined();
    const cases = {
      "read own world's players": [await anon(`worlds/${p.world}/players`), 200],
      "read another world's chat": [await anon("worlds/302/chat"), 200],
      "read every world at once": [await anon("worlds"), 401],
      "read meta": [await anon("meta"), 401],
      "read moderation": [await anon("moderation"), 401],
      "read profiles": [await anon("profiles"), 401],
      "read the old room (world/)": [await anon("world/players"), 401],
      "read an id that is not a world": [await anon("worlds/abc"), 401],
      "write a player": [await anon(`worlds/${p.world}/players/${p.pid}/n`, { method: "PUT", body: '"Hacker"' }), 401],
      "write chat": [await anon(`worlds/${p.world}/chat/x`, { method: "PUT", body: '{"m":"hi"}' }), 401],
    };
    const bad = Object.entries(cases).filter(([, [got, want]]) => got !== want);
    report("database rules: one world readable at a time, nothing else, no writes", bad.length === 0 ? "PASS" : "GAP", Object.entries(cases).map(([k, [got]]) => `${k} ${got}`).join(", "));
    await act(p.token, { type: "leave" });
  },

  async buildsBeforeWorlds() {
    // A tab still running the build from before worlds: it joins without a world, and its token names none.
    const p = await player();
    const join0 = await act(p.token, { type: "join", appearance: randomAppearance() });
    const beat = await act(p.token, { type: "heartbeat" });
    const chat = await act(p.token, { type: "chat", text: "old build" });
    const leave = await act(p.token, { type: "leave" });
    const anywhere = await Promise.all(worlds.worldIds().map((id) => read(`worlds/${id}/players/${p.pid}`)));
    const legacy = await read(`world/players/${p.pid}`);
    report(
      "builds from before worlds",
      join0.status === 429 && join0.json?.code === "outdated" && (join0.json?.retryAfterMs ?? 0) > 3_000 && beat.json?.code === "not_joined" && anywhere.every((r) => r === null) && legacy === null
        ? "PASS"
        : "GAP",
      `join without a world ${join0.status} ${join0.json?.code} "${join0.json?.error}" (retry ${Math.round((join0.json?.retryAfterMs ?? 0) / 60_000)} min, shown in their chatbox); heartbeat ${beat.status} ${beat.json?.code}; chat ${chat.status}; leave ${leave.status}; records written anywhere: ${anywhere.filter(Boolean).length + (legacy ? 1 : 0)}`,
    );
  },

  async worldHops() {
    const p = await joined();
    const from = p.world;
    const stale = p.token;
    const open = worlds.worldIds(Number((await read("meta/worlds")) ?? worlds.DEFAULT_OPEN_WORLDS));
    const target = open.find((id) => id !== from);
    const hop = await join(p, target, true);
    const oldRecord = await read(`worlds/${from}/players/${p.pid}`);
    const newRecord = await read(`worlds/${target}/players/${p.pid}`);
    const staleBeat = await act(stale, { type: "heartbeat" });
    const chat = await act(p.token, { type: "chat", text: `hello ${target}` });
    await sleep(300);
    const lines = Object.values((await read(`worlds/${target}/chat`)) ?? {}).filter((c) => c.pid === p.pid).length;
    const elsewhere = Object.values((await read(`worlds/${from}/chat`)) ?? {}).filter((c) => c.pid === p.pid).length;
    const closed = await join(p, worlds.LAST_WORLD, true);
    const forged = await act(p.token, { type: "join", appearance: randomAppearance(), world: 999, hop: true });
    report(
      "hops and per-world writes",
      hop.status === 200 && oldRecord === null && newRecord !== null && staleBeat.json?.code === "not_joined" && chat.status === 200 && lines === 1 && elsewhere === 0 && closed.status === 409 && forged.status === 400
        ? "PASS"
        : "GAP",
      `hop ${from} -> ${target} ${hop.status}; old record ${oldRecord === null ? "gone" : "LEFT"}; token from before the hop ${staleBeat.status} ${staleBeat.json?.code}; chat lands in ${target} (${lines}) not ${from} (${elsewhere}); hop to closed ${worlds.LAST_WORLD} ${closed.status} "${closed.json?.error}"; world 999 ${forged.status}`,
    );
    await act(p.token, { type: "leave" });
  },

  async tokenReplay() {
    // A script keeps the token /api/session gave it (or one from before a hop) and replays joins with it, to stand
    // in several worlds at once or to inflate the counts until the bank shows as full.
    const open = worlds.worldIds(Number((await read("meta/worlds")) ?? worlds.DEFAULT_OPEN_WORLDS));
    const total = async () => Object.values((await read("meta/worldPop")) ?? {}).reduce((sum, w) => sum + Math.max(0, w?.n ?? 0), 0);
    const recordsOf = async (pid) => (await Promise.all(worlds.worldIds().map((id) => read(`worlds/${id}/players/${pid}`)))).filter(Boolean).length;
    const p = await player();
    const first = p.token;
    const before = await total();
    const out = [];
    let latest = null;
    const send = async (token, body) => {
      const result = await act(token, { type: "join", appearance: randomAppearance(), ...body });
      if (result.status === 200 && result.json?.token) {
        ipOfToken.set(result.json.token, p.ip);
        latest = result.json.token;
      }
      out.push(result);
      await sleep(400);
      return result;
    };
    for (let i = 0; i < 5; i++) await send(first, { world: "auto" });
    for (const id of open) await send(first, { world: id });
    const replayed = await recordsOf(p.pid);
    // Two hops at once with the same token.
    const hops = await Promise.all(open.slice(0, 2).map((id) => act(latest, { type: "join", appearance: randomAppearance(), world: id, hop: true })));
    for (const h of hops) if (h.status === 200 && h.json?.token) (ipOfToken.set(h.json.token, p.ip), (latest = h.json.token));
    await sleep(300);
    const records = await recordsOf(p.pid);
    const seats = (await total()) - before;
    report(
      "token replay and concurrent hops (one record and one seat per player)",
      replayed === 1 && records === 1 && seats === 1 ? "PASS" : "GAP",
      `${out.length} joins with the session's token: ${JSON.stringify(countStatuses(out))}, records afterwards ${replayed}; two hops at once ${hops.map((h) => h.status).join("/")}, records ${records}; seats taken ${seats}`,
    );
    for (const token of [latest, first]) await act(token, { type: "leave" });
  },

  async seatCounts() {
    // Every leave and hop out gives its seat back, even when a whole world leaves at once on one instance.
    const [from, to] = worlds.worldIds(2);
    const count = async (id) => (await read(`meta/worldPop/${id}/n`)) ?? 0;
    const [from0, to0] = [await count(from), await count(to)];
    const crowd = [];
    for (let i = 0; i < 40; i++) {
      const p = await player();
      const result = await join(p, from);
      if (result.status === 200 && p.world === from) crowd.push(p);
    }
    const joinedCount = await count(from);
    const hoppers = crowd.slice(0, 10);
    const leavers = crowd.slice(10);
    const hops = await Promise.all(hoppers.map((p) => join(p, to, true)));
    const leaves = await Promise.all(leavers.map((p) => act(p.token, { type: "leave" })));
    await sleep(300);
    const [from1, to1] = [await count(from), await count(to)];
    const hopped = hops.filter((h) => h.status === 200).length;
    report(
      "seat counts under concurrent leaves and hops (meta/worldPop)",
      joinedCount - from0 === crowd.length && from1 === from0 && to1 - to0 === hopped ? "PASS" : "GAP",
      `${crowd.length} joined ${from} (count +${joinedCount - from0}); ${leaves.length} left and ${hopped} hopped to ${to} at once (${JSON.stringify(countStatuses([...hops, ...leaves]))}); ${from} back to ${from1} (was ${from0}), ${to} +${to1 - to0}`,
    );
    for (const p of hoppers) await act(p.token, { type: "leave" });
  },

  async nameCheckEnumeration() {
    const p = await player();
    const out = [];
    for (let i = 0; i < 30; i++) out.push(await session(p.ip, { token: p.token, name: `Probe${i}`, check: true }));
    const ok = out.filter((r) => r.status === 200).length;
    report("name availability enumeration", ok <= 12 ? "PASS" : "GAP", `${ok} of 30 checks answered in a burst (action bucket: 10, then 3/s)`);
  },
};

const selected = args.only ? args.only.split(",") : Object.keys(checks);
for (const name of selected) {
  try {
    await checks[name]();
  } catch (err) {
    report(name, "FAIL", err instanceof Error ? err.message : String(err));
  }
}
if (args.out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
}
process.exit(0);
