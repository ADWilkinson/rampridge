# RampRidge operations runbook

How the maintainer launches, watches and repairs production at
https://www.rampridge.xyz. Contributors never need it to develop; it is
public so the way the live bank is run is open too.

Everything here runs from the repository root with `.env.local` holding
production's server values (`vercel env pull .env.local`). Scripts read
secrets from it and never print them. Days in telemetry are UTC. Vercel CLI
commands use the linked project's team; add `--scope <team>` (or set
`VERCEL_SCOPE` for `scripts/ops`) if the CLI is logged in to another. Firebase
CLI commands use the project in `.firebaserc`.

| What | Command |
|---|---|
| One-screen status | `node scripts/ops/status.mjs` (add `--watch 30` to keep it open) |
| Health only | `curl -s https://www.rampridge.xyz/api/health \| jq` (200 ok, 503 degraded, 404 deploy predates it) |
| Live deployment | `vercel inspect www.rampridge.xyz` |
| Deploy | `bun run deploy:prod`, then [After a deploy](#after-a-deploy) |
| Logs | `vercel logs --environment production --no-branch --since 30m` |
| Worlds | Firebase console, `rampridge-world`, `meta/worlds`, `meta/worldCap`, `meta/roomCap` (see [Worlds](#worlds-and-realtime-load)) |
| Moderation | `node scripts/ops/moderate.mjs recent` then `mute` / `ban` / `purge` |
| Stuck buy | `node scripts/ops/intent.mjs <intent hash \| tx hash \| buyer address>` |
| Buy/sell matrix | `bun run ops:matrix` (read-only, one to two minutes; see [Peer matrix](#peer-matrix-what-can-be-bought-and-sold-right-now)) |
| Seller spreads off | `SELL_SPREAD_ENABLED = false` + deploy (see [Seller spreads](#seller-spreads)) |
| Cleanup | `node scripts/ops/db-maintenance.mjs` (dry run) |

Agents and contributors never write to the production database. Every
database change in this runbook (world settings, moderation, cleanup with
`--apply`, rules) is the maintainer's action.

## Before going live

1. `bun run check` passes and the tree is committed (deploy ships HEAD only).
2. Deploy, then run every check in [After a deploy](#after-a-deploy).
3. Load https://www.rampridge.xyz once on a phone and once on desktop, press
   Play, then confirm `page_view` and `play` moved in the status Funnel. If
   every counter stays at 0, telemetry is not wired or not deployed yet.
4. CDP paymaster: check the remaining global budget (see "Gas sponsorship"
   below) and raise it before announcing if launch traffic could exceed it.
5. Worlds: set `meta/worlds` = `14` and `meta/roomCap` = `2000` (see
   [Worlds](#worlds-and-realtime-load)). No deploy is needed. Left unset, the
   defaults open only 3 worlds of 200 and turn away player 601 onward with
   "The bank is full". Open worlds cost nothing until players are in them:
   arrivals fill one world to 140 before the next gets anyone, so a quiet
   launch is still one lively world, and `meta/roomCap` is the cost brake.
6. One-time guards, also in that section: a Firebase budget alert and a
   Vercel firewall rate rule on `/api/act`.
7. Announcement copy: name only payment methods buyers can actually use.
   Check the live book with `bun run ops:matrix` first. At launch (2026-10-11
   and 12) Peer's eligible book had no Venmo or PayPal offers at about $20 or
   $250, because nearly every Venmo and PayPal deposit is Peer Pay; Revolut,
   Wise, Zelle, Cash App and Chime filled both sizes in USD. So "Buy real USDC
   with Revolut, Wise, Zelle and more" was accurate, and Venmo only on the
   sell side.
8. Run `bun run ops:matrix` once more just before announcing. It should end
   "No errors." (see [Peer matrix](#peer-matrix-what-can-be-bought-and-sold-right-now)).

## Deploy

```bash
bun run deploy:prod          # clean export of HEAD -> vercel deploy --prod
```

Database rules change only with `firebase deploy --only database`.
Browsers may read one world at a time (`worlds/{301..399}`) and nothing else; server-only paths such as `ops/`, `meta/`, `presence/`, `moderation/`, `ipjoins/` and `ratelimits/` need no rule.

### The worlds release (once)

A one-off migration, kept for the record: a new deployment starts with worlds
and skips it. The release that split the bank into worlds moves the realtime
data from `world/` to `worlds/{id}/` and changes the rules to match. In this
order:

1. Rules first: `firebase deploy --only database`.
   Tabs still on the old build lose their view of the bank for the minute
   until step 2; they are about to be told to reload anyway.
2. Code: `bun run deploy:prod`, then [After a deploy](#after-a-deploy).
3. Open the site, press Play: the chatbox says "Welcome to RampRidge. You are
   on World 301." and the Logout tab's World Switcher lists the open worlds
   (301-314 at the launch settings in [Before going live](#before-going-live)).
4. A tab that loaded the old build before step 2 is refused at its next
   heartbeat or Play with "RampRidge was updated. Reload the page to keep
   playing." (in its chatbox, or on the title). Nothing it sends is written.
   If it later loads a code chunk the new deployment doesn't have, the
   existing "RampRidge was updated. Reload to continue." screen shows too.
5. Remove the single room's leftovers: `node scripts/ops/db-maintenance.mjs
   --legacy` (dry run), then `--legacy --apply`. It deletes `world/`,
   `meta/room` and `meta/chatWindow`; nothing reads them now.

### After a deploy

Run all of these after every production deploy. Each line says what a pass looks like.

```bash
# 1. The new build is the one serving: both print the same dpl_ id, created just now.
vercel inspect www.rampridge.xyz
curl -s https://www.rampridge.xyz/api/health | jq '{ok, id: .deployment.id, telemetry, missingConfig}'
#    ok true, telemetry "on", missingConfig []. A 404 means the serving build predates /api/health.

# 2. Cache headers. actors.bin is content-hashed (?v=), so it is cached for a year;
#    everything else under /game keeps a one-hour cache so a re-bake shows up the same day.
curl -sI https://www.rampridge.xyz/game/actors/actors.bin | grep -i cache-control
#    public, max-age=31536000, immutable
curl -sI https://www.rampridge.xyz/game/world/varrock-west-bank.glb | grep -i cache-control
curl -sI https://www.rampridge.xyz/game/sprites/manifest.json | grep -i cache-control
#    both: public, max-age=3600, stale-while-revalidate=86400

# 3. Funnel and errors move: open the site, press Play, then
node scripts/ops/status.mjs                       # page_view and play counted today
vercel logs --environment production --no-branch --since 15m --query client-error
#    no new error groups since the deploy
```

4. The title downloads none of the Peer SDK, Privy, WalletConnect or Firebase.
   The title needs only the shell, the engine and the game assets; the realtime
   client, the world screen, the light interfaces and the merchants (Peer SDK)
   load once the title is idle, and the trading interfaces, `@zkp2p/cash`, Privy
   and WalletConnect once the world is idle or a player opens them.
   `src/app/titleGraph.test.ts` guards the source; this checks what is served:

   ```bash
   SITE=https://www.rampridge.xyz node --input-type=module <<'EOF'
   const site = process.env.SITE, get = async (p) => (await fetch(site + p)).text();
   const seen = new Map(), queue = [/src="\/assets\/([^"]+\.js)"/.exec(await get("/"))[1]];
   while (queue.length) {
     const f = queue.shift();
     if (seen.has(f)) continue;
     const code = await get(`/assets/${f}`);
     seen.set(f, code);
     // Static imports, plus the shell and engine chunks the title loads before it shows.
     for (const m of code.matchAll(/(?:import|export)\s*(?:[\w$*{},\s]*from\s*)?["']\.\/([^"']+\.js)["']|assets\/((?:AppRoot|game|osrs)-[\w-]+\.js)/g)) queue.push(m[1] ?? m[2]);
   }
   const banned = { "@zkp2p": /@zkp2p\//, privy: /auth\.privy\.io/, walletconnect: /relay\.walletconnect\.(?:org|com)/, firebase: /@firebase\/database/ };
   const hits = [...seen].flatMap(([f, code]) => Object.entries(banned).filter(([, re]) => re.test(code)).map(([name]) => `${name} in ${f}`));
   console.log(`title: ${seen.size} chunks, ${Math.round([...seen.values()].join("").length / 1024)} KB;`, hits.length ? `FAIL ${hits.join(", ")}` : "ok");
   EOF
   ```

   A pass prints `ok` (a build of the 2026-10-11 working tree: about 21 chunks,
   1.2 MB uncompressed). The build serving before that deploy fails with
   `firebase` and `@zkp2p` hits across about 40 chunks and 3.4 MB.

## Roll back

```bash
vercel ls rampridge --environment production   # pick the last good READY url
vercel rollback <that url> --yes
vercel inspect www.rampridge.xyz               # confirm it is serving
```

- After a rollback Vercel stops auto-aliasing new production deploys. When the
  fix is out, `bun run deploy:prod`, then
  `vercel promote <new url> --yes`.
- A rollback restores code only. Database contents (including the world
  settings) and env vars stay as they are.
- Rolling back past the worlds release also needs the old rules, which let
  browsers read `world/`: save the rules below to a file, point
  `firebase.json` at it for one `firebase deploy --only database`, then
  restore it. Old builds then work as before, with an empty room.

  ```json
  {
    "rules": {
      ".read": false,
      ".write": false,
      "world": {
        ".read": true,
        "chat": { ".indexOn": ["t"] },
        "events": { ".indexOn": ["t"] },
        "players": { ".indexOn": ["ls"] }
      }
    }
  }
  ```
- Open tabs keep their build's chunks (skew protection); a reload moves them.

## Watch

```bash
vercel logs --environment production --no-branch --since 30m                       # everything recent
vercel logs --environment production --no-branch --since 1h --level error          # server errors and [client-error] lines
vercel logs --environment production --no-branch --since 1h --status-code 5xx      # failing requests
vercel logs --environment production --no-branch --since 1h --query client-error   # browser errors (already scrubbed)
vercel logs <deployment url> --follow                                               # live tail of one deployment
```

`--no-branch` matters: deploys come from a clean export with no git metadata, so
the default branch filter (main) hides every log line.

### Reading the funnel (`status.mjs`)

| Row | Means | Worry when |
|---|---|---|
| `play / page_view` | visitors who pressed Play | low on `*-inapp` browsers: X's in-app browser, suggest opening in Safari/Chrome |
| `login / play` | Privy logins completed | flat while `play` grows: see Privy |
| `signal_ok / quote` | orders placed from a quote | `signal_fail` rising: Curator, gas, or liquidity moved |
| `fulfil_ok / verify_start` | purchases completed | `fulfil_fail` > 0: read the `buy.fulfill` errors, then the intent |
| `deposit_ok / sell_start` | sell orders listed | `deposit_fail` > 0: read the `deposit` errors |
| `send_ok` | USDC sent off the platform from Send | `send_unconfirmed` > 0: a send whose outcome was lost; the window settles it from the chain, read the `send` errors if it persists |
| `gas_fail` | smart-wallet sends the paymaster refused | any: see Gas sponsorship |
| `practice_start`, `practice_done / practice_start` | practice trades opened and finished (simulated: no wallet, chain or money, and never counted as a quote, signal or fulfilment) | `practice_done` far below `practice_start`: a step of the practice confuses people |
| `client_error` | distinct browser errors per page | a jump after a deploy: roll back |

`Browsers` and `Sources` split today's page views by browser family and by
where the visit came from. A source is one coarse class from
`shared/referrer.ts` (`x`, `github`, `peer`, `search`, `newsletter`, `share`
for a trade link, `direct` when no referrer or campaign arrived, and so on),
read from `?from=share`, then `utm_source`, then the referring host. Only the
class is stored, under `ops/referrers/{day}`, never the URL. Messaging apps and
many in-app browsers send no referrer, so their visits read as `direct`: tag
links posted there with `?utm_source=telegram` (or the outlet's name).

Errors are grouped by fingerprint under "Top groups". The record names the
context (`buy.signal`, `deposit`, `sponsorship`, `boundary`), browser family,
build and path. Messages are scrubbed of addresses, tokens and payee handles
before storage. The browser sends them to `POST /api/log` (funnel counters
under `ops/metrics/{day}`, errors under `ops/errors/{day}`).

Kill switch if telemetry itself misbehaves: set `RAMPRIDGE_TELEMETRY=off`
(`vercel env add RAMPRIDGE_TELEMETRY production`), then `bun run deploy:prod`,
because env changes only reach a new deployment. `/api/log` then accepts and
drops everything without touching the database, and `/api/health` reports
`"telemetry": "off"`. Remove the variable and redeploy to turn it back on.

## Peer matrix: what can be bought and sold right now

`docs/design.md` ("Currencies and payment methods") is the matrix: selling
offers 11 platforms and the 11 major currencies in `shared/currencies.ts`,
all priced by the oracle; the buy side's matrix is defined in
`src/peer/platforms.ts`. `scripts/ops/peer-matrix.ts` checks it against the
live sources. It only reads: no wallet, no signing, no `makers/create`, no
database, and it needs no `.env.local`.

```bash
bun run ops:matrix                                    # one to two minutes; prints the tables
bun scripts/ops/peer-matrix.ts --json /tmp/matrix.json   # also where the JSON goes (default: $TMPDIR/rampridge-peer-matrix.json)
bun scripts/ops/peer-matrix.ts --no-quotes            # skip Curator quotes (a few seconds)
bun scripts/ops/peer-matrix.ts --amounts 50,1000      # other order sizes, in USD
```

| Section | Asks | Fails when |
|---|---|---|
| (a) | Attestation service `GET /buyer/supported` vs `BUYER_TEE_VERIFIERS` | a listed verifier is no longer served, or a live buy platform can't be verified |
| (b) | SDK catalogue, the app's buy platforms and Sell form (`sellCapabilities`) vs the documented matrix | a pair left the catalogue, a sell currency has no oracle, or the app and docs disagree (`drift:`) |
| (c) | Curator quotes at about $20 and $250 for every buy platform x currency, the same request the Exchange sends | a request keeps failing after backoff (429/5xx) |
| (d) | Peer Cash oracle rate for every currency the app trades | any doesn't price |

Peer Cash also sells some currencies that aren't major (Revolut and Wise TRY
and ZAR, Wise IDR and PHP). They are left out on purpose; (b) lists them
without failing.

- `none` in the BUY table means no fillable offer at that size, with
  Curator's nearby sizes in brackets. It's reported, never failed: the book
  moves by the minute, and many currencies are thin (on 2026-10-12, 20 of 71
  pairs filled at $20 and 31 at $250). Venmo and PayPal are always `none`
  while every deposit there is Peer Pay.
- `pid:missing` on an Alipay quote means Curator has no Alipay PID for that
  seller. The Exchange won't place an order with them, because the buyer
  would have no QR to pay.
- `WARN` lines don't fail the run: an oracle reading over a day old, or a new
  verifier the app doesn't list.
- It exits 0 on "No errors.", otherwise 1, with every failure on an `ERROR`
  line.

## Worlds and realtime load

Every player downloads every other player's moves, presence updates and chat
in their own world, so a world's realtime traffic grows with the square of
its size, and the bill with the sum of those squares. The bank is therefore
split into worlds numbered like the original game's (301, 302, ...), each a
full copy of Varrock West Bank with its own players, chat and stalls. World
news (verified trades) goes to every world, and the merchants stand in every
world. Mutes, bans and the per-address limit hold across all of them.

With n players in a world and about 13 messages a minute per pair when
everyone is active (11 when nobody hops, 5.5 when calm), each world sends
n² × 13 / 60 messages a second and costs about n² × 13 × 200 × 60 / 1e9
dollars an hour on Blaze. So
the same players cost less spread over more, smaller worlds: a world of 140
costs about $3.20 an hour (4,200 messages a second), one of 200 about $6.50
(8,500). Measured (`scripts/load/README.md`, a tenth of the players hopping
worlds every minute, so on the high side), with arrivals placed as the
server places them and the launch settings (14 worlds open, `meta/roomCap`
2000):

| Players | Worlds (players each) | Firebase $ an hour | With only the default 3 worlds open | The same players in one room |
|---|---|---|---|---|
| 300 | 140, 140, 20 | 6.5 | 6.5 | 14.7 |
| 600 | 4 x 140, 40 | 13.1 | 19.6 | 59 |
| 1,000 | 7 x 140, 20 | 22.5 | 19.6, and 400 turned away | 163 (over the 100,000/s limit) |
| 1,200 | 8 x 140, 80 | 26.7 | 19.6, and 600 turned away | 235 (over) |
| 2,000 | 14 x about 143 | 46.7 | 19.6, and 1,400 turned away | 653 (over) |

An open world nobody is in costs nothing. The database limits bind on the
total, not on one world: writes reach about 900 a second at 2,000 players
(the limit is 1,000) and responses about 61,000 (limit about 100,000), which
is why `meta/roomCap` 2000 is the ceiling.

### Where players go

- **Play now** and returning players are placed by the server: the busiest
  open world still below 70% of the cap (so a quiet evening has one lively
  bank, not three empty ones), then, once every world is past that, the
  quietest world with room. Never a full world.
- A player already standing in a world (a reload, a second tab, a rejoin
  after a short pause) goes back to it, even if it is full or closed.
- A link with `?world=302`, and a shared trade's link (it asks for the world
  the trade was announced in), get that world when it has room, else the
  usual placement. "Invite a friend" in the Account tab links to the
  player's world.
- The Logout tab says "You are on World 302." and has the World Switcher: the
  open worlds with their player counts (refreshed every 10 s while open,
  cached 5 s at the edge), the current one highlighted. A click hops: a short
  "Please wait...", the player arrives on the same tile in the new world,
  and the chatbox says "Welcome to RampRidge. You are on World 304." A full
  or closed world refuses the hop ("World 302 is full.").
- When every open world is full (or `meta/roomCap` is reached), newcomers see
  "The bank is full right now. Try again in a few minutes."

### Opening, capping and closing worlds (`meta/worlds`, `meta/worldCap`, `meta/roomCap`)

All three are read on every join; set them in the Firebase console (the
project in `.firebaserc`, Realtime Database, instance `rampridge-world`, Data,
under `meta`), typed without quotes so they are numbers (a string `"4"` is
ignored). No deploy. CLI equivalent:
`firebase database:set /meta/worlds --data 4 --instance rampridge-world`.

| Key | Means | Unset |
|---|---|---|
| `meta/worlds` | How many worlds are open: 301 up to 300 + this (at most 20, so 320) | 3 |
| `meta/worldCap` | Players per world | 200 |
| `meta/roomCap` | Players across every world: the overall ceiling | no ceiling |

Launch: `meta/worlds` 14 and `meta/roomCap` 2000, `meta/worldCap` unset
(200). That admits 2,000 players at about $47 an hour at most; the 14 worlds
reach their 70% soft fill (140 each) at 1,960, so nobody is crowded into a
full world before the ceiling.

Now (since 2026-10-12, left running for fun at the lowest cost):
`meta/worlds` 3, `meta/worldCap` 100 and `meta/roomCap` 100. Arrivals fill
World 301 to 70 before 302 gets anyone, so a full bank costs about $0.90 an
hour at most, and an ordinary day with a handful of players stays inside
Firebase's free allowance. The prune cron runs hourly, since heartbeats do
the frequent sweeps. Before sending a crowd (a post, a stream), raise
`meta/roomCap` and `meta/worlds` as the table above allows.

- **Cost**: opening worlds never adds cost by itself: an empty world sends
  nothing, and arrivals fill the busiest world below 140 before the next
  gets anyone. Once players spill over, more open worlds are cheaper than
  fewer full ones (1,200 players: about $27 an hour in worlds of 140, $39 in
  six full worlds of 200). The brake on spending is `meta/roomCap`: lower it
  to cap the bill.
- **More players than worlds**: when `status.mjs` shows every open world past
  140, raise `meta/worlds` (at most 20) or, if they are near 200, raise
  `meta/roomCap` only if the bill and the write limit allow. New arrivals
  start filling the next world at once.
- **Smaller or larger worlds**: `meta/worldCap` between 100 and 250. Below
  100 a world feels empty; above 250 one world's traffic (n²) climbs fast.
  Lowering it never removes anyone: a world over the new cap just takes no
  newcomers until it drops under.
- **Closing a world**: lower `meta/worlds`. The highest-numbered worlds stop
  taking arrivals and hops; players inside stay until they leave or hop,
  and an empty closed world's chat and counts are deleted by the next prune.
- **Emergency brake**: lower `meta/roomCap` (or `meta/worldCap`). It stops new
  joins at once; nobody already inside is removed.
- The counts are soft. Each world's count (`meta/worldPop/{id}`) is recounted
  by the light prune about every 30 s (and by the hourly cron) and moved
  in between by server-side increments on every arrival, hop and leave, so a
  burst of joins can overshoot a cap by the few that read the same counts.
- Where each player stands is `presence/{pid}` (server only): one record per
  player, whatever token a script replays. `moderate.mjs` kicks clear it.
- A player whose tab was silent for 60 s (a phone put away) has been pruned
  and comes back as a newcomer, preferring their last world. If every world
  is full, their chatbox says so once and presence retries every 15 s.

### Watching the worlds

- `node scripts/ops/status.mjs --watch 30`: the `Worlds` line shows each
  world's online players against the cap (`301 143/200   302 98/200`), the
  server's count when it differs, closed worlds, and the room cap.
- `curl -s https://www.rampridge.xyz/api/worlds | jq`: what the World
  Switcher shows (open worlds, counts, `full`).
- Firebase console, `rampridge-world`, Usage: downloads and load. If load
  climbs past about 70% with worlds below their cap, lower `meta/worldCap`
  rather than opening more worlds.

### Other door limits

- **20 players per address**, across every world (`IP_PLAYER_CAP` in
  `api/_lib/ipPlayers.ts`). More players from one public address are refused
  with "Too many players from your network are in the bank. Try again
  later." Shared networks hit this: a
  meetup or office on one Wi-Fi, and occasionally a mobile carrier's shared
  (CGNAT) address. IPv6 counts by /64. Raising it needs a code change and a
  deploy.
- **New sessions per address**: a burst of 60, then one every 10 s. A meetup
  of more than 60 new guests on one network waits.
- **Chat**: each player one line per 1.2 s and 30 a minute; each address a
  burst of 10 lines, then one a second; each world 20 lines a second.

### One-time guards (maintainer)

- **Firebase budget alert**: Google Cloud console, Billing, Budgets & alerts,
  a monthly budget scoped to the Firebase project and the Realtime Database
  service (for example $200, alerts at 25, 50 and 100 percent). Alerts email;
  they do not stop spending, and billing data lags by hours, so `online` in
  `status.mjs` and the Firebase Usage tab are the live signal.
- **Vercel firewall rate rule on `/api/act`**: Vercel dashboard, project
  `rampridge`, Firewall, a rule for request path `/api/act` with a rate limit
  keyed by IP (for example 1,200 requests per 60 s, then 429). A load-test
  player averages about 13 requests a minute (heartbeat 4, moves 8, chat 1)
  and an address holds at most 20 players across all worlds, so this only bites on scripts. The app already
  refuses floods, but every refused request still costs a function call and a
  database transaction; the firewall stops them first. The client backs off on
  a 429.

### Realtime Database overload

Symptoms: Health `rtdb` slow or `timeout`, 5xx on `/api/act`, players
rubber-banding. Check Firebase console, Realtime Database, `rampridge-world`,
Usage (load, connections, downloads).

1. Lower `meta/roomCap` or `meta/worldCap` (or `meta/worlds`). It stops new
   joins at once; worlds shrink as players leave.
2. `RAMPRIDGE_TELEMETRY=off` + redeploy removes telemetry writes.
3. Chat is already capped at 20 messages a second in each world.
4. A heartbeat is one `/api/act` call every 15 s: a rate-limit transaction and
   an `ls` transaction, and only every other one writes `ls` (it is rewritten
   once it is 20 s old). A player is pruned 60 s after their last `ls`. Status
   `sweep` age above about 60 s while players are online means heartbeats are
   failing. Read the `--level error` logs above.

## Incidents

### Gas sponsorship (CDP paymaster budget, $100 global limit)

Symptoms: `gas_fail` > 0, errors with context `sponsorship` (AA31/AA33, "spend
limit", "max per user", "not in allowlist"), and embedded-wallet players see "The
bank couldn't sponsor this transaction". External wallets are unaffected
because they pay their own gas.

1. Coinbase Developer Platform (portal.cdp.coinbase.com), the project whose
   Paymaster URL is set in Privy (Privy dashboard, the app in
   `PRIVY_APP_ID`, Smart wallets, Base): Paymaster, then Configuration.
   Raise the global limit (and the per-user limit if one player hit it). Billing
   must cover it.
2. "not in allowlist": a transaction targets a contract the policy does not list.
   The allowlist is USDC, EscrowV2 `0x7777…00Ef`, OrchestratorV3
   `0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`, WhitelistPolicy
   `0x389Cd9bA91FfFcd83d267B241E975541892759Ce`. An SDK upgrade that moves a
   contract needs the new address added.
3. No deploy is needed. Players retry the same action.

### Curator (Peer API) down

Symptoms: Health `curator FAIL`, `signal_fail` rising, merchants show the last
good book (status `market` age grows). Signals need Curator `/v3/sign`, so buys
stop. Deposits already listed keep working on-chain.

- Confirm: `curl -s -o /dev/null -w "%{http_code}\n" "https://api.zkp2p.xyz/v3/orderbook/table?currency=USD&chainId=8453&token=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&mode=eligible&limit=1"`.
- Nothing to change on our side. Tell Peer and wait. Orders already signalled and
  deposits already listed stay valid on-chain. Players can finish them once
  Curator is back.

### Seller spreads

A seller can price an order from -5% to +5% around the oracle rate; 0% is the
default and lists through Peer Cash's own `prepare()` (`docs/design.md`,
"Selling"). Peer Cash 0.7.2's order reads refuse a deposit with a non-zero
spread, so the Bank's order list, withdraw and top-up reach those orders
through `src/peer/sell/spreadOrders.ts`; zero-spread orders go through Peer
Cash itself.

**Turning spreads off (`SELL_SPREAD_ENABLED`).** It needs a deploy.

1. In `src/peer/sell/spreadRate.ts`, set `export const SELL_SPREAD_ENABLED = false;`.
2. `bun run check`, commit, `bun run deploy:prod`, then
   [After a deploy](#after-a-deploy).
3. Check: in the Bank, Deposit shows no spread control.

While it is off, every new order lists at the market rate (0%). Orders
already listed keep their spread on-chain and stay in the Bank (list,
withdraw and top-up still go through `spreadOrders.ts`, which is not
switched). Set it back to `true` and redeploy to turn it on.

### Players can't get in

- "The bank is full right now": every open world is at `meta/worldCap`, or
  `meta/roomCap` is reached. Open another world (`meta/worlds`) as described
  under [Opening, capping and closing worlds](#opening-capping-and-closing-worlds-metaworlds-metaworldcap-metaroomcap).
- "World 302 is full." after a click in the World Switcher: that world is at
  its cap; any other world in the list with room works.
- "Too many players from your network": the 20-per-address limit (a meetup,
  an office, a shared mobile address). Ask them to switch one device to mobile
  data or another network. Raising the limit needs a deploy.
- "You're doing that too quickly" on Play from a crowded network: the session
  bucket (60, then one every 10 s per address). It clears by itself.

### Chat abuse

```bash
node scripts/ops/moderate.mjs recent --minutes 15        # who said what (pid, name, line)
node scripts/ops/moderate.mjs who <name>                 # profile, presence, their lines
node scripts/ops/moderate.mjs mute <name|pid> --minutes 60 --reason "spam" --apply
node scripts/ops/moderate.mjs ban <name|pid> --days 7 --reason "scam" --apply   # also kicks
node scripts/ops/moderate.mjs purge <name|pid> --apply   # delete their chat lines + kick
node scripts/ops/moderate.mjs list | unmute | unban
```

These work without a deploy and across every world: `recent` lists each line
with its world (`w302`), `kick`, `ban` and `purge` remove the player from
whichever world they are in, and a mute or ban follows them through hops.
The `moderation/{pid}` record is what counts:
`/api/act` reads it on every chat line and every join, so a muted player's
chat is refused as "You're sending messages too quickly." and a banned player
is kicked and refused at the door until the record ends, however long they sit
idle. The script also squeezes the player's rate-limit bucket. Its `--hold`
flag (re-assert every 30 s) dates from before `/api/act` read the record and is
no longer needed. A banned player can come back as a new guest from a fresh
browser; there is no IP ban. Purged lines disappear for new visitors and drop
out of open tabs straight away.

### Privy login failing

Symptoms: `login` flat while `play` grows, players stuck on "Existing user", and
browser console shows an origin error.

- Privy dashboard, the app and web client in `src/config.ts` (`PRIVY_APP_ID`,
  `PRIVY_CLIENT_ID`): allowed origins must include
  `https://www.rampridge.xyz` (the apex redirects to www). Vercel preview URLs
  are not allowed, so login fails there by design.
- Google can refuse sign-in inside in-app browsers (embedded webviews). If
  `*-inapp` traffic logs in far less, tell players to use email or open the page
  in Safari/Chrome.

### A stuck buy order

Ask the player for their wallet address (Account tab) or the order's
transaction, then:

```bash
node scripts/ops/intent.mjs <buyer address>      # their open orders
node scripts/ops/intent.mjs <intent or tx hash>  # one order, open or closed
```

| Status | Meaning | Do |
|---|---|---|
| OPEN, lock expires in N min | waiting for payment or proof | buyer pays the shown handle, then Verify payment in the Exchange (Peer extension) |
| EXPIRED, not pruned | can still be fulfilled | if they paid, verify and fulfil now |
| FULFILLED | USDC released (tx shown) | nothing stuck. Reload or reopen the Exchange |
| CANCELLED / pruned | USDC back in the seller's deposit | if fiat was sent, the seller refunds off-platform, or escalate to Peer support with the intent hash and payment receipt |

Search further back with `--days 14`. Basescan works too: OrchestratorV3
`0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7`, read `getIntent(intentHash)` (owner
`0x0` means closed).

### Everyone must sign in again (database wipe)

Set `SESSION_NOT_BEFORE` (unix seconds) in Vercel production env and redeploy.
Tokens issued earlier are refused, so clients start fresh.

## After launch

```bash
node scripts/ops/db-maintenance.mjs                                   # inventory + plan (dry run)
node scripts/ops/db-maintenance.mjs --name-pattern '^(qa|test|e2e)'   # review test players
node scripts/ops/db-maintenance.mjs --keep-errors-days 14 --stale-guests 30 --orphans --apply
```

It never touches `shares/` (public links to real trades). Once after the worlds
release: `node scripts/ops/db-maintenance.mjs --legacy --apply` (see
[The worlds release](#the-worlds-release-once)). Any script runs against the
Firebase emulator instead with `FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000`.
