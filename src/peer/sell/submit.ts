/**
 * Creates a sell order (a Peer Cash deposit) through the unsigned path so it
 * works with smart wallets: prepare() (with Peer's single-order intent range
 * for Alipay) -> sendCalls([approve, createDeposit])
 * as one batched user operation where supported -> finalizePreparedCashout()
 * -> one Peer Pay access-policy call per restricted payment method.
 *
 * Duplicate protection: a pending record is persisted before the deposit batch
 * is sent and kept until the order is fully listed (or has closed). While it
 * exists, no new deposit can start from this wallet; recovery reconciles it
 * against the chain (receipt, then the wallet's indexed orders) and finishes
 * it. An attempt with no deposit is abandoned only on evidence that none can
 * still land (see `safeToAbandon`).
 */

import {
  isCashError,
  type CashClient,
  type CashOrder,
  type CashOrderState,
  type PrepareResult,
  type PreparedTransaction,
} from "@zkp2p/cash";
import {
  decodeFunctionData,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { CHAIN_ID } from "@/config";
import type { TxSender, WalletCall } from "@/wallet/types";
import { readGasBalance, readUsdcBalance } from "./balance";
import { classifySendFailure, sellError, toSellFlowError, SellFlowError } from "./errors";
import { initialSteps, toReceive, type ListedSell, type ResolvedLeg, type SubmitSteps } from "./machine";
import {
  defaultPendingSellStore,
  rememberLastSellDeposit,
  type KeyValueStorage,
  type PendingSellBaseline,
  type PendingSellRecord,
  type PendingSellStore,
} from "./persistence";
import { intentAmountRangeFor } from "./singleOrder";
import { getSellSdkClient, prepareSpreadSell, type SellSdkClient } from "./spread";

export type SellCashClient = Pick<
  CashClient,
  "prepare" | "finalizePreparedCashout" | "prepareAccessPolicy" | "orders" | "order"
>;

export type SellPublicClient = Pick<
  PublicClient,
  "readContract" | "getBalance" | "getTransactionReceipt" | "getTransactionCount" | "getCode"
>;

export interface SellDeps {
  client: SellCashClient;
  sender: TxSender;
  /**
   * Enables fresh balance and gas checks, the pre-send baseline, receipt and
   * policy lookups and nonce checks during recovery. Without it recovery can
   * only wait for the indexer or ABANDON_AFTER_MS.
   */
  publicClient?: SellPublicClient | null;
  pending?: PendingSellStore;
  /** Storage for the "last deposit" pointer (defaults to localStorage). */
  storage?: KeyValueStorage;
  now?: () => number;
  /** The SDK client a non-zero spread is built with (defaults to `getSellSdkClient()`; tests and the fork). */
  sdk?: Pick<SellSdkClient, "chainId" | "runtimeEnv" | "registerPayeeDetails" | "prepareCreateDeposit">;
}

export interface SubmitSellInput {
  /** USDC base units. */
  amount: bigint;
  legs: ResolvedLeg[];
  /** The seller's spread on the oracle rate, basis points; 0 or absent is Peer Cash's own market-rate path. */
  spreadBps?: number;
}

export type StepsListener = (steps: SubmitSteps) => void;

/**
 * With no unconfirmed transaction on record, an attempt may be abandoned after
 * this long with no deposit indexed, provided the wallet's USDC has not fallen
 * by the order amount since sending.
 */
export const DISCARD_AFTER_MS = 10 * 60_000;
/** A plain EOA whose mined nonce has not moved since sending may be abandoned after this long. */
export const EOA_DISCARD_AFTER_MS = 60_000;
/**
 * Last resort: after a day with no deposit indexed, even an attempt whose
 * transaction never confirmed is treated as dropped, so a lost transaction
 * cannot block the wallet forever.
 */
export const ABANDON_AFTER_MS = 24 * 60 * 60_000;
/** Slack between our clock and the indexer's `updatedAt` when matching a recovered deposit. */
const RECOVERY_CLOCK_SLACK_SECONDS = 300;

const inFlight = new Set<string>();

/** ERC-4337 EntryPoint event (same shape in v0.6 and v0.7). */
const USER_OPERATION_EVENT = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

/**
 * The Peer Pay policy call `prepareAccessPolicy` encodes, and the reads that
 * show whether it already took effect. `configureDeposit` is idempotent for a
 * group that is already allowed, so a re-send is safe on-chain but costs a
 * wallet prompt and gas; reading first avoids it.
 */
const WHITELIST_POLICY_ABI = parseAbi([
  "function configureDeposit(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bool _enabled, bytes32[] _groupIds, address[] _takers)",
  "function enabled(address, uint256, bytes32) view returns (bool)",
  "function getAllowedGroups(address _escrow, uint256 _depositId, bytes32 _paymentMethod) view returns (bytes32[])",
]);

/**
 * A smart wallet's user operation can revert inside a bundle transaction that
 * itself succeeds. approve + createDeposit run in one user operation, so a
 * failed UserOperationEvent for this wallet proves no deposit was created.
 */
export function userOperationReverted(receipt: { logs: readonly Log[] }, owner: string): boolean {
  try {
    const events = parseEventLogs({ abi: USER_OPERATION_EVENT, eventName: "UserOperationEvent", logs: [...receipt.logs] });
    const mine = events.filter((e) => e.args.sender.toLowerCase() === owner.toLowerCase());
    return mine.length > 0 && mine.every((e) => !e.args.success);
  } catch {
    return false;
  }
}

/** Writes after the deposit exists are best effort: the earlier "sending" record still blocks a duplicate. */
function writeQuietly(store: PendingSellStore, record: PendingSellRecord): void {
  try {
    store.write(record);
  } catch {
    // Recovery falls back to the stored "sending" record and the wallet's indexed orders.
  }
}

export function toWalletCall(tx: PreparedTransaction): WalletCall {
  return { to: tx.to, data: tx.data, value: tx.value };
}

function ownerKey(sender: Pick<TxSender, "address">): string {
  return sender.address.toLowerCase();
}

/** The deposit batch must end with createDeposit so the receipt `sendCalls` returns is the deposit's. */
function assertPlan(plan: PrepareResult): void {
  const last = plan.steps.at(-1);
  const valid =
    plan.txs.length > 0 &&
    plan.txs.length === plan.steps.length &&
    last?.kind === "createDeposit" &&
    plan.steps.filter((s) => s.kind === "createDeposit").length === 1 &&
    plan.txs.every((tx) => tx.chainId === CHAIN_ID);
  if (!valid) throw sellError("INVALID_PLAN");
}

async function preflight(deps: SellDeps, amount: bigint): Promise<void> {
  if (amount <= 0n) throw sellError("INVALID_AMOUNT");
  const { publicClient, sender } = deps;
  if (!publicClient) return;
  const balance = await readUsdcBalance(publicClient, sender.address).catch(() => null);
  if (balance !== null && balance < amount) throw sellError("INSUFFICIENT_BALANCE");
  if (!sender.sponsored) {
    const gas = await readGasBalance(publicClient, sender.address).catch(() => null);
    if (gas === 0n) throw sellError("NO_GAS");
  }
}

/** Existing deposit ids, so recovery can tell the new deposit apart. Best effort. */
async function snapshotDepositIds(client: SellCashClient, owner: Address): Promise<string[] | null> {
  try {
    const orders = await client.orders(owner, { limit: 100 });
    return orders.map((o) => o.depositId);
  } catch {
    return null;
  }
}

function hasCode(code: Hex | undefined): boolean {
  return Boolean(code && code !== "0x");
}

/** The wallet's nonce, code and USDC just before sending. Null when any read fails. */
async function readBaseline(deps: SellDeps): Promise<PendingSellBaseline | null> {
  const { publicClient, sender } = deps;
  if (!publicClient) return null;
  try {
    const [nonce, code, usdc] = await Promise.all([
      publicClient.getTransactionCount({ address: sender.address, blockTag: "latest" }),
      publicClient.getCode({ address: sender.address }),
      readUsdcBalance(publicClient, sender.address),
    ]);
    return { nonce, isContract: hasCode(code), usdcBalance: usdc.toString() };
  } catch {
    return null;
  }
}

/** The indexed order, or null while it is not indexed yet or the indexer is down. */
async function readOrder(client: SellCashClient, depositId: string): Promise<CashOrder | null> {
  try {
    return (await client.order(depositId)) ?? null;
  } catch {
    return null;
  }
}

/** True when the chain already shows the policy `tx` would configure; null when it cannot tell. */
async function policyConfigured(publicClient: SellPublicClient, tx: PreparedTransaction): Promise<boolean | null> {
  try {
    const call = decodeFunctionData({ abi: WHITELIST_POLICY_ABI, data: tx.data });
    if (call.functionName !== "configureDeposit") return null;
    const [escrow, depositId, paymentMethod, , groupIds] = call.args;
    const [enabled, allowed] = await Promise.all([
      publicClient.readContract({
        address: tx.to,
        abi: WHITELIST_POLICY_ABI,
        functionName: "enabled",
        args: [escrow, depositId, paymentMethod],
      }),
      publicClient.readContract({
        address: tx.to,
        abi: WHITELIST_POLICY_ABI,
        functionName: "getAllowedGroups",
        args: [escrow, depositId, paymentMethod],
      }),
    ]);
    const have = new Set(allowed.map((group) => group.toLowerCase()));
    return enabled === true && groupIds.every((group) => have.has(group.toLowerCase()));
  } catch {
    return null;
  }
}

function withoutKey(map: Record<string, Hex> | undefined, key: string): Record<string, Hex> {
  const { [key]: _removed, ...rest } = map ?? {};
  return rest;
}

/**
 * Marks remaining policies that already took effect so they are never sent
 * again: a submitted policy transaction that has since confirmed, or a policy
 * the chain shows configured. A submitted one that reverted is forgotten so
 * it is sent again; one still unconfirmed is kept and re-checked next time.
 */
async function settlePolicies(deps: SellDeps, record: PendingSellRecord): Promise<PendingSellRecord> {
  const { publicClient } = deps;
  const depositId = record.depositId;
  if (!publicClient || !depositId) return record;
  let next = record;
  for (const method of remainingPolicies(record)) {
    const submitted = next.pendingPolicyTxHashes?.[method];
    if (submitted) {
      let receipt: TransactionReceipt | null = null;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: submitted });
      } catch {
        // Not mined yet, or unreadable: fall through to reading the policy itself.
      }
      if (receipt) {
        const pendingPolicyTxHashes = withoutKey(next.pendingPolicyTxHashes, method);
        if (receipt.status === "success" && !userOperationReverted(receipt, record.owner)) {
          next = { ...next, pendingPolicyTxHashes, policyTxHashes: { ...next.policyTxHashes, [method]: submitted } };
          continue;
        }
        next = { ...next, pendingPolicyTxHashes };
      }
    }
    let tx: PreparedTransaction;
    try {
      tx = deps.client.prepareAccessPolicy(depositId, method);
    } catch {
      continue;
    }
    if ((await policyConfigured(publicClient, tx)) === true) {
      next = {
        ...next,
        pendingPolicyTxHashes: withoutKey(next.pendingPolicyTxHashes, method),
        policyVerified: [...(next.policyVerified ?? []), method],
      };
    }
  }
  return next;
}

function listedFrom(record: PendingSellRecord): ListedSell {
  return {
    depositId: record.depositId ?? "",
    amount: BigInt(record.amount),
    legs: record.legs.map((leg) => ({ platform: leg.platform, currencies: leg.currencies as ListedSell["legs"][number]["currencies"] })),
    ...(record.spreadBps ? { spreadBps: record.spreadBps } : {}),
    txHashes: {
      createDeposit: record.createTxHash ?? null,
      accessPolicy: record.accessPolicyPaymentMethods
        .map((m) => record.policyTxHashes[m])
        .filter((h): h is Hex => typeof h === "string"),
    },
  };
}

function remainingPolicies(record: PendingSellRecord): Hex[] {
  const verified = new Set((record.policyVerified ?? []).map((m) => m.toLowerCase()));
  return record.accessPolicyPaymentMethods.filter((m) => !record.policyTxHashes[m] && !verified.has(m.toLowerCase()));
}

function stepsForRecord(record: PendingSellRecord): SubmitSteps {
  const deposited = record.stage === "deposited";
  return {
    approve: deposited ? "done" : "failed",
    createDeposit: deposited ? "done" : "failed",
    accessPolicy:
      record.accessPolicyPaymentMethods.length === 0 ? "skipped" : remainingPolicies(record).length ? "failed" : "done",
  };
}

class StepTracker {
  steps: SubmitSteps;
  constructor(
    private readonly listener: StepsListener,
    initial: SubmitSteps = initialSteps(),
  ) {
    this.steps = initial;
  }
  set(patch: Partial<SubmitSteps>): void {
    this.steps = { ...this.steps, ...patch };
    this.listener(this.steps);
  }
  failActive(): void {
    const patch: Partial<SubmitSteps> = {};
    for (const [id, status] of Object.entries(this.steps) as [keyof SubmitSteps, SubmitSteps[keyof SubmitSteps]][]) {
      if (status === "active") patch[id] = "failed";
    }
    this.set(patch);
  }
}

/** Maps a failed policy send, keeping any hash the wallet reported so the next try inspects it first. */
function policyFailure(err: unknown, depositId: string, paymentMethod: Hex): SellFlowError {
  if (isCashError(err)) {
    const mapped = toSellFlowError(err, { stage: "policy", depositId, paymentMethod });
    if (mapped.code === "ACCESS_POLICY_CONFIGURATION_FAILED") return mapped;
  }
  const failure = classifySendFailure(err);
  const hash = failure.kind === "unknown" || failure.kind === "reverted" ? failure.hash : null;
  return sellError("ACCESS_POLICY_CONFIGURATION_FAILED", {
    depositId,
    paymentMethod,
    cause: err,
    ...(hash ? { transactionHash: hash } : {}),
    ...(failure.kind === "unknown" && hash
      ? { message: "Your order is live, but its buyer restriction hasn't confirmed yet." }
      : {}),
  });
}

/**
 * Attaches every remaining Peer Pay policy, one call per payment method so each
 * confirmation is recorded on its own. A failure leaves the record in place
 * for `retryAccessPolicy`; the deposit itself is never recreated. A policy the
 * wallet submitted without a confirmation is remembered, so the retry checks
 * that transaction before sending another.
 */
async function completeAccessPolicies(
  deps: SellDeps,
  store: PendingSellStore,
  initial: PendingSellRecord,
  tracker: StepTracker,
): Promise<ListedSell> {
  let record = initial;
  const depositId = record.depositId;
  if (!depositId) throw sellError("SUBMISSION_UNKNOWN");
  const remaining = remainingPolicies(record);
  if (remaining.length) tracker.set({ accessPolicy: "active" });
  for (const paymentMethod of remaining) {
    let receipt: TransactionReceipt;
    try {
      const tx = deps.client.prepareAccessPolicy(depositId, paymentMethod);
      receipt = await deps.sender.sendCalls([toWalletCall(tx)], { label: "Restrict buyers to Peer Pay" });
    } catch (err) {
      tracker.failActive();
      const failure = classifySendFailure(err);
      if (failure.kind === "unknown" && failure.hash) {
        record = { ...record, pendingPolicyTxHashes: { ...record.pendingPolicyTxHashes, [paymentMethod]: failure.hash } };
        writeQuietly(store, record);
      }
      throw policyFailure(err, depositId, paymentMethod);
    }
    if (receipt.status !== "success") {
      tracker.failActive();
      throw sellError("ACCESS_POLICY_CONFIGURATION_FAILED", {
        depositId,
        paymentMethod,
        transactionHash: receipt.transactionHash,
      });
    }
    record = {
      ...record,
      policyTxHashes: { ...record.policyTxHashes, [paymentMethod]: receipt.transactionHash },
      pendingPolicyTxHashes: withoutKey(record.pendingPolicyTxHashes, paymentMethod),
    };
    writeQuietly(store, record);
  }
  tracker.set({ accessPolicy: record.accessPolicyPaymentMethods.length ? "done" : "skipped" });
  store.clear(record.owner);
  return listedFrom(record);
}

/**
 * Lists a new sell order. `onSteps` receives per-step status as it changes.
 * Throws SellFlowError; its `recovery.action` says what is safe next.
 */
export async function submitSell(deps: SellDeps, input: SubmitSellInput, onSteps: StepsListener = () => undefined): Promise<ListedSell> {
  const { client, sender } = deps;
  const store = deps.pending ?? defaultPendingSellStore();
  const now = deps.now ?? Date.now;
  const owner = ownerKey(sender);
  const tracker = new StepTracker(onSteps);

  if (inFlight.has(owner) || store.read(owner)) throw sellError("PENDING_SUBMISSION_EXISTS");
  inFlight.add(owner);
  try {
    await preflight(deps, input.amount);

    let plan: PrepareResult;
    try {
      // Alipay fills in one order (Peer's single-order rule); every other order keeps Peer Cash's default range.
      const range = intentAmountRangeFor(input.amount, input.legs.map((leg) => leg.platform));
      const spreadBps = input.spreadBps ?? 0;
      plan =
        spreadBps === 0
          ? await client.prepare({ amount: input.amount, receive: toReceive(input.legs), ...(range ? { intentAmountRange: range } : {}) })
          : await prepareSpreadSell(deps.sdk ?? getSellSdkClient(), {
              amount: input.amount,
              legs: input.legs,
              spreadBps,
              ...(range ? { intentAmountRange: range } : {}),
            });
    } catch (err) {
      throw toSellFlowError(err, { stage: "prepare" });
    }
    assertPlan(plan);
    tracker.set({ accessPolicy: plan.accessPolicyPaymentMethods.length ? "pending" : "skipped" });

    // Both are read before anything is sent: recovery compares the chain against them.
    const [knownDepositIds, baseline] = await Promise.all([snapshotDepositIds(client, sender.address), readBaseline(deps)]);
    const sending: PendingSellRecord = {
      v: 1,
      owner,
      stage: "sending",
      startedAt: now(),
      amount: input.amount.toString(),
      legs: input.legs.map((leg) => ({ platform: leg.platform, currencies: [...leg.currencies] })),
      ...(input.spreadBps ? { spreadBps: input.spreadBps } : {}),
      knownDepositIds,
      baseline,
      accessPolicyPaymentMethods: [...plan.accessPolicyPaymentMethods],
      policyTxHashes: {},
    };
    try {
      store.write(sending);
    } catch (err) {
      // Without a recovery record a refresh mid-send could not be reconciled, so do not send.
      throw sellError("UNKNOWN", { cause: err, message: "Your browser blocked saving order progress, so nothing was sent." });
    }

    tracker.set({ approve: "active", createDeposit: "active" });
    let receipt: TransactionReceipt;
    try {
      receipt = await sender.sendCalls(plan.txs.map(toWalletCall), { label: "Create sell order" });
    } catch (err) {
      tracker.failActive();
      const failure = classifySendFailure(err);
      if (failure.kind === "unknown") {
        // Keep the attempt; a reported hash lets recovery read its receipt directly.
        if (failure.hash) writeQuietly(store, { ...sending, createTxHash: failure.hash });
      } else {
        // Rejected, never sent, or reverted: no deposit exists, so the wallet may sell again.
        store.clear(owner);
      }
      throw toSellFlowError(err, { stage: "send" });
    }

    let depositId: string;
    try {
      depositId = client.finalizePreparedCashout({
        transactionHash: receipt.transactionHash,
        status: receipt.status,
        logs: receipt.logs,
      }).depositId;
    } catch (err) {
      tracker.failActive();
      if (isCashError(err) && err.code === "TRANSACTION_FAILED") {
        // The batch reverted: no deposit exists and the approval alone moves no funds.
        store.clear(owner);
        throw toSellFlowError(err, { stage: "send", transactionHash: receipt.transactionHash });
      }
      if (userOperationReverted(receipt, owner)) {
        store.clear(owner);
        throw sellError("TRANSACTION_FAILED", { stage: "send", transactionHash: receipt.transactionHash, cause: err });
      }
      writeQuietly(store, { ...sending, createTxHash: receipt.transactionHash });
      throw toSellFlowError(err, { stage: "finalize", transactionHash: receipt.transactionHash });
    }

    tracker.set({ approve: "done", createDeposit: "done" });
    const deposited: PendingSellRecord = {
      ...sending,
      stage: "deposited",
      depositId,
      createTxHash: receipt.transactionHash,
    };
    writeQuietly(store, deposited);
    rememberLastSellDeposit(owner, { depositId, txHash: receipt.transactionHash, at: now() }, deps.storage);
    return await completeAccessPolicies(deps, store, deposited, tracker);
  } finally {
    inFlight.delete(owner);
  }
}

export interface AccessPolicyFallback {
  depositId: string;
  /** Payment-method hashes still to configure. */
  paymentMethods: Hex[];
  amount: bigint;
  legs: ListedSell["legs"];
}

/**
 * Finishes the remaining access policies of a confirmed deposit from its
 * pending record. `fallback` (from the error that reported the failure) is
 * used only when the record is gone, e.g. storage was cleared.
 *
 * Checks the chain first: a policy whose earlier transaction confirmed, or
 * that the chain already shows configured, is not sent again. If the order
 * has closed (filled or withdrawn) there is nothing left to restrict: the
 * record is cleared and ORDER_NOT_ACTIVE (recovery "none") is thrown, after
 * which the wallet can sell again.
 */
export async function retryAccessPolicy(
  deps: SellDeps,
  onSteps: StepsListener = () => undefined,
  fallback?: AccessPolicyFallback,
): Promise<ListedSell> {
  const store = deps.pending ?? defaultPendingSellStore();
  const owner = ownerKey(deps.sender);
  let record = store.read(owner);
  if ((!record || !record.depositId) && fallback) {
    record = {
      v: 1,
      owner,
      stage: "deposited",
      startedAt: (deps.now ?? Date.now)(),
      amount: fallback.amount.toString(),
      legs: fallback.legs.map((leg) => ({ platform: leg.platform, currencies: [...leg.currencies] })),
      knownDepositIds: null,
      accessPolicyPaymentMethods: [...fallback.paymentMethods],
      policyTxHashes: {},
      depositId: fallback.depositId,
    };
  }
  if (!record || record.stage !== "deposited" || !record.depositId) throw sellError("PENDING_SUBMISSION_EXISTS");
  if (inFlight.has(owner)) throw sellError("PENDING_SUBMISSION_EXISTS");
  const depositId = record.depositId;
  inFlight.add(owner);
  try {
    const order = await readOrder(deps.client, depositId);
    if (order && !order.isInFlight) {
      store.clear(owner);
      throw sellError("ORDER_NOT_ACTIVE", {
        depositId,
        message: "This order has already closed, so it no longer needs a buyer restriction.",
      });
    }
    const settled = await settlePolicies(deps, record);
    if (settled !== record) writeQuietly(store, settled);
    return await completeAccessPolicies(deps, store, settled, new StepTracker(onSteps, stepsForRecord(settled)));
  } finally {
    inFlight.delete(owner);
  }
}

/** True while this tab is submitting or finishing a deposit for the wallet. */
export function isSellInFlight(owner: string): boolean {
  return inFlight.has(owner.toLowerCase());
}

export type ReconcileResult =
  | { status: "none" }
  /** This tab is still submitting for the wallet; nothing was checked or changed. */
  | { status: "inFlight" }
  | { status: "listed"; listed: ListedSell }
  | { status: "needsAccessPolicy"; depositId: string; remaining: Hex[]; record: PendingSellRecord; steps: SubmitSteps }
  /**
   * The deposit exists but closed (filled or withdrawn) before its buyer
   * restriction was attached, so nothing is left to restrict. The pending
   * record was cleared and the wallet can sell again.
   */
  | { status: "closed"; depositId: string; state: CashOrderState }
  | {
      status: "notFound";
      record: PendingSellRecord;
      ageMs: number;
      /** True once abandoning the attempt cannot race a late deposit (see `discardPendingSell`). */
      canDiscard: boolean;
      /** The deposit transaction the wallet reported that the chain has not confirmed, if any. */
      unconfirmedTxHash: Hex | null;
      steps: SubmitSteps;
    }
  | { status: "unavailable"; record: PendingSellRecord; error: SellFlowError; steps: SubmitSteps };

/**
 * Records the deposit and resolves what is left of it. Before asking for a
 * policy it checks that the order is still open and whether the policy
 * already took effect, so neither a closed order nor a policy confirmed
 * elsewhere can keep the wallet blocked.
 */
async function settleDeposit(
  deps: SellDeps,
  store: PendingSellStore,
  record: PendingSellRecord,
  depositId: string,
  createTxHash: Hex | undefined,
  indexed?: CashOrder,
): Promise<ReconcileResult> {
  let deposited: PendingSellRecord = {
    ...record,
    stage: "deposited",
    depositId,
    ...(createTxHash ? { createTxHash } : {}),
  };
  if (remainingPolicies(deposited).length > 0) {
    const order = indexed ?? (await readOrder(deps.client, depositId));
    if (order && !order.isInFlight) {
      store.clear(record.owner);
      return { status: "closed", depositId, state: order.state };
    }
    deposited = await settlePolicies(deps, deposited);
  }
  const remaining = remainingPolicies(deposited);
  if (remaining.length === 0) {
    store.clear(record.owner);
    return { status: "listed", listed: listedFrom(deposited) };
  }
  writeQuietly(store, deposited);
  return { status: "needsAccessPolicy", depositId, remaining, record: deposited, steps: stepsForRecord(deposited) };
}

/** The newest indexed deposit that can only be this attempt's. */
function findRecoveredOrder(record: PendingSellRecord, orders: readonly CashOrder[]): CashOrder | null {
  const amount = BigInt(record.amount);
  const known = record.knownDepositIds ? new Set(record.knownDepositIds) : null;
  const since = Math.floor(record.startedAt / 1000) - RECOVERY_CLOCK_SLACK_SECONDS;
  const candidates = orders.filter((o) => {
    if (o.totalAmount !== amount) return false;
    if (known) return !known.has(o.depositId);
    // Without a snapshot only an untouched, recently updated deposit qualifies.
    return o.filledAmount === 0n && o.returnedAmount === 0n && (o.updatedAt ?? 0) >= since;
  });
  candidates.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return candidates[0] ?? null;
}

/** What the stored deposit transaction hash proves. */
type CreateTxEvidence =
  /** No hash on record. */
  | "none"
  /** Mined without creating a deposit (e.g. the wallet reported the approval's hash). */
  | "noDeposit"
  /** Reported by the wallet but not seen mined (or the receipt could not be read): it may still land. */
  | "unconfirmed";

/**
 * True when a plain EOA has had no transaction mined since sending: its
 * mined nonce is still the baseline. The batch is approve then createDeposit,
 * sent one at a time with each confirmed before the next, so createDeposit
 * was never sent. Contract wallets (smart accounts, Safes, EIP-7702
 * delegations, now or at sending) are excluded: their operations do not move
 * the account's own nonce.
 */
async function eoaSentNothing(deps: SellDeps, record: PendingSellRecord): Promise<boolean> {
  const { publicClient, sender } = deps;
  const baseline = record.baseline;
  if (!publicClient || !baseline || baseline.isContract || sender.kind === "smart") return false;
  try {
    const [latest, pending, code] = await Promise.all([
      publicClient.getTransactionCount({ address: sender.address, blockTag: "latest" }),
      publicClient.getTransactionCount({ address: sender.address, blockTag: "pending" }),
      publicClient.getCode({ address: sender.address }),
    ]);
    return !hasCode(code) && latest === baseline.nonce && pending === latest;
  } catch {
    return false;
  }
}

/** False once the wallet's USDC has fallen by the order amount since sending, as a landed deposit would make it. */
async function usdcUntouched(deps: SellDeps, record: PendingSellRecord): Promise<boolean> {
  const before = record.baseline?.usdcBalance;
  if (before === undefined || !deps.publicClient) return false;
  try {
    const balance = await readUsdcBalance(deps.publicClient, deps.sender.address);
    return balance > BigInt(before) - BigInt(record.amount);
  } catch {
    return false;
  }
}

/**
 * Whether an attempt with no deposit on the index can be abandoned without
 * racing a late one:
 * 1. After EOA_DISCARD_AFTER_MS, when `eoaSentNothing` proves createDeposit was never sent.
 * 2. After DISCARD_AFTER_MS with no unconfirmed transaction, while the USDC
 *    balance shows no deposit landed that the index has not caught up with.
 * 3. After ABANDON_AFTER_MS with nothing indexed, whatever else is known.
 * Without a pre-send baseline only rule 3 applies.
 */
async function safeToAbandon(
  deps: SellDeps,
  record: PendingSellRecord,
  createTx: CreateTxEvidence,
  ageMs: number,
): Promise<boolean> {
  if (ageMs >= ABANDON_AFTER_MS) return true;
  if (createTx === "unconfirmed") return false;
  if (ageMs >= EOA_DISCARD_AFTER_MS && (await eoaSentNothing(deps, record))) return true;
  return ageMs >= DISCARD_AFTER_MS && (await usdcUntouched(deps, record));
}

/**
 * Checks an interrupted submission against the chain. Never sends anything.
 * Order of evidence: the stored deposit id, the stored createDeposit receipt,
 * then the wallet's indexed orders created after the attempt started.
 */
export async function reconcilePendingSell(deps: SellDeps): Promise<ReconcileResult> {
  const store = deps.pending ?? defaultPendingSellStore();
  const now = deps.now ?? Date.now;
  const owner = ownerKey(deps.sender);
  if (inFlight.has(owner)) return { status: "inFlight" };
  const record = store.read(owner);
  if (!record) return { status: "none" };
  if (record.depositId) return settleDeposit(deps, store, record, record.depositId, record.createTxHash);

  let createTx: CreateTxEvidence = "none";
  if (record.createTxHash) {
    createTx = "unconfirmed";
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = deps.publicClient ? await deps.publicClient.getTransactionReceipt({ hash: record.createTxHash }) : null;
    } catch {
      // Not mined yet, or the node could not answer: the transaction may still land.
    }
    if (receipt) {
      if (receipt.status === "reverted" || userOperationReverted(receipt, owner)) {
        store.clear(owner);
        return { status: "none" };
      }
      try {
        const resolved = deps.client.finalizePreparedCashout({
          transactionHash: receipt.transactionHash,
          status: receipt.status,
          logs: receipt.logs,
        });
        return settleDeposit(deps, store, record, resolved.depositId, receipt.transactionHash);
      } catch {
        // No deposit event in a mined transaction: it created none. Decide from the index.
        createTx = "noDeposit";
      }
    }
  }

  let orders: CashOrder[];
  try {
    orders = await deps.client.orders(deps.sender.address, { limit: 100 });
  } catch (err) {
    return { status: "unavailable", record, error: toSellFlowError(err, { stage: "read" }), steps: stepsForRecord(record) };
  }
  const found = findRecoveredOrder(record, orders);
  if (found) return settleDeposit(deps, store, record, found.depositId, record.createTxHash, found);

  const ageMs = Math.max(0, now() - record.startedAt);
  return {
    status: "notFound",
    record,
    ageMs,
    canDiscard: await safeToAbandon(deps, record, createTx, ageMs),
    unconfirmedTxHash: createTx === "unconfirmed" ? (record.createTxHash ?? null) : null,
    steps: stepsForRecord(record),
  };
}

/**
 * Abandons an interrupted attempt the chain shows never landed, so the wallet
 * can sell again. Re-reconciles first and refuses unless discarding is safe.
 */
export async function discardPendingSell(deps: SellDeps): Promise<ReconcileResult> {
  const result = await reconcilePendingSell(deps);
  if (result.status === "notFound" && result.canDiscard) {
    (deps.pending ?? defaultPendingSellStore()).clear(ownerKey(deps.sender));
    return { status: "none" };
  }
  return result;
}

/** The SellFlowError that describes a reconcile result the player must act on, if any. */
export function reconcileError(result: ReconcileResult): SellFlowError | null {
  switch (result.status) {
    case "needsAccessPolicy":
      return sellError("ACCESS_POLICY_CONFIGURATION_FAILED", { depositId: result.depositId, paymentMethod: result.remaining[0] });
    case "notFound": {
      const unconfirmed = result.canDiscard ? null : result.unconfirmedTxHash;
      const base = sellError("SUBMISSION_UNKNOWN", {
        message: result.canDiscard
          ? "Your last deposit attempt never showed up on-chain."
          : unconfirmed
            ? "Your last deposit was sent but hasn't confirmed yet."
            : "Your last deposit from this wallet hasn't shown up on-chain yet.",
        ...(unconfirmed ? { transactionHash: unconfirmed } : {}),
      });
      return new SellFlowError({
        code: base.code,
        message: base.message,
        transactionHash: base.transactionHash,
        recovery: {
          ...base.recovery,
          canDiscard: result.canDiscard,
          hint: result.canDiscard
            ? "No deposit was found for it. If your wallet still shows a request from that attempt, reject it, then start a new order."
            : unconfirmed
              ? "Wait for it to confirm or fail in your wallet. Don't deposit again yet."
              : "If your wallet shows the deposit as sent, wait for it to confirm. Don't deposit again yet.",
        },
      });
    }
    case "unavailable":
      return sellError("PENDING_SUBMISSION_EXISTS", { cause: result.error });
    default:
      return null;
  }
}
