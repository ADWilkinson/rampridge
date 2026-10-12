/**
 * One golden-signal case: a live Curator quote, what the Peer web app would
 * sign for it, what RampRidge actually put on the fork, and the cancel.
 */

import { referrerFeeConfigToPreciseUnits, type Zkp2pClient } from "@zkp2p/sdk";
import { Attribution } from "ox/erc8021";
import { encodeFunctionData, getAddress, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { BUY_REFERRER_FEE } from "@/config";
import { cancelBuyIntent, readEscrowIntent, signalBuyIntent, type SignalResult } from "@/peer/buy/chain";
import { getBuyQuotes, MarketError, type BuyQuote } from "@/peer/market";
import type { BuyPlatformId, FiatCode } from "@/peer/platforms";
import type { TxSender } from "@/wallet/types";
import { assertOwnFork, forkClient } from "./fork";
import {
  ESCROW_ABI,
  ORCHESTRATOR,
  ORCHESTRATOR_ABI,
  accountIntents,
  decodeSignal,
  readDeposit,
  readDepositIntent,
  readIntent,
  type DepositLiquidity,
  type OnchainIntent,
  type SignalParams,
} from "./peer";
import { webSignalInputs } from "./webReference";

export const RAMPRIDGE_FEE_PRECISE = referrerFeeConfigToPreciseUnits({ ...BUY_REFERRER_FEE });

export interface Pair {
  platform: BuyPlatformId;
  currency: FiatCode;
}

export const PRIMARY_PAIRS: readonly Pair[] = [
  { platform: "zelle", currency: "USD" },
  { platform: "chime", currency: "USD" },
  { platform: "revolut", currency: "GBP" },
  { platform: "wise", currency: "EUR" },
  { platform: "revolut", currency: "USD" },
];

/** Tried in order when a primary pair has no quote the fork can fill right now. */
export const FALLBACK_PAIRS: readonly Pair[] = [
  { platform: "wise", currency: "GBP" },
  { platform: "revolut", currency: "EUR" },
  { platform: "wise", currency: "USD" },
  { platform: "cashapp", currency: "USD" },
  { platform: "monzo", currency: "GBP" },
  { platform: "paypal", currency: "USD" },
  { platform: "venmo", currency: "USD" },
];

export const FIAT_AMOUNTS = ["20", "50"] as const;

export function label(pair: Pair): string {
  return `${pair.platform}/${pair.currency}`;
}

export function hasDuplicateRecipient(legs: SignalParams["referralFees"]): boolean {
  return new Set(legs.map((l) => l.recipient.toLowerCase())).size !== legs.length;
}

export interface WebReference {
  /** prepare() exactly as the web app builds it for this quote (integrator fee in place of WEB_REFERRER_FEE_CONFIG). */
  withFee: { data: Hex; params: SignalParams };
  /** The same call without any integrator fee: the legs Curator signs for a plain Peer web buyer. */
  plain: { data: Hex; params: SignalParams };
  applyWebReferrerFee: boolean;
}

export async function webReference(client: Zkp2pClient, quote: BuyQuote, account: Address): Promise<WebReference> {
  const inputs = webSignalInputs(quote.raw as never, quote.currency, account, BUY_REFERRER_FEE);
  const withFee = await client.signalIntent.prepare(inputs.params);
  const { referrerFeeConfig: _fee, ...plainParams } = inputs.params;
  const plain = await client.signalIntent.prepare(plainParams);
  return {
    withFee: { data: withFee.data, params: decodeSignal(withFee.data) },
    plain: { data: plain.data, params: decodeSignal(plain.data) },
    applyWebReferrerFee: inputs.applyWebReferrerFee,
  };
}

/** Live quotes for a pair whose deposits the fork can still fill. */
export async function fillableQuotes(client: Zkp2pClient, pair: Pair, recipient: Address): Promise<BuyQuote[]> {
  for (const fiatAmount of FIAT_AMOUNTS) {
    let quotes: BuyQuote[];
    try {
      quotes = (await getBuyQuotes({ ...pair, fiatAmount, platforms: [pair.platform], recipient, client })).quotes;
    } catch (error) {
      if (error instanceof MarketError) return [];
      throw error;
    }
    const fillable: BuyQuote[] = [];
    for (const quote of quotes) {
      const deposit = await readDeposit(forkClient, BigInt(quote.depositId));
      if (deposit.remainingDeposits >= quote.signalAmount) fillable.push(quote);
    }
    if (fillable.length) return fillable;
  }
  return [];
}

/** The calldata the orchestrator received for an intent, from the signal transaction or bundle. */
export type CalldataSource = (signal: SignalResult, receipt: TransactionReceipt) => Promise<Hex>;

export const directCalldata: CalldataSource = async (signal) => {
  if (!signal.txHash) throw new Error("signal has no transaction hash");
  const tx = await forkClient.getTransaction({ hash: signal.txHash });
  if (tx.to?.toLowerCase() !== ORCHESTRATOR.toLowerCase()) throw new Error(`signal tx went to ${tx.to}`);
  return tx.input;
};

export interface SignalCase {
  pair: Pair;
  quote: BuyQuote;
  owner: Address;
  web: WebReference;
  before: DepositLiquidity;
  signal: SignalResult;
  signalReceipt: TransactionReceipt;
  /** Exactly what RampRidge's signal call carried (with its ERC-8021 suffix). */
  sentData: Hex;
  sent: SignalParams;
  onchain: OnchainIntent;
  managerFee: bigint;
  /** Intents the escrow pruned while locking this one (frees their liquidity). */
  prunedDuringSignal: Hex[];
  blockTimestamp: bigint;
  afterSignal: DepositLiquidity;
  escrowLock: { intentHash: Hex; amount: bigint; expiryTime: bigint };
  cancelTx: Hex;
  cancelData: Hex;
  afterCancel: DepositLiquidity;
  afterCancelEscrow: Awaited<ReturnType<typeof readEscrowIntent>>;
  afterCancelOwnerIntents: readonly Hex[];
  afterCancelIntent: OnchainIntent;
  availableBefore: bigint;
  availableAfterCancel: bigint;
}

async function availableLiquidity(client: Zkp2pClient, quote: BuyQuote): Promise<bigint> {
  return (await client.getPvDepositById(`${quote.escrow}_${quote.depositId}`, { strictEscrow: true })).availableLiquidity;
}

/** Signals `quote` with RampRidge's own signalBuyIntent, inspects it, then cancels it with cancelBuyIntent. */
export async function runSignalCase(opts: {
  pair: Pair;
  quote: BuyQuote;
  client: Zkp2pClient;
  sender: TxSender;
  calldata: CalldataSource;
  cancelCalldata?: (txHash: Hex) => Promise<Hex>;
  /** The web reference for this quote and sender, when already fetched. */
  web?: WebReference;
}): Promise<SignalCase> {
  await assertOwnFork();
  const { quote, client, sender } = opts;
  const depositId = BigInt(quote.depositId);
  const web = opts.web ?? (await webReference(client, quote, sender.address));
  const before = await readDeposit(forkClient, depositId);
  const availableBefore = await availableLiquidity(client, quote);

  const signal = await signalBuyIntent(client, sender, quote);
  if (!signal.txHash) throw new Error("signalBuyIntent returned no transaction");
  const signalReceipt = await forkClient.getTransactionReceipt({ hash: signal.txHash });
  const sentData = await opts.calldata(signal, signalReceipt);
  const onchain = await readIntent(forkClient, signal.intentHash);
  const snapshots = parseEventLogs({ abi: ORCHESTRATOR_ABI, logs: signalReceipt.logs, eventName: "IntentManagerFeeSnapshotted" });
  const managerSnapshot = snapshots.find((e) => (e.args as { intentHash: Hex }).intentHash === signal.intentHash);
  const pruned = parseEventLogs({ abi: [...ORCHESTRATOR_ABI, ...ESCROW_ABI], logs: signalReceipt.logs })
    .filter((e) => e.eventName === "IntentPruned" || e.eventName === "FundsUnlocked")
    .map((e) => (e.args as { intentHash: Hex }).intentHash)
    .filter((h) => h !== signal.intentHash);
  const block = await forkClient.getBlock({ blockNumber: signalReceipt.blockNumber });
  const afterSignal = await readDeposit(forkClient, depositId);
  const escrowLock = await readDepositIntent(forkClient, depositId, signal.intentHash);

  const cancelTx = await cancelBuyIntent(client, sender, signal.intentHash, signal.orchestrator);
  const cancelData = opts.cancelCalldata
    ? await opts.cancelCalldata(cancelTx)
    : (await forkClient.getTransaction({ hash: cancelTx })).input;
  const afterCancel = await readDeposit(forkClient, depositId);

  return {
    pair: opts.pair,
    quote,
    owner: getAddress(sender.address),
    web,
    before,
    signal,
    signalReceipt,
    sentData,
    sent: decodeSignal(sentData),
    onchain,
    managerFee: managerSnapshot ? (managerSnapshot.args as { fee: bigint }).fee : 0n,
    prunedDuringSignal: [...new Set(pruned)],
    blockTimestamp: block.timestamp,
    afterSignal,
    escrowLock,
    cancelTx,
    cancelData,
    afterCancel,
    afterCancelEscrow: await readEscrowIntent(client, quote.escrow, quote.depositId, signal.intentHash),
    afterCancelOwnerIntents: await accountIntents(forkClient, sender.address),
    afterCancelIntent: await readIntent(forkClient, signal.intentHash),
    availableBefore,
    availableAfterCancel: await availableLiquidity(client, quote),
  };
}

/** signalIntent calldata without any ERC-8021 suffix. */
export function bareSignalCalldata(params: SignalParams): Hex {
  return encodeFunctionData({ abi: ORCHESTRATOR_ABI, functionName: "signalIntent", args: [params] });
}

export function suffixFor(codes: readonly string[]): Hex {
  return Attribution.toDataSuffix({ codes: [...codes] });
}
