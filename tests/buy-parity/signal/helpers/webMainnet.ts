/**
 * Real, recent signalIntent calls the Peer web app made on Base mainnet.
 *
 * IntentSignaled logs on OrchestratorV3 give the transactions; a callTracer
 * trace gives the exact OrchestratorV3.signalIntent call frame (direct EOA
 * sends, and ERC-4337 bundles through EntryPoint v0.7 / EIP-7702 accounts
 * alike). A call is the web app's when its calldata carries the web app's
 * ERC-8021 attribution, `zkp2p-web` then the Base builder code, which
 * clients/web useSignalIntent sets and nothing else sends.
 */

import { parseEventLogs, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";
import { mainnetClient } from "./fork";
import {
  BASE_BUILDER_CODE,
  ORCHESTRATOR,
  ORCHESTRATOR_ABI,
  WEB_REFERRER_CODE,
  attributionCodes,
  decodeSignal,
  paymentMethodName,
  type SignalParams,
} from "./peer";

const SIGNAL_SELECTOR = "0xf3ff8655";

interface CallFrame {
  from: string;
  to?: string;
  input: string;
  error?: string;
  calls?: CallFrame[];
}

export interface WebSignal {
  txHash: Hash;
  blockNumber: bigint;
  blockTimestamp: bigint;
  /** The transaction's `to`: OrchestratorV3 for a direct send, else the EntryPoint the bundle went through. */
  txTo: Address | null;
  txType: string;
  /** msg.sender of the signalIntent frame (the intent owner). */
  caller: Address;
  /** The exact calldata the web app handed its wallet (with its ERC-8021 suffix). */
  input: Hex;
  params: SignalParams;
  codes: string[];
  platform: string | null;
  receipt: TransactionReceipt;
  intentHash: Hex;
}

function signalFrames(frame: CallFrame, out: CallFrame[] = []): CallFrame[] {
  if (!frame.error && frame.to?.toLowerCase() === ORCHESTRATOR.toLowerCase() && frame.input.startsWith(SIGNAL_SELECTOR)) {
    out.push(frame);
  }
  for (const child of frame.calls ?? []) signalFrames(child, out);
  return out;
}

export function isWebAttribution(codes: readonly string[]): boolean {
  return codes.length === 2 && codes[0] === WEB_REFERRER_CODE && codes[1] === BASE_BUILDER_CODE;
}

/**
 * The newest web-app signals, newest first, at most `perPlatform` for each of
 * `platforms`, scanning back at most `maxBlocks` blocks in windows.
 */
export async function recentWebSignals(opts: {
  platforms: readonly string[];
  perPlatform: number;
  maxBlocks?: bigint;
  window?: bigint;
}): Promise<WebSignal[]> {
  const latest = await mainnetClient.getBlockNumber();
  const floor = latest - (opts.maxBlocks ?? 200_000n);
  const window = opts.window ?? 5_000n;
  const found = new Map<string, WebSignal[]>(opts.platforms.map((p) => [p, []]));
  const seen = new Set<string>();
  const done = () => [...found.values()].every((list) => list.length >= opts.perPlatform);

  for (let to = latest; to > floor && !done(); to -= window) {
    const from = to - window + 1n > floor ? to - window + 1n : floor;
    const logs = await mainnetClient.getLogs({ address: ORCHESTRATOR, fromBlock: from, toBlock: to });
    const events = parseEventLogs({ abi: ORCHESTRATOR_ABI, logs, eventName: "IntentSignaled" }).reverse();
    for (const event of events) {
      if (done()) break;
      const args = event.args as { paymentMethod?: Hex; verifier?: Hex };
      const platform = paymentMethodName((args.paymentMethod ?? args.verifier ?? "0x") as Hex);
      const bucket = platform ? found.get(platform) : undefined;
      if (!bucket || bucket.length >= opts.perPlatform || seen.has(event.transactionHash)) continue;
      seen.add(event.transactionHash);
      const trace = (await mainnetClient.request({
        method: "debug_traceTransaction" as never,
        params: [event.transactionHash, { tracer: "callTracer" }] as never,
      })) as CallFrame;
      for (const frame of signalFrames(trace)) {
        const input = frame.input as Hex;
        const codes = attributionCodes(input);
        if (!isWebAttribution(codes)) continue;
        const [tx, receipt, block] = await Promise.all([
          mainnetClient.getTransaction({ hash: event.transactionHash }),
          mainnetClient.getTransactionReceipt({ hash: event.transactionHash }),
          mainnetClient.getBlock({ blockNumber: event.blockNumber }),
        ]);
        const params = decodeSignal(input);
        if (paymentMethodName(params.paymentMethod) !== platform) continue;
        bucket.push({
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
          blockTimestamp: block.timestamp,
          txTo: tx.to ?? null,
          txType: tx.type,
          caller: frame.from as Address,
          input,
          params,
          codes,
          platform,
          receipt,
          intentHash: (event.args as { intentHash: Hex }).intentHash,
        });
        break;
      }
    }
  }
  return [...found.values()].flat().sort((a, b) => Number(b.blockNumber - a.blockNumber));
}
