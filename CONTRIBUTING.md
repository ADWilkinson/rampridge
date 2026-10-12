# Contributing to RampRidge

Thanks for helping. RampRidge is a game and a live exchange at once: a bug in
the bank's interfaces can cost a real player real money. These guidelines
keep contributions easy to review and keep the money paths safe.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on
  the approach. The scope is deliberately one room (Varrock West Bank), and
  [docs/design.md](docs/design.md) is the product spec: the 2007 client is the
  reference for every visual and interaction decision.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.
- By contributing you agree that your contributions are licensed under the
  project's [MIT License](LICENSE).

## Setting up

Follow [Getting started](README.md#getting-started) in the README: install
with Bun, build the game assets with `bun run setup:assets`, copy
`.env.example` to `.env.local`, start the database emulator and run
`bun run dev`.

[CLAUDE.md](CLAUDE.md) describes the architecture and conventions in depth;
it is written for coding agents but is the best map of the codebase for
anyone.

## Making a change

1. Branch from `main`: `feature/short-description` or `fix/short-description`.
2. Keep each commit to one logical change. Commit messages are lowercase, in
   the imperative, with no trailing period, and start with a type:
   - `feat: sell majors at the oracle rate with an optional seller spread`
   - `fix: keep the bank-full refusal inside the design window on phones`
   - `docs: describe the payment scroll's new structure`
   - `test: type the worlds suite's join helper`
   - `refactor: type the presence lock by its use` (no behaviour change)
   - `chore: keep the world screen's imports sorted` (tooling and housekeeping)
3. Add or update tests with the change. Unit tests live next to the code
   (`*.test.ts`, or `__tests__/` in `src/peer`).
4. Run `bun run check` (typecheck, lint, unit tests, production build). It
   must pass before review; CI runs the same command on every pull request.
5. For interface changes, check the result in the browser, on desktop and at
   phone width, using the harness pages under `/dev/` where they cover it, and
   add screenshots to the pull request.

### Conventions

- TypeScript strict mode throughout. Import app code with the `@/` alias
  (`src/`) and shared code with `@shared/`.
- Server code (`api/`, `shared/`) runs as native Node ESM on Vercel, so its
  relative imports end in `.js` (`api/_lib/esm.test.ts` enforces this).
- The title screen must stay light. Never import the Peer SDKs, Privy,
  WalletConnect, viem or Firebase statically from a module the title loads;
  load them lazily. `src/app/titleGraph.test.ts` guards this.
- Every write to the realtime database goes through `POST /api/act`, which
  validates, rate-limits and filters it. Browsers only ever read, and only one
  world (`database.rules.json`).
- Every flow renders its loading, empty, error, success and disabled states,
  works with the keyboard, and respects reduced motion (see the design spec).
- Copy is plain and specific: say what happened and what the player can do
  next.

## Money-path safety

The buy, sell and send paths (`src/peer`, `src/wallet`, the fee and
attribution settings in `src/config.ts`) move real funds on Base mainnet.
Changes there follow these rules:

1. **Never move real funds in tests.** Unit tests use fakes. Anything that
   needs real contracts runs on a local anvil fork: `bun run test:fork`, the
   send fork suite or the parity suites (see [Testing](README.md#testing)).
   Never add a test that signs for, or sends to, Base mainnet, and never use a
   funded key in a test.
2. **Keep the guards.** The fork suites stub payee registration, so no handle
   is ever registered with Peer; the parity proxy refuses every method that
   could send or sign; the load scripts refuse anything but a local target.
   Don't weaken these.
3. **Run the fork suite for money-path changes**, and say in the pull request
   which suites you ran and what they showed.
4. **Explain the effect on amounts.** Say how the change affects what a
   player pays, receives or is shown, including fees, rounding and
   attribution. Fees, the referral code and the attribution codes in
   `src/config.ts` are production revenue settings: pull requests shouldn't
   change them without discussion first.
5. **Never write to production data.** Develop against the database emulator.
   `RAMPRIDGE_DEV_LIVE_DB=1` and the ops scripts' `--apply` are for the
   maintainer only.
6. **No secrets in the repository.** `.env.local` is gitignored; keep real
   values there or in your host's environment. `.gitleaks.toml` configures the
   secret scan; add an allowlist entry only for a value verified to be public
   or fake, with the reason.

## Game assets

The game's art, models, sounds and fonts are Jagex's and must never be
committed: the bake decodes them locally into `public/game`, which git
ignores. Don't add screenshots or other captures of the game to the
repository either; link to the live site instead. If you change the bake,
run `bun run bake` and include the updated `scripts/bake/assets.lock.json`.

## Pull requests

- Fill in the pull request template: what changed, why, how you tested it.
- Keep pull requests focused; split unrelated changes.
- Be patient with review. RampRidge is maintained by one person.

Thank you for contributing.
