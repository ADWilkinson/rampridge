# Fork tests: the money paths against Peer's real contracts

These suites run the app's own Peer modules (`src/peer/market.ts`,
`src/peer/buy/chain.ts`, `src/peer/buy/store.ts`, `src/peer/sell/*`) and its own
wallet senders (`src/wallet/senders.ts`) against Peer's deployed EscrowV2,
OrchestratorV3, WhitelistPolicy and payment verifiers on a local anvil fork of
Base mainnet. Nothing touches mainnet or the RampRidge database.

## Running

Not part of `bun run test` or `bun run check` (the default config only
includes `src`, `shared`, `api` and `scripts`):

```bash
# Needs foundry's anvil (https://getfoundry.sh) and an archive-capable Base mainnet RPC.
export FORK_UPSTREAM_RPC_URL=...          # e.g. an Alchemy Base URL; it carries a key, so it is never printed
bun run test:fork                         # = vitest run -c vitest.fork.config.ts
```

`tests/fork/setup/global.ts` starts anvil on port 8547 forking Base at the
latest block (`--auto-impersonate`) and stops it afterwards. If a Base fork
already answers on `FORK_RPC_URL` (default `http://127.0.0.1:8547`) it is reused
and re-forked at the latest block first (`anvil_reset`), unless
`FORK_KEEP_STATE=1`. Other knobs: `FORK_PORT` and `ANVIL_BIN` (default
`~/.foundry/bin/anvil`, else `anvil` on `PATH`). Typecheck with
`bunx tsc -p tests/fork/tsconfig.json --noEmit`; lint with
`bunx oxlint tests/fork vitest.fork.config.ts --deny-warnings`. A full run takes
about a minute and needs network access to Curator.

## What is real and what is stood in

| Service | In these tests |
|---|---|
| Base contracts (USDC, EscrowV2, OrchestratorV3, WhitelistPolicy, verifiers) | Real bytecode and state, forked |
| Curator quotes, `/v3/sign` gating signatures, payee lookups | Real production API (`https://api.zkp2p.xyz`) |
| Payee registration (`POST /v2/makers/create`) | Stubbed: returns a test hash, so no handle is ever registered with Curator |
| Peer indexer (GraphQL) | Answered from fork chain state (`helpers/offchain.ts`), so order reads, top-up and withdraw see fork deposits. Peer Cash's attribution query (`PeerCashAttributedDeposits`) is answered as the real indexer decodes it: the ERC-8021 codes on the createDeposit transaction's own calldata, so a smart-wallet batch is not attributed |
| Attestation service (`/buyer/verify`) | Answered locally with a structurally exact attestation; nothing is posted to Peer |
| Wallets | The app's `createExternalSender` over an impersonated EOA, and `createSmartSender` over a Coinbase Smart Wallet (viem `toCoinbaseSmartAccount`, as Privy builds it) submitted through `EntryPoint.handleOps` |

Fulfilment needs a real payment proof. The suites sign the attestation with a
fresh key: first untrusted (the contract must reject it at the witness check,
after every other check passed, shown by a call trace), then added as a witness
on the fork only (`MultiAttestationVerifier.addWitness`, impersonating its
owner), which must release exactly the quoted USDC and pay every fee leg. The
attestation layout and EIP-712 type (`PaymentAttestation(bytes32 intentHash,
uint256 releaseAmount,bytes32 dataHash)`) were taken from a real Revolut
fulfilment on Base and checked against the live witness signature.

The smart-wallet double prefunds the EntryPoint itself; production uses the CDP
paymaster. The suite instead checks that every sponsored call targets the
paymaster allowlist (USDC, EscrowV2, OrchestratorV3, WhitelistPolicy) and lists
the functions used: `USDC.approve`, `EscrowV2.createDeposit` /
`withdrawDeposit` (plus `addFunds`, `removeFunds`, `pruneExpiredIntents` on
top-up, partial withdraw and expired-intent withdraw), `OrchestratorV3.signalIntent` /
`cancelIntent` / `fulfillIntent`, `WhitelistPolicy.configureDeposit`.

## Suites

- `sell.fork.test.ts`: Revolut deposit (prepare, batched approve and
  createDeposit, finalize), payee hash, oracle market-rate config, gating
  service, `peer-cash` + `peer-ref-TOFIAT` + `rampridge` attribution, top-up,
  partial withdraw, withdraw all with exact balances; Venmo with the Peer Pay
  access policy; recovery from a lost deposit receipt, a rejected policy step
  and a lost policy receipt (never a second deposit or policy). Then the Sell
  form's whole matrix, major currencies only (`shared/currencies.ts`), every
  pair through Peer Cash's oracle market rate: `sellCapabilities()` is exactly
  the 11 platforms below (Zelle's enrolment and Alipay's 10 USDC single order
  included), and each lists one deposit holding every major currency it offers
  on one leg: Alipay CNY; Cash App, Chime, Venmo, xMoney, Zelle USD; Monzo GBP;
  PayPal AUD CAD EUR GBP NZD SGD USD; Revolut AUD CAD CHF CNY EUR GBP MXN NZD
  SGD USD; UPI INR; Wise AUD CAD CHF CNY EUR GBP INR MXN NZD SGD USD. Each is
  checked for its stubbed payee hash, gating service, intent range (Alipay:
  the whole deposit minus 1 USDC; below 10 USDC it is refused before sending),
  Peer Pay policy on Venmo and PayPal only, attribution, and every currency
  tuple exactly as Peer Cash builds it (`buildMarketRateCurrencyOverride`:
  `minConversionRate` 1 sentinel, the oracle adapter at 0 bps spread) in the
  createDeposit calldata and on the escrow. A Venmo USD + Wise EUR, GBP order
  is byte-identical to Peer Cash's own `prepare()` (approve and createDeposit),
  restricts Venmo only and reads back through Peer Cash. Seller spreads: a
  +100 bps Revolut EUR, GBP order and a -100 bps Venmo USD + Wise EUR order are
  Peer Cash's deposit with only `spreadBps` changed (same calldata otherwise,
  same approve, same ERC-8021 codes), price at oracle x (1 + spread), are hidden
  by Peer Cash 0.7.2 alone but read back through `withSpreadOrders` and the
  app's client, then top up and withdraw all with exact balances; a spread
  outside -500..+500 bps is refused.
- `buy.fork.test.ts`: live quote (eligible, 50 bps fee priced in), signal from
  a fork address with Curator's real signature, the on-chain intent and fee
  legs, receipt parsers, cancel, the fulfil calldata and where an untrusted
  proof is rejected, a full trusted release, a seller with a rate-manager fee,
  and a deposit listed with Galleon's TOFIAT code.
- `buy-store.fork.test.ts`: the Exchange's buy store end to end (quote,
  confirm, reload and new-device recovery, extension capture, a rejected proof,
  Retry to a completed release, cancel, and a signal whose receipt the wallet
  lost).
- `smart-wallet.fork.test.ts`: Coinbase Smart Wallet v1 and v1.1, the first
  operation deploying the account, `execute()` / `executeBatch()` checked by
  `eth_call` from the EntryPoint before `handleOps`, buy and sell end to end,
  and a Wise GBP + EUR market-rate deposit as one batched operation that Peer
  Cash still reads back and withdraws (the indexer can't attribute a
  smart-wallet batch; a market-rate order needs no attribution).

Tests that need a particular kind of live offer (a rate-manager fee, a
TOFIAT-referred deposit) skip themselves when Curator has none at that moment.
