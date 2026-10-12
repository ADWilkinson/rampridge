/**
 * Withdraw-All, Withdraw-X, Top-up and Collect for the bank and the
 * collection box, behind a per-order lock that outlives the interface.
 *
 * Every money action re-reads its order, records a lock (with that fresh
 * snapshot) before the wallet sees anything, then sends. The lock is kept in
 * a module store mirrored to localStorage, so closing the bank, reloading or
 * opening a second tab cannot clear it. It is released only on evidence:
 *
 * - the order moved the expected way in a fresh read (total up for a top-up,
 *   returned up for a withdrawal);
 * - a receipt proves the outcome: reverted means nothing changed, and a
 *   smart wallet's own user operation succeeding means the whole batch went
 *   through (sequential wallets' receipts only show that a step mined, since
 *   the hash can belong to an earlier step such as the approval);
 * - a withdrawal's order has nothing left in it, so nothing can be sent twice;
 * - or, after DISCARD_AFTER_MS with no sign of it, the player says their
 *   wallet shows nothing pending.
 *
 * A confirmed action keeps the order "settling" until the index shows it, so
 * the next action is always checked against amounts that include it.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type { CashClient } from "@zkp2p/cash";
import type { Address, Hex, PublicClient, TransactionReceipt } from "viem";
import {
  ABANDON_AFTER_MS,
  DISCARD_AFTER_MS,
  browserStorage,
  fetchSellOrder,
  sellQueryKeys,
  toSellFlowError,
  topUpSellOrder,
  withdrawSellOrder,
  type BalanceReader,
  type KeyValueStorage,
  type SellFlowError,
  type SellOrderRow,
} from "@/peer/sell";
import { walletQueryKeys } from "@/wallet/balances";
import { scopeUserOperation } from "@/wallet/sequence";
import type { TxSender, WalletKind } from "@/wallet/types";
import { remainingAmount, usdcText } from "./helpers";

export type OrderTxKind = "withdraw-all" | "withdraw" | "top-up";

export type OrderTxPhase =
  /** Handed to the wallet; outcome not known yet. From another page load it counts as unknown. */
  | "sending"
  /** The wallet could not confirm it: it may still land. */
  | "unknown"
  /** Confirmed on-chain; waiting for the order index to show it. */
  | "settling";

/** Order amounts (USDC base units, decimal strings) from the fresh read taken just before sending. */
export interface OrderSnapshot {
  total: string;
  returned: string;
  remaining: string;
}

export interface OrderTxRecord {
  v: 1;
  id: string;
  /** Lowercase wallet address. */
  owner: string;
  depositId: string;
  kind: OrderTxKind;
  /** USDC base units asked for; null for Withdraw-All (everything left). */
  amount: string | null;
  before: OrderSnapshot;
  phase: OrderTxPhase;
  txHash: Hex | null;
  walletKind: WalletKind;
  /** ms since epoch when the lock was taken (just before the wallet request). */
  startedAt: number;
  /** ms since epoch when it confirmed (settling only). */
  confirmedAt: number | null;
  /** A receipt shows a transaction from this attempt mined, without proving the order changed. */
  mined: boolean;
  /** The page load that is sending it. */
  page: string;
}

/** Unknown outcomes the player may release by hand after this long with no sign on-chain. */
export const UNKNOWN_RELEASE_AFTER_MS = DISCARD_AFTER_MS;
/** A confirmed action stops holding its order after this long even if the index never shows it. */
export const SETTLE_MAX_MS = 3 * 60_000;
/** Records older than this are dropped on load, so a lost transaction cannot block an order forever. */
export const RECORD_TTL_MS = ABANDON_AFTER_MS;
export const CHECK_INTERVAL_MS = 8_000;

const STORAGE_KEY = "rampridge:bank:orderTxs:v1";

function randomId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** This page load. A "sending" record from any other page (a reload, another tab) has an unknown outcome. */
export const PAGE_ID = randomId();
/** Record ids this page is sending right now. */
const liveSends = new Set<string>();
/** Wallets this page is sending from right now (one wallet request at a time). */
const sendingOwners = new Set<string>();

export function isLiveSend(record: OrderTxRecord): boolean {
  return record.phase === "sending" && record.page === PAGE_ID && liveSends.has(record.id);
}

// ---------------------------------------------------------------------------
// Pure rules

export function snapshotOf(row: Pick<SellOrderRow, "totalAmount" | "filledAmount" | "returnedAmount">): OrderSnapshot {
  return { total: row.totalAmount.toString(), returned: row.returnedAmount.toString(), remaining: remainingAmount(row).toString() };
}

function big(value: string | null | undefined): bigint {
  try {
    return value ? BigInt(value) : 0n;
  } catch {
    return 0n;
  }
}

export function recordAmount(record: Pick<OrderTxRecord, "kind" | "amount" | "before">): bigint {
  return record.kind === "withdraw-all" ? big(record.before.remaining) : big(record.amount);
}

/** True when a read of the order shows this action took effect. */
export function orderMoved(
  record: Pick<OrderTxRecord, "kind" | "amount" | "before">,
  order: Pick<SellOrderRow, "totalAmount" | "returnedAmount">,
): boolean {
  const total = big(record.before.total);
  const returned = big(record.before.returned);
  switch (record.kind) {
    case "top-up":
      return order.totalAmount >= total + big(record.amount);
    case "withdraw":
      return order.returnedAmount >= returned + big(record.amount);
    case "withdraw-all":
      return order.returnedAmount > returned;
  }
}

export type ReceiptVerdict =
  /** The whole action went through (a smart wallet's batched user operation succeeded). */
  | "success"
  /** It reverted: the money step never ran. */
  | "failed"
  /** A transaction mined, but it may be an earlier step (sequential wallets). */
  | "mined"
  /** The receipt does not contain this wallet's user operation. */
  | "unproven";

/**
 * What a receipt for the hash the wallet reported proves. Withdrawals and
 * top-ups always end with their money call, so a reverted step means the
 * money call either reverted or was never sent.
 */
export function receiptVerdict(receipt: Pick<TransactionReceipt, "status" | "logs">, owner: string, walletKind: WalletKind): ReceiptVerdict {
  if (receipt.status === "reverted") return "failed";
  const scope = scopeUserOperation(receipt, owner as Address);
  if (scope.outcome === "failed") return "failed";
  if (walletKind === "smart") return scope.outcome === "success" ? "success" : "unproven";
  return "mined";
}

/** The money lock on an order, if any: an action being sent, unconfirmed, or settling. */
export function lockFor(records: readonly OrderTxRecord[], owner: string, depositId: string): OrderTxRecord | null {
  const key = owner.toLowerCase();
  return records.find((r) => r.owner === key && r.depositId === depositId) ?? null;
}

/** "your top-up of 100.00 USDC", "your withdrawal of 500.00 USDC" */
export function orderTxSubject(record: Pick<OrderTxRecord, "kind" | "amount" | "before">): string {
  const amount = usdcText(recordAmount(record));
  return record.kind === "top-up" ? `your top-up of ${amount} USDC` : `your withdrawal of ${amount} USDC`;
}

/** What the status line says while the wallet has the request: "Withdrawing 10.00 USDC". */
export function orderTxWorkingText(record: Pick<OrderTxRecord, "kind" | "amount" | "before">): string {
  if (record.kind === "withdraw-all") return "Closing your offer";
  const amount = usdcText(big(record.amount));
  return record.kind === "top-up" ? `Adding ${amount} USDC to your offer` : `Withdrawing ${amount} USDC`;
}

/** The game message for an action that went through. */
export function orderTxDoneText(record: Pick<OrderTxRecord, "kind" | "amount" | "before">, recovered: boolean): string {
  const amount = usdcText(recordAmount(record));
  switch (record.kind) {
    case "withdraw-all":
      return recovered ? `Your withdrawal of ${amount} USDC went through.` : `Your offer is closed. ${amount} USDC is back in your wallet.`;
    case "withdraw":
      return recovered ? `Your withdrawal of ${amount} USDC went through.` : `You withdraw ${amount} USDC.`;
    case "top-up":
      return recovered ? `Your top-up of ${amount} USDC went through.` : `You add ${amount} USDC to your offer.`;
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function orderTxFailedText(record: Pick<OrderTxRecord, "kind" | "amount" | "before">): string {
  return `${capitalise(orderTxSubject(record))} failed on-chain, so nothing changed.`;
}

export function orderTxUnconfirmedText(record: Pick<OrderTxRecord, "kind" | "amount" | "before">): string {
  return `${capitalise(orderTxSubject(record))} hasn't been confirmed.`;
}

/** The game message when a fresh read no longer allows what the player chose. Nothing was sent. */
export function orderTxChangedText(
  request: Pick<OrderTxRequest, "kind">,
  order: Pick<SellOrderRow, "canWithdraw" | "pendingAmount" | "availableAmount" | "totalAmount" | "filledAmount" | "returnedAmount"> & { order: { withdrawn?: boolean } },
): string {
  const remaining = remainingAmount(order);
  switch (request.kind) {
    case "withdraw-all":
      if (order.order.withdrawn || remaining <= 0n) return "This offer has nothing left to withdraw.";
      if (!order.canWithdraw && order.pendingAmount > 0n) return "A buyer is paying for part of this offer right now.";
      return `This offer now has ${usdcText(remaining)} USDC left. Check it and try again.`;
    case "withdraw":
      return order.availableAmount > 0n
        ? `You can only withdraw ${usdcText(order.availableAmount)} USDC from this offer right now.`
        : "Nothing in this offer is unlocked right now.";
    case "top-up":
      return "This offer is closed, so it can't be topped up.";
  }
}

// ---------------------------------------------------------------------------
// Store

function isRecord(value: unknown): value is OrderTxRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<OrderTxRecord>;
  return (
    r.v === 1 &&
    typeof r.id === "string" &&
    typeof r.owner === "string" &&
    typeof r.depositId === "string" &&
    (r.kind === "withdraw-all" || r.kind === "withdraw" || r.kind === "top-up") &&
    (r.phase === "sending" || r.phase === "unknown" || r.phase === "settling") &&
    typeof r.startedAt === "number" &&
    !!r.before &&
    typeof r.before.total === "string" &&
    typeof r.before.returned === "string" &&
    typeof r.before.remaining === "string"
  );
}

export interface OrderTxStore {
  /** React hook over the records. */
  use: <T>(selector: (records: readonly OrderTxRecord[]) => T) => T;
  records(): readonly OrderTxRecord[];
  subscribe(listener: () => void): () => void;
  add(record: OrderTxRecord): void;
  /** Applies `patch`; false when the record is gone (someone else resolved it). */
  update(id: string, patch: Partial<OrderTxRecord>): boolean;
  /** Removes the record; true only for the caller that removed it. */
  remove(id: string): boolean;
  /** Re-reads storage (another tab wrote). */
  reload(): void;
}

export function createOrderTxStore(storage: KeyValueStorage, now: () => number = Date.now): OrderTxStore {
  // After a failed write this page keeps its own copy and stops trusting storage.
  let storageOk = true;
  const read = (): OrderTxRecord[] => {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isRecord).filter((r) => now() - r.startedAt < RECORD_TTL_MS) : [];
    } catch {
      return [];
    }
  };
  const state = create<{ records: readonly OrderTxRecord[] }>(() => ({ records: read() }));
  const current = (): OrderTxRecord[] => (storageOk ? read() : [...state.getState().records]);
  const write = (records: OrderTxRecord[]) => {
    state.setState({ records });
    if (!storageOk) return;
    try {
      if (records.length) storage.setItem(STORAGE_KEY, JSON.stringify(records));
      else storage.removeItem(STORAGE_KEY);
    } catch {
      storageOk = false;
    }
  };
  return {
    use: (selector) => state((s) => selector(s.records)),
    records: () => state.getState().records,
    subscribe: (listener) => state.subscribe(listener),
    add(record) {
      write([...current().filter((r) => r.id !== record.id), record]);
    },
    update(id, patch) {
      const list = current();
      if (!list.some((r) => r.id === id)) {
        if (storageOk) state.setState({ records: list });
        return false;
      }
      write(list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      return true;
    },
    remove(id) {
      const list = current();
      if (!list.some((r) => r.id === id)) {
        if (storageOk) state.setState({ records: list });
        return false;
      }
      write(list.filter((r) => r.id !== id));
      return true;
    },
    reload() {
      if (storageOk) state.setState({ records: read() });
    },
  };
}

let defaultStore: OrderTxStore | null = null;

/** The page's store over localStorage (memory when storage is blocked), kept in step with other tabs. */
export function orderTxStore(): OrderTxStore {
  if (defaultStore) return defaultStore;
  const store = createOrderTxStore(browserStorage());
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY || e.key === null) store.reload();
    });
  }
  defaultStore = store;
  return store;
}

// ---------------------------------------------------------------------------
// Sending

export type OrderTxRequest =
  /** `expectRemaining` is the amount the player confirmed; a different fresh amount stops the send. */
  | { kind: "withdraw-all"; depositId: string; expectRemaining?: bigint }
  | { kind: "withdraw"; depositId: string; amount: bigint }
  | { kind: "top-up"; depositId: string; amount: bigint };

export type OrderTxSendResult =
  | { status: "sent"; record: OrderTxRecord; txHash: Hex }
  /** An earlier attempt on this order is unconfirmed or still settling. Nothing was sent. */
  | { status: "locked"; record: OrderTxRecord }
  /** This wallet already has a request open. Nothing was sent. */
  | { status: "busy" }
  /** The fresh read no longer allows this action (or the amount changed). Nothing was sent. */
  | { status: "changed"; order: SellOrderRow }
  /** `unknown` errors keep the order locked; any other error sent nothing. */
  | { status: "failed"; error: SellFlowError; unknown: boolean; record: OrderTxRecord | null };

export interface OrderTxSendDeps {
  client: CashClient;
  sender: TxSender;
  /** Enables the fresh wallet-balance check before a top-up. */
  publicClient: BalanceReader | null;
  queryClient?: QueryClient | null;
  store?: OrderTxStore;
  now?: () => number;
}

/** Whether a fresh read of the order allows the request. */
export function allowsOrderTx(order: SellOrderRow, request: OrderTxRequest): boolean {
  switch (request.kind) {
    case "withdraw-all": {
      const remaining = remainingAmount(order);
      if (!order.canWithdraw || order.order.withdrawn || remaining <= 0n) return false;
      return request.expectRemaining === undefined || request.expectRemaining === remaining;
    }
    case "withdraw":
      return !order.order.withdrawn && request.amount > 0n && request.amount <= order.availableAmount;
    case "top-up":
      return order.canTopUp && request.amount > 0n;
  }
}

export function invalidateOrderQueries(queryClient: QueryClient | null | undefined, owner: string, depositId: string): void {
  if (!queryClient) return;
  void queryClient.invalidateQueries({ queryKey: sellQueryKeys.orders(owner) });
  void queryClient.invalidateQueries({ queryKey: sellQueryKeys.order(depositId) });
  void queryClient.invalidateQueries({ queryKey: sellQueryKeys.usdcBalance(owner) });
  void queryClient.invalidateQueries({ queryKey: walletQueryKeys.all });
}

/**
 * Sends one money action on an order. The lock is written before the wallet
 * request and survives the interface closing, so the outcome always lands in
 * the store even if nobody is watching.
 */
export async function sendOrderTx(deps: OrderTxSendDeps, request: OrderTxRequest): Promise<OrderTxSendResult> {
  const store = deps.store ?? orderTxStore();
  const now = deps.now ?? Date.now;
  const owner = deps.sender.address.toLowerCase();
  const { depositId } = request;
  const held = lockFor(store.records(), owner, depositId);
  if (held) return { status: "locked", record: held };
  if (sendingOwners.has(owner)) return { status: "busy" };
  sendingOwners.add(owner);
  try {
    let fresh: SellOrderRow;
    try {
      fresh = await fetchSellOrder(deps.client, depositId);
    } catch (err) {
      return { status: "failed", error: toSellFlowError(err, { stage: "read", depositId }), unknown: false, record: null };
    }
    // Another tab may have written while the read was out.
    store.reload();
    const heldNow = lockFor(store.records(), owner, depositId);
    if (heldNow) return { status: "locked", record: heldNow };
    if (!allowsOrderTx(fresh, request)) {
      invalidateOrderQueries(deps.queryClient, owner, depositId);
      return { status: "changed", order: fresh };
    }

    const record: OrderTxRecord = {
      v: 1,
      id: randomId(),
      owner,
      depositId,
      kind: request.kind,
      amount: request.kind === "withdraw-all" ? null : request.amount.toString(),
      before: snapshotOf(fresh),
      phase: "sending",
      txHash: null,
      walletKind: deps.sender.kind,
      startedAt: now(),
      confirmedAt: null,
      mined: false,
      page: PAGE_ID,
    };
    liveSends.add(record.id);
    store.add(record);
    const txDeps = { client: deps.client, sender: deps.sender, publicClient: deps.publicClient };
    try {
      const result =
        request.kind === "top-up"
          ? await topUpSellOrder(txDeps, depositId, request.amount)
          : await withdrawSellOrder(txDeps, depositId, request.kind === "withdraw" ? request.amount : undefined);
      const settled: OrderTxRecord = { ...record, phase: "settling", txHash: result.txHash, confirmedAt: now() };
      liveSends.delete(record.id);
      store.update(record.id, { phase: "settling", txHash: result.txHash, confirmedAt: settled.confirmedAt });
      return { status: "sent", record: settled, txHash: result.txHash };
    } catch (err) {
      const error = toSellFlowError(err, { stage: request.kind === "top-up" ? "topUp" : "withdraw", depositId });
      const unknown = error.recovery.action === "reconcile";
      liveSends.delete(record.id);
      if (unknown) {
        const txHash = error.transactionHash ?? null;
        store.update(record.id, { phase: "unknown", txHash });
        return { status: "failed", error, unknown, record: { ...record, phase: "unknown", txHash } };
      }
      store.remove(record.id);
      return { status: "failed", error, unknown, record: null };
    } finally {
      liveSends.delete(record.id);
      invalidateOrderQueries(deps.queryClient, owner, depositId);
    }
  } finally {
    sendingOwners.delete(owner);
  }
}

// ---------------------------------------------------------------------------
// Checking

export interface OrderTxCheckDeps {
  client: Pick<CashClient, "order">;
  publicClient: Pick<PublicClient, "getTransactionReceipt"> | null;
  now?: () => number;
}

export type OrderTxCheck =
  /** The index shows it: done. */
  | { kind: "moved"; order: SellOrderRow }
  /** A receipt proves it went through; the index has not caught up. */
  | { kind: "confirmed"; order: SellOrderRow | null }
  /** It reverted: nothing changed. */
  | { kind: "failed" }
  /** A withdrawal whose order now has nothing left: nothing can be sent twice. */
  | { kind: "nothing-left"; order: SellOrderRow }
  /** A settling record the index never showed within SETTLE_MAX_MS. */
  | { kind: "expired" }
  | { kind: "waiting"; mined: boolean; canRelease: boolean };

/** Looks for evidence about one record. Never sends anything. */
export async function checkOrderTx(record: OrderTxRecord, deps: OrderTxCheckDeps): Promise<OrderTxCheck> {
  const now = deps.now ?? Date.now;
  let order: SellOrderRow | null = null;
  try {
    order = await fetchSellOrder(deps.client, record.depositId);
  } catch {
    // The index could not answer: no evidence either way.
  }
  if (order && orderMoved(record, order)) return { kind: "moved", order };
  if (record.phase === "settling") {
    return now() - (record.confirmedAt ?? record.startedAt) >= SETTLE_MAX_MS ? { kind: "expired" } : { kind: "waiting", mined: true, canRelease: false };
  }
  let mined = record.mined;
  if (record.txHash && deps.publicClient) {
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await deps.publicClient.getTransactionReceipt({ hash: record.txHash });
    } catch {
      // Not mined yet, or the node could not answer: it may still land.
    }
    if (receipt) {
      const verdict = receiptVerdict(receipt, record.owner, record.walletKind);
      if (verdict === "failed") return { kind: "failed" };
      if (verdict === "success") return { kind: "confirmed", order };
      if (verdict === "mined") mined = true;
    }
  }
  if (record.kind !== "top-up" && order && remainingAmount(order) === 0n) return { kind: "nothing-left", order };
  return { kind: "waiting", mined, canRelease: now() - record.startedAt >= UNKNOWN_RELEASE_AFTER_MS };
}

export type OrderTxEvent =
  /** An unconfirmed action turned out to have gone through. */
  | { kind: "confirmed"; record: OrderTxRecord }
  /** An unconfirmed action reverted: nothing changed. */
  | { kind: "failed"; record: OrderTxRecord }
  /** An unconfirmed withdrawal's order has nothing left in it. */
  | { kind: "nothing-left"; record: OrderTxRecord }
  /** A confirmed action now shows in the bank (or stopped waiting for it). */
  | { kind: "settled"; record: OrderTxRecord }
  | { kind: "waiting"; record: OrderTxRecord; mined: boolean; canRelease: boolean };

const checking = new Set<string>();

/**
 * Checks every unresolved record of a wallet and applies what it finds.
 * Records being sent by this page are skipped. Safe to call from several
 * interfaces at once: each resolution is reported once, by whoever applied it.
 */
export async function reconcileOrderTxs(store: OrderTxStore, owner: string, deps: OrderTxCheckDeps): Promise<OrderTxEvent[]> {
  const now = deps.now ?? Date.now;
  const key = owner.toLowerCase();
  const records = store.records().filter((r) => r.owner === key && !isLiveSend(r) && !checking.has(r.id));
  const events: OrderTxEvent[] = [];
  await Promise.all(
    records.map(async (record) => {
      checking.add(record.id);
      try {
        const result = await checkOrderTx(record, deps);
        const latest = store.records().find((r) => r.id === record.id);
        // Resolved elsewhere, or the sending page moved it on meanwhile.
        if (!latest || latest.phase !== record.phase || isLiveSend(latest)) return;
        const settling = record.phase === "settling";
        switch (result.kind) {
          case "moved":
            if (store.remove(record.id)) events.push({ kind: settling ? "settled" : "confirmed", record });
            return;
          case "confirmed":
            if (store.update(record.id, { phase: "settling", confirmedAt: now(), mined: true })) events.push({ kind: "confirmed", record });
            return;
          case "expired":
            if (store.remove(record.id)) events.push({ kind: "settled", record });
            return;
          case "failed":
          case "nothing-left":
            if (store.remove(record.id)) events.push({ kind: result.kind, record });
            return;
          case "waiting":
            if (result.mined && !record.mined) store.update(record.id, { mined: true });
            events.push({ kind: "waiting", record, mined: result.mined, canRelease: result.canRelease });
            return;
        }
      } finally {
        checking.delete(record.id);
      }
    }),
  );
  return events;
}

/**
 * Releases an unconfirmed record by the player's word, only once
 * UNKNOWN_RELEASE_AFTER_MS has passed with no sign of it.
 */
export function releaseOrderTx(store: OrderTxStore, record: OrderTxRecord, now: () => number = Date.now): boolean {
  if (record.phase === "settling" || isLiveSend(record)) return false;
  if (now() - record.startedAt < UNKNOWN_RELEASE_AFTER_MS) return false;
  return store.remove(record.id);
}

// ---------------------------------------------------------------------------
// React

/** This wallet's records, kept current across interfaces and tabs. */
export function useOrderTxs(owner: string | null | undefined): readonly OrderTxRecord[] {
  const all = orderTxStore().use((records) => records);
  return useMemo(() => {
    const key = owner?.toLowerCase();
    return key ? all.filter((r) => r.owner === key) : [];
  }, [all, owner]);
}

export interface OrderTxWatcher {
  /** Checks now; resolves with what it found (including "waiting" for each unresolved record). */
  check: () => Promise<OrderTxEvent[]>;
}

/**
 * Keeps checking this wallet's unresolved records while the interface is
 * open and reports resolutions through `onEvent` (never "waiting" ones).
 */
export function useOrderTxWatcher(opts: {
  owner: string;
  client: CashClient;
  publicClient: Pick<PublicClient, "getTransactionReceipt"> | null;
  records: readonly OrderTxRecord[];
  onEvent: (event: OrderTxEvent) => void;
}): OrderTxWatcher {
  const { owner, client, publicClient, records } = opts;
  const queryClient = useQueryClient();
  const onEvent = useRef(opts.onEvent);
  onEvent.current = opts.onEvent;

  const check = useCallback(async () => {
    const events = await reconcileOrderTxs(orderTxStore(), owner, { client, publicClient });
    for (const event of events) {
      if (event.kind === "waiting") continue;
      invalidateOrderQueries(queryClient, owner, event.record.depositId);
      onEvent.current(event);
    }
    return events;
  }, [owner, client, publicClient, queryClient]);

  const unresolved = records.some((r) => !isLiveSend(r));
  useEffect(() => {
    if (!unresolved) return;
    let stopped = false;
    void check();
    const timer = window.setInterval(() => {
      if (!stopped) void check();
    }, CHECK_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [unresolved, check]);

  return { check };
}
