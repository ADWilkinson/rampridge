# RampRidge: guide for contributors and coding agents

`CLAUDE.md` is the canonical guide; `AGENTS.md` is a symlink to it, so every
agent reads the same file. Humans should start with `README.md` and
`CONTRIBUTING.md`; this file goes deeper.

Varrock West Bank from Old School RuneScape, rebuilt as a live peer-to-peer
crypto exchange on the Peer protocol (ZKP2P) on Base. Players walk into the
bank, chat, and buy or sell USDC for fiat (Venmo, Revolut, Wise, Cash App,
Zelle, PayPal, Monzo and more). Everything else in the game is omitted.
`docs/design.md` is the product spec; the 2007 client is the reference for
every visual and interaction decision.

## Guardrails

These hold for every change, whoever makes it.

- **Real money.** The buy, sell and send paths (`src/peer`, `src/wallet`, the
  fee and attribution settings in `src/config.ts`) move real USDC on Base
  mainnet. Never sign for or send to mainnet from a test or script, never use
  a funded key, and test chain behaviour only on a local anvil fork (the fork
  and parity suites below). Don't weaken their guards: payee registration is
  stubbed, the parity proxy refuses send and sign methods, and the load
  scripts refuse non-local targets.
- **Never write to production data.** Develop against the Realtime Database
  emulator. Don't set `RAMPRIDGE_DEV_LIVE_DB=1`, and don't run the ops
  scripts' `--apply` or `firebase deploy`: those are the maintainer's.
- **Secrets.** Never commit or print one. Server values live in `.env.local`
  (gitignored) locally and in the host's environment in production.
  `FORK_UPSTREAM_RPC_URL` usually carries an API key: pass it, never echo it.
  `.gitleaks.toml` allowlists only values verified to be public or fake.
- **Game assets.** The art, models, sounds and fonts are Jagex's. They are
  baked locally into `public/game` (and the link preview cards into
  `public/og*.png`), which git ignores; never commit them or screenshots of
  the game. `scripts/bake/assets.lock.json` pins every file production serves,
  and the deploy refuses assets that don't match it.
- **Revenue defaults.** The buy fee, Peer referral code and attribution codes
  in `src/config.ts` are production settings. Forks override them with
  `VITE_*` variables; don't change the defaults without the maintainer.
- **The title stays light.** Never import the Peer SDKs, Privy,
  WalletConnect, viem or Firebase statically from a module the title screen
  loads (see Load order).

## Commands

```bash
bun install
bun run setup:assets   # fresh clone: bake public/game from the cache pinned in scripts/bake/assets.lock.json
bun run bake           # after changing the bake: re-bake from .cache/osrs and rewrite the asset lock
bun run dev            # http://localhost:5173 (keep this port: Privy allows this origin)
bun run check          # typecheck + lint + unit tests + build; must pass for every change
bun run ops:matrix     # read-only live check of the buy/sell matrix against Peer (no env needed)
```

Local API and database:

```bash
cp .env.example .env.local          # emulator on, throwaway secrets
bash scripts/load/emulator.sh       # Realtime Database emulator on 127.0.0.1:9460 (no Firebase login needed)
bun run dev                         # the page and /api both use the emulator
```

The local `/api` (a Vite plugin, `scripts/dev-api.ts`) answers 503 unless
`FIREBASE_DATABASE_EMULATOR_HOST` points it at the emulator (or
`RAMPRIDGE_DEV_LIVE_DB=1` opts in to the live database). It reads server
variables from the shell, then the `.env` files (`.env.local`). With the emulator set, the
page reads the same emulator (`vite.config.ts` passes the host on as
`VITE_RTDB_EMULATOR_HOST`), never the live database; production builds
ignore it. Even locally, buying, selling and sending are real mainnet
transactions.

Suites outside `bun run check` (shell env; `FORK_UPSTREAM_RPC_URL` is an
archive-capable Base mainnet RPC URL, and the suites need foundry's `anvil`):

```bash
bun run test:fork                                          # money paths on an anvil fork (tests/fork/README.md)
bunx vitest run -c tests/send-fork/vitest.config.ts        # USDC send on a fork (tests/send-fork/README.md)
bun run test:parity                                        # buy signals vs the Peer web app's code and real transactions
bunx vitest run -c tests/buy-parity/golden/vitest.golden.config.ts   # replays real fulfilments
bunx vitest run --config dev/buy-e2e/vitest.e2e.config.ts  # full UI buy in headless Chrome on a fork
bunx tsc -p tests/fork/tsconfig.json --noEmit              # the fork suites typecheck separately
```

Load and abuse tests run only against the emulator (`scripts/load/README.md`).

## Architecture

```
src/
  app/        React shell: screens (loading, login, game), providers, global store
  game/       three.js engine (no React): world, entities, OSRS model animation,
              camera, input/picking, pathfinding, overhead text, minimap
  ui/         OSRS-styled React interfaces drawn over the canvas; ui/kit is the component kit
  net/        realtime client: session token, world subscription, actions
  peer/       Peer protocol flows: buy (quote -> signal -> pay -> verify ->
              fulfill) and sell (cash-out deposits), extension handoff
  wallet/     Privy login, smart-wallet/external-wallet TxSender adapter, USDC send
  config.ts   public runtime config: production defaults, VITE_* overrides
api/          Vercel functions: session, act (all world writes), worlds, market,
              wallet, log, health, share, og, cron/prune
shared/       wire protocol, movement, world rules, chat/name rules shared by api and browser
scripts/bake/ build-time asset pipeline from the OSRS cache -> public/game
scripts/ops/  operator scripts (status, moderation, stuck orders, matrix)
scripts/load/ emulator-only load and abuse tests
dev/          harness pages (/dev/*.html) for the engine, interfaces and UI kit
tests/        fork, parity and e2e suites (not part of bun run check)
docs/         design.md (product spec), runbook.md (operations)
```

### Realtime world

- Firebase Realtime Database instance `rampridge-world` (production). The
  bank runs as numbered worlds (301, 302, ...; `shared/worlds.ts`), each with
  its own `worlds/{id}/players|chat|events`. Browsers may read one world at a
  time and nothing else (`database.rules.json`); every write goes through
  `POST /api/act`, which authenticates a session token, validates,
  rate-limits and filters before writing with the Admin SDK.
- A join picks the world (`api/_lib/worlds.ts`: the busiest open world below
  70% of its cap, then the quietest with room; where the player already
  stands; or a requested `?world=`) and answers with a session token naming
  it. Where a player stands is the server's `presence/{pid}`
  (`api/_lib/presence.ts`), never the token, so a player has one record and
  one seat whatever token is replayed. Every other action acts in the token's
  world only; a hop is a join to another world (World Switcher, Logout tab).
  World news is written to every world; merchants, mutes and bans are global.
  A join without a world comes from a build older than worlds and is refused
  as `outdated` (reload).
- Movement is tile-based on the original 600 ms tick. A move writes only the
  path, a server start time and the run flag; every client replays it
  deterministically (`shared/protocol.ts#positionAt`). Presence is a 15 s
  heartbeat that rewrites `ls` only once it is 20 s old (every other
  heartbeat, so about every 30 s). A player whose `ls` is 60 s old is gone:
  clients stop drawing them, and the light prune (run by heartbeats at most
  every 30 s, and by the hourly cron) deletes them.
- World limits, because every player downloads every other player's updates
  in their world (traffic grows with the square of a world): `meta/worlds`
  (open worlds, default 3), `meta/worldCap` (players per world, default 200)
  and `meta/roomCap` (optional ceiling across all worlds), positive whole
  numbers set in the database with no deploy. Players already inside a world
  always get back in. At most 20 players per address across all worlds
  (`api/_lib/ipPlayers.ts`, IPv6 by /64). `docs/runbook.md` has the cost
  formulas and measured limits.
- Chat is filtered server-side (`shared/chat.ts`): profanity, plus links,
  wallet addresses and payment handles, because off-protocol trades are the
  scam vector. Trades only settle through the bank interfaces.

### Peer integration

- Coverage: selling offers only the major currencies in
  `shared/currencies.ts` (USD, EUR, GBP, CAD, AUD, NZD, CHF, SGD, MXN, CNY,
  INR; each has a live Peer oracle), on 11 platforms. The buy side's matrix is
  defined in `src/peer/platforms.ts`. The matrix, registrations and deferrals
  are in `docs/design.md` ("Currencies and payment methods");
  `bun run ops:matrix` checks it live.
- Buy: `getQuote` (mode `eligible`, so no taker stake is ever required) ->
  `signalIntent` via Curator `/v3/sign` -> the buyer pays off-platform ->
  Peer extension `authenticate` (buyer TEE capture) -> the buyer picks the
  matching payment -> `fulfillIntent`. Construct the SDK with
  `baseApiUrl: https://api.zkp2p.xyz` or signalling fails. Alipay (CNY,
  PeerAuth 0.6.7) and UPI via Amazon Pay (INR, 0.6.8) are beta and QR-only;
  Alipay needs the maker's PID from Curator
  (`GET /v2/makers/alipay/{payeeDetailsHash}`) and never signals without it.
  Venmo and PayPal only fill unrestricted deposits (nearly all are Peer Pay,
  and there is no stake gate).
- Sell: `@zkp2p/cash` prepare -> batched approve + createDeposit ->
  `finalizePreparedCashout` -> access-policy transaction for Venmo and PayPal
  (Peer Pay: only Peer Pay merchants can fill those orders; Cash App stays
  public). Every currency is priced by its oracle (Peer Cash's market-rate
  path, as on Peer's web app; no rate floor). One spread per order: 0% by
  default (Peer web's default, exactly Peer Cash's `prepare()`), and sellers
  may choose -5% to +5% in 0.1% steps (`src/peer/sell/spread.ts`; switch
  `SELL_SPREAD_ENABLED` in `spreadRate.ts`). Peer Cash's reads refuse
  spread orders, so `src/peer/sell/spreadOrders.ts` lists and manages them.
  Zelle sellers confirm enrolment; an Alipay deposit is at least 10 USDC and
  fills in one order. A handle that needs the one-time PeerAuth
  registration offers to install the extension when it is missing.
- Revenue (production defaults in `src/config.ts`, overridable with `VITE_*`):
  every deposit carries the Peer referral code `TOFIAT` (`peer-ref-TOFIAT`;
  Curator pays the code's owner an integration share of Peer's fee, at no
  extra cost to sellers), and every buy quote and intent carries a 50 bps
  referrer fee to `BUY_REFERRER_FEE.recipient`, disclosed as "RampRidge fee"
  on the confirm screens. When a deposit already carries the code, Curator
  signs a second leg to the same wallet and the app waives its own fee
  (`duplicatesReferrerLeg` in `src/peer/buy/chain.ts`). All transactions carry
  ERC-8021 codes `rampridge` + `peer-ref-TOFIAT`.
- Practice trade (`{ id: "practice" }`, `src/ui/interfaces/buy/Practice.tsx`):
  the real buy store and interfaces on the simulated client, wallet and
  extension in `src/ui/interfaces/buy/simulated.ts`, so nothing reaches Peer,
  the chain, Privy or the world. Payment and Verify opened from it carry
  `practice: true`; `usePractice()` hides what only a real order has (pay
  link, QR, help, Share, announcement). The store's telemetry is injected, so
  practice never counts as a quote or fulfilment.
- Wallets: Privy. The production client's allowed origins include
  https://www.rampridge.xyz and http://localhost:5173, so login works on the
  dev server. Embedded users get a sponsored Coinbase Smart Wallet on Base
  (`SPONSORED_CALL_TARGETS` mirrors the paymaster's allowlist); external
  wallets pay their own gas.

### Load order

Title = shell + engine + game assets. Title idle = the realtime client and
world screen, then the light interfaces and the merchants (Peer SDK). World
idle or on demand = the trading interfaces, `@zkp2p/cash`, Privy and
WalletConnect. `src/app/titleGraph.test.ts` keeps the Peer SDKs, the wallet
stack, viem and Firebase out of the title's static graph; never import them
statically from a title-path module.

## Conventions

- TypeScript strict throughout; Bun is the package manager and script runner
  (`bun.lock`). Aliases: `@/` is `src/`, `@shared/` is `shared/`.
- `api/` and `shared/` run as native Node ESM on Vercel: relative imports end
  in `.js` (`api/_lib/esm.test.ts` walks every server file).
- Handlers take their dependencies (`api/_lib/deps.ts`) so tests run them
  against the in-memory database (`api/_lib/memoryDb.ts`).
- Lint is oxlint with `--deny-warnings`; the `lint` script in `package.json`
  lists the paths it covers.
- Interfaces follow `docs/design.md`; every flow renders loading, empty,
  error, success and disabled states, works with the keyboard and respects
  reduced motion. Copy is plain: what happened and what to do next.
- Vendored code under `scripts/bake/vendor` keeps upstream style; local edits
  are marked "RampRidge patch" and listed in `scripts/bake/README.md`.
- Commits: one logical change each, lowercase imperative with a type prefix
  (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`), no trailing period.

## Tests

| Where | Runs with | What |
|---|---|---|
| `src/**/*.test.ts`, `shared/**`, `api/**`, `scripts/**` | `bun run test` (in `bun run check`, and CI on every push) | Unit tests (Vitest, node environment). Colocated with the code; `src/peer` uses `__tests__/`. API handlers run against `memoryDb`. Tests that read the baked assets skip when `public/game` is absent. |
| `tests/fork` | `bun run test:fork` | Buy, sell and smart-wallet money paths against Peer's deployed contracts on an anvil fork; live Curator quotes and signatures; payee registration and the attestation service stood in |
| `tests/send-fork` | its own `vitest.config.ts` | The USDC send path on a fork, including lost outcomes |
| `tests/buy-parity/signal`, `tests/buy-parity/golden` | `bun run test:parity`, `vitest.golden.config.ts` | Buy signals and fulfilments compared with the Peer web app's code and real Base transactions, through a read-only mainnet proxy |
| `tests/buy-parity/fork-ui-e2e` | `dev/buy-e2e/vitest.e2e.config.ts` | The real interface in headless Chrome, buying on a fork with a simulated extension |
| `scripts/load` | `node scripts/load/*.mjs` | Load and abuse against the emulator only (Node: `lib.mjs` needs `node:module` `registerHooks`, which Bun lacks) |

## Configuration

`.env.example` lists every variable. Server values (Vercel functions and the
dev API): `FIREBASE_SERVICE_ACCOUNT` (Admin SDK JSON; not needed with the
emulator), `SESSION_SECRET` (HMAC for session tokens, 32+ bytes),
`BASE_RPC_URL`, `CRON_SECRET`; optional `RAMPRIDGE_TELEMETRY=off` and
`SESSION_NOT_BEFORE` (unix seconds; refuses older session tokens). Browser
values are `VITE_*` and public by design; contributors only ever need
`VITE_BASE_RPC_URL` (a keyed RPC if the public one rate-limits) or
`VITE_TELEMETRY`. Everything else the page talks to (Privy, Firebase, the
WalletConnect project, the fee wallet, the referral and attribution codes, the
help account) is fixed in `src/config.ts` and `src/wallet/constants.ts`, and
changes there need the maintainer's agreement.

## Production

- Live at https://www.rampridge.xyz. The apex redirects to www, which is the
  origin Privy allows.
- Hosted on Vercel. Server secrets live in the Vercel project's environment,
  never in the repo.
- Realtime state is the `rampridge-world` Realtime Database instance; its
  rules deploy with `firebase deploy --only database`.
- Deploys (`bun run deploy:prod`), world settings, moderation and incident
  response are the maintainer's; `docs/runbook.md` is the procedure.
  `GET /api/health` returns 200 or 503 with the serving deployment id.
  Telemetry runs only on the production host; `RAMPRIDGE_TELEMETRY=off` is
  its kill switch (needs a redeploy).
