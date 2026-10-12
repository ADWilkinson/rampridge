/**
 * Worlds: assignment, hops, per-world validation of every write, world news
 * reaching every world, the per-world prune and the database rules that keep
 * everything but `worlds/*` private. scripts/load/abuse.mjs runs the rules
 * and old-client checks against the emulator.
 */

import { readFileSync } from "node:fs";
import { getContracts, resolveFiatCurrencyBytes32, resolvePaymentMethodHash } from "@zkp2p/sdk";
import { erc20Abi } from "viem";
import type { Abi } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { encodePath, PLAYER_TIMEOUT_MS } from "../../shared/protocol";
import type { ActResponse, PlayerRecord, SessionResponse } from "../../shared/protocol";
import { DEFAULT_APPEARANCE, SPAWN_TILE } from "../../shared/world";
import type { ApiErrorBody } from "../../shared/world";
import { DEFAULT_OPEN_WORLDS, DEFAULT_WORLD_CAP, MAX_WORLDS, softTarget, worldIds } from "../../shared/worlds";
import type { WorldListResponse } from "../../shared/worlds";
import type { DepositRead } from "./chain";
import { createActHandler } from "./handlers/act";
import { createPruneHandler } from "./handlers/prune";
import { createSessionHandler } from "./handlers/session";
import { createWorldsHandler, WORLDS_CACHE_CONTROL } from "./handlers/worlds";
import { IP_PLAYER_CAP } from "./ipPlayers";
import { playerPath } from "./players";
import { PRESENCE_BUSY_MESSAGE, PRESENCE_LOCK_MS, presencePath } from "./presence";
import { pruneLight } from "./prune";
import { STALL_RECHECK_MS } from "./stallSweep";
import { encodeLog, jsonRequest, readBody, TEST_CRON_SECRET, TEST_SECRET, testDeps } from "./testing";
import type { TestDeps } from "./testing";
import { verifySession } from "./token";
import {
  OPEN_WORLDS_PATH,
  rankWorlds,
  ROOM_CAP_PATH,
  ROOM_FULL_MESSAGE,
  WORLD_CAP_PATH,
  worldConfigFrom,
  worldPopPath,
} from "./worlds";

type Player = SessionResponse & { token: string; pid: string; name: string; ip: string };

let deps: TestDeps;
let sessionHandler: ReturnType<typeof createSessionHandler>;
let actHandler: ReturnType<typeof createActHandler>;
let ipCounter = 0;

beforeEach(() => {
  deps = testDeps();
  sessionHandler = createSessionHandler(deps);
  actHandler = createActHandler(deps);
  ipCounter = 0;
});

const nextIp = () => `192.0.2.${++ipCounter}`;

async function newPlayer(ip = nextIp()): Promise<Player> {
  const response = await sessionHandler(jsonRequest("/api/session", {}, { headers: { "x-vercel-forwarded-for": ip } }));
  expect(response.status).toBe(200);
  return { ...(await readBody<SessionResponse>(response)), ip } as Player;
}

function act(player: Pick<Player, "token" | "ip">, body: unknown): Promise<Response> {
  return actHandler(jsonRequest("/api/act", body, { token: player.token, headers: { "x-vercel-forwarded-for": player.ip } }));
}

/** Joins as a client does: adopts the token the join answers with. Returns the response body. */
type JoinResult = ActResponse & Partial<ApiErrorBody> & { status: number };

async function join(player: Player, world: number | "auto" = "auto", hop = false): Promise<JoinResult> {
  const response = await act(player, { type: "join", appearance: DEFAULT_APPEARANCE, world, ...(hop ? { hop } : {}) });
  const body = await readBody<ActResponse & Partial<ApiErrorBody>>(response);
  if (response.status === 200 && body.token) player.token = body.token;
  return { ...body, status: response.status };
}

async function arrive(world: number | "auto" = "auto"): Promise<Player & { world: number }> {
  const player = await newPlayer();
  const body = await join(player, world);
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return Object.assign(player, { world: body.world! });
}

const record = (world: number, pid: string) => deps.memory.read(playerPath(world, pid)) as PlayerRecord | null;
const pop = (world: number) => (deps.memory.read(worldPopPath(world)) as { n: number } | null)?.n ?? 0;
const totalPop = () => worldIds().reduce((sum, id) => sum + pop(id), 0);
/** Every world `pid` has a record in. */
const recordsOf = (pid: string) => worldIds().filter((id) => record(id, pid) !== null);
const presence = (pid: string) => deps.memory.read(presencePath(pid));

function settings(worlds: number | null, cap: number | null, roomCap: number | null = null): void {
  deps.memory.write(OPEN_WORLDS_PATH, worlds);
  deps.memory.write(WORLD_CAP_PATH, cap);
  deps.memory.write(ROOM_CAP_PATH, roomCap);
}

describe("operator settings", () => {
  it("defaults to three worlds of 200 and ignores anything that is not a positive whole number", () => {
    expect(worldConfigFrom({ worlds: null, cap: null, roomCap: null })).toEqual({ open: [301, 302, 303], cap: 200, roomCap: null });
    expect(DEFAULT_OPEN_WORLDS).toBe(3);
    expect(DEFAULT_WORLD_CAP).toBe(200);
    for (const bad of [0, -2, 2.5, "5", true, {}]) {
      expect(worldConfigFrom({ worlds: bad, cap: bad, roomCap: bad })).toEqual({ open: [301, 302, 303], cap: 200, roomCap: null });
    }
    expect(worldConfigFrom({ worlds: 5, cap: 150, roomCap: 600 })).toEqual({ open: [301, 302, 303, 304, 305], cap: 150, roomCap: 600 });
    // Never more than MAX_WORLDS.
    expect(worldConfigFrom({ worlds: 99, cap: 1, roomCap: null }).open).toHaveLength(MAX_WORLDS);
  });
});

describe("assignment", () => {
  it("fills the busiest world below its soft target, then the quietest with room, never a full one", () => {
    const open = [301, 302, 303];
    const cap = 200;
    expect(softTarget(cap)).toBe(140);
    expect(rankWorlds(open, new Map(), cap)).toEqual([301, 302, 303]);
    expect(rankWorlds(open, new Map([[302, 12]]), cap)).toEqual([302, 301, 303]);
    // 301 has reached the soft target: the next busiest below it fills up first.
    expect(rankWorlds(open, new Map([[301, 140], [302, 30]]), cap)).toEqual([302, 303, 301]);
    // Everyone past the target: the quietest with room, and the full world not at all.
    expect(rankWorlds(open, new Map([[301, 200], [302, 160], [303, 141]]), cap)).toEqual([303, 302]);
    expect(rankWorlds(open, new Map([[301, 200], [302, 200], [303, 250]]), cap)).toEqual([]);
    // Closed worlds are never offered, however quiet.
    expect(rankWorlds([301], new Map([[301, 199], [302, 0]]), cap)).toEqual([301]);
  });

  it("places arrivals so a quiet bank has one lively world, then spills, then says the bank is full", async () => {
    settings(3, 10); // soft target 7
    const placed: number[] = [];
    for (let i = 0; i < 30; i++) placed.push((await arrive()).world);
    expect(placed.slice(0, 7)).toEqual(Array(7).fill(301));
    expect(placed.slice(7, 14)).toEqual(Array(7).fill(302));
    expect(placed.slice(14, 21)).toEqual(Array(7).fill(303));
    // Past every soft target the quietest world with room takes the next one.
    expect(placed.slice(21)).toEqual([301, 302, 303, 301, 302, 303, 301, 302, 303]);
    expect([pop(301), pop(302), pop(303)]).toEqual([10, 10, 10]);

    const late = await newPlayer();
    const refused = await join(late);
    expect(refused).toMatchObject({ ok: false, code: "rate_limited", error: ROOM_FULL_MESSAGE });
    expect(refused.retryAfterMs).toBeGreaterThan(3_000);
    // Opening a fourth world (no deploy) lets them in.
    deps.memory.write(OPEN_WORLDS_PATH, 4);
    expect((await join(late)).world).toBe(304);
  });

  it("honours a requested world when it has room, and assigns one otherwise", async () => {
    settings(3, 2);
    expect((await arrive(303)).world).toBe(303);
    expect((await arrive(303)).world).toBe(303);
    // 303 is full now; the request falls back to the usual assignment.
    expect((await arrive(303)).world).toBe(301);
    // A world that is not open is never honoured (301 has reached its soft target of one, so 302 is next).
    expect((await arrive(305)).world).toBe(302);
  });

  it("keeps a player in the world they are standing in, full or closed, until they leave it", async () => {
    settings(3, 2);
    const a = await arrive(302);
    await arrive(302);
    // A reload or a second tab asks for "auto" (or their world) and lands where they stand, though 302 is full.
    expect((await join(a)).world).toBe(302);
    expect((await join(a, 302)).world).toBe(302);
    expect(pop(302)).toBe(2);
    // Closing 302 stops arrivals there, not the players inside.
    deps.memory.write(OPEN_WORLDS_PATH, 1);
    expect((await join(a)).world).toBe(302);
    // Once they have left, they are a newcomer and go to an open world.
    expect((await act(a, { type: "leave" })).status).toBe(200);
    expect(pop(302)).toBe(1);
    expect(presence(a.pid)).toBeNull();
    expect((await join(a)).world).toBe(301);
  });

  it("holds the overall room cap across every world", async () => {
    settings(3, 10, 3);
    for (let i = 0; i < 3; i++) await arrive(301 + i);
    expect((await join(await newPlayer())).error).toBe(ROOM_FULL_MESSAGE);
  });
});

describe("hopping worlds (World Switcher)", () => {
  it("moves the player in one write, keeping their tile, and hands back a token for the new world", async () => {
    const player = await arrive();
    expect(player.world).toBe(301);
    // Standing one tile east of the spawn.
    const tile = { x: SPAWN_TILE.x + 1, y: SPAWN_TILE.y };
    deps.memory.write(`${playerPath(301, player.pid)}/p`, encodePath([tile]));
    const before = player.token;
    const writes: Array<Record<string, unknown>> = [];
    const update = deps.memory.update.bind(deps.memory);
    deps.memory.update = (updates) => {
      writes.push(updates);
      return update(updates);
    };
    deps.clock.now += 5_000;
    const hop = await join(player, 303, true);
    expect(hop).toMatchObject({ ok: true, world: 303 });
    expect(player.token).not.toBe(before);
    expect(await verifySession(player.token, TEST_SECRET, deps.clock.now)).toMatchObject({ pid: player.pid, world: 303 });
    // Out of 301 and into 303 in one atomic update: nobody ever sees them in two worlds.
    const moveWrite = writes.find((w) => playerPath(303, player.pid) in w)!;
    expect(moveWrite[playerPath(301, player.pid)]).toBeNull();
    expect(record(301, player.pid)).toBeNull();
    expect(record(303, player.pid)).toMatchObject({ p: encodePath([tile]), ls: deps.clock.now, j: deps.clock.now });
    expect([pop(301), pop(303)]).toEqual([0, 1]);
  });

  it("refuses a hop to a full or closed world and leaves the player where they are", async () => {
    settings(3, 1);
    const player = await arrive();
    await arrive(302);
    const full = await join(player, 302, true);
    expect(full).toMatchObject({ ok: false, code: "conflict", error: "World 302 is full." });
    const closed = await join(player, 307, true);
    expect(closed).toMatchObject({ ok: false, code: "conflict", error: "World 307 is not open." });
    expect(record(301, player.pid)).not.toBeNull();
    expect(pop(301)).toBe(1);
    // A hop needs a world number.
    const response = await act(player, { type: "join", appearance: DEFAULT_APPEARANCE, world: "auto", hop: true });
    expect(response.status).toBe(400);
  });

  it("lets a player hop while the overall room cap is reached: they are already inside", async () => {
    settings(3, 10, 2);
    const player = await arrive();
    await arrive();
    expect((await join(player, 302, true)).world).toBe(302);
  });

  it("validates every later write against the token's world", async () => {
    const player = await arrive();
    const stale = { ...player };
    await join(player, 302, true);
    // The token from before the hop still names 301, where the player no longer is.
    for (const body of [{ type: "heartbeat" }, { type: "emote", emote: "wave" }, { type: "chat", text: "hi" }]) {
      deps.clock.now += 2_000;
      expect((await readBody<ApiErrorBody>(await act(stale, body))).code).toBe("not_joined");
    }
    expect(deps.memory.read("worlds/301")).toBeNull();
    // The new token acts in 302 only.
    deps.clock.now += 2_000;
    expect((await act(player, { type: "chat", text: "hello 302" })).status).toBe(200);
    expect(Object.values(deps.memory.read("worlds/302/chat") as Record<string, { m: string }>).map((c) => c.m)).toEqual(["hello 302"]);
    deps.clock.now += 2_000;
    expect((await act(player, { type: "move", path: [SPAWN_TILE, { x: SPAWN_TILE.x, y: SPAWN_TILE.y + 1 }], run: false })).status).toBe(200);
    expect(deps.memory.read("worlds/301")).toBeNull();
  });

  it("keeps chat, players and the chat cap separate per world", async () => {
    const a = await arrive(301);
    const b = await arrive(302);
    expect((await act(a, { type: "chat", text: "in 301" })).status).toBe(200);
    expect((await act(b, { type: "chat", text: "in 302" })).status).toBe(200);
    const lines = (world: number) => Object.values((deps.memory.read(`worlds/${world}/chat`) ?? {}) as Record<string, { m: string }>).map((c) => c.m);
    expect(lines(301)).toEqual(["in 301"]);
    expect(lines(302)).toEqual(["in 302"]);
    expect(Object.keys(deps.memory.read("worlds/301/players") as object)).toEqual([a.pid]);
    expect(deps.memory.read("meta/worldChat/301")).toMatchObject({ c: 1 });
    expect(deps.memory.read("meta/worldChat/302")).toMatchObject({ c: 1 });
  });

  it("carries the player's stall to the new world, and the sweep follows it there", async () => {
    const wallet = "0x4068d180e4051c7abc91bc17b897738622f1cbbb";
    const revolut = resolvePaymentMethodHash("revolut", { env: "production" });
    const gbp = resolveFiatCurrencyBytes32("GBP");
    let available = 9_966_326n;
    const deposit = (): DepositRead => ({
      depositId: 5559n,
      depositor: wallet,
      token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      acceptingIntents: true,
      available,
      paymentMethods: [{ hash: revolut, active: true, currencies: [{ code: gbp, minConversionRate: 750_000_000_000_000_000n }] }],
    });
    deps.chainStub.readDeposit = async () => deposit();
    const seller = await arrive();
    deps.memory.write(`profiles/${seller.pid}/w`, wallet);
    deps.memory.write(`${playerPath(301, seller.pid)}/w`, wallet);
    expect((await act(seller, { type: "stall", depositId: "5559" })).status).toBe(200);
    const indexed = deps.memory.read(`stalls/${seller.pid}`);
    expect(indexed).toMatchObject({ c: deps.clock.now });

    await join(seller, 302, true);
    expect(record(302, seller.pid)?.s?.available).toBe("9.966326");
    // The index does not move with the player; the sweep finds them through their presence.
    expect(deps.memory.read(`stalls/${seller.pid}`)).toEqual(indexed);
    expect(deps.memory.read(`presence/${seller.pid}`)).toEqual({ w: 302 });

    available = 4_000_000n;
    deps.clock.now += STALL_RECHECK_MS;
    expect((await act(seller, { type: "heartbeat" })).status).toBe(200);
    expect(record(302, seller.pid)?.s?.available).toBe("4");
  });
});

describe("one player, one record (presence/{pid})", () => {
  it("a join replayed with the session's token never takes a second seat or leaves a second record", async () => {
    settings(3, 10);
    const player = await newPlayer();
    // The token /api/session answered with names no world, like any token a script keeps.
    const first = { token: player.token, ip: player.ip };
    expect((await join(player)).world).toBe(301);
    for (let i = 0; i < 6; i++) {
      deps.clock.now += 1_000;
      const replay = await readBody<ActResponse>(await act(first, { type: "join", appearance: DEFAULT_APPEARANCE, world: "auto" }));
      expect(replay.world).toBe(301);
    }
    expect([pop(301), pop(302), pop(303)]).toEqual([1, 0, 0]);
    expect(recordsOf(player.pid)).toEqual([301]);
    // Asking for other worlds with it moves the player; it never copies them.
    for (const world of [302, 303]) {
      deps.clock.now += 1_000;
      expect((await readBody<ActResponse>(await act(first, { type: "join", appearance: DEFAULT_APPEARANCE, world }))).world).toBe(world);
    }
    expect(recordsOf(player.pid)).toEqual([303]);
    expect(presence(player.pid)).toEqual({ w: 303 });
    expect(totalPop()).toBe(1);
  });

  it("a token from before a hop rejoins the world the player is in", async () => {
    const player = await arrive();
    const stale = { token: player.token, ip: player.ip };
    await join(player, 302, true);
    deps.clock.now += 1_000;
    const rejoin = await readBody<ActResponse>(await act(stale, { type: "join", appearance: DEFAULT_APPEARANCE, world: "auto" }));
    expect(rejoin.world).toBe(302);
    expect(recordsOf(player.pid)).toEqual([302]);
    expect([pop(301), pop(302)]).toEqual([0, 1]);
  });

  it("two hops sent together leave the player in one world", async () => {
    const player = await arrive();
    const copy = { token: player.token, ip: player.ip };
    const hop = (to: number, who: Pick<Player, "token" | "ip">) =>
      act(who, { type: "join", appearance: DEFAULT_APPEARANCE, world: to, hop: true }).then((r) => readBody<ActResponse & Partial<ApiErrorBody>>(r));
    const outcomes = await Promise.all([hop(302, player), hop(303, copy)]);
    // Whichever lands second either waits for the first (429, which the client waits out and sends again) or
    // moves the player on from where the first left them; never a copy.
    for (const o of outcomes) if (!o.ok) expect(o).toMatchObject({ code: "rate_limited", error: PRESENCE_BUSY_MESSAGE });
    expect(recordsOf(player.pid)).toHaveLength(1);
    const landed = recordsOf(player.pid)[0];
    expect(presence(player.pid)).toEqual({ w: landed });
    expect(totalPop()).toBe(1);
  });

  it("a lock left by a join that died frees itself, and still says where the player is", async () => {
    const player = await arrive();
    deps.memory.write(presencePath(player.pid), { w: 301, l: deps.clock.now + PRESENCE_LOCK_MS, k: "crashed" });
    expect((await join(player)).code).toBe("rate_limited");
    deps.clock.now += PRESENCE_LOCK_MS + 1;
    expect((await join(player, 302, true)).world).toBe(302);
    expect(recordsOf(player.pid)).toEqual([302]);
  });

  it(`an address keeps at most ${IP_PLAYER_CAP} players, however their tokens are replayed across worlds`, async () => {
    settings(3, 30);
    const ip = nextIp();
    const bots: Array<{ token: string; ip: string; pid: string }> = [];
    for (let i = 0; i < IP_PLAYER_CAP; i++) {
      const bot = await newPlayer(ip);
      bots.push({ token: bot.token, ip, pid: bot.pid });
    }
    for (const world of [301, 302, 303]) {
      deps.clock.now += 1_000;
      for (const bot of bots) expect((await act(bot, { type: "join", appearance: DEFAULT_APPEARANCE, world })).status).toBe(200);
    }
    const records = worldIds().flatMap((id) => Object.keys((deps.memory.read(`worlds/${id}/players`) ?? {}) as object));
    expect(records).toHaveLength(IP_PLAYER_CAP);
    expect(totalPop()).toBe(IP_PLAYER_CAP);
    expect((await join(await newPlayer(ip))).error).toMatch(/your network/);
  });

  it("holds meta/roomCap for a hop by a player who is not inside", async () => {
    settings(3, 10, 2);
    await arrive();
    await arrive();
    const outsider = await newPlayer();
    expect(await join(outsider, 302, true)).toMatchObject({ status: 429, error: ROOM_FULL_MESSAGE });
    expect(recordsOf(outsider.pid)).toEqual([]);
    expect(totalPop()).toBe(2);
  });

  it("a leave or a stall action with a token from before a hop leaves the player and their stall alone", async () => {
    const wallet = "0x4068d180e4051c7abc91bc17b897738622f1cbbb";
    let available = 9_966_326n;
    deps.chainStub.readDeposit = async () => ({
      depositId: 5559n,
      depositor: wallet,
      token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      acceptingIntents: true,
      available,
      paymentMethods: [
        {
          hash: resolvePaymentMethodHash("revolut", { env: "production" }),
          active: true,
          currencies: [{ code: resolveFiatCurrencyBytes32("GBP"), minConversionRate: 750_000_000_000_000_000n }],
        },
      ],
    });
    const seller = await arrive();
    deps.memory.write(`profiles/${seller.pid}/w`, wallet);
    deps.memory.write(`${playerPath(301, seller.pid)}/w`, wallet);
    expect((await act(seller, { type: "stall", depositId: "5559" })).status).toBe(200);
    const stale = { token: seller.token, ip: seller.ip };
    await join(seller, 302, true);
    const index = deps.memory.read(`stalls/${seller.pid}`);

    deps.clock.now += 1_000;
    expect((await act(stale, { type: "leave" })).status).toBe(200);
    expect(record(302, seller.pid)?.s?.depositId).toBeDefined();
    expect(presence(seller.pid)).toEqual({ w: 302 });
    expect(pop(302)).toBe(1);
    deps.clock.now += 1_000;
    expect((await readBody<ApiErrorBody>(await act(stale, { type: "stall", depositId: "5559" }))).code).toBe("not_joined");
    deps.clock.now += 1_000;
    expect((await readBody<ApiErrorBody>(await act(stale, { type: "stall", depositId: null }))).code).toBe("not_joined");
    expect(deps.memory.read(`stalls/${seller.pid}`)).toEqual(index);

    // So the sweep still keeps the stall in 302 honest.
    available = 1_000_000n;
    deps.clock.now += STALL_RECHECK_MS;
    expect((await act(seller, { type: "heartbeat" })).status).toBe(200);
    expect(record(302, seller.pid)?.s?.available).toBe("1");
  });

  it("gives every seat back when a world's players all leave at once", async () => {
    settings(3, 50);
    const players = await Promise.all(Array.from({ length: 25 }, () => arrive(301)));
    expect(pop(301)).toBe(25);
    const statuses = await Promise.all(players.map(async (p) => (await act(p, { type: "leave" })).status));
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(pop(301)).toBe(0);
    expect(worldIds().every((id) => deps.memory.read(`worlds/${id}/players`) === null)).toBe(true);
    expect(deps.memory.read("presence")).toBeNull();
  });
});

describe("builds from before worlds", () => {
  it("are told to reload when they join, and their other actions write nothing", async () => {
    const player = await newPlayer();
    const response = await act(player, { type: "join", appearance: DEFAULT_APPEARANCE });
    expect(response.status).toBe(429);
    const body = await readBody<ApiErrorBody>(response);
    expect(body).toMatchObject({ code: "outdated", error: "RampRidge was updated. Reload the page to keep playing." });
    // A 429 with a long wait is what those builds show in the chatbox instead of retrying.
    expect(body.retryAfterMs).toBeGreaterThan(3_000);
    // A token without a world is in no world: heartbeats ask for a join (which is refused as above), leaves are no-ops.
    expect((await readBody<ApiErrorBody>(await act(player, { type: "heartbeat" }))).code).toBe("not_joined");
    deps.clock.now += 2_000;
    expect((await readBody<ApiErrorBody>(await act(player, { type: "move", path: [SPAWN_TILE], run: false }))).code).toBe("not_joined");
    expect((await act(player, { type: "leave" })).status).toBe(200);
    expect(deps.memory.read("worlds")).toBeNull();
  });

  it("keep the token's world when the session is refreshed or the wallet proved", async () => {
    const player = await arrive(302);
    const refreshed = await readBody<SessionResponse>(
      await sessionHandler(jsonRequest("/api/session", { token: player.token }, { headers: { "x-vercel-forwarded-for": player.ip } })),
    );
    expect(refreshed.world).toBe(302);
    expect(await verifySession(refreshed.token!, TEST_SECRET, deps.clock.now)).toMatchObject({ world: 302 });
    // So the refreshed token still acts in 302.
    expect((await act({ token: refreshed.token!, ip: player.ip }, { type: "heartbeat" })).status).toBe(200);
  });
});

describe("players per network, across worlds", () => {
  it(`counts an address's players in every world against one cap of ${IP_PLAYER_CAP}`, async () => {
    settings(3, 8);
    const ip = nextIp();
    const worlds = new Set<number>();
    for (let i = 0; i < IP_PLAYER_CAP; i++) {
      const bot = await newPlayer(ip);
      const body = await join(bot);
      expect(body.ok).toBe(true);
      worlds.add(body.world!);
    }
    expect(worlds.size).toBe(3);
    const extra = await newPlayer(ip);
    expect((await join(extra)).error).toMatch(/your network/);
    // The refused join gave its seat back.
    expect(pop(301) + pop(302) + pop(303)).toBe(IP_PLAYER_CAP);
    expect(Object.values(deps.memory.read("ipjoins") as Record<string, Record<string, { w: number }>>)[0]).toSatisfy((entries: Record<string, { w: number }>) =>
      Object.values(entries).every((e) => [301, 302, 303].includes(e.w)),
    );
  });
});

describe("moderation is global", () => {
  it("a mute follows the player into every world, and a ban keeps them out of all of them", async () => {
    const player = await arrive();
    deps.memory.write(`moderation/${player.pid}`, { m: deps.clock.now + 60 * 60_000 });
    await join(player, 302, true);
    expect((await act(player, { type: "chat", text: "hello" })).status).toBe(429);
    expect((await act(player, { type: "leave" })).status).toBe(200);
    deps.memory.write(`moderation/${player.pid}`, { b: deps.clock.now + 86_400_000 });
    for (const world of [301, 302, 303]) expect((await join(player, world)).status).toBe(429);
    expect(deps.memory.read("worlds/302/players")).toBeNull();
  });
});

describe("world news", () => {
  const wallet = "0x4068d180e4051c7abc91bc17b897738622f1cbbb";
  const tx = `0x${"ab".repeat(32)}`;
  const { abis } = getContracts(8453, "production");

  it("reaches every open world, and a closed one players are still in, under one key", async () => {
    const buyer = await arrive(302);
    const lingering = await arrive(303);
    void lingering;
    deps.memory.write(OPEN_WORLDS_PATH, 2);
    deps.memory.write(`profiles/${buyer.pid}/w`, wallet);
    const { orchestrators, usdc, verifiers } = deps.chainStub.contracts;
    const intentHash = `0x${"11".repeat(32)}`;
    deps.chainStub.getReceipt = async () => ({
      status: "success",
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
        encodeLog(erc20Abi, "Transfer", { from: orchestrators[0]!, to: wallet, value: 50_000_000n }, usdc, 6),
        encodeLog(abis.orchestratorV3 as Abi, "IntentFulfilled", { intentHash, fundsTransferredTo: wallet, amount: 50_000_000n, isManualRelease: false }, orchestrators[0]!, 7),
      ],
    });
    expect((await act(buyer, { type: "announce", kind: "bought", tx })).status).toBe(200);
    const keys = [301, 302, 303].map((w) => Object.keys((deps.memory.read(`worlds/${w}/events`) ?? {}) as object));
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toEqual(keys[0]);
    expect(keys[2]).toEqual(keys[0]);
    expect(deps.memory.read(`worlds/304/events`)).toBeNull();
  });
});

describe("the per-world prune", () => {
  it("drops silent players and recounts each world, and retires a closed world once it is empty", async () => {
    const a = await arrive(301);
    const b = await arrive(302);
    const c = await arrive(303);
    deps.clock.now += 1_000;
    expect((await act(b, { type: "chat", text: "bye" })).status).toBe(200);
    deps.memory.write(`${playerPath(302, b.pid)}/ls`, deps.clock.now - PLAYER_TIMEOUT_MS - 1);
    // Operator closes 303 while c is still inside.
    deps.memory.write(OPEN_WORLDS_PATH, 2);
    let report = await pruneLight(deps.memory, deps.clock.now);
    expect(report).toMatchObject({ players: 1, worlds: { 301: 1, 302: 0, 303: 1 }, retired: [] });
    expect(record(302, b.pid)).toBeNull();
    expect(presence(b.pid)).toBeNull();
    expect(presence(a.pid)).toEqual({ w: 301 });
    expect([pop(301), pop(302), pop(303)]).toEqual([1, 0, 1]);
    // 303 empties: its chat, events and counts go.
    expect((await act(c, { type: "chat", text: "last one out" })).status).toBe(200);
    expect((await act(c, { type: "leave" })).status).toBe(200);
    report = await pruneLight(deps.memory, deps.clock.now);
    expect(report.retired).toEqual([303]);
    expect(deps.memory.read("worlds/303")).toBeNull();
    expect(deps.memory.read(worldPopPath(303))).toBeNull();
    expect(deps.memory.read("meta/worldChat/303")).toBeNull();
    // Open worlds stay, empty or not.
    expect(deps.memory.read("worlds/302/chat")).not.toBeNull();
    void a;
  });

  it("the cron visits every possible world, so players in a world nobody counts are pruned too", async () => {
    const now = deps.clock.now;
    deps.memory.write("worlds/312/players/stalexxxxxxxxxxx", { n: "A", a: DEFAULT_APPEARANCE, p: "1,1", t: now, r: false, ls: now - PLAYER_TIMEOUT_MS - 1, j: now });
    const response = await createPruneHandler(deps)(
      new Request("https://www.rampridge.xyz/api/cron/prune", { headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` } }),
    );
    const body = await readBody<{ report: { players: number; retired: number[] } }>(response);
    expect(body.report).toMatchObject({ players: 1, retired: [312] });
    expect(deps.memory.read("worlds")).toBeNull();
  });
});

describe("GET /api/worlds", () => {
  it("lists the open worlds with their counts, briefly cached at the edge", async () => {
    settings(4, 2);
    await arrive(301);
    await arrive(301);
    await arrive(303);
    const response = await createWorldsHandler(deps)(new Request("https://www.rampridge.xyz/api/worlds"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(WORLDS_CACHE_CONTROL);
    const body = await readBody<WorldListResponse>(response);
    expect(body).toEqual({
      ok: true,
      cap: 2,
      worlds: [
        { id: 301, players: 2, full: true },
        { id: 302, players: 0, full: false },
        { id: 303, players: 1, full: false },
        { id: 304, players: 0, full: false },
      ],
      now: deps.clock.now,
    });
  });
});

describe("database rules", () => {
  const rules = JSON.parse(readFileSync(new URL("../../database.rules.json", import.meta.url), "utf8")) as { rules: Record<string, unknown> };

  /** Every `.read`/`.write` in the tree, with its path. */
  function grants(node: unknown, path: string[] = []): Array<{ path: string; kind: string; value: unknown }> {
    if (node === null || typeof node !== "object") return [];
    const out: Array<{ path: string; kind: string; value: unknown }> = [];
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === ".read" || key === ".write") out.push({ path: path.join("/") || "/", kind: key, value });
      else if (!key.startsWith(".")) out.push(...grants(value, [...path, key]));
    }
    return out;
  }

  it("lets browsers read one world at a time and nothing else, and write nowhere", () => {
    expect(grants(rules.rules)).toEqual([
      { path: "/", kind: ".read", value: false },
      { path: "/", kind: ".write", value: false },
      { path: "worlds/$world", kind: ".read", value: "$world.matches(/^3[0-9][0-9]$/)" },
    ]);
  });

  it("indexes what the clients and the prune order by, in every world", () => {
    const world = (rules.rules.worlds as Record<string, Record<string, Record<string, unknown>>>).$world!;
    expect(world.players![".indexOn"]).toEqual(["ls"]);
    expect(world.chat![".indexOn"]).toEqual(["t"]);
    expect(world.events![".indexOn"]).toEqual(["t"]);
  });
});
