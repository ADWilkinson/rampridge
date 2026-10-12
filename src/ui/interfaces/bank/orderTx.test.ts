import { describe, expect, it } from "vitest";
import { withExplain, type CashClient, type CashFill, type CashOrder, type CashOrderState } from "@zkp2p/cash";
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { memoryStorage, type BalanceReader, type KeyValueStorage } from "@/peer/sell";
import { TransactionPendingError, UserRejectedError } from "@/wallet/errors";
import type { TxSender, WalletCall, WalletKind } from "@/wallet/types";
import {
  PAGE_ID,
  UNKNOWN_RELEASE_AFTER_MS,
  allowsOrderTx,
  checkOrderTx,
  createOrderTxStore,
  lockFor,
  orderMoved,
  orderTxChangedText,
  orderTxDoneText,
  orderTxFailedText,
  orderTxUnconfirmedText,
  receiptVerdict,
  reconcileOrderTxs,
  releaseOrderTx,
  sendOrderTx,
  type OrderTxRecord,
} from "./orderTx";

const U = (n: number) => BigInt(Math.round(n * 1_000_000));
const OWNER = "0xabcd000000000000000000000000000000000001" as Address;
const ESCROW = "0x2f121cddca6d652f35e8b3e560f9760898888888";
const DEPOSIT = `${ESCROW}_7`;
const HASH = `0x${"ab".repeat(32)}` as Hex;

interface Spec {
  total: bigint;
  filled: bigint;
  pending: bigint;
  returned: bigint;
  state: CashOrderState;
  fills: CashFill[];
  withdrawn: boolean;
}

/** A tiny chain: one order, a wallet that does what `next` says, and receipts by hash. */
function world(initial: Partial<Spec> = {}) {
  const spec: Spec = { total: U(500), filled: 0n, pending: 0n, returned: 0n, state: "awaiting-buyer", fills: [], withdrawn: false, ...initial };
  const receipts = new Map<Hex, TransactionReceipt>();
  let next: "ok" | "reject" | "unknown" | "unknown-lands" = "ok";
  let sends = 0;
  let reads = 0;
  const order = (): CashOrder => {
    const remaining = spec.total - spec.filled - spec.returned;
    const live = !spec.withdrawn && spec.state !== "delivered" && spec.state !== "returned";
    return withExplain({
      depositId: DEPOSIT,
      state: spec.state,
      fills: spec.fills,
      totalAmount: spec.total,
      filledAmount: spec.filled,
      pendingAmount: spec.pending,
      returnedAmount: spec.returned,
      nextActions: live && remaining > 0n && spec.pending === 0n ? ["wait", "withdraw"] : live ? ["wait"] : [],
      intentCount: spec.fills.length,
      isInFlight: live,
      withdrawn: spec.withdrawn,
    });
  };
  const apply = (data: string) => {
    const [verb, amount] = data.split(":");
    if (verb === "topup") spec.total += BigInt(amount ?? "0");
    else if (verb === "withdraw" && amount === "all") {
      spec.returned += spec.total - spec.filled - spec.returned;
      spec.withdrawn = true;
      spec.state = "returned";
    } else if (verb === "withdraw") spec.returned += BigInt(amount ?? "0");
  };
  const client = {
    order: async () => {
      reads += 1;
      return order();
    },
    prepareWithdraw: async (_id: string, opts: { amount?: bigint } = {}) => ({
      txs: [{ to: ESCROW, data: `withdraw:${opts.amount ?? "all"}`, value: 0n, chainId: 8453 }],
      steps: [],
    }),
    prepareTopUp: async (_id: string, amount: bigint) => ({ txs: [{ to: ESCROW, data: `topup:${amount}`, value: 0n, chainId: 8453 }], steps: [] }),
  } as unknown as CashClient;
  const sender = (kind: WalletKind = "smart"): TxSender => ({
    address: OWNER,
    kind,
    sponsored: true,
    signMessage: async () => "0x",
    walletClient: {} as TxSender["walletClient"],
    sendCalls: async (calls: WalletCall[]) => {
      sends += 1;
      const mode = next;
      if (mode === "reject") throw new UserRejectedError();
      if (mode === "unknown") throw new TransactionPendingError(HASH);
      for (const call of calls) apply(String(call.data));
      const receipt = { transactionHash: HASH, status: "success", logs: [] } as unknown as TransactionReceipt;
      receipts.set(HASH, receipt);
      if (mode === "unknown-lands") throw new TransactionPendingError(HASH);
      return receipt;
    },
  });
  const publicClient = {
    readContract: async () => U(10_000),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = receipts.get(hash);
      if (!r) throw new Error("not found");
      return r;
    },
  } as unknown as BalanceReader & Pick<PublicClient, "getTransactionReceipt">;
  return {
    spec,
    client,
    sender,
    publicClient,
    receipts,
    setNext: (mode: typeof next) => {
      next = mode;
    },
    get sends() {
      return sends;
    },
    get reads() {
      return reads;
    },
  };
}

function record(extra: Partial<OrderTxRecord> = {}): OrderTxRecord {
  return {
    v: 1,
    id: "r1",
    owner: OWNER.toLowerCase(),
    depositId: DEPOSIT,
    kind: "top-up",
    amount: U(100).toString(),
    before: { total: U(500).toString(), returned: "0", remaining: U(500).toString() },
    phase: "unknown",
    txHash: null,
    walletKind: "smart",
    startedAt: Date.now(),
    confirmedAt: null,
    mined: false,
    page: "another-page",
    ...extra,
  };
}

const userOpAbi = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

function userOpLog(sender: Address, success: boolean) {
  const topics = encodeEventTopics({ abi: userOpAbi, eventName: "UserOperationEvent", args: { userOpHash: HASH, sender, paymaster: OWNER } });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [1n, success, 1n, 1n]);
  return { address: entryPoint07Address, topics, data } as unknown as TransactionReceipt["logs"][number];
}

describe("evidence rules", () => {
  it("counts an order as moved only by the expected amount in the expected column", () => {
    const top = record({ kind: "top-up", amount: U(100).toString() });
    expect(orderMoved(top, { totalAmount: U(599), returnedAmount: 0n })).toBe(false);
    expect(orderMoved(top, { totalAmount: U(600), returnedAmount: 0n })).toBe(true);
    const part = record({ kind: "withdraw", amount: U(40).toString() });
    expect(orderMoved(part, { totalAmount: U(500), returnedAmount: U(39) })).toBe(false);
    expect(orderMoved(part, { totalAmount: U(500), returnedAmount: U(40) })).toBe(true);
    const all = record({ kind: "withdraw-all", amount: null });
    expect(orderMoved(all, { totalAmount: U(500), returnedAmount: 0n })).toBe(false);
    expect(orderMoved(all, { totalAmount: U(500), returnedAmount: U(500) })).toBe(true);
  });

  it("trusts a receipt only for what it proves", () => {
    const reverted = { status: "reverted", logs: [] } as unknown as TransactionReceipt;
    const plain = { status: "success", logs: [] } as unknown as TransactionReceipt;
    expect(receiptVerdict(reverted, OWNER, "smart")).toBe("failed");
    // A bundle without this wallet's user operation proves nothing about it.
    expect(receiptVerdict(plain, OWNER, "smart")).toBe("unproven");
    expect(receiptVerdict({ status: "success", logs: [userOpLog(OWNER, true)] } as unknown as TransactionReceipt, OWNER, "smart")).toBe("success");
    expect(receiptVerdict({ status: "success", logs: [userOpLog(OWNER, false)] } as unknown as TransactionReceipt, OWNER, "smart")).toBe("failed");
    // Sequential wallets: the hash may be the approval, so success is only "mined".
    expect(receiptVerdict(plain, OWNER, "external")).toBe("mined");
    expect(receiptVerdict(plain, OWNER, "embedded")).toBe("mined");
  });

  it("describes each action exactly", () => {
    const top = record();
    expect(orderTxUnconfirmedText(top)).toBe("Your top-up of 100.00 USDC hasn't been confirmed.");
    expect(orderTxFailedText(top)).toBe("Your top-up of 100.00 USDC failed on-chain, so nothing changed.");
    expect(orderTxDoneText(top, true)).toBe("Your top-up of 100.00 USDC went through.");
    expect(orderTxDoneText(record({ kind: "withdraw-all", amount: null }), false)).toBe("Your offer is closed. 500.00 USDC is back in your wallet.");
  });
});

describe("the order lock", () => {
  it("survives a reload and blocks a second send after an unknown outcome", async () => {
    const storage: KeyValueStorage = memoryStorage();
    const w = world();
    const store = createOrderTxStore(storage);
    w.setNext("unknown");
    const first = await sendOrderTx({ client: w.client, sender: w.sender(), publicClient: null, store }, { kind: "top-up", depositId: DEPOSIT, amount: U(100) });
    expect(first.status).toBe("failed");
    expect(first.status === "failed" && first.unknown).toBe(true);
    expect(w.sends).toBe(1);

    // Same page, bank reopened: the store still has it.
    const again = await sendOrderTx({ client: w.client, sender: w.sender(), publicClient: null, store }, { kind: "top-up", depositId: DEPOSIT, amount: U(100) });
    expect(again.status).toBe("locked");

    // A reload: a new store over the same storage still blocks, and nothing reaches the wallet.
    const reloaded = createOrderTxStore(storage);
    expect(lockFor(reloaded.records(), OWNER, DEPOSIT)?.phase).toBe("unknown");
    expect(lockFor(reloaded.records(), OWNER, DEPOSIT)?.txHash).toBe(HASH);
    const afterReload = await sendOrderTx({ client: w.client, sender: w.sender(), publicClient: null, store: reloaded }, { kind: "withdraw", depositId: DEPOSIT, amount: U(10) });
    expect(afterReload.status).toBe("locked");
    expect(w.sends).toBe(1);
  });

  it("keeps the lock while there is no evidence, and releases it when the order moves", async () => {
    const storage = memoryStorage();
    const w = world();
    const store = createOrderTxStore(storage);
    w.setNext("unknown");
    await sendOrderTx({ client: w.client, sender: w.sender(), publicClient: w.publicClient, store }, { kind: "top-up", depositId: DEPOSIT, amount: U(100) });

    const waiting = await reconcileOrderTxs(store, OWNER, { client: w.client, publicClient: w.publicClient });
    expect(waiting.map((e) => e.kind)).toEqual(["waiting"]);
    expect(store.records()).toHaveLength(1);

    // The top-up lands late: the order's total rises by the amount.
    w.spec.total += U(100);
    const [a, b] = await Promise.all([
      reconcileOrderTxs(store, OWNER, { client: w.client, publicClient: w.publicClient }),
      reconcileOrderTxs(store, OWNER, { client: w.client, publicClient: w.publicClient }),
    ]);
    // Reported once, however many interfaces are checking.
    expect([...a!, ...b!].filter((e) => e.kind === "confirmed")).toHaveLength(1);
    expect(store.records()).toHaveLength(0);
  });

  it("releases with 'nothing changed' when the receipt shows it reverted", async () => {
    const w = world();
    const store = createOrderTxStore(memoryStorage());
    store.add(record({ txHash: HASH }));
    w.receipts.set(HASH, { transactionHash: HASH, status: "reverted", logs: [] } as unknown as TransactionReceipt);
    const events = await reconcileOrderTxs(store, OWNER, { client: w.client, publicClient: w.publicClient });
    expect(events.map((e) => e.kind)).toEqual(["failed"]);
    expect(store.records()).toHaveLength(0);
  });

  it("does not release an unproven smart-wallet receipt, and settles a proven one until the index shows it", async () => {
    const w = world();
    const store = createOrderTxStore(memoryStorage());
    store.add(record({ txHash: HASH }));
    w.receipts.set(HASH, { transactionHash: HASH, status: "success", logs: [] } as unknown as TransactionReceipt);
    expect((await reconcileOrderTxs(store, OWNER, { client: w.client, publicClient: w.publicClient })).map((e) => e.kind)).toEqual(["waiting"]);

    w.receipts.set(HASH, { transactionHash: HASH, status: "success", logs: [userOpLog(OWNER, true)] } as unknown as TransactionReceipt);
    expect((await reconcileOrderTxs(store, OWNER, { client: w.client, publicClient: w.publicClient })).map((e) => e.kind)).toEqual(["confirmed"]);
    // Confirmed, but money actions wait until the bank shows it.
    expect(store.records()[0]?.phase).toBe("settling");
    w.spec.total += U(100);
    expect((await reconcileOrderTxs(store, OWNER, { client: w.client, publicClient: w.publicClient })).map((e) => e.kind)).toEqual(["settled"]);
    expect(store.records()).toHaveLength(0);
  });

  it("treats a send cut off by a reload as unknown", async () => {
    const w = world();
    const store = createOrderTxStore(memoryStorage());
    store.add(record({ phase: "sending", page: "an-earlier-load" }));
    const result = await sendOrderTx({ client: w.client, sender: w.sender(), publicClient: null, store }, { kind: "top-up", depositId: DEPOSIT, amount: U(5) });
    expect(result.status).toBe("locked");
    expect((await reconcileOrderTxs(store, OWNER, { client: w.client, publicClient: null })).map((e) => e.kind)).toEqual(["waiting"]);
  });

  it("lets the player release an unknown outcome only after the waiting period", () => {
    const t0 = 1_000_000;
    const store = createOrderTxStore(memoryStorage(), () => t0 + UNKNOWN_RELEASE_AFTER_MS);
    const r = record({ startedAt: t0 });
    store.add(r);
    expect(releaseOrderTx(store, r, () => t0 + UNKNOWN_RELEASE_AFTER_MS - 1)).toBe(false);
    expect(store.records()).toHaveLength(1);
    expect(releaseOrderTx(store, r, () => t0 + UNKNOWN_RELEASE_AFTER_MS)).toBe(true);
    expect(store.records()).toHaveLength(0);
  });

  it("releases a cancelled send straight away, since nothing was sent", async () => {
    const w = world();
    const store = createOrderTxStore(memoryStorage());
    w.setNext("reject");
    const result = await sendOrderTx({ client: w.client, sender: w.sender(), publicClient: null, store }, { kind: "withdraw", depositId: DEPOSIT, amount: U(10) });
    expect(result.status === "failed" && !result.unknown).toBe(true);
    expect(store.records()).toHaveLength(0);
  });

  it("checks the order again at send time and sends nothing when it no longer allows the action", async () => {
    const w = world({ pending: U(50) });
    const store = createOrderTxStore(memoryStorage());
    const tooMuch = await sendOrderTx({ client: w.client, sender: w.sender(), publicClient: null, store }, { kind: "withdraw", depositId: DEPOSIT, amount: U(460) });
    expect(tooMuch.status).toBe("changed");
    if (tooMuch.status === "changed") expect(orderTxChangedText({ kind: "withdraw" }, tooMuch.order)).toBe("You can only withdraw 450.00 USDC from this offer right now.");
    const all = await sendOrderTx({ client: w.client, sender: w.sender(), publicClient: null, store }, { kind: "withdraw-all", depositId: DEPOSIT });
    expect(all.status).toBe("changed");
    if (all.status === "changed") expect(orderTxChangedText({ kind: "withdraw-all" }, all.order)).toBe("A buyer is paying for part of this offer right now.");
    expect(w.sends).toBe(0);
    expect(store.records()).toHaveLength(0);
  });

  it("refuses a Withdraw-All whose amount changed since the player confirmed it", async () => {
    const w = world({ filled: U(100) });
    const store = createOrderTxStore(memoryStorage());
    const result = await sendOrderTx({ client: w.client, sender: w.sender(), publicClient: null, store }, { kind: "withdraw-all", depositId: DEPOSIT, expectRemaining: U(500) });
    expect(result.status).toBe("changed");
    expect(w.sends).toBe(0);
    if (result.status === "changed") {
      expect(allowsOrderTx(result.order, { kind: "withdraw-all", depositId: DEPOSIT, expectRemaining: U(400) })).toBe(true);
    }
  });

  it("allows one wallet request at a time and settles a confirmed send until the index shows it", async () => {
    const w = world();
    const store = createOrderTxStore(memoryStorage());
    const deps = { client: w.client, sender: w.sender(), publicClient: w.publicClient, store };
    const [one, two] = await Promise.all([
      sendOrderTx(deps, { kind: "top-up", depositId: DEPOSIT, amount: U(100) }),
      sendOrderTx(deps, { kind: "withdraw", depositId: `${ESCROW}_8`, amount: U(1) }),
    ]);
    expect(one.status).toBe("sent");
    expect(two.status).toBe("busy");
    expect(w.sends).toBe(1);
    const held = lockFor(store.records(), OWNER, DEPOSIT);
    expect(held?.phase).toBe("settling");
    expect(held?.page).toBe(PAGE_ID);
    // The fake index already shows it: the next check settles it silently.
    expect((await reconcileOrderTxs(store, OWNER, { client: w.client, publicClient: w.publicClient })).map((e) => e.kind)).toEqual(["settled"]);
  });

  it("finds a withdrawal with nothing left behind it", async () => {
    const w = world({ filled: U(500), state: "delivered" });
    const r = record({ kind: "withdraw", amount: U(10).toString() });
    expect((await checkOrderTx(r, { client: w.client, publicClient: null })).kind).toBe("nothing-left");
  });
});
