# Load and abuse tests

Simulated players and attacks against the local dev API and the Firebase
Realtime Database emulator. They measure what crowded worlds cost (realtime
download per client, messages a second per world, API latency) and check
that the server refuses abuse. They never touch production.

| File | What it does |
|---|---|
| `emulator.sh` | Starts the database emulator on `127.0.0.1:9460` (namespace `rampridge-world`, the repo's `database.rules.json`). `PORT=9470` runs a second one; its hub and logging ports move with it. |
| `swarm.mjs` | N players, each like a browser tab: session, join (the server assigns the world), its own realtime connection to that world with the same subscriptions as `src/net/transport.ts`, heartbeat every 15 s, legal random walks (or following another player), chat and emotes, optional world hops, leave. One counting proxy per world. Prints and writes a JSON report with a per-world breakdown, and `afterLeave`: each world's count and the records left once everyone has gone (both should be 0). |
| `abuse.mjs` | Session farming (IPv4 and IPv6), cross-site sessions, chat spam and floods, bots from one address, the overall room cap, mutes and bans, malformed and oversized payloads, teleports, name squatting and look-alikes, join/leave churn, stale players, stall and announcement forgery, token replay and tampering, the database rules, builds from before worlds, hops with per-world writes, joins replayed with old tokens (one record and one seat per player), and the world counts under concurrent leaves and hops. Each check prints PASS, GAP or INFO. Always exits 0: it reports, it does not gate. |
| `summarise.mjs` | Turns swarm reports into a measured table, a fit of traffic against world size, and an extrapolation to production prices and limits for worlds of `--cap` players beside the same players in one room. |
| `lib.mjs`, `firebase.json` | Shared helpers (a byte- and frame-counting proxy in front of the emulator, a browser-like subscription) and the emulator config. |

## Safety

- `swarm.mjs` and `abuse.mjs` refuse any `--api` or `--emulator` that is not
  `127.0.0.1`, `localhost` or `::1` (`assertLocal` in `lib.mjs`).
- The dev API writes to the emulator only while `FIREBASE_DATABASE_EMULATOR_HOST`
  is set, and then never loads the production service account. Check its
  startup line: `[dev-api] /api/* uses the Firebase database emulator at 127.0.0.1:9460.`
  Never start it with `RAMPRIDGE_DEV_LIVE_DB=1` for these tests.
- Give the dev API throwaway `SESSION_SECRET` (32 bytes or more) and
  `CRON_SECRET` on the command line. Without them it copies whatever
  `.env.local` holds (production's, on a maintainer's machine), and
  `abuse.mjs` needs the same values to forge tokens and call the cron.
  `BASE_RPC_URL=https://mainnet.base.org` keeps any private RPC key out of the
  run (only the stall and announcement checks read Base).

## Running

Needs the Firebase CLI and Java (for the emulator), Node 22.18 or newer (the
scripts load `shared/*.ts` through Node's type stripping and
`module.registerHooks`; tested on Node 26), and `bun install` done.

```bash
# Terminal 1: the database emulator (foreground; Ctrl-C stops it and its data)
bash scripts/load/emulator.sh

# Terminal 2: the dev API against it
export SESSION_SECRET=load-test-session-secret-never-production CRON_SECRET=load-test-cron-secret
FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9460 BASE_RPC_URL=https://mainnet.base.org \
  bunx vite --port 5260 --strictPort

# Terminal 3: the same two exports, then
node scripts/load/swarm.mjs --players 600 --duration 180 --ramp 30 --follow 0.1 --hop 0.1 --worlds 5 --world-cap 200 --out w-600.json
node scripts/load/swarm.mjs --players 1200 --duration 180 --ramp 30 --follow 0.1 --hop 0.1 --worlds 10 --world-cap 200 --out w-1200.json
node scripts/load/abuse.mjs --out abuse.json                  # --only rules,worldHops,... for a subset
node scripts/load/summarise.mjs --label worlds w-600.json w-1200.json   # --open 14 --room-cap 2000 (the launch settings)
```

`--worlds` and `--world-cap` write `meta/worlds` and `meta/worldCap` into the
emulator before the run, as the operator would in the Firebase console. To
watch the swarm, open the dev server in a browser: with
`FIREBASE_DATABASE_EMULATOR_HOST` set, the page reads the same emulator
(`vite.config.ts`), not the live database.

- Swarm options (defaults): `--players 50`, `--duration 120` seconds of steady
  play, `--ramp 20` seconds to bring everyone in, `--workers ceil(players/50)`
  processes, `--move-every 10`, `--chat-every 60`, `--emote-every 120` (mean
  seconds), `--run 0.3`, `--follow 0` (share of players following another
  player, re-planning every 600 ms like the engine's Follow), `--worlds` and
  `--world-cap` (the server's defaults, 3 and 200), `--hop 0` (share of
  players who hop to another world about once a minute), `--api
  http://localhost:5260`, `--emulator 127.0.0.1:9460`.
- `--watch emulator=<pid>,vite=<pid>` also samples their CPU and memory
  (`lsof -ti tcp:9460 -sTCP:LISTEN` and `lsof -ti tcp:5260 -sTCP:LISTEN` give
  the pids).
- Each swarm player sends from its own `10.x.y.z` address, so per-address
  limits stay out of the way; `abuse.mjs` uses fresh `198.18.x.x` addresses
  per check and a random start, so reruns don't inherit rate-limit buckets.
- `summarise.mjs` fits traffic per client as a straight line through the
  origin in the size of the client's own world, one point per world per run
  (reports from before worlds count as one world). It assumes the current
  server, where only every other heartbeat writes `ls`, and places the
  extrapolated players as the server does (fill the busiest world to 70% of
  `--cap`, then spill) across `--open` worlds (default 14) under `--room-cap`
  (default 2000), beside the default 3 worlds and one room.
- Abuse check names for `--only`: `sessionFarmingIpv4`, `sessionFarmingIpv6`,
  `crossSiteSession`, `chatSpamOneSession`, `chatFloodManySessions`,
  `botsPerAddress`, `sameplayerConcurrency`, `roomCap`, `moderation`,
  `oldClientCompat`, `fragments`, `oversizedAndMalformed`, `chatFilterEvasion`,
  `teleportMoves`, `names`, `joinLeaveChurn`, `stalePlayers`, `forgery`,
  `walletProofForgery`, `tokens`, `rules`, `buildsBeforeWorlds`, `worldHops`,
  `tokenReplay`, `seatCounts`, `nameCheckEnumeration`.

Latency comes from the local emulator and one Vite process, so treat it as
relative. Bytes and message counts are the protocol's own and carry over to
production.

## Results with worlds placed as the server places them, 2026-10-12

After the review fixes (one record and one seat per player through
`presence/{pid}`, world counts moved by server-side increments). Apple M4
Pro, one emulator and one Vite process (the host was also busy, load
average 8 to 15), 10% following, 10% hopping to another world about once a
minute, 180 s steady, every player active. More worlds were open than the
players fill (`--worlds 5` for 600, `--worlds 10` for 1,200), as at launch,
so the server packed arrivals into worlds of about 140 (70% of 200) and the
hoppers spread out from there.

| | 600 players, 5 open | 1,200 players, 10 open |
|---|---|---|
| Players per world (steady) | 142, 137, 142, 137, 42 | 127-149 x 8, 66, 13 |
| Realtime download per client per minute | 305 KB | 310 KB |
| Messages per client per minute | 1,693 | 1,722 |
| Messages a second per world (worlds of ~140) | 3,966-4,349 | 3,521-4,668 |
| Messages a second, all worlds | 16,935 | 34,435 |
| join p50 / p95 / p99 | 4.9 / 8.5 / 24 ms | 4.5 / 20 / 38 ms |
| move p50 / p95 / p99 | 4.2 / 7.2 / 11 ms | 4.8 / 12 / 28 ms |
| heartbeat p50 / p95 / p99 | 3.2 / 6.5 / 10 ms | 3.8 / 11 / 26 ms |
| chat p50 / p95 / p99 | 5.6 / 10 / 17 ms | 6.7 / 21 / 53 ms |
| hop p50 / p95 / p99 | 8.7 / 15 / 19 ms (240 hops, all placed) | 10 / 28 / 76 ms (395 hops, all placed) |
| leave p50 / p95 | 24 / 28 ms | 50 / 95 ms |
| Errors | 1 of 32,575 (a chat line sent with the token from before its player's hop) | 1 of 64,551 (the same) |
| World counts and records after everyone left | all 0, no records | all 0, no records |
| Emulator CPU mean / max | 43% / 59% | 87% / 112% |

Each client downloads 2,351 B and 12.8 messages a minute for every other
player in its world with a tenth of the players hopping each minute (1,990 B
and 11.3 without hops, below): a hop rewrites the whole player record in two
worlds. A world of 140 costs about $3.20 an hour and sends 4,200 messages a
second; one of 200 costs $6.50 and sends 8,500. Before the fixes the mass
leave at the end of a run left phantom players in the counts (187 after a
1,200 run in review); now every count returns to 0.

Extrapolated with that fit, at the launch settings (`meta/worlds` 14,
`meta/roomCap` 2000; `summarise.mjs` defaults):

| Players | Worlds (players each) | Turned away | Download per client per minute | Firebase $ an hour | With only the default 3 open: $ an hour, turned away | One room: $ an hour | Responses a second, all worlds | Writes a second |
|---|---|---|---|---|---|---|---|---|
| 300 | 140, 140, 20 | 0 | 303 KB | 6.47 | 6.47, 0 | 14.70 | 8,422 | 135 |
| 600 | 4 x 140, 40 | 0 | 306 KB | 13.07 | 19.60, 0 | 58.79 | 17,013 | 270 |
| 800 | 5 x 140, 100 | 0 | 310 KB | 17.65 | 19.60, 200 | 104.51 | 22,968 | 360 |
| 1,000 | 7 x 140, 20 | 0 | 316 KB | 22.48 | 19.60, 400 | 163.29 (over) | 29,263 | 449 |
| 1,200 | 8 x 140, 80 | 0 | 312 KB | 26.66 | 19.60, 600 | 235.13 (over) | 34,707 | 539 |
| 2,000 | 12 x 143, 2 x 142 | 0 | 328 KB | 46.68 | 19.60, 1,400 | 653.13 (over) | 60,762 | 899 (near) |
| 2,500 | 12 x 143, 2 x 142 | 500 (room cap) | 328 KB | 46.68 | 19.60, 1,900 | 1,020.51 (over) | 60,762 | 899 (near) |

Open worlds cost nothing until players are in them, and once arrivals spill
over, more open worlds are cheaper than fewer full ones (1,200 players: $27
an hour in worlds of about 140, $39 in six full worlds of 200). The binding
limit is the database's 1,000 writes a second on the total, near 2,000
players, so `meta/roomCap` 2000 is the ceiling and the cost brake.

Abuse checks on the same server (`abuse.mjs`, the full suite): every check
PASS except the same GAP and INFO rows as on 2026-10-11 below. The new ones:
`tokenReplay` (8 joins replayed with the session's token and two
simultaneous hops leave one record and take one seat) and `seatCounts` (40
players in one world, 30 leaving and 10 hopping out at once: both counts
come back exactly).

## Results with every world full, 2026-10-12

Apple M4 Pro, one emulator and one Vite process, 10% following, 180 s
steady, every player active (walking every ~10 s, chatting every ~60 s).
The server placed every arrival (`--worlds 3` / `6`, `--world-cap 200`), so
both runs filled every world to its cap: the worst case for a world's
traffic. (Before the review fixes; the extrapolation below assumed exactly
enough worlds for everyone, all full, and is superseded by the table above.)

| | 600 players, 3 worlds | 1,200 players, 6 worlds |
|---|---|---|
| Players per world | 200, 200, 200 | 200 x 6 |
| Realtime download per client per minute | 395 KB | 386 KB |
| Messages per client per minute | 2,286 | 2,241 |
| Messages a second per world | 7,549-7,711 | 7,157-7,958 |
| Messages a second, all worlds | 22,860 | 44,830 |
| join p50 / p95 / p99 | 7.6 / 79 / 180 ms | 5.0 / 140 / 243 ms |
| move p50 / p95 / p99 | 5.0 / 22 / 67 ms | 7.6 / 64 / 133 ms |
| heartbeat p50 / p95 / p99 | 4.1 / 17 / 56 ms | 6.5 / 57 / 123 ms |
| chat p50 / p95 / p99 | 6.7 / 30 / 100 ms | 11.4 / 120 / 242 ms |
| Errors, 429s | 0, 0 (29,505 requests) | 0, 0 (59,500 requests) |
| Emulator CPU mean / max | 51% / 97% | 96% / 122% |

What a client downloads depends only on the size of its own world: 1,990 B a
minute for each other player there (11.3 messages), against 1,909 B in the
single-room runs below. Doubling the players with worlds of the same size
doubles the total and leaves each client's share flat; in one room it
quadruples. The p95 and p99 latencies at 1,200 come from the single local
emulator process running flat out, not from the API.

Extrapolated with that fit (Blaze $1 per GB downloaded, TLS framing and
reconnects included; arrivals placed as the server places them, at least 3
worlds open and as many more as the players need):

| Players | Worlds (players each) | Download per client per minute | Firebase $ an hour, worlds | Firebase $ an hour, one room | Responses a second, all worlds | Writes a second |
|---|---|---|---|---|---|---|
| 300 | 140, 140, 20 | 257 KB | 5.51 | 12.52 | 7,446 | 124 |
| 600 | 3 x 200 | 389 KB | 16.69 | 50.06 | 22,563 | 248 |
| 1,000 | 5 x 200 | 389 KB | 27.82 | 139.05 | 37,606 | 414 |
| 1,200 | 6 x 200 | 389 KB | 33.39 | 200.23 (270,000 responses a second: over) | 45,127 | 497 |
| 2,000 | 10 x 200 | 389 KB | 55.64 | 556.17 | 75,211 (near) | 828 (near) |
| 3,000 | 15 x 200 | 389 KB | 83.46 | 1,251.36 | 112,817 (over) | 1,241 (over) |

A full world of 200 costs about $5.60 an hour and sends about 7,500 messages
a second. The single database's limits now bind on the total, not on one
room: writes reach 1,000 a second at about 2,400 players and responses
100,000 a second at about 2,600, so `meta/roomCap` 2,000 is a sensible
overall ceiling (`docs/runbook.md`). Vercel stays well under $1 an hour.

Abuse results with worlds (`abuse.mjs`, same server): every check PASS except
the same GAP and INFO rows as on 2026-10-11 below (the one-tile speed hack
measured 21.9 tiles a second this time). The new checks: `rules` (a browser reads one world at a time and nothing else,
and writes nothing), `buildsBeforeWorlds` (a join without a world gets the
429 `outdated` refusal and nothing is written), `worldHops` (a hop moves the
record in one write, the token from before the hop acts nowhere, chat lands
only in the new world, a closed or made-up world is refused).

## Results, single room, 2026-10-11

Apple M4 Pro, runs of 50, 150 and 300 players with 10% following, 180 s
steady. "Before" is the server as it stood that evening, before the load
fixes; "after" adds the fixes listed below.

| | Before | After |
|---|---|---|
| Realtime download per client per minute, for each player in the room | 3,354 B | 1,909 B |
| Messages per client per minute, for each player in the room | 13.2 | 11.1 |
| API requests per player per minute | 13.2 (heartbeat 4, move 7.7, chat 1, emote 0.6) | 13.2 |
| 300 players: download per client per minute | 988 KB | 557 KB |
| 300 players: room messages a second | 19,800 | 16,700 |
| 300 players: move p50 / p95 / p99 | 7.5 / 56 / 156 ms | 6.9 / 33 / 179 ms |
| 300 players: errors | 0.03% | 0.02% (3 local fetch failures) |

Extrapolated to production with the "after" fit (Blaze $1 per GB downloaded,
TLS framing and reconnect handshakes included; Firebase's limits are about
100,000 responses and 1,000 writes a second per database):

| Players | Download GB an hour | Firebase $ an hour | Responses a second | Writes a second | Vercel $ an hour |
|---|---|---|---|---|---|
| 300 | 12.1 | 12 | 16,700 | 122 | 0.16 |
| 500 | 33.5 | 33 | 46,400 | 204 | 0.26 |
| 700 | 65.6 | 66 | 91,000 (near) | 285 | 0.36 |
| 1,000 | 133.9 | 134 | 185,700 (over) | 407 | 0.52 |

So one room held about 670-730 players when everyone is active (11 messages a
minute per pair) and about 1,040 when calm (5.5), and its cost grew with the
square of the room. Worlds (above) replaced the single room for that reason.

Fixes measured in the "after" runs:

- Moves and emotes write only the fields they change (path, start time, run
  flag; emote and its time) instead of the whole player record.
- Heartbeats rewrite `ls` only once it is 20 s old, so every other heartbeat
  reaches the other clients; a player times out after 60 s instead of 45 s.
- Per-address keys count an IPv6 address by its /64.
- Chat per address: a burst of 10, then one a second, on top of each player's
  own pace and the room's 20 a second.
- At most 20 players in the room per address (`api/_lib/ipPlayers.ts`).
- `meta/roomCap`: an operator cap on the room, no deploy (now the overall cap across worlds, `api/_lib/worlds.ts`).
- A chosen name that reads like another player's in the game font (I/l/1,
  O/0) is refused (`nameSkeletons/`).
- `/api/act` enforces `moderation/{pid}` mutes and bans.
- A player's own parallel actions no longer get a spurious `not_joined` 409.

Abuse results after the fixes: every check PASS except these.

| Check | Result |
|---|---|
| Speed hack with one-tile moves | GAP: 8 back-to-back one-tile moves accepted, 16 tiles a second (running is 3.3). Each step is legal, so it is a fast walk, not a teleport |
| Old token after a rename | INFO: sessions are 30-day bearer tokens; the old one still works and chat shows the current name. Revocable only all at once (`SESSION_NOT_BEFORE`) |
| 2 MB body | INFO: 500 locally; the handler refuses over 8 KB and Vercel caps bodies at 4.5 MB |
| Chat filter evasion | INFO: masked lines, for reading by eye |
