/**
 * On-chain steps of a buy: signal, cancel and fulfil an intent through the
 * player's TxSender, plus the receipt parsing that turns a transaction into
 * an intent hash. Calldata always comes from the SDK's `.prepare()`, which
 * fetches the Curator `/v3/sign` signature and appends ERC-8021 attribution.
 */

import {
  apiGetPayeeDetails,
  referrerFeeConfigToPreciseUnits,
  type BuyerTeePaymentProofInput,
  type IndexerIntent,
  type PreparedTransaction,
  type Zkp2pClient,
} from "@zkp2p/sdk";
import {
  decodeFunctionData,
  getAddress,
  isHash,
  numberToHex,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { BUY_REFERRER_FEE, PEER_API_URL, PEER_ATTESTATION_URL, PEER_ATTRIBUTION } from "@/config";
import type { TxSender } from "@/wallet/types";
import { PEER_ABIS, PEER_API_TIMEOUT_MS } from "../client";
import type { BuyQuote } from "../market";
import { alipayPid, needsRecipientId, type BuyPlatformId } from "../platforms";
import { netAfterReferralFees } from "./amounts";
import { BuyFlowError, decodeRevertName, toBuyError } from "./errors";

const TX_OVERRIDES = { referrer: [...PEER_ATTRIBUTION] };

/** Production intents expire 6 hours after signalling unless extended. */
export const DEFAULT_INTENT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Wallet failures (src/wallet WalletError codes) that prove a send created no
 * intent: refused before anything was broadcast, or mined and reverted.
 * Anything else from a send (receipt or wallet timeouts, unknown wallet
 * errors) may still have landed, unless the error's `mayHaveLanded` says not.
 */
const NO_INTENT_WALLET_CODES: ReadonlySet<string> = new Set([
  "user_rejected",
  "insufficient_gas",
  "sponsorship_failed",
  "chain_switch_failed",
  "wallet_not_ready",
  "busy",
  "popup_blocked",
  "call_reverted",
  "reverted",
  "invalid_request",
]);

/**
 * Block time vs this browser's clock: when matching a reconciled intent to
 * its send, and as the margin after a signature's expiry before an unseen
 * send is treated as never landing.
 */
const SIGNAL_CLOCK_SKEW_MS = 15 * 60 * 1000;

/** RampRidge's referral leg as OrchestratorV3 stores it: 18-decimal fraction of the gross amount. */
export const BUY_REFERRER_FEE_PRECISE = referrerFeeConfigToPreciseUnits({ ...BUY_REFERRER_FEE });

/** How many of the account's newest open intents reconciliation inspects. */
const RECONCILE_MAX_INTENTS = 20;

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

/**
 * The signal transaction may be on-chain but its intent could not be read:
 * the wallet timed out after sending, or the receipt had no IntentSignaled
 * for this owner. The quote must never be resent until `reconcileSignal`
 * says no intent was created.
 */
export class SignalSentError extends BuyFlowError {
  /** The submitted transaction, when the wallet reported one. */
  readonly txHash: Hex | null;
  /** The orchestrator the signal was sent to. */
  readonly orchestrator: Address;
  /** When Curator's signature stops being accepted on-chain (ms), when known. */
  readonly signatureExpiresAt: number | null;
  /** The signed call left out RampRidge's fee (see `duplicatesReferrerLeg`). */
  readonly referrerFeeWaived: boolean;

  constructor(
    txHash: Hex | null,
    orchestrator: Address,
    signatureExpiresAt: number | null,
    cause: unknown,
    referrerFeeWaived = false,
  ) {
    super("tx_pending", "Your order may still be going through. Checking the chain before doing anything else.", true, {
      cause,
    });
    this.name = "SignalSentError";
    this.txHash = txHash;
    this.orchestrator = orchestrator;
    this.signatureExpiresAt = signatureExpiresAt;
    this.referrerFeeWaived = referrerFeeWaived;
  }
}

/** What a prepared signalIntent call will actually put on-chain. */
export interface SignalCallParams {
  referralFees: ReadonlyArray<{ recipient: Address; fee: bigint }>;
  /**
   * When the gating signature stops being accepted (ms). Null for a deposit
   * with no gating service (Curator's 409 "enforced on-chain": empty
   * signature, expiration 0), whose signal OrchestratorV3 never expires.
   */
  signatureExpiresAt: number | null;
}

/**
 * Decodes the parameters of a prepared OrchestratorV3 signalIntent call from
 * its calldata (the ERC-8021 suffix is ignored), so checks run on exactly what
 * will be sent. Null when the calldata is not a signalIntent call.
 */
export function decodeSignalCall(data: Hex): SignalCallParams | null {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: PEER_ABIS.orchestrator, data });
  } catch {
    return null;
  }
  if (decoded.functionName !== "signalIntent") return null;
  const params = asRecord(decoded.args?.[0]);
  const { referralFees, signatureExpiration } = params;
  if (!Array.isArray(referralFees) || typeof signatureExpiration !== "bigint") return null;
  const fees: { recipient: Address; fee: bigint }[] = [];
  for (const leg of referralFees as unknown[]) {
    const { recipient, fee } = asRecord(leg);
    if (typeof recipient !== "string" || typeof fee !== "bigint") return null;
    fees.push({ recipient: recipient as Address, fee });
  }
  return {
    referralFees: fees,
    signatureExpiresAt: signatureExpiration > 0n ? Number(signatureExpiration) * 1000 : null,
  };
}

function legsTo(call: SignalCallParams | null, recipient: string): SignalCallParams["referralFees"] {
  return call?.referralFees.filter((leg) => sameAddress(leg.recipient, recipient)) ?? [];
}

/**
 * True when Curator signed two legs to RampRidge's fee wallet. It does that
 * for every deposit listed with Galleon's TOFIAT referral code (all RampRidge,
 * usdctofiat and tokensto.cash sell orders): the code's owner, which is also
 * `BUY_REFERRER_FEE.recipient`, gets an integration share of Peer's fee as a
 * leg of its own. OrchestratorV3 rejects a repeated recipient
 * (DuplicateReferralFeeRecipient) and a fresh quote signs the same legs, so
 * such a deposit is signed again without RampRidge's fee instead.
 */
export function duplicatesReferrerLeg(call: SignalCallParams | null): boolean {
  return legsTo(call, BUY_REFERRER_FEE.recipient).length > 1;
}

/**
 * The SDK replaces the referral legs with whatever Curator's /v3/sign returns,
 * so the signed call is checked before sending: when the quote priced in
 * RampRidge's fee, exactly one leg must pay it at exactly 50 bps. Otherwise
 * the fee the player confirmed is not what the intent takes, and the offer
 * must be re-quoted rather than sent.
 *
 * With the fee waived (`duplicatesReferrerLeg`), the legs must name each
 * recipient once and leave the buyer at least the quoted USDC.
 */
export function assertReferrerLeg(quote: BuyQuote, call: SignalCallParams | null, opts: { waived?: boolean } = {}): void {
  if (opts.waived) {
    const recipients = new Set(call?.referralFees.map((leg) => leg.recipient.toLowerCase()) ?? []);
    if (call && recipients.size === call.referralFees.length) {
      // The manager fee is taken on top of the legs, exactly as the quote priced it.
      const net = netAfterReferralFees(quote.signalAmount, call.referralFees) - quote.fees.manager;
      if (net >= quote.usdcAmount) return;
    }
    throw new BuyFlowError("rate_changed", "Peer changed the fees on this offer. Get a fresh quote.", true);
  }
  if (quote.fees.referrer <= 0n) return;
  const ours = legsTo(call, BUY_REFERRER_FEE.recipient);
  if (call && ours.length === 1 && ours[0]?.fee === BUY_REFERRER_FEE_PRECISE) return;
  throw new BuyFlowError("rate_changed", "Peer changed the fees on this offer. Get a fresh quote.", true);
}

/**
 * False only when the error proves the send created no intent. A wallet error
 * that says whether its transaction may still land (`mayHaveLanded`, set from
 * how far the send got) is believed; anything else is judged by its code.
 */
export function sendMayHaveLanded(error: unknown): boolean {
  const landed = error && typeof error === "object" ? (error as { mayHaveLanded?: unknown }).mayHaveLanded : undefined;
  if (typeof landed === "boolean") return landed;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && NO_INTENT_WALLET_CODES.has(code)) return false;
  const mapped = toBuyError(error, { stage: "signal" }).code;
  return mapped !== "user_rejected" && mapped !== "insufficient_gas";
}

function hashOf(error: unknown): Hex | null {
  const hash = error && typeof error === "object" ? (error as { hash?: unknown }).hash : undefined;
  return typeof hash === "string" && isHash(hash) ? hash : null;
}

function sameAddress(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Simulates the exact call from the sender before the wallet sees it, so
 * contract rejections surface with their revert data instead of an opaque
 * sponsored-transaction failure. Transport errors are ignored: the send
 * itself will retry the network and report anything real.
 */
export async function preflight(client: Zkp2pClient, from: Address, tx: PreparedTransaction): Promise<void> {
  try {
    await client.publicClient.request({
      method: "eth_call",
      params: [{ from, to: tx.to, data: tx.data, value: numberToHex(tx.value ?? 0n) }, "latest"],
    });
  } catch (error) {
    const reverted =
      decodeRevertName(error) !== null || /revert/i.test(error instanceof Error ? error.message : String(error));
    if (reverted) throw error;
  }
}

async function send(sender: TxSender, tx: PreparedTransaction, label: string): Promise<TransactionReceipt> {
  const receipt = await sender.sendCalls([{ to: tx.to, data: tx.data, value: tx.value }], { label });
  if (receipt.status !== "success") {
    throw new BuyFlowError("tx_failed", "The transaction failed on-chain. Try again.", true);
  }
  return receipt;
}

export interface SignaledIntent {
  intentHash: Hex;
  orchestrator: Address;
  depositId: bigint;
  amount: bigint;
  rate: bigint;
  /** ms since epoch, from the event. */
  signaledAt: number;
}

/**
 * Reads the IntentSignaled event the orchestrator emitted for this owner and
 * deposit. Bundled smart-wallet transactions can carry other users' logs, so
 * the owner and deposit must both match.
 */
export function parseSignaledIntent(
  logs: readonly Log[],
  owner: Address,
  expected?: { depositId?: bigint; orchestrator?: Address },
): SignaledIntent | null {
  const events = parseEventLogs({ abi: PEER_ABIS.orchestrator, logs: [...logs], eventName: "IntentSignaled" });
  for (const event of events) {
    const args = asRecord(event.args);
    if (!sameAddress(args.owner, owner)) continue;
    if (expected?.orchestrator && !sameAddress(event.address, expected.orchestrator)) continue;
    if (expected?.depositId !== undefined && args.depositId !== expected.depositId) continue;
    if (
      typeof args.intentHash !== "string" ||
      typeof args.depositId !== "bigint" ||
      typeof args.amount !== "bigint" ||
      typeof args.conversionRate !== "bigint" ||
      typeof args.timestamp !== "bigint"
    ) {
      continue;
    }
    return {
      intentHash: args.intentHash as Hex,
      orchestrator: getAddress(event.address),
      depositId: args.depositId,
      amount: args.amount,
      rate: args.conversionRate,
      signaledAt: Number(args.timestamp) * 1000,
    };
  }
  return null;
}

/** The escrow's lock expiry for an intent (FundsLocked), in ms. */
export function parseLockExpiry(logs: readonly Log[], intentHash: Hex): number | null {
  const events = parseEventLogs({ abi: PEER_ABIS.escrow, logs: [...logs], eventName: "FundsLocked" });
  for (const event of events) {
    const args = asRecord(event.args);
    if (typeof args.intentHash === "string" && args.intentHash.toLowerCase() === intentHash.toLowerCase()) {
      return typeof args.expiryTime === "bigint" ? Number(args.expiryTime) * 1000 : null;
    }
  }
  return null;
}

/** USDC released to the buyer by IntentFulfilled, if the receipt has it. */
export function parseFulfilledAmount(logs: readonly Log[], intentHash: Hex): bigint | null {
  const events = parseEventLogs({ abi: PEER_ABIS.orchestrator, logs: [...logs], eventName: "IntentFulfilled" });
  for (const event of events) {
    const args = asRecord(event.args);
    if (typeof args.intentHash === "string" && args.intentHash.toLowerCase() === intentHash.toLowerCase()) {
      return typeof args.amount === "bigint" ? args.amount : null;
    }
  }
  return null;
}

/** The escrow's lock for an intent: still held (with its expiry) or gone. */
export type EscrowIntentState = { open: true; expiresAt: number } | { open: false };

/**
 * Reads the escrow's lock for an intent straight from EscrowV2. The escrow
 * deletes the lock when the intent is released, cancelled or pruned, so a
 * zeroed record means the intent can no longer be fulfilled. Null when the
 * read fails.
 */
export async function readEscrowIntent(
  client: Zkp2pClient,
  escrow: Address,
  depositId: string,
  intentHash: Hex,
): Promise<EscrowIntentState | null> {
  try {
    const result = asRecord(
      await client.publicClient.readContract({
        address: escrow,
        abi: PEER_ABIS.escrow,
        functionName: "getDepositIntent",
        args: [BigInt(depositId), intentHash],
      }),
    );
    const expiry = result.expiryTime;
    if (typeof expiry !== "bigint") return null;
    const lockedHash = typeof result.intentHash === "string" ? result.intentHash.toLowerCase() : null;
    if (expiry === 0n || lockedHash === ZERO_HASH) return { open: false };
    return { open: true, expiresAt: Number(expiry) * 1000 };
  } catch {
    return null;
  }
}

/**
 * The rate manager's fee on a deposit, as an 18-decimal fraction of the
 * released amount (0 when the deposit has no manager), read from EscrowV2's
 * `getManagerFee`. OrchestratorV3 snapshots this value at signal time and does
 * not expose the snapshot, so the current value stands in for it. Null when
 * the read fails.
 */
export async function readManagerFee(client: Zkp2pClient, escrow: Address, depositId: string): Promise<bigint | null> {
  try {
    const result = await client.publicClient.readContract({
      address: escrow,
      abi: PEER_ABIS.escrow,
      functionName: "getManagerFee",
      args: [BigInt(depositId)],
    });
    const [recipient, fee] = Array.isArray(result) ? result : [];
    if (typeof recipient !== "string" || typeof fee !== "bigint" || fee < 0n) return null;
    // The orchestrator takes nothing without a recipient.
    return sameAddress(recipient, zeroAddress) ? 0n : fee;
  } catch {
    return null;
  }
}

/** Reads the escrow's expiry for an intent. Null when the read fails or the lock is gone. */
export async function readIntentExpiry(
  client: Zkp2pClient,
  escrow: Address,
  depositId: string,
  intentHash: Hex,
): Promise<number | null> {
  const state = await readEscrowIntent(client, escrow, depositId, intentHash);
  return state?.open ? state.expiresAt : null;
}

/** A payee Curator registered: the handle to pay and whether it is a business profile. */
export interface PayeeRecord {
  handle: string;
  /** Revolut Business payees have no working revolut.me link or QR. */
  business: boolean;
  /**
   * The account id payment links need where it differs from the handle
   * (Alipay: the maker's 16-digit metadata.alipayPid). Absent or null otherwise.
   */
  recipientId?: string | null;
}

/** Looks a payee up by hash; a bare handle means "not a business profile". */
export type PayeeLookup = (platform: BuyPlatformId, payeeDetailsHash: Hex) => Promise<string | PayeeRecord | null>;

export function asPayeeRecord(found: string | PayeeRecord | null): PayeeRecord | null {
  if (!found) return null;
  return typeof found === "string" ? { handle: found, business: false } : found;
}

/**
 * The payee Curator registered for a hashed payee, or null if unknown.
 * Curator also returns `isBusiness` (absent from the SDK type) and
 * `metadata.profileType`; like Peer's web app, the explicit profile type wins.
 */
export async function fetchPayee(platform: BuyPlatformId, payeeDetailsHash: Hex): Promise<PayeeRecord | null> {
  try {
    const response = await apiGetPayeeDetails(
      { processorName: platform, hashedOnchainId: payeeDetailsHash },
      PEER_API_URL,
      PEER_API_TIMEOUT_MS,
    );
    const payee = response.responseObject as (typeof response.responseObject & { isBusiness?: boolean }) | undefined;
    if (!payee?.offchainId) return null;
    const profileType = String(payee.metadata?.profileType || (payee.isBusiness ? "BUSINESS" : ""));
    const recipientId = needsRecipientId(platform) ? alipayPid(payee.metadata) : null;
    return {
      handle: payee.offchainId,
      business: profileType.trim().toUpperCase() === "BUSINESS",
      ...(recipientId ? { recipientId } : {}),
    };
  } catch {
    return null;
  }
}

/** The payee handle Curator registered for a hashed payee, or null if unknown. */
export async function fetchPayeeHandle(platform: BuyPlatformId, payeeDetailsHash: Hex): Promise<string | null> {
  return (await fetchPayee(platform, payeeDetailsHash))?.handle ?? null;
}

async function ensureGas(client: Zkp2pClient, sender: TxSender): Promise<void> {
  if (sender.sponsored) return;
  let balance: bigint;
  try {
    balance = await client.publicClient.getBalance({ address: sender.address });
  } catch {
    return;
  }
  if (balance === 0n) {
    throw new BuyFlowError("insufficient_gas", "Your wallet needs a little ETH on Base to pay gas.", true);
  }
}

async function availableLiquidity(client: Zkp2pClient, escrow: Address, depositId: string): Promise<bigint | null> {
  try {
    const view = await client.getPvDepositById(`${escrow}_${depositId}`, { strictEscrow: true });
    return view.availableLiquidity;
  } catch {
    return null;
  }
}

export interface SignalResult extends SignaledIntent {
  /** The signal transaction; null when the intent was found by reading the orchestrator instead. */
  txHash: Hex | null;
  expiresAt: number;
  /**
   * RampRidge's fee was left off this intent because Curator already pays
   * its wallet Peer's integration share on the deposit (`duplicatesReferrerLeg`):
   * the buyer receives the quote's referrer fee on top of the quoted USDC.
   */
  referrerFeeWaived?: boolean;
}

async function signalFromReceipt(
  client: Zkp2pClient,
  receipt: TransactionReceipt,
  owner: Address,
  quote: BuyQuote,
  orchestrator: Address,
): Promise<SignalResult | null> {
  const signaled = parseSignaledIntent(receipt.logs, owner, { depositId: BigInt(quote.depositId), orchestrator });
  if (!signaled) return null;
  const expiresAt =
    parseLockExpiry(receipt.logs, signaled.intentHash) ??
    (await readIntentExpiry(client, quote.escrow, quote.depositId, signaled.intentHash)) ??
    signaled.signaledAt + DEFAULT_INTENT_TTL_MS;
  return { ...signaled, txHash: receipt.transactionHash, expiresAt };
}

/** The signalIntent call for a quote, with Curator's `/v3/sign` gating signature for the sender. */
function prepareSignal(client: Zkp2pClient, sender: TxSender, quote: BuyQuote, withReferrerFee: boolean) {
  return client.signalIntent.prepare({
    depositId: BigInt(quote.depositId),
    amount: quote.signalAmount,
    toAddress: sender.address,
    processorName: quote.platform,
    payeeDetails: quote.payeeDetailsHash,
    fiatCurrencyCode: quote.currency,
    conversionRate: quote.rate,
    escrowAddress: quote.escrow,
    postIntentHook: zeroAddress,
    preIntentHookData: "0x",
    data: "0x",
    // Only when the quote priced it in, as Peer's web app does, so the USDC the
    // player confirmed is exactly what the intent releases to them.
    ...(withReferrerFee ? { referrerFeeConfig: { ...BUY_REFERRER_FEE } } : {}),
    txOverrides: TX_OVERRIDES,
  });
}

/**
 * Signals the intent for a quote: Curator signs it for the sender, the
 * deposit's liquidity is re-checked, the call is simulated, then sent. The
 * intent hash comes from the receipt's IntentSignaled event. A deposit whose
 * signed legs would pay RampRidge's wallet twice is signed again without
 * RampRidge's fee (`duplicatesReferrerLeg`), and the result says so.
 *
 * Throws `SignalSentError` when the transaction may have landed but its
 * intent could not be read; every other error means no intent was created.
 */
export async function signalBuyIntent(client: Zkp2pClient, sender: TxSender, quote: BuyQuote): Promise<SignalResult> {
  await ensureGas(client, sender);
  const withReferrerFee = quote.fees.referrer > 0n;
  let prepared = await prepareSignal(client, sender, quote, withReferrerFee);
  let call = decodeSignalCall(prepared.data);
  let referrerFeeWaived = false;
  if (withReferrerFee && duplicatesReferrerLeg(call)) {
    prepared = await prepareSignal(client, sender, quote, false);
    call = decodeSignalCall(prepared.data);
    referrerFeeWaived = true;
  }
  assertReferrerLeg(quote, call, { waived: referrerFeeWaived });
  const signatureExpiresAt = call?.signatureExpiresAt ?? null;

  const available = await availableLiquidity(client, quote.escrow, quote.depositId);
  if (available !== null && available < quote.signalAmount) {
    throw new BuyFlowError("liquidity", "This seller doesn't have that much USDC left. Pick another offer.", true);
  }
  await preflight(client, sender.address, prepared);

  let receipt: TransactionReceipt;
  try {
    receipt = await sender.sendCalls([{ to: prepared.to, data: prepared.data, value: prepared.value }], {
      label: "Reserve USDC",
    });
  } catch (error) {
    if (sendMayHaveLanded(error)) {
      throw new SignalSentError(hashOf(error), prepared.to, signatureExpiresAt, error, referrerFeeWaived);
    }
    throw error;
  }
  if (receipt.status !== "success") {
    throw new BuyFlowError("tx_failed", "The transaction failed on-chain. Try again.", true);
  }
  const signal = await signalFromReceipt(client, receipt, sender.address, quote, prepared.to);
  if (!signal) throw new SignalSentError(receipt.transactionHash, prepared.to, signatureExpiresAt, null, referrerFeeWaived);
  return referrerFeeWaived ? { ...signal, referrerFeeWaived } : signal;
}

export type SignalReconciliation =
  /** The intent exists on-chain. */
  | { kind: "found"; signal: SignalResult }
  /** The transaction was mined and reverted, so no intent was created. */
  | { kind: "reverted" }
  /**
   * The signature expired (plus a clock margin) and a successful read of the
   * orchestrator still shows no intent: the send can no longer land.
   */
  | { kind: "lapsed" }
  /** Still unknown: the transaction may be pending, or the chain could not be read. */
  | { kind: "unknown" };

/**
 * The owner's open intent on `orchestrator` for the quote's deposit,
 * signalled no earlier than `since` (ms). Read straight from the
 * orchestrator, which unlike the ProtocolViewer cannot silently omit one.
 * Throws when the chain read fails.
 */
async function findSignaledIntent(
  client: Zkp2pClient,
  owner: Address,
  quote: BuyQuote,
  orchestrator: Address,
  since: number,
  txHash: Hex | null,
): Promise<SignalResult | null> {
  const hashes = await client.publicClient.readContract({
    address: orchestrator,
    abi: PEER_ABIS.orchestrator,
    functionName: "getAccountIntents",
    args: [owner],
  });
  if (!Array.isArray(hashes)) throw new Error("Unexpected getAccountIntents result");
  const newestFirst = (hashes as unknown[]).filter((h): h is Hex => typeof h === "string").reverse();
  for (const intentHash of newestFirst.slice(0, RECONCILE_MAX_INTENTS)) {
    const intent = asRecord(
      await client.publicClient.readContract({
        address: orchestrator,
        abi: PEER_ABIS.orchestrator,
        functionName: "getIntent",
        args: [intentHash],
      }),
    );
    const { depositId, amount, conversionRate, timestamp } = intent;
    if (!sameAddress(intent.owner, owner) || !sameAddress(intent.escrow, quote.escrow)) continue;
    if (typeof depositId !== "bigint" || depositId !== BigInt(quote.depositId)) continue;
    if (typeof amount !== "bigint" || typeof conversionRate !== "bigint" || typeof timestamp !== "bigint") continue;
    const signaledAt = Number(timestamp) * 1000;
    if (signaledAt < since) continue;
    const expiresAt =
      (await readIntentExpiry(client, quote.escrow, quote.depositId, intentHash)) ?? signaledAt + DEFAULT_INTENT_TTL_MS;
    return {
      intentHash,
      orchestrator: getAddress(orchestrator),
      depositId,
      amount,
      rate: conversionRate,
      signaledAt,
      txHash,
      expiresAt,
    };
  }
  return null;
}

/** A signal send whose outcome is being settled. */
export interface SentSignal {
  txHash: Hex | null;
  orchestrator: Address;
  /** ms since epoch, this browser's clock. */
  sentAt: number;
  /** When the signed call stops being accepted on-chain (ms), when known. */
  signatureExpiresAt: number | null;
  /** The signed call left out RampRidge's fee (`SignalSentError.referrerFeeWaived`). */
  referrerFeeWaived?: boolean;
}

/**
 * Settles a signal whose transaction may have landed (`SignalSentError`):
 * waits for the transaction when its hash is known, then polls the
 * orchestrator for the owner's new intent on the quote's deposit until
 * `timeoutMs` runs out. Only a mined, reverted transaction, or an expired
 * signature with the orchestrator still showing no intent, proves no intent
 * was created; anything inconclusive is `unknown`, never a licence to resend.
 */
export async function reconcileSignal(
  client: Zkp2pClient,
  owner: Address,
  quote: BuyQuote,
  sent: SentSignal,
  opts: { timeoutMs: number; intervalMs?: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<SignalReconciliation> {
  const deadline = opts.now() + opts.timeoutMs;
  const found = (signal: SignalResult): SignalReconciliation => ({
    kind: "found",
    signal: sent.referrerFeeWaived ? { ...signal, referrerFeeWaived: true } : signal,
  });
  if (sent.txHash) {
    let mined: TransactionReceipt | null = null;
    try {
      mined = await client.publicClient.waitForTransactionReceipt({
        hash: sent.txHash,
        timeout: Math.max(Math.floor(opts.timeoutMs / 2), 1_000),
      });
    } catch {
      mined = null;
    }
    if (mined) {
      if (mined.status !== "success") return { kind: "reverted" };
      const signal = await signalFromReceipt(client, mined, owner, quote, sent.orchestrator);
      if (signal) return found(signal);
    }
  }
  const since = sent.sentAt - SIGNAL_CLOCK_SKEW_MS;
  let interval = opts.intervalMs ?? 2_000;
  for (;;) {
    try {
      // Taken before the read, so a send that landed during it is still seen.
      const readAt = opts.now();
      const signal = await findSignaledIntent(client, owner, quote, sent.orchestrator, since, sent.txHash);
      if (signal) return found(signal);
      if (sent.signatureExpiresAt !== null && readAt > sent.signatureExpiresAt + SIGNAL_CLOCK_SKEW_MS) {
        return { kind: "lapsed" };
      }
    } catch {
      // RPC hiccup: keep polling until the deadline.
    }
    if (opts.now() + interval > deadline) return { kind: "unknown" };
    await opts.sleep(interval);
    interval = Math.min(interval * 2, 10_000);
  }
}

/** Cancels the sender's own intent (owner-only on-chain). */
export async function cancelBuyIntent(
  client: Zkp2pClient,
  sender: TxSender,
  intentHash: Hex,
  orchestrator: Address | null,
): Promise<Hex> {
  await ensureGas(client, sender);
  const prepared = await client.cancelIntent.prepare({
    intentHash,
    ...(orchestrator ? { orchestratorAddress: orchestrator } : {}),
    txOverrides: TX_OVERRIDES,
  });
  await preflight(client, sender.address, prepared);
  const receipt = await send(sender, prepared, "Cancel order");
  return receipt.transactionHash;
}

export interface FulfillResult {
  txHash: Hex;
  /** From IntentFulfilled; null if the event was not found in the receipt. */
  released: bigint | null;
}

/**
 * Proves the payment and releases the USDC. `prepare` posts the proof to the
 * attestation service, which is where payee, amount and replay checks run.
 */
export async function fulfillBuyIntent(
  client: Zkp2pClient,
  sender: TxSender,
  intentHash: Hex,
  orchestrator: Address | null,
  proof: BuyerTeePaymentProofInput,
): Promise<FulfillResult> {
  await ensureGas(client, sender);
  const prepared = await client.fulfillIntent.prepare({
    intentHash,
    proof,
    attestationServiceUrl: PEER_ATTESTATION_URL,
    postIntentHookData: "0x",
    ...(orchestrator ? { orchestratorAddress: orchestrator } : {}),
    txOverrides: TX_OVERRIDES,
  });
  await preflight(client, sender.address, prepared);
  const receipt = await send(sender, prepared, "Release USDC");
  return { txHash: receipt.transactionHash, released: parseFulfilledAmount(receipt.logs, intentHash) };
}

/** Polls the indexer until the intent shows FULFILLED or the time runs out. */
export async function waitForIndexedFulfillment(
  client: Zkp2pClient,
  intentHash: Hex,
  opts: { timeoutMs?: number; intervalMs?: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<IndexerIntent | null> {
  const deadline = opts.now() + (opts.timeoutMs ?? 30_000);
  const interval = opts.intervalMs ?? 1_500;
  for (;;) {
    try {
      const intent = await client.indexer.getIntentByHash(intentHash);
      if (intent?.status === "FULFILLED") return intent;
    } catch {
      // Indexer hiccup: keep polling until the deadline.
    }
    if (opts.now() + interval > deadline) return null;
    await opts.sleep(interval);
  }
}
