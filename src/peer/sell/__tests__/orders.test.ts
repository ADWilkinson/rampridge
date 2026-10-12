import { describe, expect, it, vi } from "vitest";
import { deriveCashOrder, type CashOrder } from "@zkp2p/cash";
import type { BalanceReader } from "../balance";
import { isSellFlowError } from "../errors";
import { fetchSellOrders, topUpSellOrder, toSellOrderRow, watchSellOrder, withdrawSellOrder } from "../orders";
import { cashError, ESCROW, hash, mockCashClient, mockSender, order, receipt, USDC, userRejection } from "./helpers";

const DEPOSIT = "0x2222222222222222222222222222222222222222_9";

describe("toSellOrderRow", () => {
  it("derives the unlocked balance, progress and actions", () => {
    const row = toSellOrderRow(order(DEPOSIT, 100_000_000n, 1_700_000_000, { taken: 25_000_000n }));
    expect(row.availableAmount).toBe(75_000_000n);
    expect(row.progress).toBe(0.25);
    expect(row.canWithdraw).toBe(true);
    expect(row.canTopUp).toBe(true);
    expect(row.explanation.length).toBeGreaterThan(0);
  });

  it("does not offer a top-up or withdrawal on a closed order", () => {
    const closed = deriveCashOrder(DEPOSIT, [], {
      remainingAmount: 0n,
      withdrawnAmount: 100_000_000n,
      status: "CLOSED",
      updatedAt: 1_700_000_000,
    });
    const row = toSellOrderRow(closed);
    expect(row.state).toBe("returned");
    expect(row.canTopUp).toBe(false);
    expect(row.canWithdraw).toBe(false);
    expect(row.availableAmount).toBe(0n);
  });
});

describe("fetchSellOrders", () => {
  it("lists live orders first and maps indexer failures", async () => {
    const client = mockCashClient();
    const live = order("0xlive_1", 10_000_000n, 100);
    const done = { ...order("0xdone_2", 10_000_000n, 200), isInFlight: false } as CashOrder;
    client.orders.mockResolvedValue([done, live]);
    expect((await fetchSellOrders(client, "0xabc")).map((r) => r.depositId)).toEqual(["0xlive_1", "0xdone_2"]);

    client.orders.mockRejectedValue(cashError("INDEXER_UNAVAILABLE", undefined, true));
    await expect(fetchSellOrders(client, "0xabc")).rejects.toMatchObject({ code: "INDEXER_UNAVAILABLE", retryable: true });
  });
});

describe("withdraw and top-up", () => {
  const tx = (data: `0x${string}`) => ({ to: ESCROW, data, value: 0n, chainId: 8453 });

  it("withdraws through the prepared plan in one sendCalls", async () => {
    const client = mockCashClient();
    const sender = mockSender();
    client.prepareWithdraw.mockResolvedValue({
      txs: [tx("0x01"), tx("0x02")],
      steps: [
        { kind: "pruneExpiredIntents", description: "Prune" },
        { kind: "withdrawDeposit", description: "Withdraw" },
      ],
    });
    sender.sendCalls.mockResolvedValue(receipt(hash(4)));
    const result = await withdrawSellOrder({ client, sender }, DEPOSIT);
    expect(client.prepareWithdraw).toHaveBeenCalledWith(DEPOSIT, {});
    expect(sender.sendCalls.mock.calls[0]?.[0]).toEqual([
      { to: ESCROW, data: "0x01", value: 0n },
      { to: ESCROW, data: "0x02", value: 0n },
    ]);
    expect(result).toMatchObject({ depositId: DEPOSIT, txHash: hash(4) });
  });

  it("passes a partial amount and explains a live buyer blocking a full close", async () => {
    const client = mockCashClient();
    const sender = mockSender();
    client.prepareWithdraw.mockResolvedValue({ txs: [tx("0x03")], steps: [{ kind: "removeFunds", description: "" }] });
    sender.sendCalls.mockResolvedValue(receipt(hash(5)));
    await withdrawSellOrder({ client, sender }, DEPOSIT, 5_000_000n);
    expect(client.prepareWithdraw).toHaveBeenCalledWith(DEPOSIT, { amount: 5_000_000n });

    client.prepareWithdraw.mockRejectedValue(cashError("ACTIVE_INTENT_BLOCKS_WITHDRAWAL", undefined, true));
    const err = await withdrawSellOrder({ client, sender }, DEPOSIT).catch((e: unknown) => e);
    expect(isSellFlowError(err) && err.recovery.action).toBe("wait");
  });

  it("never claims success for a reverted or unknown withdrawal", async () => {
    const client = mockCashClient();
    const sender = mockSender();
    client.prepareWithdraw.mockResolvedValue({ txs: [tx("0x04")], steps: [{ kind: "withdrawDeposit", description: "" }] });
    sender.sendCalls.mockResolvedValueOnce(receipt(hash(6), "reverted"));
    await expect(withdrawSellOrder({ client, sender }, DEPOSIT)).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    sender.sendCalls.mockRejectedValueOnce(new Error("timeout"));
    await expect(withdrawSellOrder({ client, sender }, DEPOSIT)).rejects.toMatchObject({ code: "SUBMISSION_UNKNOWN" });
    sender.sendCalls.mockRejectedValueOnce(userRejection());
    await expect(withdrawSellOrder({ client, sender }, DEPOSIT)).rejects.toMatchObject({ code: "USER_REJECTED" });
    sender.sendCalls.mockRejectedValueOnce(Object.assign(new Error("Allow pop-ups and try again."), { code: "popup_blocked" }));
    await expect(withdrawSellOrder({ client, sender }, DEPOSIT)).rejects.toMatchObject({
      code: "WALLET_NOT_SENT",
      message: "Allow pop-ups and try again.",
    });
  });

  it("checks the balance before a top-up and sends approve + addFunds", async () => {
    const client = mockCashClient();
    const sender = mockSender();
    const publicClient = { readContract: vi.fn().mockResolvedValue(1_000_000n) } as unknown as BalanceReader;
    await expect(topUpSellOrder({ client, sender, publicClient }, DEPOSIT, 2_000_000n)).rejects.toMatchObject({
      code: "INSUFFICIENT_BALANCE",
    });
    expect(client.prepareTopUp).not.toHaveBeenCalled();

    client.prepareTopUp.mockResolvedValue({
      txs: [{ to: USDC, data: "0x05", value: 0n, chainId: 8453 }, tx("0x06")],
      steps: [
        { kind: "approve", description: "" },
        { kind: "addFunds", description: "" },
      ],
    });
    sender.sendCalls.mockResolvedValue(receipt(hash(7)));
    await expect(topUpSellOrder({ client, sender, publicClient }, DEPOSIT, 500_000n)).resolves.toMatchObject({ txHash: hash(7) });
    await expect(topUpSellOrder({ client, sender }, DEPOSIT, 0n)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });
});

describe("watchSellOrder", () => {
  it("absorbs indexer lag, yields each update and stops when the order is done", async () => {
    const client = mockCashClient();
    const live = order(DEPOSIT, 10_000_000n, 100);
    const done = { ...live, state: "delivered", isInFlight: false } as CashOrder;
    let call = 0;
    client.watch.mockImplementation(async function* () {
      call += 1;
      if (call === 1) throw cashError("ORDER_NOT_FOUND", undefined, true);
      yield live;
      yield done;
    });
    const states: string[] = [];
    for await (const row of watchSellOrder(client, DEPOSIT, { pollIntervalMs: 1 })) states.push(row.state);
    expect(states).toEqual(["awaiting-buyer", "delivered"]);
    expect(call).toBe(2);
  });

  it("throws non-retryable errors as SellFlowError", async () => {
    const client = mockCashClient();
    client.watch.mockImplementation(async function* () {
      yield* [];
      throw cashError("INVALID_DEPOSIT_ID");
    });
    await expect(async () => {
      for await (const row of watchSellOrder(client, "bad", { pollIntervalMs: 1 })) void row;
    }).rejects.toMatchObject({ code: "INVALID_DEPOSIT_ID" });
  });
});
