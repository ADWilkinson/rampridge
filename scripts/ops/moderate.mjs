#!/usr/bin/env bun
/**
 * Chat moderation for launch day. Find an abuser, then mute, ban, kick or
 * purge their chat. Changes are dry runs unless --apply is given.
 *
 *   bun scripts/ops/moderate.mjs recent [--minutes 15]          # recent chat with pids
 *   bun scripts/ops/moderate.mjs who <name|pid>                 # profile, presence, recent lines
 *   bun scripts/ops/moderate.mjs mute <name|pid> [--minutes 60] [--reason "..."] --apply
 *   bun scripts/ops/moderate.mjs ban <name|pid> [--days 7] [--reason "..."] --apply
 *   bun scripts/ops/moderate.mjs kick <name|pid> --apply        # remove from their world (they can rejoin)
 *   bun scripts/ops/moderate.mjs purge <name|pid> --apply       # delete their chat lines and kick
 *   bun scripts/ops/moderate.mjs unmute|unban <name|pid> --apply
 *   bun scripts/ops/moderate.mjs list                           # active mutes and bans
 *   add --hold to mute or ban to keep re-asserting it every 30 s until it ends (Ctrl-C to stop)
 *
 * How it is enforced with today's server (no deploy needed):
 * - mute sets the player's chat clock (`ratelimits/act/{pid}/cl`) into the
 *   future, so /api/act refuses their chat as "too quickly" until then.
 * - ban drains the player's action bucket (`ratelimits/act/{pid}`: b far
 *   below zero, u at the ban's end) so every action, joining included, is
 *   refused until about ten minutes after the ban ends; it also kicks them.
 * The durable record is `moderation/{pid}` ({ m: muted until, b: banned
 * until, r: reason, at }). /api/act reads it on every chat line and join, so
 * a mute or ban holds however long the player idles; --hold is no longer
 * needed (see docs/runbook.md). Sanctions are global: a muted player is muted
 * in every world, and a ban keeps them out of all of them. Chat is read and
 * purged across every world. A banned player can still start over as a new
 * guest from a fresh browser; there is no IP ban.
 */

import {
  ago,
  bannedBucket,
  fail,
  findPresence,
  hhmmss,
  kickUpdates,
  mutedBucket,
  numberFlag,
  openDatabase,
  parseArgs,
  printTarget,
  read,
  resolvePlayer,
  WORLD_IDS,
} from "./_lib.mjs";

const MAX_MUTE_MINUTES = 7 * 24 * 60;
const MAX_BAN_DAYS = 20;
const HOLD_EVERY_MS = 30_000;

const { flags, positionals } = parseArgs(process.argv.slice(2), ["apply", "hold"]);
const [command, who] = positionals;
const apply = flags.apply === true;
const reason = typeof flags.reason === "string" ? flags.reason.slice(0, 200) : null;

const USAGE = "usage: moderate.mjs recent|who|mute|unmute|ban|unban|kick|purge|list [name|pid] [--apply]";
if (!command) fail(USAGE);

const { db, target, close } = await openDatabase();
printTarget(target, apply ? "(applying changes)" : "(dry run: add --apply to change anything)");

async function player() {
  if (!who) fail(`${command} needs a player name or pid.`);
  const found = await resolvePlayer(db, who);
  if (!found) fail(`No player named or with pid "${who}".`);
  return found;
}

/** Chat lines across every world, oldest first, each with its world. */
async function chatLines(filterPid = null, sinceMs = 0) {
  const snaps = await Promise.all(WORLD_IDS.map((world) => db.ref(`worlds/${world}/chat`).orderByChild("t").startAt(sinceMs).get()));
  const lines = [];
  snaps.forEach((snap, i) => {
    snap.forEach((child) => {
      const value = child.val();
      if (!filterPid || value?.pid === filterPid) lines.push({ world: WORLD_IDS[i], key: child.key, ...value });
    });
  });
  return lines.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

function describe({ pid, profile }, presence, moderation, now) {
  console.log(`Player   ${profile?.n ?? "(no profile)"}  pid ${pid}`);
  console.log(`Profile  created ${ago(profile?.c, now)}, wallet ${profile?.w ? "verified" : "none"}`);
  console.log(`Presence ${presence ? `in world ${presence.world}, last heartbeat ${ago(presence.record?.ls, now)}` : "not in any world"}`);
  if (moderation) {
    const parts = [];
    if ((moderation.m ?? 0) > now) parts.push(`muted until ${new Date(moderation.m).toISOString()}`);
    if ((moderation.b ?? 0) > now) parts.push(`banned until ${new Date(moderation.b).toISOString()}`);
    console.log(`Status   ${parts.length ? parts.join(", ") : "no active sanction"}${moderation.r ? ` (${moderation.r})` : ""}`);
  }
}

/** Sets the chat clock so chat is refused until `until`; keeps the rest of the bucket. */
async function holdMute(pid, until, now) {
  await db.ref(`ratelimits/act/${pid}`).transaction((current) => mutedBucket(current, until, now));
}

async function holdBan(pid, until) {
  await db.ref(`ratelimits/act/${pid}`).set(bannedBucket(until));
  await db.ref().update(kickUpdates(pid));
}

async function holdLoop(apply, until, label) {
  if (!flags.hold) return;
  console.log(`Holding the ${label} until ${new Date(until).toISOString()} (Ctrl-C to stop; the record stays either way).`);
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(HOLD_EVERY_MS, until - Date.now())));
    try {
      await apply(Date.now());
    } catch (err) {
      console.error(`re-assert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const now = Date.now();
try {
  switch (command) {
    case "recent": {
      const minutes = numberFlag(flags, "minutes", 15);
      const lines = await chatLines(null, now - minutes * 60_000);
      if (!lines.length) console.log(`No chat in the last ${minutes} minutes.`);
      for (const line of lines) console.log(`${hhmmss(line.t)}  w${line.world}  ${String(line.pid).padEnd(16)}  ${String(line.n).padEnd(12)}  ${line.m}`);
      break;
    }
    case "who": {
      const found = await player();
      const [presence, moderation, lines] = await Promise.all([
        findPresence(db, found.pid),
        read(db, `moderation/${found.pid}`),
        chatLines(found.pid),
      ]);
      describe(found, presence, moderation, now);
      console.log(`Chat     ${lines.length} line(s) in the worlds' history`);
      for (const line of lines.slice(-10)) console.log(`  ${hhmmss(line.t)}  w${line.world}  ${line.m}`);
      break;
    }
    case "list": {
      const all = (await read(db, "moderation")) ?? {};
      const active = Object.entries(all).filter(([, m]) => Math.max(m?.m ?? 0, m?.b ?? 0) > now);
      if (!active.length) console.log("No active mutes or bans.");
      for (const [pid, m] of active) {
        const profile = await read(db, `profiles/${pid}`);
        const kind = (m.b ?? 0) > now ? `banned until ${new Date(m.b).toISOString()}` : `muted until ${new Date(m.m).toISOString()}`;
        console.log(`${pid}  ${String(profile?.n ?? "?").padEnd(12)}  ${kind}${m.r ? `  (${m.r})` : ""}`);
      }
      break;
    }
    case "mute": {
      const found = await player();
      const minutes = Math.min(numberFlag(flags, "minutes", 60), MAX_MUTE_MINUTES);
      const until = now + minutes * 60_000;
      console.log(`Mute ${found.profile?.n ?? found.pid} (${found.pid}) for ${minutes} min, until ${new Date(until).toISOString()}.`);
      if (!apply) break;
      await db.ref(`moderation/${found.pid}`).update({ m: until, r: reason, at: now });
      await holdMute(found.pid, until, now);
      console.log("Muted. Their chat is refused with \"You're sending messages too quickly.\"");
      await holdLoop((t) => holdMute(found.pid, until, t), until, "mute");
      break;
    }
    case "unmute": {
      const found = await player();
      console.log(`Unmute ${found.profile?.n ?? found.pid} (${found.pid}).`);
      if (!apply) break;
      await db.ref(`moderation/${found.pid}/m`).remove();
      await db.ref(`ratelimits/act/${found.pid}`).transaction((current) => {
        if (!current || typeof current.cl !== "number" || current.cl <= now) return current ?? null;
        const { cl: _cl, ...rest } = current;
        return rest;
      });
      console.log("Unmuted.");
      break;
    }
    case "ban": {
      const found = await player();
      const days = Math.min(numberFlag(flags, "days", 7), MAX_BAN_DAYS);
      const until = now + days * 86_400_000;
      console.log(`Ban ${found.profile?.n ?? found.pid} (${found.pid}) for ${days} day(s), until ${new Date(until).toISOString()}; kicks them now.`);
      if (!apply) break;
      await db.ref(`moderation/${found.pid}`).update({ b: until, m: until, r: reason, at: now });
      await holdBan(found.pid, until);
      console.log("Banned and removed from their world. Every action they send is refused, in every world.");
      await holdLoop(() => holdBan(found.pid, until), until, "ban");
      break;
    }
    case "unban": {
      const found = await player();
      console.log(`Unban ${found.profile?.n ?? found.pid} (${found.pid}).`);
      if (!apply) break;
      await db.ref(`moderation/${found.pid}`).remove();
      await db.ref(`ratelimits/act/${found.pid}`).remove();
      console.log("Unbanned (and unmuted). They can rejoin by reloading.");
      break;
    }
    case "kick": {
      const found = await player();
      console.log(`Kick ${found.profile?.n ?? found.pid} (${found.pid}) from their world.`);
      if (!apply) break;
      await db.ref().update(kickUpdates(found.pid));
      console.log("Kicked. Their client rejoins on its next heartbeat unless they are banned.");
      break;
    }
    case "purge": {
      const found = await player();
      const lines = await chatLines(found.pid);
      console.log(`Purge ${lines.length} chat line(s) by ${found.profile?.n ?? found.pid} (${found.pid}) and kick them.`);
      for (const line of lines.slice(-5)) console.log(`  ${hhmmss(line.t)}  w${line.world}  ${line.m}`);
      if (!apply) break;
      const updates = kickUpdates(found.pid);
      for (const line of lines) updates[`worlds/${line.world}/chat/${line.key}`] = null;
      await db.ref().update(updates);
      console.log(
        "Purged. Open tabs drop their lines from the chatbox at once (a tab loaded before this behaviour shipped keeps them until it reloads), and new visitors never see them.",
      );
      break;
    }
    default:
      fail(USAGE);
  }
} finally {
  await close();
}
process.exit(0);
