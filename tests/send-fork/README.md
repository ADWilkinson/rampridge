# Send fork test: USDC sends against Base's real contracts

`send.fork.test.ts` runs the app's own send path (`src/wallet/send.ts`:
`sendUsdc`, `createSendChain`, `checkPendingSend`, and the wallet senders in
`src/wallet/senders.ts`) against Base's real USDC (FiatToken v2.2) and
ERC-4337 EntryPoint v0.6 on a local anvil fork. Nothing touches mainnet.

## Running

Not part of `bun run test`. Needs foundry's anvil (`~/.foundry/bin/anvil`,
else `anvil` on `PATH`) and a Base mainnet RPC to fork from:

```bash
export FORK_UPSTREAM_RPC_URL=...        # a Base mainnet RPC that serves eth_getLogs; never printed
bunx vitest run -c tests/send-fork/vitest.config.ts
bunx tsc -p tests/send-fork/tsconfig.json --noEmit
```

`global-setup.ts` starts anvil on port 8560 (`SEND_FORK_PORT`, keep it in
8560-8569) forking Base at the latest block with `--auto-impersonate`, and
stops it afterwards. A Base fork already answering on that port is reused.
`SEND_FORK_UPSTREAM_RPC_URL` overrides `FORK_UPSTREAM_RPC_URL` for this suite;
`ANVIL_BIN` the binary.
A run takes a few seconds.

## What it proves

- **External EOA** (`createExternalSender`, impersonated): the mined
  transaction is from the player to USDC with exactly the calldata
  `usdcTransferCall` builds (`transfer(to, amount)` plus the ERC-8021
  `rampridge` / `peer-ref-TOFIAT` suffix); balances move by exactly the
  amount; "All" sends the exact 6-decimal balance; an amount above the balance
  re-read before sending is refused with no transaction; the review's fee
  estimate and simulation work; a send whose outcome was lost is found again
  by its hash and by the chain's Transfer history (`eth_getLogs`).
- **Coinbase Smart Wallet, as Privy builds it**: viem `toCoinbaseSmartAccount`
  (version 1) with a Privy-style local owner that signs raw hashes, in
  permissionless `createSmartAccountClient` with fees at 175% of the estimate,
  driven through `createSmartSender` with WalletProvider's adapter
  (`client.sendTransaction({ calls })`). A minimal bundler (`fork.ts`)
  checks each user operation with an `eth_call` from the EntryPoint, then
  submits it with `EntryPoint.handleOps`. The first send deploys the account,
  the second runs on it. Each operation's callData is
  `execute(USDC, 0, <the app's exact transfer calldata>)`: the only call
  target is USDC, which is on the gas sponsor's allowlist
  (`SPONSORED_CALL_TARGETS`).

- **A smart-wallet send whose outcome was lost**: the fork bundler is served
  over real HTTP on `SEND_FORK_BUNDLER_PORT` (default 8561) and answers the
  operation's `eth_sendUserOperation` with HTTP 502 after it landed. The app
  keeps the pending record with the user operation's hash (computed from the
  request it sent, `userOperationHashIn`), refuses a second send, and settles
  the first as landed both from the bundler (`eth_getUserOperationReceipt`)
  and from the Transfer history. An operation the bundler has no record of,
  with the whole history since showing nothing, may be given up after
  `RELEASE_PENDING_AFTER_MS`; once the balance is down by the amount it may
  not (`canReleasePending`).

There is no paymaster on the fork, so the smart account prefunds the
EntryPoint itself; production's CDP paymaster sponsors the same operation
because its only target is USDC.
