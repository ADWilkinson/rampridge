/**
 * Launch hardening: limits that hold across many sessions from one network,
 * and writes sized for a crowded room. scripts/load/abuse.mjs runs the same
 * scenarios against the dev API and the database emulator.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { PLAYER_TIMEOUT_MS } from "../../shared/protocol";
import type { ActResponse, PlayerRecord, SessionResponse } from "../../shared/protocol";
import { DEFAULT_APPEARANCE, SPAWN_TILE } from "../../shared/world";
import type { ApiErrorBody } from "../../shared/world";
import { createActHandler } from "./handlers/act";
import { createSessionHandler } from "./handlers/session";
import { IP_PLAYER_CAP } from "./ipPlayers";
import { guestDigits } from "./names";
import { playerPath, PRESENCE_REFRESH_MS } from "./players";
import { pruneLight, prunePlayers } from "./prune";
import { IP_CHAT_BUCKET, ipBucketKey, SESSION_CREATE_BUCKET } from "./ratelimit";
import { ROOM_CAP_PATH, ROOM_FULL_MESSAGE, worldPopPath } from "./worlds";
import { jsonRequest, readBody, testDeps } from "./testing";
import type { TestDeps } from "./testing";

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

async function newPlayer(ip = nextIp(), name?: string): Promise<Player> {
  const response = await sessionHandler(
    jsonRequest("/api/session", name === undefined ? {} : { name }, { headers: { "x-vercel-forwarded-for": ip } }),
  );
  expect(response.status).toBe(200);
  return { ...(await readBody<SessionResponse>(response)), ip } as Player;
}

function act(player: Pick<Player, "token" | "ip">, body: unknown): Promise<Response> {
  return actHandler(jsonRequest("/api/act", body, { token: player.token, headers: { "x-vercel-forwarded-for": player.ip } }));
}

/** Joins wherever the server places the player and adopts the token naming that world, as the client does. */
async function join(player: Pick<Player, "token" | "ip">): Promise<Response> {
  const response = await act(player, { type: "join", appearance: DEFAULT_APPEARANCE, world: "auto" });
  if (response.status === 200) {
    const body = await readBody<ActResponse>(response.clone());
    if (body.token) player.token = body.token;
  }
  return response;
}

async function joined(ip?: string): Promise<Player> {
  const player = await newPlayer(ip);
  expect((await join(player)).status).toBe(200);
  return player;
}

/** The first world: every test here fits in it. */
const WORLD = 301;

function record(pid: string): PlayerRecord | null {
  return deps.memory.read(playerPath(WORLD, pid)) as PlayerRecord | null;
}

/** Records every database write the handlers make. */
function recordWrites(): string[] {
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
    writes.push(...Object.entries(updates).map(([path, value]) => `update ${path}=${JSON.stringify(value)}`));
    return update(updates);
  };
  return writes;
}

describe("ipBucketKey", () => {
  it("keeps IPv4 as it is and groups IPv6 by its /64", () => {
    expect(ipBucketKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucketKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(ipBucketKey("2001:0db8:0001:0002:ffff:0:0:1")).toBe("2001:db8:1:2::/64");
    expect(ipBucketKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucketKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBucketKey("[2001:db8:1:2::9]")).toBe("2001:db8:1:2::/64");
    expect(ipBucketKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(ipBucketKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipBucketKey("::ffff:cb00:7109")).toBe("203.0.113.9");
  });

  it("passes anything else through unchanged", () => {
    expect(ipBucketKey("unknown")).toBe("unknown");
    expect(ipBucketKey("1::2::3")).toBe("1::2::3");
    expect(ipBucketKey("2001:db8:1:2:3:4:5:6:7")).toBe("2001:db8:1:2:3:4:5:6:7");
  });
});

describe("session farming", () => {
  it("counts every address in one IPv6 /64 against one bucket", async () => {
    for (let i = 0; i < SESSION_CREATE_BUCKET.capacity; i++) {
      await newPlayer(`2001:db8:aa:bb:${(i + 1).toString(16)}::1`);
    }
    const response = await sessionHandler(
      jsonRequest("/api/session", {}, { headers: { "x-vercel-forwarded-for": "2001:db8:aa:bb:ffff::7" } }),
    );
    expect(response.status).toBe(429);
    // Another /64 is another subscriber.
    await newPlayer("2001:db8:aa:bc::1");
  });

  it("widens guest numbers after two collisions", () => {
    expect([0, 1, 2, 3, 4, 11].map(guestDigits)).toEqual([4, 4, 5, 5, 6, 6]);
  });
});

describe("look-alike names", () => {
  const ask = (body: Record<string, unknown>) =>
    sessionHandler(jsonRequest("/api/session", body, { headers: { "x-vercel-forwarded-for": nextIp() } }));

  it("refuses a name that reads like another player's in the game font", async () => {
    const owner = await newPlayer(nextIp(), "Wilkinson");
    await newPlayer(nextIp(), "Bob Lol");
    for (const name of ["WiIkinson", "Wi1kinson", "wilklnson", "B0b Lol", "Bob LoI"]) {
      const response = await ask({ name });
      expect(response.status, name).toBe(400);
      expect((await readBody<ApiErrorBody>(response)).error).toMatch(/looks too much like/);
    }
    // A refused claim leaves nothing behind.
    expect(deps.memory.read("names/wiikinson")).toBeNull();
    // Checking says so too, without claiming.
    const asker = await newPlayer();
    const check = await ask({ token: asker.token, name: "WiIkinson", check: true });
    expect(check.status).toBe(400);
    // The owner may restyle within the same look, and frees it by moving on.
    expect((await readBody<SessionResponse>(await ask({ token: owner.token, name: "WiIkinson" }))).name).toBe("WiIkinson");
    expect((await readBody<SessionResponse>(await ask({ token: owner.token, name: "Titan" }))).name).toBe("Titan");
    expect((await newPlayer(nextIp(), "Wi1kinson")).name).toBe("Wi1kinson");
  });

  it("leaves unrelated names alone", async () => {
    await newPlayer(nextIp(), "Zezima");
    for (const name of ["Zezlma2", "Lynx", "Bill", "Oslo", "Guest1234"]) expect((await ask({ name })).status, name).toBe(200);
  });
});

describe("chat across many sessions from one network", () => {
  it("holds one address to its own share of the room", async () => {
    const ip = nextIp();
    const bots: Player[] = [];
    for (let i = 0; i < IP_CHAT_BUCKET.capacity + 2; i++) bots.push(await joined(ip));
    const responses: Response[] = [];
    for (const bot of bots) responses.push(await act(bot, { type: "chat", text: "buy my stuff" }));
    expect(responses.filter((r) => r.status === 200)).toHaveLength(IP_CHAT_BUCKET.capacity);
    const refused = responses.at(-1)!;
    expect(refused.status).toBe(429);
    expect((await readBody<ApiErrorBody>(refused)).error).toMatch(/your network/);
    // Someone else in the room is unaffected.
    expect((await act(await joined(), { type: "chat", text: "hello" })).status).toBe(200);
    // The address gets a message back each second (this bot's own pace allows one every 1.2 s).
    deps.clock.now += Math.max(1_200, 1_000 / IP_CHAT_BUCKET.refillPerSecond);
    expect((await act(bots[0]!, { type: "chat", text: "one more" })).status).toBe(200);
  });
});

describe("players per network", () => {
  it(`admits ${IP_PLAYER_CAP} players from one address, then refuses until one leaves`, async () => {
    const ip = nextIp();
    const players: Player[] = [];
    for (let i = 0; i < IP_PLAYER_CAP; i++) players.push(await joined(ip));
    const extra = await newPlayer(ip);
    const refused = await join(extra);
    expect(refused.status).toBe(429);
    const body = await readBody<ApiErrorBody>(refused);
    expect(body.error).toMatch(/your network/);
    expect(body.retryAfterMs).toBeGreaterThan(3_000);
    expect(record(extra.pid)).toBeNull();

    // A player already counted can always rejoin (after a pause, or a second tab).
    expect((await join(players[0]!)).status).toBe(200);
    // Other networks are unaffected.
    await joined();

    expect((await act(players[1]!, { type: "leave" })).status).toBe(200);
    expect((await join(extra)).status).toBe(200);
    // The departed player's entry was dropped when the slot was reused.
    expect(Object.keys(deps.memory.read(`ipjoins`) as Record<string, Record<string, number>>)).toHaveLength(2);
  });

  it("skips the per-address checks when the request carries no address", async () => {
    const player = await newPlayer();
    const response = await actHandler(jsonRequest("/api/act", { type: "join", appearance: DEFAULT_APPEARANCE, world: "auto" }, { token: player.token }));
    expect(response.status).toBe(200);
    expect(deps.memory.read("ipjoins")).toBeNull();
  });
});

describe("moderation records (scripts/ops/moderate.mjs)", () => {
  it("refuses a muted player's chat until the mute ends, even after their bucket is dropped", async () => {
    const player = await joined();
    deps.memory.write(`moderation/${player.pid}`, { m: deps.clock.now + 60 * 60_000, r: "spam", at: deps.clock.now });
    // The cron drops idle buckets; the record still holds.
    deps.memory.write(`ratelimits/act/${player.pid}`, null);
    const refused = await act(player, { type: "chat", text: "hello again" });
    expect(refused.status).toBe(429);
    const body = await readBody<ApiErrorBody>(refused);
    expect(body.error).toBe("You're sending messages too quickly.");
    expect(body.retryAfterMs).toBeGreaterThan(59 * 60_000);
    // Everything else still works while muted.
    expect((await act(player, { type: "emote", emote: "wave" })).status).toBe(200);
    deps.clock.now += 60 * 60_000 + 1;
    expect((await act(player, { type: "chat", text: "sorry" })).status).toBe(200);
  });

  it("keeps a banned player out of the room until the ban ends", async () => {
    const player = await joined();
    expect((await act(player, { type: "leave" })).status).toBe(200);
    deps.memory.write(`moderation/${player.pid}`, { b: deps.clock.now + 86_400_000, m: deps.clock.now + 86_400_000 });
    const refused = await join(player);
    expect(refused.status).toBe(429);
    expect(record(player.pid)).toBeNull();
    deps.clock.now += 86_400_000 + 1;
    expect((await join(player)).status).toBe(200);
  });
});

describe("operator room cap (meta/roomCap, across every world)", () => {
  it("does nothing until meta/roomCap is set", async () => {
    for (let i = 0; i < 5; i++) await joined();
    expect(deps.memory.read(worldPopPath(WORLD))).toMatchObject({ n: 5 });
  });

  it("refuses newcomers past the cap, never the players inside", async () => {
    deps.memory.write(ROOM_CAP_PATH, 2);
    const first = await joined();
    const second = await joined();
    const late = await newPlayer();
    const refused = await join(late);
    expect(refused.status).toBe(429);
    const body = await readBody<ApiErrorBody>(refused);
    expect(body.error).toBe(ROOM_FULL_MESSAGE);
    expect(body.retryAfterMs).toBeGreaterThan(3_000);
    // Rejoining (a second tab, a pause) always works for someone already inside.
    expect((await join(first)).status).toBe(200);

    // A leave gives its place back at once.
    expect((await act(second, { type: "leave" })).status).toBe(200);
    expect(deps.memory.read(worldPopPath(WORLD))).toMatchObject({ n: 1 });
    expect((await join(late)).status).toBe(200);
    expect(deps.memory.read(worldPopPath(WORLD))).toMatchObject({ n: 2 });
  });

  it("recounts only players who are still heartbeating", async () => {
    deps.memory.write(ROOM_CAP_PATH, 10);
    await joined();
    const quiet = await joined();
    deps.memory.write(`${playerPath(WORLD, quiet.pid)}/ls`, deps.clock.now - PLAYER_TIMEOUT_MS - 1);
    deps.memory.write(playerPath(WORLD, "fragmentxxxxxxxx"), { p: "1,1", t: 1 });
    expect((await pruneLight(deps.memory, deps.clock.now)).worlds[WORLD]).toBe(1);
    expect(deps.memory.read(worldPopPath(WORLD))).toEqual({ n: 1, at: deps.clock.now });
  });

  it("ignores a cap that is not a positive whole number", async () => {
    for (const cap of [0, -1, 1.5, "5"]) {
      deps.memory.write(ROOM_CAP_PATH, cap);
      expect((await join(await newPlayer())).status).toBe(200);
    }
  });
});

describe("writes sized for a crowded room", () => {
  it("a move writes the path, start and run flag, nothing else", async () => {
    const player = await joined();
    const before = record(player.pid)!;
    const writes = recordWrites();
    deps.clock.now += 1_000;
    const path = [SPAWN_TILE, { x: SPAWN_TILE.x + 1, y: SPAWN_TILE.y }];
    const encoded = `${SPAWN_TILE.x},${SPAWN_TILE.y};${SPAWN_TILE.x + 1},${SPAWN_TILE.y}`;
    const response = await act(player, { type: "move", path, run: true });
    expect(response.status).toBe(200);
    expect(writes.filter((w) => w.startsWith("update"))).toEqual([
      `update worlds/301/players/${player.pid}/p="${encoded}"`,
      `update worlds/301/players/${player.pid}/t=${deps.clock.now}`,
      `update worlds/301/players/${player.pid}/r=true`,
    ]);
    expect(writes.some((w) => w.includes("worlds/301/players") && !w.startsWith("update"))).toBe(false);
    expect(record(player.pid)).toEqual({ ...before, p: encoded, t: deps.clock.now, r: true });
  });

  it("a move clears an emote only when one is showing", async () => {
    const player = await joined();
    deps.clock.now += 1_000;
    expect((await act(player, { type: "emote", emote: "wave" })).status).toBe(200);
    expect(record(player.pid)).toMatchObject({ e: "wave", et: deps.clock.now });
    deps.clock.now += 1_000;
    expect((await act(player, { type: "move", path: [SPAWN_TILE, { x: SPAWN_TILE.x, y: SPAWN_TILE.y + 1 }], run: false })).status).toBe(200);
    const after = record(player.pid)!;
    expect(after.e ?? null).toBeNull();
    expect(after.et ?? null).toBeNull();
  });

  it("an emote writes its two fields", async () => {
    const player = await joined();
    const writes = recordWrites();
    deps.clock.now += 1_000;
    expect((await act(player, { type: "emote", emote: "cheer" })).status).toBe(200);
    expect(writes.filter((w) => w.includes("worlds/301/players"))).toEqual([
      `update worlds/301/players/${player.pid}/e="cheer"`,
      `update worlds/301/players/${player.pid}/et=${deps.clock.now}`,
    ]);
  });

  it("a move or emote from a player who is not in the world creates nothing", async () => {
    const player = await newPlayer();
    const moved = await act(player, { type: "move", path: [SPAWN_TILE, { x: SPAWN_TILE.x + 1, y: SPAWN_TILE.y }], run: false });
    expect((await readBody<ApiErrorBody>(moved)).code).toBe("not_joined");
    const emoted = await act(player, { type: "emote", emote: "wave" });
    expect((await readBody<ApiErrorBody>(emoted)).code).toBe("not_joined");
    expect(record(player.pid)).toBeNull();
  });

  it("a fragment left by a move that raced a leave is not a player and is pruned", async () => {
    const player = await joined();
    // What a move's update leaves behind when the leave lands between its read and its write.
    deps.memory.write(playerPath(WORLD, player.pid), { p: "3185,3438", t: deps.clock.now, r: false });
    const beat = await act(player, { type: "heartbeat" });
    expect((await readBody<ApiErrorBody>(beat)).code).toBe("not_joined");
    const moved = await act(player, { type: "move", path: [SPAWN_TILE, { x: SPAWN_TILE.x + 1, y: SPAWN_TILE.y }], run: false });
    expect((await readBody<ApiErrorBody>(moved)).code).toBe("not_joined");
    expect((await prunePlayers(deps.memory, WORLD, deps.clock.now)).removed).toBe(1);
    expect(record(player.pid)).toBeNull();
    // Rejoining writes a whole record again.
    expect((await join(player)).status).toBe(200);
    expect(record(player.pid)).toMatchObject({ n: player.name, ls: deps.clock.now });
  });

  it("a heartbeat keeps a quiet player for the whole timeout with half the writes", async () => {
    const player = await joined();
    const writes = recordWrites();
    let lsWrites = 0;
    for (let t = 15_000; t <= 5 * 60_000; t += 15_000) {
      deps.clock.now += 15_000;
      const before = record(player.pid)!.ls;
      expect((await act(player, { type: "heartbeat" })).status).toBe(200);
      if (record(player.pid)!.ls !== before) lsWrites++;
      expect(deps.clock.now - record(player.pid)!.ls).toBeLessThan(PRESENCE_REFRESH_MS);
      expect((await prunePlayers(deps.memory, WORLD, deps.clock.now)).removed).toBe(0);
    }
    expect(lsWrites).toBe(10);
    expect(writes.length).toBeGreaterThan(0);
    // Two missed heartbeats in a row still leave the player in the world.
    deps.clock.now += 2 * 15_000;
    expect((await prunePlayers(deps.memory, WORLD, deps.clock.now)).removed).toBe(0);
    deps.clock.now += PLAYER_TIMEOUT_MS;
    expect((await prunePlayers(deps.memory, WORLD, deps.clock.now)).removed).toBe(1);
  });
});
