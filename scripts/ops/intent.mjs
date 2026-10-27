#!/usr/bin/env bun
/**
 * Reads a buy order (a Peer intent on OrchestratorV3) straight from Base, for
 * "my purchase is stuck" reports. Read-only. Uses BASE_RPC_URL from the shell
 * or .env.local.
 *
 *   bun scripts/ops/intent.mjs <intent hash>         # the order itself
 *   bun scripts/ops/intent.mjs <signal or fulfil tx> # the order(s) a transaction touched
 *   bun scripts/ops/intent.mjs <buyer address>       # the buyer's open orders
 *   options: --days 3 (how far back to search history for a closed order)
 *
 * The buyer finds their address in the Account tab; the signal transaction is
 * on the order's receipt in the Exchange.
 */

import { getContracts, getCurrencyCodeFromHash, resolvePaymentMethodNameFromHash } from "@zkp2p/sdk";
import { createPublicClient, formatUnits, http, parseEventLogs, toEventSelector, zeroAddress } from "viem";
import { base } from "viem/chains";
import { fail, numberFlag, parseArgs, serverEnv } from "./_lib.mjs";

const BLOCKS_PER_DAY = 43_200n;
/** BUY_REFERRER_FEE.recipient in src/config.ts. */
const RAMPRIDGE_FEE_RECIPIENT = "0xc141cbe4f4a9cabc3cc78159a9268a4e008922cd";

const { flags, positionals } = parseArgs(process.argv.slice(2));
const input = positionals[0]?.trim();
if (!input || !/^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(input)) {
  fail("usage: intent.mjs <intent hash | tx hash | buyer address> [--days 3]");
}
const days = numberFlag(flags, "days", 3);
const rpcUrl = serverEnv("BASE_RPC_URL") ?? "https://mainnet.base.org";

const { addresses, abis } = getContracts(8453, "production");
const orchestrator = { address: addresses.orchestratorV3, abi: abis.orchestratorV3 };
const escrow = { address: addresses.escrowV2 ?? addresses.escrow, abi: abis.escrowV2 ?? abis.escrow };
const client = createPublicClient({ chain: base, transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });

const LIFECYCLE = ["IntentSignaled", "IntentFulfilled", "IntentPruned"];
const lifecycleTopics = orchestrator.abi
  .filter((item) => item.type === "event" && LIFECYCLE.includes(item.name))
  .map((item) => toEventSelector(item));

const usdc = (units) => `${formatUnits(units, 6)} USDC`;
const when = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
const minutesFromNow = (seconds) => Math.round((Number(seconds) * 1000 - Date.now()) / 60_000);
const tryName = (fn, hash) => {
  try {
    return fn(hash) ?? hash;
  } catch {
    return hash;
  }
};

/** Lifecycle logs for one intent, searched back `days`, in shrinking block ranges if the RPC refuses a wide one. */
async function history(intentHash) {
  const latest = await client.getBlockNumber();
  const span = BigInt(Math.ceil(days)) * BLOCKS_PER_DAY;
  let cursor = latest > span ? latest - span : 0n;
  let chunk = span + 1n;
  const logs = [];
  while (cursor <= latest) {
    const to = cursor + chunk - 1n < latest ? cursor + chunk - 1n : latest;
    try {
      const raw = await client.request({
        method: "eth_getLogs",
        params: [
          {
            address: orchestrator.address,
            fromBlock: `0x${cursor.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
            topics: [lifecycleTopics, intentHash],
          },
        ],
      });
      logs.push(...parseEventLogs({ abi: orchestrator.abi, logs: raw }));
      cursor = to + 1n;
    } catch (err) {
      if (chunk <= 500n) throw err;
      chunk = chunk > 10_000n ? 10_000n : chunk / 4n;
    }
  }
  return logs;
}

async function describeIntent(intentHash) {
  console.log(`\nIntent ${intentHash}`);
  const intent = await client.readContract({ ...orchestrator, functionName: "getIntent", args: [intentHash] });
  if (intent.owner === zeroAddress) {
    const logs = await history(intentHash);
    const signaled = logs.find((l) => l.eventName === "IntentSignaled");
    const fulfilled = logs.find((l) => l.eventName === "IntentFulfilled");
    const pruned = logs.find((l) => l.eventName === "IntentPruned");
    if (signaled) {
      const a = signaled.args;
      console.log(`  signalled  ${usdc(a.amount)} from deposit #${a.depositId} in tx ${signaled.transactionHash} (block ${signaled.blockNumber})`);
    }
    if (fulfilled) {
      const a = fulfilled.args;
      console.log(`  STATUS     FULFILLED: ${usdc(a.amount)} released to ${a.fundsTransferredTo}${a.isManualRelease ? " (released manually by the seller)" : ""}`);
      console.log(`             tx ${fulfilled.transactionHash} (block ${fulfilled.blockNumber})`);
      console.log("  next       Nothing is stuck: the USDC is in that wallet. If the game still shows the order, the player should reopen the Exchange or reload.");
    } else if (pruned) {
      console.log(`  STATUS     CANCELLED or EXPIRED and pruned in tx ${pruned.transactionHash} (block ${pruned.blockNumber}); the USDC went back to the seller's deposit.`);
      console.log("  next       If the buyer already paid fiat, they need the seller to refund it off-platform, or Peer support with this intent hash and the payment receipt.");
    } else {
      console.log(`  STATUS     NOT OPEN, and no lifecycle event in the last ${days} day(s). Try --days 14, or check it is an OrchestratorV3 intent.`);
    }
    return;
  }

  const [lock, deposit] = await Promise.all([
    client.readContract({ ...escrow, functionName: "getDepositIntent", args: [intent.depositId, intentHash] }).catch(() => null),
    client.readContract({ ...escrow, functionName: "getDeposit", args: [intent.depositId] }).catch(() => null),
  ]);
  const rate = Number(formatUnits(intent.conversionRate, 18));
  const fiat = Number(formatUnits(intent.amount, 6)) * rate;
  const currency = tryName(getCurrencyCodeFromHash, intent.fiatCurrency);
  const platform = tryName(resolvePaymentMethodNameFromHash, intent.paymentMethod);
  const hasFee = (intent.referralFees ?? []).some((f) => String(f.recipient ?? f[0]).toLowerCase() === RAMPRIDGE_FEE_RECIPIENT);
  console.log(`  buyer      ${intent.owner}  (USDC goes to ${intent.to})`);
  console.log(`  order      ${usdc(intent.amount)} for about ${fiat.toFixed(2)} ${currency} via ${platform} at ${rate.toFixed(4)}`);
  console.log(`  deposit    #${intent.depositId} on escrow ${intent.escrow}${deposit ? `, seller ${deposit.depositor}, accepting intents ${deposit.acceptingIntents ? "yes" : "no"}, ${usdc(deposit.remainingDeposits)} left` : ""}`);
  console.log(`  signalled  ${when(intent.timestamp)}  RampRidge fee leg: ${hasFee ? "yes" : "no"}`);
  const expiry = lock?.expiryTime ?? 0n;
  if (expiry === 0n) {
    console.log("  STATUS     OPEN on the orchestrator, but the escrow holds no lock for it (mid-release?). Re-run in a minute.");
  } else if (minutesFromNow(expiry) > 0) {
    console.log(`  STATUS     OPEN, lock expires ${when(expiry)} (in ${minutesFromNow(expiry)} min)`);
    console.log("  next       The buyer pays the seller's handle, then Verify payment in the Exchange (Peer extension). Fulfilment releases the USDC.");
  } else {
    console.log(`  STATUS     EXPIRED ${-minutesFromNow(expiry)} min ago, not yet pruned: it CAN still be fulfilled until someone prunes it.`);
    console.log("  next       If the buyer paid, have them verify and fulfil now. Otherwise the seller (or anyone) can prune it to free the USDC.");
  }
}

try {
  if (input.length === 42) {
    const hashes = await client.readContract({ ...orchestrator, functionName: "getAccountIntents", args: [input] });
    console.log(`Open intents for ${input} on OrchestratorV3: ${hashes.length}`);
    for (const hash of hashes) await describeIntent(hash);
    if (!hashes.length) console.log("Closed orders do not show here: pass the order's signal transaction or intent hash instead.");
  } else {
    const intent = await client.readContract({ ...orchestrator, functionName: "getIntent", args: [input] });
    if (intent.owner !== zeroAddress) {
      await describeIntent(input);
    } else {
      const receipt = await client.getTransactionReceipt({ hash: input }).catch(() => null);
      if (receipt) {
        const touched = [
          ...new Set(
            parseEventLogs({ abi: orchestrator.abi, logs: receipt.logs })
              .filter((l) => LIFECYCLE.includes(l.eventName))
              .map((l) => l.args.intentHash),
          ),
        ];
        console.log(`Transaction ${input}: ${receipt.status}, block ${receipt.blockNumber}, ${touched.length} intent(s)`);
        for (const hash of touched) await describeIntent(hash);
        if (!touched.length) console.log("No OrchestratorV3 intent events in this transaction.");
      } else {
        await describeIntent(input);
      }
    }
  }
} catch (err) {
  fail(`Read failed: ${err instanceof Error ? err.message.split("\n")[0].replace(/https?:\/\/\S+/g, "[rpc]") : String(err)}`);
}
process.exit(0);
