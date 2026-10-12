import { getContracts, resolveFiatCurrencyBytes32, resolvePaymentMethodHash } from "@zkp2p/sdk";
import { erc20Abi, getAddress, verifyMessage } from "viem";
import type { Abi, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { beforeEach, describe, expect, it } from "vitest";
import { encodePath, HEARTBEAT_MS, PLAYER_TIMEOUT_MS } from "../../shared/protocol";
import type { ActResponse, PlayerRecord, SessionResponse } from "../../shared/protocol";
import { DEFAULT_APPEARANCE, SPAWN_TILE } from "../../shared/world";
import type { ApiErrorBody, WalletChallengeResponse } from "../../shared/world";
import type { DepositRead, SiweProof } from "./chain";
import { ConfigError } from "./env";
import { createActHandler } from "./handlers/act";
import { createPruneHandler } from "./handlers/prune";
import { createSessionHandler } from "./handlers/session";
import { createWalletHandlers } from "./handlers/wallet";
import { PRESENCE_REFRESH_MS } from "./players";
import { CHAT_KEEP, EVENTS_KEEP, LIGHT_PRUNE_INTERVAL_MS } from "./prune";
import { ACTION_BUCKET, CHAIN_BUCKET, CHAT_LIMIT, ROOM_CHAT_LIMIT, SESSION_CREATE_BUCKET } from "./ratelimit";
import { STALL_INDEX_IDLE_MS, STALL_RECHECK_MS, STALL_SWEEP_INTERVAL_MS } from "./stallSweep";
import { encodeLog, jsonRequest, readBody, TEST_CRON_SECRET, testDeps } from "./testing";
import type { TestDeps } from "./testing";
import { verifySession } from "./token";
import { TEST_SECRET } from "./testing";
import { bakedWorldRules } from "./worldRules";

type Body = Record<string, unknown>;

let deps: TestDeps;
let session: (body: unknown, headers?: Record<string, string>) => Promise<Response>;
let act: (token: string | undefined, body: unknown) => Promise<Response>;

beforeEach(() => {
  deps = testDeps();
  const sessionHandler = createSessionHandler(deps);
  const actHandler = createActHandler(deps);
  session = (body, headers) => sessionHandler(jsonRequest("/api/session", body, { headers }));
  act = (token, body) => actHandler(jsonRequest("/api/act", body, { token }));
});

async function newPlayer(name?: string): Promise<SessionResponse & { token: string; pid: string; name: string }> {
  const response = await session(name === undefined ? {} : { name });
  expect(response.status).toBe(200);
  return (await response.json()) as SessionResponse & { token: string; pid: string; name: string };
}

/** Joins (the first world, in an empty bank) and adopts the token the join answers with, as the client does. */
async function join(player: { token: string }): Promise<Response> {
  const response = await act(player.token, { type: "join", appearance: DEFAULT_APPEARANCE, world: "auto" });
  if (response.status === 200) {
    const body = await readBody<ActResponse>(response.clone());
    if (body.token) player.token = body.token;
  }
  return response;
}

async function joined(name?: string) {
  const player = await newPlayer(name);
  expect((await join(player)).status).toBe(200);
  return player;
}

const W = "worlds/301";

function record(pid: string): PlayerRecord {
  return deps.memory.read(`${W}/players/${pid}`) as PlayerRecord;
}

async function expectError(response: Response, status: number, code?: string): Promise<ApiErrorBody> {
  expect(response.status).toBe(status);
  const body = await readBody<ApiErrorBody>(response);
  expect(body.ok).toBe(false);
  if (code) expect(body.code).toBe(code);
  expect(typeof body.error).toBe("string");
  return body;
}

describe("POST /api/session", () => {
  it("creates a guest with a unique Guest name and a valid token", async () => {
    const player = await newPlayer();
    expect(player.name).toMatch(/^Guest\d{4}$/);
    expect(player.pid).toMatch(/^[0-9a-z]{16}$/);
    expect(player.wallet).toBeNull();
    expect(await verifySession(player.token, TEST_SECRET, deps.clock.now)).toEqual({
      pid: player.pid,
      name: player.name,
      wallet: null,
    });
    // No world until the first join.
    expect(player.world).toBeNull();
    expect(deps.memory.read(`profiles/${player.pid}`)).toMatchObject({ n: player.name, k: player.name.toLowerCase() });
    expect(deps.memory.read(`names/${player.name.toLowerCase()}`)).toBe(player.pid);
  });

  it("keeps names unique, ignoring case and separators", async () => {
    await newPlayer("Zezima");
    await expectError(await session({ name: "zEZIMA" }), 409, "name_taken");
    await newPlayer("Bob The-1");
    await expectError(await session({ name: "bob_the 1" }), 409, "name_taken");
  });

  it("rejects invalid and reserved names", async () => {
    await expectError(await session({ name: "Mod Ash" }), 400, "bad_request");
    for (const name of ["Mod_Ash", "PeerSupport", "Banker", "RampRidge", "News", "Wise trader"]) {
      expect((await expectError(await session({ name }), 400, "bad_request")).error).toMatch(/reserved/);
    }
    await expectError(await session({ name: "a".repeat(13) }), 400, "bad_request");
    await expectError(await session({ name: 42 }), 400, "bad_request");
  });

  it("refreshes a valid token for the same player", async () => {
    const player = await newPlayer("Lynx");
    deps.clock.now += 60_000;
    const refreshed = await readBody<SessionResponse>(await session({ token: player.token }));
    expect(refreshed).toMatchObject({ ok: true, pid: player.pid, name: "Lynx", wallet: null });
    expect(refreshed.token).not.toBe(player.token);
  });

  it("renames, releasing the old name, and updates the player in the world", async () => {
    const player = await newPlayer("Lynx");
    await join(player);
    const renamed = await readBody<SessionResponse>(await session({ token: player.token, name: "Titan" }));
    expect(renamed.name).toBe("Titan");
    expect(deps.memory.read("names/lynx")).toBeNull();
    expect(deps.memory.read("names/titan")).toBe(player.pid);
    expect(record(player.pid).n).toBe("Titan");
    // The old name is free for someone else now.
    expect((await newPlayer("lynx")).name).toBe("lynx");
    // A case-only change keeps the same key.
    const recased = await readBody<SessionResponse>(await session({ token: renamed.token, name: "TITAN" }));
    expect(recased.name).toBe("TITAN");
    expect(deps.memory.read("names/titan")).toBe(player.pid);
  });

  it("will not rename onto a taken name", async () => {
    await newPlayer("Zezima");
    const player = await newPlayer("Lynx");
    await expectError(await session({ token: player.token, name: "zezima" }), 409, "name_taken");
    expect(deps.memory.read("names/lynx")).toBe(player.pid);
  });

  it("starts a new player when the token is expired or forged", async () => {
    const player = await newPlayer("Lynx");
    deps.clock.now += 31 * 24 * 60 * 60 * 1000;
    const fresh = await readBody<SessionResponse>(await session({ token: player.token }));
    expect(fresh.pid).not.toBe(player.pid);
    const forged = await readBody<SessionResponse>(await session({ token: "garbage" }));
    expect(forged.ok).toBe(true);
  });

  it("rebuilds a profile that went missing, keeping the name", async () => {
    const player = await newPlayer("Lynx");
    deps.memory.write(`profiles/${player.pid}`, null);
    const restored = await readBody<SessionResponse>(await session({ token: player.token }));
    expect(restored).toMatchObject({ pid: player.pid, name: "Lynx" });
    expect(deps.memory.read(`profiles/${player.pid}`)).toMatchObject({ n: "Lynx" });
  });

  it("limits new players per IP, as Vercel reports it", async () => {
    const headers = { "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "198.51.100.7, 10.0.0.1" };
    for (let i = 0; i < SESSION_CREATE_BUCKET.capacity; i++) expect((await session({}, headers)).status).toBe(200);
    const limited = await session({}, headers);
    const body = await expectError(limited, 429, "rate_limited");
    expect(body.retryAfterMs).toBe(10_000);
    expect(limited.headers.get("retry-after")).toBe("10");
    // A client-supplied x-forwarded-for does not dodge the limit.
    await expectError(await session({}, { "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "203.0.113.1" }), 429);
    expect((await session({}, { "x-vercel-forwarded-for": "198.51.100.8" })).status).toBe(200);
    // The bucket refills: one more player ten seconds later.
    deps.clock.now += 10_000;
    expect((await session({}, headers)).status).toBe(200);
    expect(JSON.stringify(deps.memory.root)).not.toContain("198.51.100");
  });

  it("refuses browser requests from other sites and bodies that are not JSON", async () => {
    const handler = createSessionHandler(deps);
    const from = (url: string, headers: Record<string, string>) =>
      handler(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" }));
    await expectError(await from("https://www.rampridge.xyz/api/session", { Origin: "https://evil.example" }), 403, "forbidden");
    await expectError(await from("https://www.rampridge.xyz/api/session", { "Sec-Fetch-Site": "cross-site" }), 403, "forbidden");
    await expectError(await from("https://www.rampridge.xyz/api/session", { Origin: "null" }), 403, "forbidden");
    await expectError(await from("https://www.rampridge.xyz/api/session", { Origin: "http://localhost:5210" }), 403, "forbidden");
    // The no-cors text/plain POST another site could send.
    const simple = await handler(
      new Request("https://www.rampridge.xyz/api/session", { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: "{}" }),
    );
    await expectError(simple, 415, "bad_request");
    expect(deps.memory.read("profiles")).toBeNull();
    expect(deps.memory.read("ratelimits")).toBeNull();

    expect((await from("https://www.rampridge.xyz/api/session", { Origin: "https://www.rampridge.xyz", "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    expect((await from("http://localhost:5210/api/session", { Origin: "http://localhost:5210" })).status).toBe(200);
    expect((await from("https://www.rampridge.xyz/api/session", { Origin: "http://localhost:5173" })).status).toBe(200);
  });

  it("checks a name without claiming or renaming anything", async () => {
    await newPlayer("Zezima");
    const player = await newPlayer("Lynx");
    const before = JSON.stringify({ profiles: deps.memory.read("profiles"), names: deps.memory.read("names") });
    const check = (name: string, token: string | undefined = player.token) => session({ token, name, check: true });

    expect(await readBody<SessionResponse>(await check("  Titan "))).toEqual({ ok: true, available: true, name: "Titan", now: deps.clock.now });
    // The player's own name, in any case or separator, is available to them.
    expect(await readBody<SessionResponse>(await check("LYNX"))).toMatchObject({ available: true, name: "LYNX" });
    await expectError(await check("zezima"), 409, "name_taken");
    expect((await expectError(await check("Banker"), 400, "bad_request")).error).toBe("That name is reserved. Please choose another.");
    await expectError(await check("a".repeat(13)), 400, "bad_request");
    await expectError(await session({ name: "Titan", check: true }), 401, "unauthorized");
    await expectError(await check("Titan", "garbage"), 401, "unauthorized");
    await expectError(await session({ token: player.token, check: true }), 400, "bad_request");

    expect(JSON.stringify({ profiles: deps.memory.read("profiles"), names: deps.memory.read("names") })).toBe(before);
    expect(deps.memory.read("names/titan")).toBeNull();
  });

  it("refuses tokens issued before SESSION_NOT_BEFORE", async () => {
    const player = await joined("Lynx");
    deps.clock.now += 60_000;
    const cutoff = Math.floor(deps.clock.now / 1000);
    deps.sessionNotBefore = () => cutoff;
    await expectError(await act(player.token, { type: "heartbeat" }), 401, "unauthorized");
    const handler = createSessionHandler(deps);
    const fresh = await readBody<SessionResponse>(await handler(jsonRequest("/api/session", { token: player.token })));
    expect(fresh.pid).not.toBe(player.pid);
    deps.clock.now += 1_000;
    expect((await createActHandler(deps)(jsonRequest("/api/act", { type: "join", appearance: DEFAULT_APPEARANCE, world: "auto" }, { token: fresh.token }))).status).toBe(200);
  });

  it("fails clearly when the server is not configured", async () => {
    const handler = createSessionHandler({
      ...deps,
      sessionSecret: () => {
        throw new ConfigError("Server misconfigured: SESSION_SECRET is not set.");
      },
    });
    const body = await expectError(await handler(jsonRequest("/api/session", {})), 500, "server");
    expect(body.error).toContain("SESSION_SECRET");
  });
});

describe("POST /api/act", () => {
  it("requires a valid token", async () => {
    await expectError(await act(undefined, { type: "heartbeat" }), 401, "unauthorized");
    await expectError(await act("nope", { type: "heartbeat" }), 401, "unauthorized");
  });

  it("rejects malformed bodies", async () => {
    const player = await newPlayer();
    await expectError(await act(player.token, { type: "teleport" }), 400, "bad_request");
    const raw = await createActHandler(deps)(
      new Request("https://www.rampridge.xyz/api/act", {
        method: "POST",
        headers: { Authorization: `Bearer ${player.token}` },
        body: "{not json",
      }),
    );
    await expectError(raw, 400, "bad_request");
    const huge = await act(player.token, { type: "chat", text: "x".repeat(10_000) });
    await expectError(huge, 413, "payload_too_large");
  });

  it("joins at the spawn with server time and the profile name", async () => {
    const player = await joined("Lynx");
    const rec = record(player.pid);
    expect(rec).toMatchObject({ n: "Lynx", r: false, t: deps.clock.now, ls: deps.clock.now, j: deps.clock.now });
    expect(rec.a).toEqual(DEFAULT_APPEARANCE);
    const [x, y] = rec.p.split(",").map(Number) as [number, number];
    expect(Math.abs(x - SPAWN_TILE.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(y - SPAWN_TILE.y)).toBeLessThanOrEqual(2);
  });

  it("joins inside the hall on the baked world, not in the doorway", async () => {
    deps.worldRules = bakedWorldRules;
    act = (token, body) => createActHandler(deps)(jsonRequest("/api/act", body, { token }));
    const arrivals = new Set(bakedWorldRules().spawn.map((t) => `${t.x},${t.y}`));
    for (const random of [0, 0.5, 0.999]) {
      deps.random = () => random;
      const player = await joined();
      const [x, y] = record(player.pid).p.split(",").map(Number) as [number, number];
      expect(arrivals.has(`${x},${y}`), `${x},${y}`).toBe(true);
      expect(y === 3435 || y === 3436, `${x},${y}`).toBe(true);
    }
  });

  it("responds with the server time, and a join with its world and a token naming it", async () => {
    const player = await newPlayer();
    const body = await readBody<ActResponse>(await act(player.token, { type: "join", appearance: DEFAULT_APPEARANCE, world: "auto" }));
    expect(body).toEqual({ ok: true, now: deps.clock.now, world: 301, token: expect.any(String) });
    expect(await verifySession(body.token!, TEST_SECRET, deps.clock.now)).toEqual({ pid: player.pid, name: player.name, wallet: null, world: 301 });
    expect(await readBody(await act(body.token, { type: "heartbeat" }))).toEqual({ ok: true, now: deps.clock.now });
  });

  it("moves along a legal path and records it for replay", async () => {
    const player = await joined();
    const start = encodePath([SPAWN_TILE]);
    deps.memory.write(`${W}/players/${player.pid}/p`, start);
    deps.clock.now += 5_000;
    const path = [SPAWN_TILE, { x: SPAWN_TILE.x + 1, y: SPAWN_TILE.y + 1 }, { x: SPAWN_TILE.x + 2, y: SPAWN_TILE.y + 1 }];
    expect((await act(player.token, { type: "emote", emote: "wave" })).status).toBe(200);
    expect((await act(player.token, { type: "move", path, run: true })).status).toBe(200);
    expect(record(player.pid)).toMatchObject({ p: encodePath(path), t: deps.clock.now, r: true });
    expect(record(player.pid).e).toBeUndefined();
  });

  it("rejects illegal moves", async () => {
    const player = await joined();
    deps.memory.write(`${W}/players/${player.pid}/p`, encodePath([SPAWN_TILE]));
    const far = { x: SPAWN_TILE.x + 5, y: SPAWN_TILE.y };
    await expectError(await act(player.token, { type: "move", path: [far], run: false }), 400, "bad_request");
    const gap = [SPAWN_TILE, { x: SPAWN_TILE.x + 2, y: SPAWN_TILE.y }];
    await expectError(await act(player.token, { type: "move", path: gap, run: false }), 400, "bad_request");
    const outside = [SPAWN_TILE, { x: SPAWN_TILE.x, y: SPAWN_TILE.y - 1 }, { x: 3000, y: 3000 }];
    await expectError(await act(player.token, { type: "move", path: outside, run: false }), 400, "bad_request");
    expect(record(player.pid).p).toBe(encodePath([SPAWN_TILE]));
  });

  it("needs a join before world actions", async () => {
    const player = await newPlayer();
    for (const body of [
      { type: "heartbeat" },
      { type: "move", path: [SPAWN_TILE], run: false },
      { type: "emote", emote: "bow" },
      { type: "chat", text: "hi" },
      { type: "appearance", appearance: DEFAULT_APPEARANCE },
    ]) {
      deps.clock.now += 2_000;
      await expectError(await act(player.token, body), 409, "not_joined");
    }
    // Nothing was created by those attempts.
    expect(deps.memory.read(`${W}/players/${player.pid}`)).toBeNull();
  });

  it("heartbeats write only the player's ls, never the whole record, and only every other time", async () => {
    const player = await joined();
    const before = record(player.pid);
    // Within PRESENCE_REFRESH_MS of the last write a heartbeat confirms presence and writes nothing.
    deps.clock.now += HEARTBEAT_MS;
    expect((await act(player.token, { type: "heartbeat" })).status).toBe(200);
    expect(record(player.pid)).toEqual(before);

    const writes: string[] = [];
    const memory = deps.memory;
    const transaction = memory.transaction.bind(memory);
    const set = memory.set.bind(memory);
    const update = memory.update.bind(memory);
    memory.transaction = (path, change) => {
      writes.push(`transaction ${path}`);
      return transaction(path, change);
    };
    memory.set = (path, value) => {
      writes.push(`set ${path}`);
      return set(path, value);
    };
    memory.update = (updates) => {
      writes.push(...Object.keys(updates).map((path) => `update ${path}`));
      return update(updates);
    };

    deps.clock.now += HEARTBEAT_MS;
    expect(deps.clock.now - before.ls).toBeGreaterThanOrEqual(PRESENCE_REFRESH_MS);
    expect((await act(player.token, { type: "heartbeat" })).status).toBe(200);
    // (Sweep claims, checked below, are the only other writes a heartbeat may make.)
    expect(writes.filter((w) => !w.startsWith("transaction meta/"))).toEqual([
      `transaction ratelimits/act/${player.pid}`,
      `transaction ${W}/players/${player.pid}/ls`,
    ]);
    expect(record(player.pid)).toEqual({ ...before, ls: deps.clock.now });

    // When this instance is due to sweep, one more transaction claims it for every instance.
    writes.length = 0;
    deps.clock.now += STALL_SWEEP_INTERVAL_MS;
    await act(player.token, { type: "heartbeat" });
    expect(writes.filter((w) => w.startsWith("transaction meta/"))).toEqual(["transaction meta/sweep"]);
  });

  it("never brings back a player who left with a late heartbeat", async () => {
    const player = await joined();
    await act(player.token, { type: "leave" });
    deps.clock.now += 1_000;
    await expectError(await act(player.token, { type: "heartbeat" }), 409, "not_joined");
    expect(deps.memory.read(`${W}/players/${player.pid}`)).toBeNull();
  });

  it("caps chat across a world", async () => {
    const players = [];
    for (let i = 0; i <= ROOM_CHAT_LIMIT.perWindow; i++) players.push(await joined());
    for (const player of players.slice(0, ROOM_CHAT_LIMIT.perWindow)) {
      expect((await act(player.token, { type: "chat", text: "selling usdc" })).status).toBe(200);
    }
    const busy = await expectError(await act(players.at(-1)!.token, { type: "chat", text: "me too" }), 429, "rate_limited");
    expect(busy.retryAfterMs).toBeLessThanOrEqual(ROOM_CHAT_LIMIT.windowMs);
    expect(Object.keys(deps.memory.read(`${W}/chat`) as Body)).toHaveLength(ROOM_CHAT_LIMIT.perWindow);
    // The refused message still counted against the sender's own pace.
    deps.clock.now += CHAT_LIMIT.minIntervalMs;
    expect((await act(players.at(-1)!.token, { type: "chat", text: "me too" })).status).toBe(200);
  });

  it("filters chat, keeps effects and limits the pace", async () => {
    const player = await joined("Lynx");
    expect((await act(player.token, { type: "chat", text: "red:wave:fuck off, pay $alice at www.scam.io" })).status).toBe(200);
    const chat = deps.memory.read(`${W}/chat`) as Record<string, Body>;
    expect(Object.values(chat)).toEqual([
      { pid: player.pid, n: "Lynx", m: "**** off, pay ****** at ***********", fx: "red:wave", t: deps.clock.now },
    ]);
    const limited = await act(player.token, { type: "chat", text: "again" });
    const body = await expectError(limited, 429, "rate_limited");
    expect(body.retryAfterMs).toBe(1_200);
    deps.clock.now += 1_200;
    expect((await act(player.token, { type: "chat", text: "again" })).status).toBe(200);
    await expectError(await act(player.token, { type: "chat", text: "   " }), 400, "bad_request");
  });

  it("rate-limits bursts of actions", async () => {
    const player = await joined();
    let limited: Response | null = null;
    for (let i = 0; i < ACTION_BUCKET.capacity + 1; i++) {
      const response = await act(player.token, { type: "emote", emote: "dance" });
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    expect(limited).not.toBeNull();
  });

  it("updates emotes, appearance and heartbeats", async () => {
    const player = await joined();
    deps.clock.now += 1_000;
    await act(player.token, { type: "emote", emote: "cheer" });
    expect(record(player.pid)).toMatchObject({ e: "cheer", et: deps.clock.now });
    const look = { body: 1, kits: [72, 14, 1, 1, 0, 3, 1], colors: [24, 4, 5, 1, 2] };
    await act(player.token, { type: "appearance", appearance: look });
    expect(record(player.pid).a).toEqual(look);
    // Female hair 72 has no male equivalent.
    await expectError(await act(player.token, { type: "appearance", appearance: { ...look, body: 0 } }), 400);
    deps.clock.now += PRESENCE_REFRESH_MS;
    await act(player.token, { type: "heartbeat" });
    expect(record(player.pid).ls).toBe(deps.clock.now);
  });

  it("leaves, including via a sendBeacon body token", async () => {
    const player = await joined();
    expect((await act(player.token, { type: "leave" })).status).toBe(200);
    expect(deps.memory.read(`${W}/players/${player.pid}`)).toBeNull();
    await join(player);
    const beacon = await createActHandler(deps)(
      new Request("https://www.rampridge.xyz/api/act", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ type: "leave", token: player.token }),
      }),
    );
    expect(beacon.status).toBe(200);
    expect(deps.memory.read(`${W}/players/${player.pid}`)).toBeNull();
    // Only leave may carry the token in the body.
    await expectError(
      await createActHandler(deps)(jsonRequest("/api/act", { type: "heartbeat", token: player.token })),
      401,
    );
  });

  it("prunes silent players during heartbeats, at most every 30 s", async () => {
    const quiet = await joined();
    const active = await joined();
    deps.clock.now += PLAYER_TIMEOUT_MS + 1;
    await act(active.token, { type: "heartbeat" });
    expect(deps.memory.read(`${W}/players/${quiet.pid}`)).toBeNull();
    expect(deps.memory.read(`${W}/players/${active.pid}`)).not.toBeNull();
    expect(deps.memory.read("meta/sweep/p")).toBe(deps.clock.now);

    const late = await joined();
    deps.memory.write(`${W}/players/${late.pid}/ls`, deps.clock.now - PLAYER_TIMEOUT_MS - 1);
    deps.clock.now += LIGHT_PRUNE_INTERVAL_MS - 1;
    await act(active.token, { type: "heartbeat" });
    expect(deps.memory.read(`${W}/players/${late.pid}`)).not.toBeNull();
  });
});

describe("stalls", () => {
  const wallet = "0x4068d180e4051c7abc91bc17b897738622f1cbbb";
  const revolut = resolvePaymentMethodHash("revolut", { env: "production" });
  const gbp = resolveFiatCurrencyBytes32("GBP");
  const deposit = (overrides: Partial<DepositRead> = {}): DepositRead => ({
    depositId: 5559n,
    depositor: wallet,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    acceptingIntents: true,
    available: 9_966_326n,
    paymentMethods: [
      { hash: revolut, active: true, currencies: [{ code: gbp, minConversionRate: 750_000_000_000_000_000n }] },
    ],
    ...overrides,
  });

  async function verifiedPlayer(name = "Seller") {
    const player = await joined(name);
    deps.memory.write(`profiles/${player.pid}/w`, wallet);
    deps.memory.write(`${W}/players/${player.pid}/w`, wallet);
    return player;
  }

  it("requires a verified wallet", async () => {
    const player = await joined();
    await expectError(await act(player.token, { type: "stall", depositId: "5559" }), 403, "forbidden");
  });

  it("advertises an owned, live deposit at its effective rate", async () => {
    deps.chainStub.readDeposit = async (id) => (id === 5559n ? deposit() : null);
    deps.chainStub.effectiveRate = async () => 770_450_940_403_353_726n;
    const player = await verifiedPlayer();
    expect((await act(player.token, { type: "stall", depositId: "5559" })).status).toBe(200);
    expect(record(player.pid).s).toEqual({
      depositId: `${deps.chainStub.contracts.escrow}_5559`,
      escrow: deps.chainStub.contracts.escrow,
      platform: "revolut",
      currency: "GBP",
      available: "9.966326",
      rate: "0.77045",
    });
    deps.clock.now += 1_000;
    await act(player.token, { type: "stall", depositId: null });
    expect(record(player.pid).s).toBeUndefined();
  });

  it("falls back to the minimum rate when the effective rate is unavailable", async () => {
    deps.chainStub.readDeposit = async () => deposit();
    const player = await verifiedPlayer();
    await act(player.token, { type: "stall", depositId: "5559" });
    expect(record(player.pid).s?.rate).toBe("0.75");
  });

  it("refuses deposits that are not the player's or cannot be filled", async () => {
    const player = await verifiedPlayer();
    const cases: Array<[DepositRead | null, number]> = [
      [null, 404],
      [deposit({ depositor: "0x00000000000000000000000000000000000000aa" }), 403],
      [deposit({ acceptingIntents: false }), 400],
      [deposit({ available: 0n }), 400],
      [deposit({ token: "0x00000000000000000000000000000000000000bb" }), 400],
      [deposit({ paymentMethods: [{ hash: `0x${"99".repeat(32)}`, active: true, currencies: [] }] }), 400],
      [deposit({ paymentMethods: deposit().paymentMethods.map((m) => ({ ...m, active: false })) }), 400],
    ];
    for (const [read, status] of cases) {
      deps.chainStub.readDeposit = async () => read;
      // One chain read comes back every 10 s.
      deps.clock.now += 10_000;
      await expectError(await act(player.token, { type: "stall", depositId: "5559" }), status);
    }
    await expectError(
      await act(player.token, { type: "stall", depositId: "0x0000000000000000000000000000000000000001_5559" }),
      400,
    );
    expect(record(player.pid).s).toBeUndefined();
  });

  it("limits chain reads per player before touching the RPC", async () => {
    let reads = 0;
    deps.chainStub.readDeposit = async () => {
      reads++;
      return deposit();
    };
    const player = await verifiedPlayer();
    for (let i = 0; i < CHAIN_BUCKET.capacity; i++) {
      expect((await act(player.token, { type: "stall", depositId: "5559" })).status).toBe(200);
    }
    const limited = await expectError(await act(player.token, { type: "stall", depositId: "5559" }), 429, "rate_limited");
    expect(limited.retryAfterMs).toBe(10_000);
    expect(reads).toBe(CHAIN_BUCKET.capacity);
    // Closing a stall reads nothing on-chain, so it is never limited.
    expect((await act(player.token, { type: "stall", depositId: null })).status).toBe(200);
    deps.clock.now += 10_000;
    expect((await act(player.token, { type: "stall", depositId: "5559" })).status).toBe(200);
  });

  it("reports chain outages as 502", async () => {
    deps.chainStub.readDeposit = async () => {
      throw new Error("RPC down");
    };
    const player = await verifiedPlayer();
    await expectError(await act(player.token, { type: "stall", depositId: "5559" }), 502, "upstream");
  });

  it("advertises the first active method, skipping ones the seller switched off", async () => {
    const wise = resolvePaymentMethodHash("wise", { env: "production" });
    const usd = resolveFiatCurrencyBytes32("USD");
    deps.chainStub.readDeposit = async () =>
      deposit({
        paymentMethods: [
          { ...deposit().paymentMethods[0]!, active: false },
          { hash: wise, active: true, currencies: [{ code: usd, minConversionRate: 1_010_000_000_000_000_000n }] },
        ],
      });
    const player = await verifiedPlayer();
    await act(player.token, { type: "stall", depositId: "5559" });
    expect(record(player.pid).s).toMatchObject({ platform: "wise", currency: "USD", rate: "1.01" });
  });

  describe("re-checks on heartbeats", () => {
    let live: DepositRead | null;
    let sellers = 0;

    async function openStall() {
      live = deposit();
      deps.chainStub.readDeposit = async () => live;
      const player = await verifiedPlayer(`Seller ${++sellers}`);
      await act(player.token, { type: "stall", depositId: "5559" });
      expect(record(player.pid).s?.available).toBe("9.966326");
      expect(deps.memory.read(`stalls/${player.pid}`)).toEqual({ d: record(player.pid).s!.depositId, c: deps.clock.now });
      return player;
    }

    async function heartbeatAfter(ms: number, token: string) {
      deps.clock.now += ms;
      expect((await act(token, { type: "heartbeat" })).status).toBe(200);
    }

    it("leaves a fresh stall alone, then rewrites it when the deposit changes", async () => {
      const player = await openStall();
      live = deposit({ available: 4_000_000n });
      await heartbeatAfter(STALL_RECHECK_MS - 1_000, player.token);
      expect(record(player.pid).s?.available).toBe("9.966326");
      await heartbeatAfter(STALL_SWEEP_INTERVAL_MS, player.token);
      expect(record(player.pid).s?.available).toBe("4");
      expect(deps.memory.read(`stalls/${player.pid}/c`)).toBe(deps.clock.now);
    });

    it("clears a stall whose deposit was withdrawn, paused or switched off", async () => {
      const cases: Array<() => DepositRead | null> = [
        () => null,
        () => deposit({ acceptingIntents: false }),
        () => deposit({ available: 0n }),
        () => deposit({ paymentMethods: deposit().paymentMethods.map((m) => ({ ...m, active: false })) }),
      ];
      for (const next of cases) {
        const player = await openStall();
        live = next();
        await heartbeatAfter(STALL_RECHECK_MS, player.token);
        expect(record(player.pid).s).toBeUndefined();
        expect(deps.memory.read(`stalls/${player.pid}`)).toBeNull();
        await act(player.token, { type: "leave" });
      }
    });

    it("keeps the stall through a chain outage and retries later", async () => {
      const player = await openStall();
      deps.chainStub.readDeposit = async () => {
        throw new Error("RPC down");
      };
      await heartbeatAfter(STALL_RECHECK_MS, player.token);
      expect(record(player.pid).s?.available).toBe("9.966326");
      expect(deps.memory.read(`stalls/${player.pid}/c`)).toBe(deps.clock.now);
    });

    it("drops index entries for closed, replaced or departed stalls", async () => {
      const player = await openStall();
      await act(player.token, { type: "stall", depositId: null });
      expect(deps.memory.read(`stalls/${player.pid}`)).toBeNull();

      const other = await openStall();
      await act(other.token, { type: "leave" });
      expect(deps.memory.read(`stalls/${other.pid}`)).toBeNull();

      const orphan = await openStall();
      deps.memory.write(`${W}/players/${orphan.pid}/s`, null);
      const reads: bigint[] = [];
      deps.chainStub.readDeposit = async (id) => {
        reads.push(id);
        return live;
      };
      await heartbeatAfter(STALL_RECHECK_MS, orphan.token);
      expect(deps.memory.read(`stalls/${orphan.pid}`)).toBeNull();
      expect(reads).toEqual([]);
    });
  });
});

describe("announcements", () => {
  const wallet = "0x4068d180e4051c7abc91bc17b897738622f1cbbb";
  const { abis } = getContracts(8453, "production");
  const tx = `0x${"ab".repeat(32)}`;

  function boughtReceipt(to: string) {
    const { orchestrators, usdc, verifiers } = deps.chainStub.contracts;
    const intentHash = `0x${"11".repeat(32)}`;
    return {
      status: "success" as const,
      blockTimestampMs: deps.clock.now - 10_000,
      logs: [
        encodeLog(
          abis.unifiedPaymentVerifier as Abi,
          "PaymentVerified",
          {
            intentHash,
            method: resolvePaymentMethodHash("revolut", { env: "production" }),
            currency: resolveFiatCurrencyBytes32("GBP"),
            amount: 3_950n,
            timestamp: 0n,
            paymentId: `0x${"22".repeat(32)}`,
            payeeId: `0x${"33".repeat(32)}`,
          },
          verifiers[0]!,
          5,
        ),
        encodeLog(erc20Abi, "Transfer", { from: orchestrators[0]!, to, value: 50_000_000n }, usdc, 6),
        encodeLog(
          abis.orchestratorV3 as Abi,
          "IntentFulfilled",
          { intentHash, fundsTransferredTo: to, amount: 50_000_000n, isManualRelease: false },
          orchestrators[0]!,
          7,
        ),
      ],
    };
  }

  it("broadcasts a verified purchase once", async () => {
    const player = await joined("Buyer");
    deps.memory.write(`profiles/${player.pid}/w`, wallet);
    deps.chainStub.getReceipt = async (hash) => (hash === tx ? boughtReceipt(wallet) : null);
    expect((await act(player.token, { type: "announce", kind: "bought", tx })).status).toBe(200);
    const events = Object.values(deps.memory.read(`${W}/events`) as Record<string, Body>);
    expect(events).toEqual([
      {
        kind: "bought",
        pid: player.pid,
        n: "Buyer",
        usdc: "50",
        fiat: "39.5",
        currency: "GBP",
        platform: "revolut",
        tx,
        t: deps.clock.now,
      },
    ]);
    deps.clock.now += 1_000;
    await expectError(await act(player.token, { type: "announce", kind: "bought", tx }), 409, "conflict");
    expect(Object.keys(deps.memory.read(`${W}/events`) as Body)).toHaveLength(1);
  });

  it("rejects purchases paid to another wallet, and players without a wallet", async () => {
    const player = await joined();
    await expectError(await act(player.token, { type: "announce", kind: "bought", tx }), 403);
    deps.memory.write(`profiles/${player.pid}/w`, wallet);
    deps.chainStub.getReceipt = async () => boughtReceipt("0x00000000000000000000000000000000000000aa");
    deps.clock.now += 1_000;
    await expectError(await act(player.token, { type: "announce", kind: "bought", tx }), 403, "forbidden");
    expect(deps.memory.read(`${W}/events`)).toBeNull();
  });

  it("asks to retry while the transaction is pending", async () => {
    const player = await joined();
    deps.memory.write(`profiles/${player.pid}/w`, wallet);
    await expectError(await act(player.token, { type: "announce", kind: "bought", tx }), 409, "conflict");
  });
});

describe("wallet proof", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  let wallet: ReturnType<typeof createWalletHandlers>;

  /** What publicClient.verifySiweMessage does, with a local EOA signature check instead of an RPC call. */
  async function verifySiweLocally({ message, signature, domain, nonce, address, time }: SiweProof): Promise<boolean> {
    const parsed = parseSiweMessage(message);
    if (!parsed.address || !validateSiweMessage({ message: parsed, domain, nonce, address, time })) return false;
    return verifyMessage({ address: parsed.address, message, signature });
  }

  beforeEach(() => {
    deps.chainStub.verifySiweMessage = verifySiweLocally;
    wallet = createWalletHandlers(deps);
  });

  const challenge = (token: string | undefined, address: string = account.address, origin = "https://www.rampridge.xyz") =>
    wallet.GET(
      new Request(`${origin}/api/wallet?address=${address}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
    );

  it("issues a one-time Sign-In with Ethereum message bound to the site, player and wallet", async () => {
    const player = await newPlayer();
    await expectError(await challenge(undefined), 401);
    await expectError(await challenge(player.token, "0x123"), 400);
    const body = await readBody<WalletChallengeResponse>(await challenge(player.token));
    expect(body.ok).toBe(true);
    const parsed = parseSiweMessage(body.message!);
    expect(parsed).toMatchObject({
      domain: "www.rampridge.xyz",
      uri: "https://www.rampridge.xyz",
      address: getAddress(account.address),
      version: "1",
      chainId: 8453,
      statement: `Link this wallet to RampRidge player ${player.pid}. Signing is free and sends no transaction.`,
    });
    expect(parsed.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed.issuedAt?.getTime()).toBe(deps.clock.now);
    expect(parsed.expirationTime?.getTime()).toBe(deps.clock.now + 10 * 60 * 1000);
    expect(body.message!.startsWith(`www.rampridge.xyz wants you to sign in with your Ethereum account:\n${getAddress(account.address)}`)).toBe(true);
    expect(body.address).toBe(account.address.toLowerCase());
    expect(body.expiresAt).toBe(deps.clock.now + 10 * 60 * 1000);
  });

  it("names the local dev server as the domain, and production for any other host", async () => {
    const player = await newPlayer();
    const local = await readBody<WalletChallengeResponse>(await challenge(player.token, account.address, "http://localhost:5173"));
    expect(parseSiweMessage(local.message!)).toMatchObject({ domain: "localhost:5173", uri: "http://localhost:5173" });
    deps.clock.now += 1_000;
    const other = await readBody<WalletChallengeResponse>(await challenge(player.token, account.address, "https://rampridge-git-x.vercel.app"));
    expect(parseSiweMessage(other.message!).domain).toBe("www.rampridge.xyz");
  });

  it("verifies the signature, stores the wallet and returns a token carrying it", async () => {
    const player = await joined();
    deps.memory.write(`${W}/players/${player.pid}/s`, {
      depositId: "x",
      escrow: "y",
      platform: "revolut",
      currency: "GBP",
      available: "1",
      rate: "1",
    });
    const { message } = await readBody<WalletChallengeResponse>(await challenge(player.token));
    const signature = await account.signMessage({ message: message! });
    const proof = { token: player.token, address: account.address, message, signature };
    const response = await wallet.POST(jsonRequest("/api/wallet", proof));
    const body = await readBody<SessionResponse>(response);
    const lower = account.address.toLowerCase();
    expect(body).toMatchObject({ ok: true, pid: player.pid, wallet: lower });
    expect(await verifySession(body.token!, TEST_SECRET, deps.clock.now)).toMatchObject({ wallet: lower });
    expect(deps.memory.read(`profiles/${player.pid}/w`)).toBe(lower);
    expect(record(player.pid).w).toBe(lower);
    expect(record(player.pid).s).toBeUndefined();

    // The challenge is single-use.
    deps.clock.now += 1_000;
    await expectError(await wallet.POST(jsonRequest("/api/wallet", proof)), 400, "bad_request");
  });

  it("rejects a signature from another wallet and burns the challenge", async () => {
    const player = await newPlayer();
    const { message } = await readBody<WalletChallengeResponse>(await challenge(player.token));
    const impostor = privateKeyToAccount(generatePrivateKey());
    const signature = await impostor.signMessage({ message: message! });
    const response = await wallet.POST(
      jsonRequest("/api/wallet", { token: player.token, address: account.address, message, signature }),
    );
    await expectError(response, 403, "forbidden");
    expect(deps.memory.read(`nonces/${player.pid}`)).toBeNull();
    expect(deps.memory.read(`profiles/${player.pid}/w`)).toBeNull();
  });

  it("rejects expired or altered challenges", async () => {
    const player = await newPlayer();
    const { message } = await readBody<WalletChallengeResponse>(await challenge(player.token));
    const altered = message!.replace("Nonce:", "Nonce: 0");
    const sigAltered = await account.signMessage({ message: altered });
    await expectError(
      await wallet.POST(jsonRequest("/api/wallet", { token: player.token, address: account.address, message: altered, signature: sigAltered })),
      400,
    );
    deps.clock.now += 11 * 60 * 1000;
    const signature = await account.signMessage({ message: message! });
    await expectError(
      await wallet.POST(jsonRequest("/api/wallet", { token: player.token, address: account.address, message, signature })),
      400,
    );
  });

  it("limits signature checks per player", async () => {
    const player = await newPlayer();
    const impostor = privateKeyToAccount(generatePrivateKey());
    const attempt = async () => {
      deps.clock.now += 1_000;
      const { message } = await readBody<WalletChallengeResponse>(await challenge(player.token));
      const signature = await impostor.signMessage({ message: message! });
      return wallet.POST(jsonRequest("/api/wallet", { token: player.token, address: account.address, message, signature }));
    };
    for (let i = 0; i < CHAIN_BUCKET.capacity; i++) await expectError(await attempt(), 403, "forbidden");
    await expectError(await attempt(), 429, "rate_limited");
  });

  it("refuses proofs posted from another site or not as JSON", async () => {
    const player = await newPlayer();
    const { message } = await readBody<WalletChallengeResponse>(await challenge(player.token));
    const signature = await account.signMessage({ message: message! });
    const proof = { token: player.token, address: account.address, message, signature };
    await expectError(await wallet.POST(jsonRequest("/api/wallet", proof, { headers: { Origin: "https://evil.example" } })), 403, "forbidden");
    await expectError(await wallet.POST(jsonRequest("/api/wallet", proof, { headers: { "Content-Type": "text/plain" } })), 415);
    expect(deps.memory.read(`profiles/${player.pid}/w`)).toBeNull();
    expect((await wallet.POST(jsonRequest("/api/wallet", proof))).status).toBe(200);
  });

  it("reports an unreachable chain as 502 and keeps the challenge", async () => {
    deps.chainStub.verifySiweMessage = async () => {
      throw new Error("RPC down");
    };
    const player = await newPlayer();
    const { message } = await readBody<WalletChallengeResponse>(await challenge(player.token));
    const signature = (await account.signMessage({ message: message! })) as Hex;
    await expectError(
      await wallet.POST(jsonRequest("/api/wallet", { token: player.token, address: account.address, message, signature })),
      502,
      "upstream",
    );
    expect(deps.memory.read(`nonces/${player.pid}`)).not.toBeNull();
  });
});

describe("GET /api/cron/prune", () => {
  it("requires the cron secret", async () => {
    const handler = createPruneHandler(deps);
    await expectError(await handler(new Request("https://www.rampridge.xyz/api/cron/prune")), 401);
    await expectError(
      await handler(new Request("https://www.rampridge.xyz/api/cron/prune", { headers: { Authorization: "Bearer wrong" } })),
      401,
    );
  });

  it("drops stale state and trims the logs", async () => {
    const now = deps.clock.now;
    const players: Record<string, Body> = {
      fresh: { n: "A", a: DEFAULT_APPEARANCE, p: "1,1", t: now, r: false, ls: now - 1_000, j: now },
      stale: { n: "B", a: DEFAULT_APPEARANCE, p: "1,1", t: now, r: false, ls: now - PLAYER_TIMEOUT_MS - 1, j: now },
    };
    const chat: Record<string, Body> = {};
    for (let i = 0; i < CHAT_KEEP + 20; i++) chat[`c${String(i).padStart(4, "0")}`] = { pid: "p", n: "A", m: "hi", t: now - 1_000 + i };
    chat.ancient = { pid: "p", n: "A", m: "old", t: now - 3 * 60 * 60 * 1000 };
    const events: Record<string, Body> = {};
    for (let i = 0; i < EVENTS_KEEP + 5; i++) events[`e${String(i).padStart(3, "0")}`] = { kind: "bought", n: "A", usdc: "1", platform: "peer", tx: "0x", t: i };
    deps.memory.root = {
      worlds: { 301: { players, chat, events } },
      nonces: { a: { m: "x", a: "y", x: now - 1 }, b: { m: "x", a: "y", x: now + 60_000 } },
      ratelimits: {
        act: { old: { b: 1, u: now - 11 * 60 * 1000 }, recent: { b: 1, u: now } },
        chain: { old: { b: 0, u: now - 11 * 60 * 1000 }, recent: { b: 2, u: now } },
        ip: { old: { b: 3, u: now - 11 * 60 * 1000 }, recent: { b: 59, u: now } },
        ipchat: { old: { b: 3, u: now - 11 * 60 * 1000 }, recent: { b: 9, u: now } },
      },
      ipjoins: {
        h1: {
          aaaaaaaaaaaaaaaa: { t: now - 2 * 24 * 60 * 60 * 1000, w: 301 },
          bbbbbbbbbbbbbbbb: { t: now, w: 301 },
          // From before worlds: a bare join time.
          cccccccccccccccc: now,
        },
      },
      announced: { [`0x${"1".repeat(64)}`]: { t: now - 25 * 60 * 60 * 1000, l1: "p" }, [`0x${"2".repeat(64)}`]: { t: now, l1: "p" } },
      stalls: { gone: { d: "x_1", c: now - STALL_INDEX_IDLE_MS - 1 }, live: { d: "x_2", c: now - 60_000 } },
    };

    const response = await createPruneHandler(deps)(
      new Request("https://www.rampridge.xyz/api/cron/prune", { headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` } }),
    );
    expect(response.status).toBe(200);
    const body = await readBody<{ report: Record<string, number> }>(response);
    expect(body.report).toEqual({
      players: 1,
      chat: 21,
      events: 5,
      worlds: { 301: 1, 302: 0, 303: 0 },
      retired: [],
      nonces: 1,
      rateLimits: 4,
      announced: 1,
      stalls: 1,
      ipJoins: 2,
    });
    expect(deps.memory.read("ipjoins")).toEqual({ h1: { bbbbbbbbbbbbbbbb: { t: now, w: 301 } } });
    expect(deps.memory.read("meta/worldPop/301")).toEqual({ n: 1, at: now });

    expect(Object.keys(deps.memory.read(`${W}/players`) as Body)).toEqual(["fresh"]);
    const keptChat = Object.keys(deps.memory.read(`${W}/chat`) as Body);
    expect(keptChat).toHaveLength(CHAT_KEEP);
    expect(keptChat).not.toContain("ancient");
    expect(keptChat).toContain(`c${String(CHAT_KEEP + 19).padStart(4, "0")}`);
    expect(Object.keys(deps.memory.read(`${W}/events`) as Body)).toHaveLength(EVENTS_KEEP);
    expect(Object.keys(deps.memory.read("nonces") as Body)).toEqual(["b"]);
    expect(Object.keys(deps.memory.read("ratelimits/act") as Body)).toEqual(["recent"]);
    expect(Object.keys(deps.memory.read("ratelimits/chain") as Body)).toEqual(["recent"]);
    expect(Object.keys(deps.memory.read("ratelimits/ip") as Body)).toEqual(["recent"]);
    expect(Object.keys(deps.memory.read("announced") as Body)).toEqual([`0x${"2".repeat(64)}`]);
    expect(Object.keys(deps.memory.read("stalls") as Body)).toEqual(["live"]);
  });
});
