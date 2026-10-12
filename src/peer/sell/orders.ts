/**
 * The player's existing sell orders: list rows, the one unwind verb
 * (withdraw, partial or full), top-ups, and a live watch of one order. Every
 * mutation goes through the unsigned prepare path and the wallet's sendCalls.
 */

import {
  isCashError,
  type CashClient,
  type CashFill,
  type CashOrder,
  type CashOrderState,
  type CashPayoutInfo,
  type CashPreparedStep,
} from "@zkp2p/cash";
import type { Hex } from "viem";
import type { TxSender } from "@/wallet/types";
import { readUsdcBalance, type BalanceReader } from "./balance";
import { sellError, toSellFlowError } from "./errors";
import { toWalletCall } from "./submit";

export interface SellOrderRow {
  depositId: string;
  state: CashOrderState;
  /** Everything the order has ever held, USDC base units. Does not shrink on withdrawals. */
  totalAmount: bigint;
  /** Delivered to buyers. */
  filledAmount: bigint;
  /** Locked by buyers who signalled and have not yet been proven. */
  pendingAmount: bigint;
  /** Returned to the seller. */
  returnedAmount: bigint;
  /** Unlocked balance still for sale (withdrawable now). */
  availableAmount: bigint;
  /** filled / total, 0..1, for a progress bar. */
  progress: number;
  /** One honest sentence about the order from live data. */
  explanation: string;
  canWithdraw: boolean;
  canTopUp: boolean;
  isInFlight: boolean;
  /** Payout legs; present on single-order reads, absent on list rows. */
  payouts: CashPayoutInfo[] | null;
  fills: CashFill[];
  /** Unix seconds of the last on-chain change. */
  updatedAt: number | null;
  /** The newest buyer still holding part of the order, for "who matched me?". */
  activeBuyer: string | null;
  order: CashOrder;
}

const LIVE_STATES: ReadonlySet<CashOrderState> = new Set(["awaiting-buyer", "matched", "delivering"]);

export function toSellOrderRow(order: CashOrder): SellOrderRow {
  const consumed = order.filledAmount + order.pendingAmount + order.returnedAmount;
  const availableAmount = order.totalAmount > consumed ? order.totalAmount - consumed : 0n;
  const progress =
    order.totalAmount > 0n ? Number((order.filledAmount * 10_000n) / order.totalAmount) / 10_000 : 0;
  const signalled = order.fills.filter((f) => f.status === "SIGNALED");
  const activeBuyer = signalled.sort((a, b) => (b.signaledAt ?? 0) - (a.signaledAt ?? 0))[0]?.buyer ?? null;
  return {
    depositId: order.depositId,
    state: order.state,
    totalAmount: order.totalAmount,
    filledAmount: order.filledAmount,
    pendingAmount: order.pendingAmount,
    returnedAmount: order.returnedAmount,
    availableAmount,
    progress,
    explanation: order.explain(),
    canWithdraw: order.nextActions.includes("withdraw"),
    canTopUp: !order.withdrawn && LIVE_STATES.has(order.state),
    isInFlight: order.isInFlight,
    payouts: order.payouts ?? null,
    fills: order.fills,
    updatedAt: order.updatedAt ?? null,
    activeBuyer,
    order,
  };
}

/** Orders for a wallet, live ones first, then newest first. */
export async function fetchSellOrders(client: Pick<CashClient, "orders">, owner: string): Promise<SellOrderRow[]> {
  let orders: CashOrder[];
  try {
    orders = await client.orders(owner);
  } catch (err) {
    throw toSellFlowError(err, { stage: "read" });
  }
  return orders.map(toSellOrderRow).sort((a, b) => {
    if (a.isInFlight !== b.isInFlight) return a.isInFlight ? -1 : 1;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
}

export async function fetchSellOrder(client: Pick<CashClient, "order">, depositId: string): Promise<SellOrderRow> {
  try {
    return toSellOrderRow(await client.order(depositId));
  } catch (err) {
    throw toSellFlowError(err, { stage: "read", depositId });
  }
}

export interface SellOrderTxResult {
  depositId: string;
  /** Hash of the transaction containing the final call. */
  txHash: Hex;
  /** What was sent, in order (e.g. pruneExpiredIntents, withdrawDeposit). */
  steps: CashPreparedStep[];
}

export interface SellOrderDeps {
  client: Pick<CashClient, "prepareWithdraw" | "prepareTopUp">;
  sender: TxSender;
  /** Enables a fresh balance check before a top-up. */
  publicClient?: BalanceReader | null;
}

async function sendPlan(
  deps: SellOrderDeps,
  depositId: string,
  plan: { txs: Parameters<typeof toWalletCall>[0][]; steps: CashPreparedStep[] },
  stage: "withdraw" | "topUp",
  label: string,
): Promise<SellOrderTxResult> {
  let receipt;
  try {
    receipt = await deps.sender.sendCalls(plan.txs.map(toWalletCall), { label });
  } catch (err) {
    throw toSellFlowError(err, { stage, depositId });
  }
  if (receipt.status !== "success") {
    throw sellError("TRANSACTION_FAILED", { stage, depositId, transactionHash: receipt.transactionHash });
  }
  return { depositId, txHash: receipt.transactionHash, steps: plan.steps };
}

/**
 * The one unwind verb. With `amount`, withdraws that much of the unlocked
 * balance (a live buyer is not disturbed); without, closes the order and
 * returns everything left, pruning expired buyer intents first if needed.
 */
export async function withdrawSellOrder(deps: SellOrderDeps, depositId: string, amount?: bigint): Promise<SellOrderTxResult> {
  if (amount !== undefined && amount <= 0n) throw sellError("INVALID_AMOUNT", { stage: "withdraw", depositId });
  let plan;
  try {
    plan = await deps.client.prepareWithdraw(depositId, amount === undefined ? {} : { amount });
  } catch (err) {
    throw toSellFlowError(err, { stage: "read", depositId });
  }
  return sendPlan(deps, depositId, plan, "withdraw", amount === undefined ? "Withdraw sell order" : "Withdraw part of sell order");
}

/** Adds USDC to a live order: same payout handle, same market pricing. */
export async function topUpSellOrder(deps: SellOrderDeps, depositId: string, amount: bigint): Promise<SellOrderTxResult> {
  if (amount <= 0n) throw sellError("INVALID_AMOUNT", { stage: "topUp", depositId });
  if (deps.publicClient) {
    const balance = await readUsdcBalance(deps.publicClient, deps.sender.address).catch(() => null);
    if (balance !== null && balance < amount) throw sellError("INSUFFICIENT_BALANCE", { stage: "topUp", depositId });
  }
  let plan;
  try {
    plan = await deps.client.prepareTopUp(depositId, amount);
  } catch (err) {
    throw toSellFlowError(err, { stage: "read", depositId });
  }
  return sendPlan(deps, depositId, plan, "topUp", "Top up sell order");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface WatchSellOrderOptions {
  signal?: AbortSignal;
  /** Poll cadence (default 5 s, the protocol's active-intent cadence). */
  pollIntervalMs?: number;
}

/**
 * Live state of one order, yielding on every change until it is delivered or
 * returned (or the signal aborts). Indexer lag right after creation
 * (ORDER_NOT_FOUND), watch timeouts and transient indexer outages are absorbed
 * and the watch resumes; any other error is thrown as a SellFlowError.
 */
export async function* watchSellOrder(
  client: Pick<CashClient, "watch">,
  depositId: string,
  opts: WatchSellOrderOptions = {},
): AsyncGenerator<SellOrderRow, void, void> {
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const { signal } = opts;
  while (!signal?.aborted) {
    try {
      for await (const order of client.watch(depositId, { pollIntervalMs, ...(signal ? { signal } : {}) })) {
        yield toSellOrderRow(order);
        if (!order.isInFlight) return;
      }
      return;
    } catch (err) {
      if (signal?.aborted) return;
      if (isCashError(err) && err.retryable) {
        await sleep(pollIntervalMs, signal);
        continue;
      }
      throw toSellFlowError(err, { stage: "read", depositId });
    }
  }
}
