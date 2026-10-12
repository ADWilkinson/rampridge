/**
 * Shared pieces for the load and abuse scripts: the shared/ TypeScript
 * modules (loaded through Node's type stripping, mapping the repo's `.js`
 * import specifiers to `.ts`), a byte- and frame-counting TCP proxy in front
 * of the database emulator, a browser-like world subscription, and small
 * HTTP and statistics helpers.
 *
 * These scripts only ever talk to the local dev API and the Firebase
 * emulator. `assertLocal` refuses anything else so a typo cannot point a
 * swarm at production.
 */

import { registerHooks } from "node:module";
import net from "node:net";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err).code;
      if (code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});

export const protocol = await import("../../shared/protocol.ts");
export const world = await import("../../shared/world.ts");
export const worlds = await import("../../shared/worlds.ts");
const collision = (await import("../../shared/collision.json", { with: { type: "json" } })).default;
const meta = (await import("../../shared/world-meta.json", { with: { type: "json" } })).default;
export const rules = world.worldRulesFromBake(collision, meta);

export const NAMESPACE = "rampridge-world";
export const DATABASE_URL = `https://${NAMESPACE}.firebaseio.com`;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Throws unless `url` (or host:port) is on this machine. */
export function assertLocal(target, what) {
  const host = target.includes("://") ? new URL(target).hostname : target.split(":")[0];
  if (!LOCAL_HOSTS.has(host)) throw new Error(`${what} must be local (got ${target}); these scripts never touch production.`);
}

export function parseArgs(argv, defaults) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    const next = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
    const current = out[key];
    out[key] = typeof current === "number" ? Number(next) : typeof current === "boolean" ? next === "true" : next;
  }
  return out;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
  return {
    n: sorted.length,
    mean: mean === null ? null : Math.round(mean * 10) / 10,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? null,
  };
}

/**
 * A TCP proxy to the emulator that counts what each connection downloads:
 * bytes and WebSocket frames (server frames are unmasked; the HTTP upgrade
 * response is skipped). One browser tab is one connection.
 */
export function countingProxy(target) {
  const [host, portText] = target.split(":");
  const port = Number(portText);
  const sockets = [];
  const totals = { down: 0, up: 0, frames: 0 };
  const server = net.createServer((client) => {
    const entry = { down: 0, up: 0, frames: 0, openedAt: Date.now(), closedAt: null };
    sockets.push(entry);
    const upstream = net.connect(port, host);
    let headerDone = false;
    let pending = Buffer.alloc(0);
    const countFrames = (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (!headerDone) {
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) return;
        headerDone = true;
        pending = pending.subarray(end + 4);
      }
      for (;;) {
        if (pending.length < 2) return;
        let len = pending[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (pending.length < 4) return;
          len = pending.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (pending.length < 10) return;
          len = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        if (pending[1] & 0x80) offset += 4;
        if (pending.length < offset + len) return;
        entry.frames++;
        totals.frames++;
        pending = pending.subarray(offset + len);
      }
    };
    upstream.on("data", (chunk) => {
      entry.down += chunk.length;
      totals.down += chunk.length;
      countFrames(chunk);
    });
    client.on("data", (chunk) => {
      entry.up += chunk.length;
      totals.up += chunk.length;
    });
    upstream.pipe(client);
    client.pipe(upstream);
    const close = () => {
      entry.closedAt ??= Date.now();
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: /** @type {import("node:net").AddressInfo} */ (server.address()).port,
        sockets,
        totals,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** JSON POST with timing. Never throws for HTTP errors; network failures come back as status 0. */
export async function post(api, path, body, { token, ip, contentType = "application/json", raw, headers = {} } = {}) {
  const h = { ...headers };
  if (contentType) h["content-type"] = contentType;
  if (token) h.authorization = `Bearer ${token}`;
  if (ip) h["x-vercel-forwarded-for"] = ip;
  const started = performance.now();
  try {
    const response = await fetch(`${api}${path}`, { method: "POST", headers: h, body: raw ?? JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON error page.
    }
    return { status: response.status, json, ms: performance.now() - started };
  } catch (err) {
    return { status: 0, json: { error: err instanceof Error ? err.message : String(err) }, ms: performance.now() - started };
  }
}

/** Walkable tiles reachable from the spawn, for random walks. */
export function reachableTiles() {
  const { grid, spawn } = rules;
  const start = spawn.find((t) => world.isWalkable(grid, t)) ?? world.SPAWN_TILE;
  const seen = new Map([[`${start.x},${start.y}`, start]]);
  const queue = [start];
  while (queue.length) {
    const tile = queue.shift();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const step = { x: tile.x + dx, y: tile.y + dy };
        const key = `${step.x},${step.y}`;
        if (seen.has(key) || !world.canStep(grid, tile, step)) continue;
        seen.set(key, step);
        queue.push(step);
      }
    }
  }
  return [...seen.values()];
}

/** Shortest legal path (inclusive of both ends) on the baked grid, or null. */
export function findPath(from, to, maxSteps = protocol.MAX_PATH_STEPS - 1) {
  const { grid } = rules;
  const key = (t) => `${t.x},${t.y}`;
  const parents = new Map([[key(from), null]]);
  let frontier = [from];
  for (let depth = 0; depth < maxSteps && frontier.length; depth++) {
    const next = [];
    for (const tile of frontier) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const step = { x: tile.x + dx, y: tile.y + dy };
          const k = key(step);
          if (parents.has(k) || !world.canStep(grid, tile, step)) continue;
          parents.set(k, tile);
          if (step.x === to.x && step.y === to.y) {
            const path = [step];
            for (let p = tile; p; p = parents.get(key(p))) path.unshift(p);
            return path;
          }
          next.push(step);
        }
      }
    }
    frontier = next;
  }
  return null;
}

export function randomAppearance(random = Math.random) {
  const body = random() < 0.5 ? 0 : 1;
  const limits = world.APPEARANCE_LIMITS;
  return {
    body,
    kits: limits.kits[body].map((n) => Math.floor(random() * n)),
    colors: limits.colors.map((n) => Math.floor(random() * n)),
  };
}

/** Writes `value` at `path` in the emulator with its owner credential (which only the emulator accepts). */
export async function emulatorPut(emulator, path, value) {
  assertLocal(emulator, "emulator");
  const response = await fetch(`http://${emulator}/${path}.json?ns=${NAMESPACE}`, {
    method: value === null ? "DELETE" : "PUT",
    headers: { Authorization: "Bearer owner" },
    body: value === null ? undefined : JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`emulator ${path}: ${response.status}`);
}

/** Reads `path` from the emulator with its owner credential; `shallow` returns only the child keys. */
export async function emulatorGet(emulator, path, { shallow = false } = {}) {
  assertLocal(emulator, "emulator");
  const response = await fetch(`http://${emulator}/${path}.json?ns=${NAMESPACE}${shallow ? "&shallow=true" : ""}`, {
    headers: { Authorization: "Bearer owner" },
  });
  if (!response.ok) throw new Error(`emulator ${path}: ${response.status}`);
  return response.json();
}

/**
 * Subscribes to one world's `worlds/{id}/*` exactly as src/net/transport.ts
 * does in a browser, through `proxyPort`. Returns the live player map and a
 * stop function.
 */
export async function subscribeWorld(name, proxyPort, counters, worldId = worlds.FIRST_WORLD) {
  const { initializeApp, deleteApp } = await import("firebase/app");
  const db = await import("firebase/database");
  const app = initializeApp({ databaseURL: DATABASE_URL }, name);
  const database = db.getDatabase(app);
  db.connectDatabaseEmulator(database, "127.0.0.1", proxyPort);
  const players = new Map();
  const unsubscribes = [];
  let offset = 0;
  let connectedAt = null;
  const count = (kind) => {
    counters[kind] = (counters[kind] ?? 0) + 1;
  };
  unsubscribes.push(
    db.onValue(db.ref(database, ".info/connected"), (snap) => {
      if (snap.val() === true) connectedAt ??= Date.now();
    }),
    db.onValue(db.ref(database, ".info/serverTimeOffset"), (snap) => {
      if (typeof snap.val() === "number") offset = snap.val();
    }),
  );
  const playersRef = db.ref(database, worlds.playersPath(worldId));
  unsubscribes.push(
    db.onChildAdded(playersRef, (snap) => {
      count("playerAdded");
      players.set(snap.key, snap.val());
    }),
    db.onChildChanged(playersRef, (snap) => {
      count("playerChanged");
      players.set(snap.key, snap.val());
    }),
    db.onChildRemoved(playersRef, (snap) => {
      count("playerRemoved");
      players.delete(snap.key);
    }),
  );
  for (const [stream, path, limit] of [
    ["chat", worlds.chatPath(worldId), 50],
    ["events", worlds.eventsPath(worldId), 20],
  ]) {
    const recent = db.query(db.ref(database, path), db.orderByChild("t"), db.limitToLast(limit));
    unsubscribes.push(db.onChildAdded(recent, () => count(stream)));
  }
  return {
    players,
    serverNow: () => Date.now() + offset,
    connected: () => connectedAt !== null,
    async stop() {
      for (const unsubscribe of unsubscribes) unsubscribe();
      db.goOffline(database);
      await deleteApp(app);
    },
  };
}
