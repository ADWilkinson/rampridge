/**
 * Order reads and order changes (withdraw, top-up) for spread deposits.
 *
 * Peer Cash 0.7.2 only treats a deposit as one of its orders when every
 * payout follows an oracle at zero spread (or is an attributed Alipay CNY /
 * UPI INR fixed payout). A RampRidge order with a seller spread (`spread.ts`)
 * fails that test, so `orders()` would hide it and `order()`, `watch()`,
 * `prepareWithdraw()` and `prepareTopUp()` would refuse it with
 * ORDER_NOT_FOUND.
 *
 * `withSpreadOrders` wraps the Peer Cash client so these also read the same
 * indexer rows with the same derivation (`derivePayouts`, `deriveCashOrder`)
 * and build the same unsigned calls (attributed exactly like Peer Cash) for a
 * deposit whose payouts are all oracle priced with a spread. Zero-spread
 * orders keep going through Peer Cash itself; only what it refuses falls back
 * to this path.
 */

import {
  BASE_USDC_ADDRESS,
  CASH_ORDER_STATUSES,
  MIN_CASHOUT_AMOUNT,
  deriveCashOrder,
  derivePayouts,
  errors,
  isCashError,
  isFillLive,
  parseCompositeDepositId,
  type CashClient,
  type CashOrder,
  type CashPayoutInfo,
  type CashPreparedStep,
  type DeriveCashOrderOptions,
  type PreparedTransaction,
} from "@zkp2p/cash";
import {
  appendAttributionToCalldata,
  createCompositeDepositId,
  getPaymentMethodsCatalog,
  isZeroRateManagerId,
  type IndexerDepositWithRelations,
} from "@zkp2p/sdk";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { CHAIN_ID } from "@/config";
import { getSellSdkClient, sellAttributionCodes, type SellSdkClient } from "./spread";
import { SPREAD_MAX_BPS, SPREAD_MIN_BPS } from "./spreadRate";

export type SpreadOrderSdk = Pick<SellSdkClient, "indexer" | "withdrawDeposit" | "removeFunds" | "pruneExpiredIntents" | "addFunds">;
type OrderSdk = SpreadOrderSdk;
type Plan = { txs: PreparedTransaction[]; steps: CashPreparedStep[] };

const ERC20_APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

function catalog() {
  return getPaymentMethodsCatalog(CHAIN_ID, "production");
}

/** Peer Cash's oracle kinds (its toPricing marks only these as market rate). */
const ORACLE_KINDS: ReadonlySet<string> = new Set(["oracle_chainlink", "oracle_pyth"]);

/** The payout follows a live oracle with a spread inside Peer's range for a new deposit (zero included). */
function isOraclePayout(payout: CashPayoutInfo): boolean {
  const { kind, spreadBps } = payout.pricing;
  return (
    typeof kind === "string" &&
    ORACLE_KINDS.has(kind) &&
    typeof spreadBps === "number" &&
    Number.isInteger(spreadBps) &&
    spreadBps >= SPREAD_MIN_BPS &&
    spreadBps <= SPREAD_MAX_BPS
  );
}

/**
 * A seller-spread order: every payout follows an oracle and at least one
 * carries a non-zero spread (all zero is Peer Cash's own order).
 */
export function isSpreadPayoutSet(payouts: readonly CashPayoutInfo[]): boolean {
  return payouts.length > 0 && payouts.every(isOraclePayout) && payouts.some((p) => p.pricing.spreadBps !== 0);
}

/** The order's spread when all its payouts share one (RampRidge sets one per order), else null. */
export function orderSpreadBps(payouts: readonly CashPayoutInfo[] | null | undefined): number | null {
  const values = new Set((payouts ?? []).map((p) => p.pricing.spreadBps));
  if (values.size !== 1) return null;
  const [only] = values;
  return typeof only === "number" && Number.isFinite(only) ? only : null;
}

/** A deposit this app shows and manages as a spread order: USDC, no rate manager, a spread payout set. */
function spreadPayouts(deposit: IndexerDepositWithRelations): CashPayoutInfo[] | null {
  if (deposit.token.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()) return null;
  const manager = (deposit as { rateManagerId?: string | null }).rateManagerId;
  if (manager && !isZeroRateManagerId(manager)) return null;
  const payouts = derivePayouts(deposit.paymentMethods ?? [], deposit.currencies ?? [], catalog());
  return isSpreadPayoutSet(payouts) ? payouts : null;
}

function toBigIntOrUndefined(value: unknown): bigint | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  try {
    return BigInt(typeof value === "number" ? Math.trunc(value) : String(value));
  } catch {
    return undefined;
  }
}

/** Peer Cash's depositOrderOptions (not exported by the package), field for field. */
function depositOrderOptions(deposit: IndexerDepositWithRelations): DeriveCashOrderOptions {
  const d = deposit as unknown as Record<string, unknown>;
  const remaining = toBigIntOrUndefined(d.remainingDeposits);
  const outstanding = toBigIntOrUndefined(d.outstandingIntentAmount);
  const taken = toBigIntOrUndefined(d.totalAmountTaken);
  const withdrawn = toBigIntOrUndefined(d.totalWithdrawn);
  const updatedAt = d.updatedAt != null ? Number(d.updatedAt) : undefined;
  return {
    ...(remaining !== undefined ? { remainingAmount: remaining } : {}),
    ...(outstanding !== undefined ? { outstandingAmount: outstanding } : {}),
    ...(taken !== undefined ? { takenAmount: taken } : {}),
    ...(withdrawn !== undefined ? { withdrawnAmount: withdrawn } : {}),
    ...(d.status != null ? { status: d.status as DeriveCashOrderOptions["status"] } : {}),
    ...(d.totalIntents != null ? { intentCount: d.totalIntents as number } : {}),
    ...(d.successRateBps != null ? { successRateBps: d.successRateBps as number } : {}),
    ...(updatedAt !== undefined && Number.isFinite(updatedAt) ? { updatedAt } : {}),
  };
}

function parseDepositId(depositId: string) {
  try {
    const parsed = parseCompositeDepositId(depositId);
    return {
      ...parsed,
      compositeId: createCompositeDepositId(parsed.escrowAddress, parsed.onchainDepositId),
      escrowArg: parsed.escrowAddress ? { escrowAddress: parsed.escrowAddress as Address } : {},
    };
  } catch (err) {
    throw errors.invalidDepositId(depositId, err);
  }
}

/** The wallet's spread orders, newest first, derived as Peer Cash's `orders()` derives its own. */
export async function readSpreadOrders(
  sdk: Pick<OrderSdk, "indexer">,
  owner: string,
  opts: { inFlight?: boolean; limit?: number } = {},
): Promise<CashOrder[]> {
  const { inFlight = false, limit = 100 } = opts;
  let deposits: IndexerDepositWithRelations[];
  try {
    deposits = await sdk.indexer.getDepositsWithRelations({ depositor: owner }, { limit });
  } catch (err) {
    throw errors.indexerUnavailable("orders", err);
  }
  const derived = deposits
    .flatMap((deposit) => {
      const payouts = spreadPayouts(deposit);
      if (!payouts) return [];
      // List rows carry no intent detail: a positive outstanding amount is treated as a live lock.
      return [deriveCashOrder(deposit.id, [], { ...depositOrderOptions(deposit), payouts, fillsIncluded: false })];
    })
    .filter((o) => o.totalAmount >= MIN_CASHOUT_AMOUNT)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return inFlight ? derived.filter((o) => o.isInFlight) : derived;
}

/** One spread order with its intents, or null when the deposit is missing or not a spread order. */
export async function readSpreadOrder(sdk: Pick<OrderSdk, "indexer">, depositId: string): Promise<CashOrder | null> {
  const { compositeId } = parseDepositId(depositId);
  let deposits: IndexerDepositWithRelations[];
  try {
    deposits = await sdk.indexer.getDepositsByIdsWithRelations([compositeId], {
      includeIntents: true,
      intentStatuses: [...CASH_ORDER_STATUSES],
    });
  } catch (err) {
    throw errors.indexerUnavailable("order", err);
  }
  const deposit = deposits[0];
  if (!deposit) return null;
  const payouts = spreadPayouts(deposit);
  if (!payouts) return null;
  return deriveCashOrder(compositeId, deposit.intents ?? [], { ...depositOrderOptions(deposit), payouts });
}

async function requireOrder(sdk: Pick<OrderSdk, "indexer">, depositId: string): Promise<CashOrder> {
  const order = await readSpreadOrder(sdk, depositId);
  if (!order) throw errors.orderNotFound(parseDepositId(depositId).compositeId);
  return order;
}

function availableAmount(order: CashOrder): bigint {
  return order.totalAmount - order.filledAmount - order.pendingAmount - order.returnedAmount;
}

/** Peer Cash's prepareWithdraw, for a spread order it refuses. */
export async function prepareSpreadWithdraw(sdk: OrderSdk, depositId: string, opts: { amount?: bigint } = {}): Promise<Plan> {
  const txOverrides = { referrer: sellAttributionCodes() };
  const { onchainDepositId, escrowArg } = parseDepositId(depositId);
  const order = await requireOrder(sdk, depositId);
  if (opts.amount !== undefined) {
    if (opts.amount <= 0n) throw errors.amountBelowMinimum(opts.amount, 1n);
    const available = availableAmount(order);
    if (opts.amount > available) throw errors.insufficientAvailableFunds(depositId, opts.amount, available);
    const tx = await sdk.removeFunds.prepare({ depositId: onchainDepositId, amount: opts.amount, ...escrowArg, txOverrides });
    return { txs: [tx], steps: [{ kind: "removeFunds", description: "Withdraw the requested unlocked USDC amount." }] };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const signaled = order.fills.filter((f) => f.status === "SIGNALED");
  const liveIntent = signaled.some((f) => isFillLive(f, nowSeconds));
  const expiredIntent = signaled.length > 0 && !liveIntent;
  if (liveIntent || (order.pendingAmount > 0n && signaled.length === 0)) throw errors.activeIntentBlocksWithdrawal(depositId);
  if (availableAmount(order) <= 0n && order.pendingAmount === 0n) throw errors.nothingToWithdraw(depositId);
  const txs: PreparedTransaction[] = [];
  const steps: CashPreparedStep[] = [];
  if (expiredIntent) {
    txs.push(await sdk.pruneExpiredIntents.prepare({ depositId: onchainDepositId, ...escrowArg, txOverrides }));
    steps.push({
      kind: "pruneExpiredIntents",
      description: "Prune expired buyer intents so the locked amount becomes withdrawable.",
    });
  }
  txs.push(await sdk.withdrawDeposit.prepare({ depositId: onchainDepositId, ...escrowArg, txOverrides }));
  steps.push({ kind: "withdrawDeposit", description: "Close the order and withdraw all remaining USDC." });
  return { txs, steps };
}

/** Peer Cash's prepareTopUp, for a spread order it refuses. */
export async function prepareSpreadTopUp(sdk: OrderSdk, depositId: string, amount: bigint): Promise<Plan> {
  if (amount < MIN_CASHOUT_AMOUNT) throw errors.amountBelowMinimum(amount, MIN_CASHOUT_AMOUNT);
  const order = await requireOrder(sdk, depositId);
  if (!order.isInFlight) throw errors.orderNotActive(depositId);
  const { onchainDepositId, escrowArg } = parseDepositId(depositId);
  const referrer = sellAttributionCodes();
  const prepared = await sdk.addFunds.prepare({ depositId: onchainDepositId, amount, ...escrowArg, txOverrides: { referrer } });
  const approve: PreparedTransaction = {
    to: BASE_USDC_ADDRESS,
    data: appendAttributionToCalldata(
      encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [prepared.to, amount] }),
      referrer,
    ),
    value: 0n,
    chainId: CHAIN_ID,
  };
  return {
    txs: [approve, prepared],
    steps: [
      { kind: "approve", description: "Approve additional Base USDC for the Peer Cash escrow." },
      { kind: "addFunds", description: "Add USDC to the existing cash-out order." },
    ],
  };
}

/** Peer Cash refused a deposit it doesn't treat as its own; it may be a spread order. */
function refusedByCash(err: unknown): boolean {
  return isCashError(err) && err.code === "ORDER_NOT_FOUND";
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

function fingerprint(order: CashOrder): string {
  return [
    order.state,
    order.filledAmount,
    order.pendingAmount,
    order.returnedAmount,
    order.intentCount ?? 0,
    order.nextActions.join("+"),
  ].join("|");
}

/**
 * The Peer Cash client with order reads and changes that also cover spread
 * deposits. Everything else is Peer Cash's own method.
 */
export function withSpreadOrders(cash: CashClient, sdk: () => OrderSdk = getSellSdkClient): CashClient {
  async function order(depositId: string): Promise<CashOrder> {
    try {
      return await cash.order(depositId);
    } catch (err) {
      if (!refusedByCash(err)) throw err;
      const spread = await readSpreadOrder(sdk(), depositId).catch(() => null);
      if (spread) return spread;
      throw err;
    }
  }

  async function orders(owner: Parameters<CashClient["orders"]>[0], opts: Parameters<CashClient["orders"]>[1] = {}): Promise<CashOrder[]> {
    const [own, spread] = await Promise.all([cash.orders(owner, opts), readSpreadOrders(sdk(), owner, opts)]);
    const seen = new Set(own.map((o) => o.depositId.toLowerCase()));
    const merged = [...own, ...spread.filter((o) => !seen.has(o.depositId.toLowerCase()))];
    return merged.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async function* watch(depositId: string, opts: Parameters<CashClient["watch"]>[1] = {}): AsyncGenerator<CashOrder, void, void> {
    const { signal, pollIntervalMs = 5_000, timeoutMs } = opts;
    const startedAt = Date.now();
    let last: string | undefined;
    while (!signal?.aborted) {
      if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) throw errors.watchTimeout(depositId, timeoutMs);
      let current: CashOrder | null = null;
      try {
        current = await order(depositId);
      } catch (err) {
        // Not indexed yet: keep polling, as Peer Cash's own watch does.
        if (!(isCashError(err) && err.code === "ORDER_NOT_FOUND")) throw err;
      }
      if (current) {
        const next = fingerprint(current);
        if (next !== last) {
          last = next;
          yield current;
        }
        if (!current.isInFlight) return;
      }
      await sleep(pollIntervalMs, signal);
    }
  }

  return {
    ...cash,
    orders: orders as CashClient["orders"],
    order,
    watch: watch as CashClient["watch"],
    async prepareWithdraw(depositId, opts = {}) {
      try {
        return await cash.prepareWithdraw(depositId, opts);
      } catch (err) {
        if (!refusedByCash(err) || !(await readSpreadOrder(sdk(), depositId).catch(() => null))) throw err;
        return prepareSpreadWithdraw(sdk(), depositId, opts);
      }
    },
    async prepareTopUp(depositId, amount) {
      try {
        return await cash.prepareTopUp(depositId, amount);
      } catch (err) {
        if (!refusedByCash(err) || !(await readSpreadOrder(sdk(), depositId).catch(() => null))) throw err;
        return prepareSpreadTopUp(sdk(), depositId, amount);
      }
    },
  };
}
