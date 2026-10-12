/**
 * Builds fixtures/rounding.json from every real IntentSignaled on OrchestratorV3
 * in a block range (read-only): how many intents there were per currency, and the
 * ones where the "send exactly" amount computed the way Peer's web app computes
 * it (floor to 6-decimal fiat, then up to the cent; see lib/peer-reference.ts)
 * is below the least payment the attestation service releases the whole intent
 * for. RampRidge's fiatToSend is evaluated against them in rounding.parity.test.ts.
 *
 *   export FORK_UPSTREAM_RPC_URL=...   # an archive-capable Base mainnet RPC; never printed
 *   bun tests/buy-parity/golden/discover-rounding.ts
 *
 * Env: GOLDEN_WINDOWS (10k-block windows, default 30), GOLDEN_TO_BLOCK (default head).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getContracts, getCurrencyCodeFromHash } from "@zkp2p/sdk";
import { decodeEventLog, type Abi, type Address, type Hex } from "viem";
import { INTENT_FULFILLED_TOPIC, INTENT_SIGNALED_TOPIC, decodeIntentFulfilled } from "./lib/decode";
import { minimumFullPaymentMinor, peerFiatToSend } from "./lib/peer-reference";
import { scrub, upstreamRpc } from "./lib/rpc";

const OUT = fileURLToPath(new URL("./fixtures/rounding.json", import.meta.url));
const rpc = upstreamRpc();
const contracts = getContracts(8453, "production");
const ORCH = contracts.addresses.orchestratorV3 as Address;
const ABI = contracts.abis.orchestratorV3 as Abi;
const WINDOWS = BigInt(process.env.GOLDEN_WINDOWS ?? 30);
/** The attestation service's release formula assumes 2-decimal fiat. */
const ZERO_DECIMAL = new Set(["JPY", "VND", "UGX", "KRW"]);

export interface RoundingCase {
  signalTxHash: Hex;
  intentHash: Hex;
  currency: string;
  amount: string;
  conversionRate: string;
  /** The intent's fulfilment, when it was fulfilled within the scan (IntentFulfilled log). */
  fulfilTxHash: Hex | null;
}

async function main() {
  const head = process.env.GOLDEN_TO_BLOCK ? BigInt(process.env.GOLDEN_TO_BLOCK) : BigInt(await rpc<Hex>("eth_blockNumber", []));
  const latest = BigInt(await rpc<Hex>("eth_blockNumber", []));
  const perCurrency: Record<string, { intents: number; underquoted: number }> = {};
  const underquoted: RoundingCase[] = [];
  let total = 0;
  for (let w = 0n; w < WINDOWS; w += 1n) {
    const to = head - w * 10_000n;
    const from = to - 9_999n;
    const logs = await rpc<Array<{ data: Hex; topics: Hex[]; transactionHash: Hex; blockNumber: Hex }>>("eth_getLogs", [
      { address: ORCH, topics: [INTENT_SIGNALED_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
    ]);
    for (const log of logs) {
      const { args } = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as {
        args: { intentHash: Hex; amount: bigint; conversionRate: bigint; fiatCurrency: Hex };
      };
      const currency = getCurrencyCodeFromHash(args.fiatCurrency);
      if (!currency || ZERO_DECIMAL.has(currency)) continue;
      const bucket = (perCurrency[currency] ??= { intents: 0, underquoted: 0 });
      bucket.intents += 1;
      total += 1;
      const shownMinor = peerFiatToSend(args.amount, args.conversionRate) / 10_000n;
      if (shownMinor >= minimumFullPaymentMinor(args.amount, args.conversionRate)) continue;
      bucket.underquoted += 1;
      // Where it was fulfilled (intents live at most 5 days).
      let fulfilTxHash: Hex | null = null;
      const signalBlock = BigInt(log.blockNumber);
      for (let f = signalBlock; f <= latest && f < signalBlock + 250_000n && !fulfilTxHash; f += 50_000n) {
        const end = f + 49_999n > latest ? latest : f + 49_999n;
        const found = await rpc<Array<{ data: Hex; topics: Hex[]; transactionHash: Hex }>>("eth_getLogs", [
          { address: ORCH, topics: [INTENT_FULFILLED_TOPIC, args.intentHash], fromBlock: `0x${f.toString(16)}`, toBlock: `0x${end.toString(16)}` },
        ]);
        const first = found[0];
        if (first && !decodeIntentFulfilled(ABI, first).isManualRelease) fulfilTxHash = first.transactionHash;
      }
      underquoted.push({
        signalTxHash: log.transactionHash,
        intentHash: args.intentHash,
        currency,
        amount: args.amount.toString(),
        conversionRate: args.conversionRate.toString(),
        fulfilTxHash,
      });
    }
    console.log(`window ${w + 1n}/${WINDOWS}: ${total} intents, ${underquoted.length} underquoted`);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify(
      { generatedAt: new Date().toISOString(), scannedBlocks: { from: Number(head - WINDOWS * 10_000n + 1n), to: Number(head) }, total, perCurrency, underquoted },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${OUT}`);
}

main().catch((error) => {
  console.error(scrub(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exit(1);
});
