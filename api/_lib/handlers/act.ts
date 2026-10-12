/**
 * POST /api/act: every write to the shared worlds. Authenticates the session
 * token (from the Authorization header, or the body for a sendBeacon leave),
 * validates, rate-limits, then applies the action with the Admin SDK.
 *
 * A join picks the player's world (api/_lib/worlds.ts) and answers with a
 * token that names it; every other action acts in the world its token names
 * and nowhere else, so a player can only ever write where they stand.
 */

import { sanitiseChat } from "../../../shared/chat.js";
import { encodePath } from "../../../shared/protocol.js";
import type { ActRequest, ActResponse, ChatRecord, PlayerRecord, Tile, WorldEventRecord, WorldRequest } from "../../../shared/protocol.js";
import { validateActRequest } from "../../../shared/validate.js";
import { checkPath, currentTiles, isWalkable, PATH_ERROR_MESSAGES, pickSpawnTile } from "../../../shared/world.js";
import type { CollisionGrid } from "../../../shared/world.js";
import { chatPath, eventsPath } from "../../../shared/worlds.js";
import { verifyBought, verifyListed } from "../announce.js";
import { authenticate } from "../auth.js";
import type { Db } from "../db.js";
import type { ApiDeps } from "../deps.js";
import {
  badRequest,
  bearerToken,
  clientIp,
  conflict,
  forbidden,
  HttpError,
  json,
  notJoined,
  outdated,
  rateLimited,
  readJson,
  unauthorized,
  upstream,
  withErrors,
} from "../http.js";
import { admitFromIp } from "../ipPlayers.js";
import { moderationOf } from "../moderation.js";
import { isPlayerRecord, mutatePlayer, playerPath, touchPlayer } from "../players.js";
import { lockPresence, presenceEntry, unlockPresence } from "../presence.js";
import type { PresenceLock } from "../presence.js";
import { getProfile } from "../profiles.js";
import type { Profile } from "../profiles.js";
import { hashIp, limitAction, limitChain, limitIpChat, limitRoomChat } from "../ratelimit.js";
import { saveShare } from "../share.js";
import { buildStall } from "../stall.js";
import { indexStall, stallIndexPath } from "../stallSweep.js";
import { createSweeper } from "../sweep.js";
import { signSession } from "../token.js";
import type { SessionClaims } from "../token.js";
import { newsWorlds, placeJoin, releaseSeat, worldConfig } from "../worlds.js";
import type { WorldConfig } from "../worlds.js";

type Action<T extends ActRequest["type"]> = Extract<ActRequest, { type: T }>;

interface Context {
  deps: ApiDeps;
  db: Db;
  pid: string;
  claims: SessionClaims;
  now: number;
  sweeper: ReturnType<typeof createSweeper>;
  /**
   * Keyed hash of the caller's address (by /64 for IPv6), or null when the
   * request carries none. Vercel always sets one; without it the per-address
   * limits are skipped and the per-player and room limits still apply.
   */
  ipHash: string | null;
}

/** The world the token names. A token without one (no join yet, or a build from before worlds) is not in any world. */
function worldOf(ctx: Context): number {
  if (ctx.claims.world === undefined) throw notJoined();
  return ctx.claims.world;
}

/** Where a hopping player stands now, if it is somewhere a player can stand; they arrive on the same tile. */
function standingTile(record: PlayerRecord, grid: CollisionGrid, now: number): Tile | null {
  const tile = currentTiles(record, now).at(-1);
  return tile && isWalkable(grid, tile) ? tile : null;
}

/** Chain reads fail as 502 so the client can tell them apart from a rejected action. */
async function onChain<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw upstream("Couldn't reach Base right now. Please try again.");
  }
}

/**
 * Joins a world: the one the player is standing in (a reload, a rejoin after
 * a pause), the one asked for if it has room, or the busiest one with room
 * (worlds.ts). Where the player stands comes from the server's presence index
 * (presence.ts), never from the token, so replaying an old token can neither
 * take a second seat nor leave a second record behind. A join into another
 * world is a hop: the record moves over in one write, keeping the tile and
 * any stall. Answers with the world and a token naming it.
 */
async function join(ctx: Context, action: Action<"join">): Promise<ActResult> {
  const request = action.world;
  if (request === undefined) throw outdated();
  const [profile, moderation, config] = await Promise.all([
    getProfile(ctx.db, ctx.pid),
    moderationOf(ctx.db, ctx.pid),
    worldConfig(ctx.db),
  ]);
  if (!profile) throw unauthorized();
  if (moderation.bannedUntil > ctx.now) throw rateLimited(moderation.bannedUntil - ctx.now);
  const lock = await lockPresence(ctx.db, ctx.pid, ctx.now);
  let written = false;
  try {
    const result = await joinLocked(ctx, action, request, profile, config, lock.from);
    written = true;
    return result;
  } finally {
    if (!written) await unlockPresence(ctx.db, lock);
  }
}

async function joinLocked(
  ctx: Context,
  action: Action<"join">,
  request: WorldRequest,
  profile: Profile,
  config: WorldConfig,
  from: number | null,
): Promise<ActResult> {
  const previous = from === null ? null : await ctx.db.get<unknown>(playerPath(from, ctx.pid));
  const standing = isPlayerRecord(previous) ? previous : null;
  const placement = await placeJoin(ctx.db, { request, hop: action.hop === true, inside: standing ? from : null }, config);
  const world = placement.world;
  if (ctx.ipHash) {
    try {
      await admitFromIp(ctx.db, ctx.ipHash, ctx.pid, world, ctx.now);
    } catch (err) {
      if (placement.seated) await releaseSeat(ctx.db, world);
      throw err;
    }
  }

  const { grid, spawn: spawnTiles } = ctx.deps.worldRules();
  const carried = standing && from !== world ? standing : null;
  const tile = (carried && standingTile(carried, grid, ctx.now)) ?? pickSpawnTile(grid, ctx.deps.random, spawnTiles);
  const record: PlayerRecord = {
    n: profile.n,
    a: action.appearance,
    p: encodePath([tile]),
    t: ctx.now,
    r: false,
    e: null,
    et: null,
    w: profile.w ?? null,
    // A stall belongs to the wallet that proved it; it follows a hop only for that wallet.
    s: carried?.s && carried.w === (profile.w ?? null) ? carried.s : null,
    ls: ctx.now,
    j: ctx.now,
  };
  // The record, where the server has the player, and (for a hop) out of the old world, in one write: nobody
  // ever sees the player in two worlds, and the presence always names the world the record is in.
  const updates: Record<string, unknown> = { [playerPath(world, ctx.pid)]: record, ...presenceEntry(ctx.pid, world) };
  if (from !== null && from !== world) updates[playerPath(from, ctx.pid)] = null;
  await ctx.db.update(updates);
  if (carried) await releaseSeat(ctx.db, from!);

  const token = await signSession(
    { pid: ctx.pid, name: profile.n, wallet: profile.w ?? null, world },
    ctx.deps.sessionSecret(),
    ctx.now,
  );
  return { world, token };
}

/**
 * A move writes only the fields it changes. Every connected client downloads
 * each move, and the whole record (name, look, wallet, stall) is two to three
 * times the size of the path, start time and run flag. The record is read
 * first to check the path from where the server has the player; a leave or
 * prune that lands in between leaves a fragment without `ls`, which clients
 * ignore, the next heartbeat answers not_joined (so the client rejoins), and
 * the next prune removes.
 */
async function move(ctx: Context, action: Action<"move">): Promise<void> {
  const { grid } = ctx.deps.worldRules();
  const path = playerPath(worldOf(ctx), ctx.pid);
  const record = await ctx.db.get<unknown>(path);
  if (!isPlayerRecord(record)) throw notJoined();
  const error = checkPath(grid, action.path, currentTiles(record, ctx.now));
  if (error) throw badRequest(PATH_ERROR_MESSAGES[error]);
  const updates: Record<string, unknown> = {
    [`${path}/p`]: encodePath(action.path),
    [`${path}/t`]: ctx.now,
    [`${path}/r`]: action.run,
  };
  // Walking ends an emote; clearing one that isn't there would only add bytes.
  if ((record.e ?? null) !== null || (record.et ?? null) !== null) {
    updates[`${path}/e`] = null;
    updates[`${path}/et`] = null;
  }
  await ctx.db.update(updates);
}

/** Like a move, an emote writes only its two fields. */
async function emote(ctx: Context, action: Action<"emote">): Promise<void> {
  const path = playerPath(worldOf(ctx), ctx.pid);
  if (typeof (await ctx.db.get<unknown>(`${path}/ls`)) !== "number") throw notJoined();
  await ctx.db.update({ [`${path}/e`]: action.emote, [`${path}/et`]: ctx.now });
}

async function chat(ctx: Context, action: Action<"chat">): Promise<void> {
  const clean = sanitiseChat(action.text);
  if (!clean) throw badRequest("That message is empty.");
  const world = worldOf(ctx);
  const [name, moderation] = await Promise.all([
    ctx.db.get<string>(`${playerPath(world, ctx.pid)}/n`),
    moderationOf(ctx.db, ctx.pid),
  ]);
  if (typeof name !== "string") throw notJoined();
  // The wording the moderation runbook documents for a mute.
  if (moderation.mutedUntil > ctx.now) throw rateLimited(moderation.mutedUntil - ctx.now, "You're sending messages too quickly.");
  if (ctx.ipHash) await limitIpChat(ctx.db, ctx.ipHash, ctx.now);
  await limitRoomChat(ctx.db, world, ctx.now);
  const record: ChatRecord = { pid: ctx.pid, n: name, m: clean.text, fx: clean.fx, t: ctx.now };
  await ctx.db.push(chatPath(world), record);
}

async function stall(ctx: Context, action: Action<"stall">): Promise<void> {
  const world = worldOf(ctx);
  // Only where the player stands: a token from before a hop must not touch the index of the stall they carried.
  if (!isPlayerRecord(await ctx.db.get<unknown>(playerPath(world, ctx.pid)))) throw notJoined();
  if (action.depositId === null) {
    await mutatePlayer(ctx.db, world, ctx.pid, (record) => ({ ...record, s: null }));
    await ctx.db.remove(stallIndexPath(ctx.pid));
    return;
  }
  const profile = await getProfile(ctx.db, ctx.pid);
  if (!profile) throw unauthorized();
  if (!profile.w) throw forbidden("Verify your wallet before opening a stall.");
  const wallet = profile.w;
  const depositId = action.depositId;
  await limitChain(ctx.db, ctx.pid, ctx.now);
  const summary = await onChain(() => buildStall(ctx.deps.chain(), depositId, wallet));
  // Indexed first so heartbeats re-check it; an entry without its stall is dropped.
  await indexStall(ctx.db, ctx.pid, summary.depositId, ctx.now);
  await mutatePlayer(ctx.db, world, ctx.pid, (record) => {
    if (record.w !== wallet) throw forbidden("Verify your wallet before opening a stall.");
    return { ...record, s: summary };
  });
}

/** `announced/{tx}`: when first claimed and which proving logs are taken (`l{logIndex}` -> pid). */
type AnnouncedRecord = Record<string, string | number>;

async function announce(ctx: Context, action: Action<"announce">): Promise<ActResult> {
  const profile = await getProfile(ctx.db, ctx.pid);
  if (!profile) throw unauthorized();
  if (!profile.w) throw forbidden("Verify your wallet to announce trades.");
  const wallet = profile.w;
  const tx = action.tx.toLowerCase();
  const path = `announced/${tx}`;

  const existing = (await ctx.db.get<AnnouncedRecord>(path)) ?? {};
  const claimed = new Set(
    Object.keys(existing)
      .filter((k) => k.startsWith("l"))
      .map((k) => Number(k.slice(1))),
  );
  await limitChain(ctx.db, ctx.pid, ctx.now);
  const chain = ctx.deps.chain();
  const receipt = await onChain(() => chain.getReceipt(tx as `0x${string}`));
  const verified =
    action.kind === "bought"
      ? verifyBought(receipt, wallet, chain.contracts, ctx.now, claimed)
      : verifyListed(receipt, wallet, chain.contracts, ctx.now, claimed);

  const slot = `l${verified.logIndex}`;
  const claim = await ctx.db.transaction<AnnouncedRecord>(path, (current) => {
    if (current?.[slot] !== undefined) return undefined;
    return { ...current, t: typeof current?.t === "number" ? current.t : ctx.now, [slot]: ctx.pid };
  });
  if (!claim.committed) throw conflict("That trade has already been announced.");

  const event: WorldEventRecord = {
    kind: verified.kind,
    pid: ctx.pid,
    n: profile.n,
    usdc: verified.usdc,
    fiat: verified.fiat,
    currency: verified.currency,
    platform: verified.platform,
    tx,
    t: ctx.now,
  };
  // World news is the best advert: every world hears it, under one key.
  const key = ctx.db.key();
  const worlds = await newsWorlds(ctx.db);
  await ctx.db.update(Object.fromEntries(worlds.map((world) => [`${eventsPath(world)}/${key}`, event])));
  // The durable record behind the trade's share link. The announcement already stands, so a failure here
  // only costs the link (the Share button falls back to the site).
  try {
    const shareId = await saveShare(ctx.db, event, ctx.pid, ctx.claims.world ?? null);
    return shareId ? { shareId } : {};
  } catch (err) {
    console.error("Share record not saved:", err instanceof Error ? err.message : String(err));
    return {};
  }
}

/** Fields an action adds to the response. */
type ActResult = Pick<ActResponse, "shareId" | "world" | "token">;

/**
 * Leaves the world the token names, if the server has the player there: a
 * token from before a hop has nothing to leave (it must not remove the player,
 * or their stall's index, from the world they hopped to), and a join of the
 * same player under way wins.
 */
async function leave(ctx: Context): Promise<void> {
  // A token from before any join has nothing to leave.
  if (ctx.claims.world === undefined) return;
  const world = ctx.claims.world;
  let lock: PresenceLock | null;
  try {
    lock = await lockPresence(ctx.db, ctx.pid, ctx.now, world);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return;
    throw err;
  }
  if (!lock) return;
  const path = playerPath(world, ctx.pid);
  let present: boolean;
  try {
    present = typeof (await ctx.db.get<unknown>(`${path}/ls`)) === "number";
    await ctx.db.update({ [path]: null, [stallIndexPath(ctx.pid)]: null, ...presenceEntry(ctx.pid, null) });
  } catch (err) {
    await unlockPresence(ctx.db, lock);
    throw err;
  }
  if (present) await releaseSeat(ctx.db, world);
}

async function dispatch(ctx: Context, action: ActRequest): Promise<ActResult | void> {
  switch (action.type) {
    case "join":
      return join(ctx, action);
    case "move":
      return move(ctx, action);
    case "chat":
      return chat(ctx, action);
    case "emote":
      return emote(ctx, action);
    case "heartbeat":
      await touchPlayer(ctx.db, worldOf(ctx), ctx.pid, ctx.now);
      // Heartbeats double as the presence and stall sweeps (sweep.ts).
      await ctx.sweeper.maybeSweep(ctx.db, ctx.deps.chain, ctx.now);
      return;
    case "leave":
      return leave(ctx);
    case "appearance":
      await mutatePlayer(ctx.db, worldOf(ctx), ctx.pid, (record) => ({ ...record, a: action.appearance }));
      return;
    case "stall":
      return stall(ctx, action);
    case "announce":
      return announce(ctx, action);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createActHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  const sweeper = createSweeper();
  return withErrors(deps.now, async (request) => {
    const body = await readJson(request, 8_192);
    // sendBeacon cannot set headers, so a leave may carry its token in the body.
    let token = bearerToken(request);
    let payload = body;
    if (!token && isRecord(body) && body.type === "leave" && typeof body.token === "string") {
      const { token: bodyToken, ...rest } = body;
      token = bodyToken as string;
      payload = rest;
    }
    const claims = await authenticate(deps, token);
    const parsed = validateActRequest(payload);
    if (!parsed.ok) throw badRequest(parsed.error);
    // An empty message should not spend the player's chat allowance.
    if (parsed.value.type === "chat" && !sanitiseChat(parsed.value.text)) throw badRequest("That message is empty.");

    const db = deps.db();
    const now = deps.now();
    await limitAction(db, claims.pid, now, parsed.value.type === "chat");
    const ip = clientIp(request);
    const ipHash = ip ? hashIp(ip, deps.sessionSecret()) : null;
    const result = (await dispatch({ deps, db, pid: claims.pid, claims, now, sweeper, ipHash }, parsed.value)) || undefined;

    const response: ActResponse = { ok: true, now: deps.now(), ...result };
    return json(response);
  });
}
