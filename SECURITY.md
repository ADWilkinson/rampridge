# Security policy

RampRidge moves real money between real people, so security reports are very
welcome. Please report privately and give us a chance to fix the problem
before it is disclosed.

## Reporting a vulnerability

Report through GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/ADWilkinson/rampridge/security/advisories/new)
(the repository's **Security** tab, then **Advisories**). Please don't open a
public issue, pull request or discussion about it.

If you can't use GitHub, send a private message on X to
[@andrewwilkinson](https://x.com/andrewwilkinson) asking for a private channel,
without the details.

A useful report says what an attacker can do, the steps to reproduce it, and
the code or endpoint involved. You'll get an acknowledgement within a few days
and updates until it is resolved. We're happy to credit you in the advisory.

There is no bug bounty programme.

## Supported versions

Only the live site (https://www.rampridge.xyz) and the `main` branch are
supported. Fixes are deployed to production, not backported.

## Scope

In scope:

- **Money paths**: anything that makes a player pay, receive or be shown the
  wrong amount; sends USDC, a fee leg or a payout to the wrong address or
  handle; or loses track of an order or a send (`src/peer`, `src/wallet`,
  `src/config.ts`).
- **Sessions and the API**: forging, replaying or stealing session tokens,
  acting as another player, forging a wallet proof, or getting past
  validation, rate limits, mutes or bans (`api/`, `shared/`).
- **The realtime database**: reading or writing anything the rules shouldn't
  allow (`database.rules.json`).
- **The chat and name filters**: getting payment handles, links, wallet
  addresses or contact details into chat, or impersonating staff or another
  player with a look-alike name (`shared/chat.ts`). Off-protocol trades are
  how players get scammed, so bypasses here matter.
- **Injection**: script injection in the game, the shared trade pages
  (`/t/{id}`) or the preview card renderer.
- **Exposure**: secrets or personal data exposed by the code, the logs or the
  telemetry endpoint.

Out of scope:

- The Peer protocol's contracts, the Peer API, the PeerAuth extension and the
  attestation service: report those to [Peer](https://peer.xyz).
- Privy, WalletConnect, the gas sponsor, Firebase, Vercel and Base themselves.
- Denial of service by volume, spam and social engineering.
- Attacks that need a compromised device, browser or extension.
- Limits already documented in [scripts/load/README.md](scripts/load/README.md)
  (abuse results), unless you show a new impact.
- Automated scanner output without a demonstrated impact.

## Testing safely

- Reproduce locally where you can: the dev server against the database
  emulator, and the fork suites for anything on-chain ([README](README.md#testing)).
- On the live site, use only your own accounts and wallets, with small amounts.
  Never touch other players' funds, orders or data.
- Don't run the load or abuse scripts against production.

We won't pursue good-faith research that follows this policy.
