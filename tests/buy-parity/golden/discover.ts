/**
 * Builds tests/buy-parity/golden/fixtures/fulfilments.json from real buyer
 * fulfilments on Base (read-only: eth_getLogs, transactions, traces, and one
 * Curator payee lookup per case; nothing is signed or sent).
 *
 *   FORK_UPSTREAM_RPC_URL=<archive-capable Base RPC> bun tests/buy-parity/golden/discover.ts
 *
 * Env: GOLDEN_WINDOWS (10k-block windows scanned back from head, default 60),
 * GOLDEN_PER_PLATFORM (cases kept per platform, default 2),
 * GOLDEN_TO_BLOCK (scan back from this block instead of head).
 *
 * IntentFulfilled logs on OrchestratorV3 are scanned newest first. Each is
 * classified cheaply from the transaction input (the fulfillIntent call is
 * found by selector, directly or inside a bundled user operation), then the
 * kept cases are re-read exactly: the orchestrator call via a callTracer
 * trace, the signal transaction via its IntentSignaled log, and the escrow
 * lock via FundsLocked.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  apiGetPayeeDetails,
  getContracts,
  getCurrencyCodeFromHash,
  getPaymentMethodsCatalog,
  resolvePaymentMethodNameFromHash,
} from "@zkp2p/sdk";
import {
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  FULFILL_SELECTOR,
  INTENT_FULFILLED_TOPIC,
  INTENT_SIGNALED_TOPIC,
  SIGNAL_SELECTOR,
  decodeFulfillCalldata,
  decodeIntentFulfilled,
  decodeMetadata,
  decodePaymentDetails,
  decodePaymentProof,
  decodeSignalCalldata,
  decodeVerificationData,
  locateCall,
  type FulfillCallArgs,
} from "./lib/decode";
import { FIXTURE_PATH, type GoldenFixtureFile, type GoldenFulfilment } from "./lib/fixtures";
import { scrub, upstreamRpc } from "./lib/rpc";

const PEER_API_URL = "https://api.zkp2p.xyz";
const contracts = getContracts(8453, "production");
const ORCHESTRATOR = getAddress(contracts.addresses.orchestratorV3 as Address);
const ORCH_ABI = contracts.abis.orchestratorV3 as Abi;
const ESCROW_ABI = (contracts.abis.escrowV2 ?? contracts.abis.escrow) as Abi;
const catalog = getPaymentMethodsCatalog(8453, "production");

const RAMPRIDGE_PLATFORMS = [
  "venmo",
  "cashapp",
  "revolut",
  "wise",
  "zelle",
  "paypal",
  "monzo",
  "chime",
  "n26",
  "luxon",
  "mercadopago",
  "monobank",
  "xmoney",
];

const WINDOWS = Number(process.env.GOLDEN_WINDOWS ?? 60);
const SPAN = 10_000n;
const PER_PLATFORM = Number(process.env.GOLDEN_PER_PLATFORM ?? 2);

const rpc = upstreamRpc();

interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

/** Finds the fulfillIntent call for `intentHash` inside arbitrary transaction input (direct or nested). */
function findFulfilArgs(input: Hex, intentHash: Hex): FulfillCallArgs | null {
  const hex = input.slice(2).toLowerCase();
  const needle = FULFILL_SELECTOR.slice(2);
  for (let at = hex.indexOf(needle); at !== -1; at = hex.indexOf(needle, at + 1)) {
    if (at % 2 !== 0) continue;
    try {
      const decoded = decodeFunctionData({ abi: ORCH_ABI, data: `0x${hex.slice(at)}` as Hex });
      const args = (decoded.args as readonly [FulfillCallArgs])[0];
      if (decoded.functionName === "fulfillIntent" && args.intentHash.toLowerCase() === intentHash.toLowerCase()) {
        return args;
      }
    } catch {
      // Not a call boundary.
    }
  }
  return null;
}

function classify(args: FulfillCallArgs): { platform: string; source: string } {
  const proof = decodePaymentProof(args.paymentProof);
  const details = decodePaymentDetails(proof.encodedPaymentDetails);
  const platform = resolvePaymentMethodNameFromHash(details.snapshot.paymentMethod, catalog) ?? `unknown:${details.snapshot.paymentMethod.slice(0, 10)}`;
  let source = "none";
  try {
    const meta = decodeMetadata(proof.metadata);
    if (meta && typeof meta.source === "string") source = meta.source;
  } catch {
    source = "unparsed";
  }
  return { platform, source };
}

async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await run(items[i] as T);
      }
    }),
  );
  return out;
}

async function findSignalLog(intentHash: Hex, beforeBlock: bigint): Promise<RawLog> {
  // Intents live at most 5 days (EscrowV2 cap): ~216k Base blocks. Search back in windows.
  for (let to = beforeBlock; to > beforeBlock - 260_000n; to -= 50_000n) {
    const from = to - 49_999n;
    const logs = await rpc<RawLog[]>("eth_getLogs", [
      {
        address: ORCHESTRATOR,
        topics: [INTENT_SIGNALED_TOPIC, intentHash],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ]);
    if (logs.length > 0) return logs[0] as RawLog;
  }
  throw new Error(`no IntentSignaled for ${intentHash}`);
}

async function payeeLookup(platform: string, payeeDetails: Hex): Promise<GoldenFulfilment["payeeLookup"]> {
  try {
    const response = await apiGetPayeeDetails({ processorName: platform, hashedOnchainId: payeeDetails }, PEER_API_URL, 15_000);
    const handle = response.responseObject?.offchainId || null;
    if (!handle) return { found: false, handleKeccak: null, handleHashesToPayee: false };
    const handleKeccak = keccak256(stringToHex(handle));
    return { found: true, handleKeccak, handleHashesToPayee: handleKeccak.toLowerCase() === payeeDetails.toLowerCase() };
  } catch {
    return { found: false, handleKeccak: null, handleHashesToPayee: false };
  }
}

interface Candidate {
  log: RawLog;
  platform: string;
  source: string;
}

async function buildCase(candidate: Candidate, ordinal: number): Promise<GoldenFulfilment> {
  const { log, platform } = candidate;
  const event = decodeIntentFulfilled(ORCH_ABI, log);
  const intentHash = event.intentHash;
  const fulfilCall = await locateCall(rpc, log.transactionHash, ORCHESTRATOR, FULFILL_SELECTOR, (input) => {
    try {
      return decodeFulfillCalldata(ORCH_ABI, input).args.intentHash.toLowerCase() === intentHash.toLowerCase();
    } catch {
      return false;
    }
  });
  const fulfil = decodeFulfillCalldata(ORCH_ABI, fulfilCall.input);
  const proof = decodePaymentProof(fulfil.args.paymentProof);
  const details = decodePaymentDetails(proof.encodedPaymentDetails);
  const verification = decodeVerificationData(fulfil.args.verificationData);
  const meta = decodeMetadata(proof.metadata);
  const fulfilBlock = BigInt(log.blockNumber);
  const block = await rpc<{ timestamp: Hex }>("eth_getBlockByNumber", [log.blockNumber, false]);

  const signalLog = await findSignalLog(intentHash, fulfilBlock);
  const signaled = decodeEventLog({ abi: ORCH_ABI, data: signalLog.data, topics: signalLog.topics as [Hex, ...Hex[]] });
  const s = signaled.args as unknown as {
    escrow: Address;
    depositId: bigint;
    paymentMethod: Hex;
    owner: Address;
    to: Address;
    amount: bigint;
    fiatCurrency: Hex;
    conversionRate: bigint;
    timestamp: bigint;
  };
  const signalCall = await locateCall(rpc, signalLog.transactionHash, ORCHESTRATOR, SIGNAL_SELECTOR, (input) => {
    try {
      const a = decodeSignalCalldata(ORCH_ABI, input).args;
      return a.depositId === s.depositId && a.amount === s.amount && getAddress(a.to) === getAddress(s.to);
    } catch {
      return false;
    }
  });
  const signal = decodeSignalCalldata(ORCH_ABI, signalCall.input);
  const signalReceipt = await rpc<{ logs: RawLog[] }>("eth_getTransactionReceipt", [signalLog.transactionHash]);
  let lockExpiry = 0;
  for (const l of signalReceipt.logs) {
    if (getAddress(l.address) !== getAddress(s.escrow)) continue;
    try {
      const ev = decodeEventLog({ abi: ESCROW_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      const a = ev.args as unknown as { intentHash?: Hex; expiryTime?: bigint };
      if (ev.eventName === "FundsLocked" && a.intentHash?.toLowerCase() === intentHash.toLowerCase()) {
        lockExpiry = Number(a.expiryTime);
      }
    } catch {
      // Other escrow events.
    }
  }

  // The escrow's own lock in the block before the fulfilment (intents can be extended after signalling).
  const lockCall = { abi: ESCROW_ABI, functionName: "getDepositIntent", args: [s.depositId, intentHash] } as const;
  const lockRaw = await rpc<Hex>("eth_call", [
    { to: s.escrow, data: encodeFunctionData(lockCall) },
    `0x${(fulfilBlock - 1n).toString(16)}`,
  ]);
  const lock = decodeFunctionResult({ ...lockCall, data: lockRaw }) as { expiryTime: bigint };

  const currency = getCurrencyCodeFromHash(s.fiatCurrency) ?? "unknown";
  return {
    id: `${platform}-${ordinal}`,
    platform,
    currency,
    intentHash,
    orchestrator: ORCHESTRATOR,
    escrow: getAddress(s.escrow),
    depositId: s.depositId.toString(),
    owner: getAddress(s.owner),
    to: getAddress(s.to),
    amount: s.amount.toString(),
    conversionRate: s.conversionRate.toString(),
    paymentMethod: s.paymentMethod,
    fiatCurrency: s.fiatCurrency,
    payeeDetails: details.snapshot.payeeDetails,
    signaledAt: Number(s.timestamp),
    referralFees: signal.args.referralFees.map((leg) => ({ recipient: getAddress(leg.recipient), fee: leg.fee.toString() })),
    signal: {
      txHash: signalLog.transactionHash,
      blockNumber: Number(BigInt(signalLog.blockNumber)),
      caller: signalCall.from,
      direct: signalCall.direct,
      suffixCodes: signal.suffixCodes,
      signatureExpiration: Number(signal.args.signatureExpiration),
      lockExpiry,
      lockExpiryAtFulfil: Number(lock.expiryTime),
      gatingSignatureLength: (signal.args.gatingServiceSignature.length - 2) / 2,
    },
    fulfil: {
      txHash: log.transactionHash,
      blockNumber: Number(fulfilBlock),
      blockTimestamp: Number(BigInt(block.timestamp)),
      caller: fulfilCall.from,
      direct: fulfilCall.direct,
      txFrom: fulfilCall.txFrom,
      suffixCodes: fulfil.suffixCodes,
      releaseAmount: proof.releaseAmount.toString(),
      netAmount: event.amount.toString(),
      fundsTransferredTo: event.fundsTransferredTo,
      signer: verification.signer,
      signatureCount: proof.signatures.length,
      attestationSource: typeof meta?.source === "string" ? meta.source : null,
      metadataKeys: meta ? Object.keys(meta).sort() : [],
      paymentAmountMinor: details.payment.amount.toString(),
      paymentTimestampMs: details.payment.timestampMs.toString(),
      timestampBufferSeconds: Number(details.snapshot.timestampBufferSeconds),
      dataHash: proof.dataHash,
      postIntentHookData: fulfil.args.postIntentHookData,
    },
    payeeLookup: await payeeLookup(platform, details.snapshot.payeeDetails),
  };
}

async function main() {
  const head = process.env.GOLDEN_TO_BLOCK ? BigInt(process.env.GOLDEN_TO_BLOCK) : BigInt(await rpc<Hex>("eth_blockNumber", []));
  const seen: Record<string, Record<string, number>> = {};
  const kept = new Map<string, Candidate[]>();
  let lowest = head;
  for (let w = 0; w < WINDOWS; w += 1) {
    const to = head - BigInt(w) * SPAN;
    const from = to - SPAN + 1n;
    lowest = from;
    const logs = await rpc<RawLog[]>("eth_getLogs", [
      { address: ORCHESTRATOR, topics: [INTENT_FULFILLED_TOPIC], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` },
    ]);
    logs.sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || Number(BigInt(b.logIndex) - BigInt(a.logIndex)));
    const classified = await pool(logs, 8, async (log) => {
      const event = decodeIntentFulfilled(ORCH_ABI, log);
      if (event.isManualRelease) return { log, platform: "manual-release", source: "manual" };
      const tx = await rpc<{ input: Hex }>("eth_getTransactionByHash", [log.transactionHash]);
      const args = findFulfilArgs(tx.input, event.intentHash);
      if (!args) return { log, platform: "unlocated", source: "unknown" };
      return { log, ...classify(args) };
    });
    for (const c of classified) {
      seen[c.platform] ??= {};
      const bucket = seen[c.platform] as Record<string, number>;
      bucket[c.source] = (bucket[c.source] ?? 0) + 1;
      if (c.source !== "buyer-tee" || !RAMPRIDGE_PLATFORMS.includes(c.platform)) continue;
      const list = kept.get(c.platform) ?? [];
      if (list.length < PER_PLATFORM) {
        list.push(c);
        kept.set(c.platform, list);
      }
    }
    const covered = [...kept.values()].filter((l) => l.length >= PER_PLATFORM).length;
    console.log(`window ${w + 1}/${WINDOWS} blocks ${from}-${to}: ${logs.length} fulfilments; platforms at quota ${covered}`);
    if (RAMPRIDGE_PLATFORMS.every((p) => (kept.get(p)?.length ?? 0) >= PER_PLATFORM)) break;
  }

  const cases: GoldenFulfilment[] = [];
  for (const platform of RAMPRIDGE_PLATFORMS) {
    const list = kept.get(platform) ?? [];
    for (const [i, candidate] of list.entries()) {
      try {
        cases.push(await buildCase(candidate, i + 1));
        console.log(`case ${platform}-${i + 1}: ${candidate.log.transactionHash}`);
      } catch (error) {
        console.log(`skipped ${platform} ${candidate.log.transactionHash}: ${scrub(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }
  const file: GoldenFixtureFile = {
    generatedAt: new Date().toISOString(),
    scannedBlocks: { from: Number(lowest), to: Number(head) },
    seen,
    cases,
  };
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`wrote ${cases.length} cases to ${FIXTURE_PATH}`);
  console.log(JSON.stringify(seen));
}

main().catch((error) => {
  console.error(scrub(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exit(1);
});
