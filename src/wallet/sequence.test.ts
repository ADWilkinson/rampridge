import { describe, expect, it, vi } from "vitest";
import {
  HttpRequestError,
  TimeoutError,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import { beforeExecution, hash, receiptWith, transferLog, userOpEvent } from "./__tests__/userOps";
import { TransactionPendingError, TransactionRevertedError, UserRejectedError, WalletError } from "./errors";
import {
  assertHash,
  normalizeCalls,
  scopeUserOperation,
  sendSequentially,
  waitForSuccessfulReceipt,
  type NormalizedCall,
  type ReceiptReplacement,
  type ReceiptSource,
} from "./sequence";

const receipt = (h: Hash, status: "success" | "reverted" = "success") => receiptWith(h, [], status);
const TOKEN: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ESCROW: Address = "0x2f121CDDCA6d652f35e8B3E560f9760898888888";

const calls: NormalizedCall[] = [
  { to: TOKEN, data: "0x095ea7b3", value: 0n },
  { to: ESCROW, data: "0xabcdef01", value: 0n },
];

describe("normalizeCalls", () => {
  it("fills data and value defaults", () => {
    expect(normalizeCalls([{ to: TOKEN }])).toEqual([{ to: TOKEN, data: "0x", value: 0n }]);
  });

  it("rejects an empty batch", () => {
    expect(() => normalizeCalls([])).toThrow(WalletError);
  });
});

describe("assertHash", () => {
  it("accepts a 32-byte hash and rejects anything else", () => {
    expect(assertHash(hash(1))).toBe(hash(1));
    expect(() => assertHash("0x1234")).toThrow(/transaction hash/);
    expect(() => assertHash(undefined)).toThrow(WalletError);
  });
});

describe("sendSequentially", () => {
  it("sends in order and waits for each receipt before the next call", async () => {
    const events: string[] = [];
    const result = await sendSequentially({
      calls,
      beforeEach: async (i) => void events.push(`check:${i}`),
      sendOne: async (_call, i) => {
        events.push(`send:${i}`);
        return hash(i + 1);
      },
      waitForReceipt: async (h) => {
        events.push(`wait:${h.slice(-1)}`);
        return receipt(h);
      },
    });
    expect(events).toEqual(["check:0", "send:0", "wait:1", "check:1", "send:1", "wait:2"]);
    expect(result.transactionHash).toBe(hash(2));
  });

  it("reports the confirmed hashes when a later call is rejected", async () => {
    const sendOne = vi
      .fn<(call: NormalizedCall, index: number) => Promise<Hash>>()
      .mockResolvedValueOnce(hash(1))
      .mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const error = await sendSequentially({ calls, sendOne, waitForReceipt: async (h) => receipt(h) }).catch((e) => e);
    expect(error).toBeInstanceOf(UserRejectedError);
    expect(error.completedHashes).toEqual([hash(1)]);
  });

  it("treats a wallet timeout during a send as possibly broadcast, never as retryable", async () => {
    const sendOne = vi
      .fn<(call: NormalizedCall, index: number) => Promise<Hash>>()
      .mockResolvedValueOnce(hash(1))
      .mockRejectedValueOnce(new Error("Request timeout"));
    const error = await sendSequentially({ calls, sendOne, waitForReceipt: async (h) => receipt(h) }).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionPendingError);
    expect(error.hash).toBeNull();
    expect(error.message).toMatch(/before trying again/);
    expect(error.completedHashes).toEqual([hash(1)]);
  });

  it("stops at a reverted step without sending the rest", async () => {
    const sendOne = vi.fn(async (_call: NormalizedCall, i: number) => hash(i + 1));
    const error = await sendSequentially({
      calls,
      sendOne,
      waitForReceipt: async (h) => {
        throw new TransactionRevertedError(h, receipt(h, "reverted"));
      },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionRevertedError);
    expect(error.completedHashes).toEqual([]);
    expect(sendOne).toHaveBeenCalledTimes(1);
  });
});

describe("waitForSuccessfulReceipt", () => {
  const EOA: Address = "0x00000000000000000000000000000000000000ee";
  const SMART: Address = "0x00000000000000000000000000000000000000aa";
  const OTHER: Address = "0x00000000000000000000000000000000000000bb";
  const plain = { sender: EOA, timeoutMs: 1000 };
  const source = (result: TransactionReceipt | Error, replacement?: ReceiptReplacement): ReceiptSource => ({
    waitForTransactionReceipt: async ({ onReplaced }) => {
      if (result instanceof Error) throw result;
      if (replacement) onReplaced?.(replacement);
      return result;
    },
  });

  it("returns a successful plain receipt unchanged", async () => {
    const mined = receipt(hash(7));
    await expect(waitForSuccessfulReceipt(source(mined), hash(7), plain)).resolves.toBe(mined);
  });

  it("throws TransactionRevertedError for a reverted receipt", async () => {
    const error = await waitForSuccessfulReceipt(source(receipt(hash(7), "reverted")), hash(7), plain).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionRevertedError);
    expect(error.hash).toBe(hash(7));
  });

  it.each([
    ["a wait timeout", new WaitForTransactionReceiptTimeoutError({ hash: hash(9) })],
    ["an RPC timeout", new TimeoutError({ body: { method: "eth_getTransactionReceipt" }, url: "https://rpc" })],
    ["a rate-limited RPC", new HttpRequestError({ status: 429, url: "https://rpc" })],
  ])("turns %s after broadcast into TransactionPendingError carrying the hash", async (_label, failure) => {
    const error = await waitForSuccessfulReceipt(source(failure), hash(9), plain).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionPendingError);
    expect(error.hash).toBe(hash(9));
    expect(error.cause).toBe(failure);
  });

  it("rejects a user operation that reverted inside a successful bundle", async () => {
    const bundle = receiptWith(hash(8), [beforeExecution(), userOpEvent(EOA, false)]);
    const error = await waitForSuccessfulReceipt(source(bundle), hash(8), plain).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionRevertedError);
    expect(error.hash).toBe(hash(8));
  });

  it("narrows a bundle receipt to the sender's own operation", async () => {
    const token: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const theirs = transferLog(token, OTHER, token, 1n);
    const ours = transferLog(token, SMART, token, 2n);
    const bundle = receiptWith(hash(8), [
      beforeExecution(),
      theirs,
      userOpEvent(OTHER, true),
      ours,
      userOpEvent(SMART, true),
    ]);
    const result = await waitForSuccessfulReceipt(source(bundle), hash(8), {
      sender: SMART,
      requireUserOperation: true,
      timeoutMs: 1000,
    });
    expect(result.transactionHash).toBe(hash(8));
    expect(result.status).toBe("success");
    expect(result.logs).toEqual([ours, bundle.logs[4]]);
  });

  it("reports a bundle without the sender's operation as pending, never as success", async () => {
    const bundle = receiptWith(hash(8), [beforeExecution(), userOpEvent(OTHER, true)]);
    const error = await waitForSuccessfulReceipt(source(bundle), hash(8), {
      sender: SMART,
      requireUserOperation: true,
      timeoutMs: 1000,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionPendingError);
    expect(error.hash).toBe(hash(8));
  });

  it("treats a wallet cancellation of the same nonce as a rejection", async () => {
    const cancel = receipt(hash(11));
    const error = await waitForSuccessfulReceipt(
      source(cancel, { reason: "cancelled", transaction: { from: EOA } }),
      hash(10),
      plain,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(UserRejectedError);
  });

  it("does not report a different transaction on the same nonce as this call", async () => {
    const error = await waitForSuccessfulReceipt(
      source(receipt(hash(11)), { reason: "replaced", transaction: { from: EOA } }),
      hash(10),
      plain,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionRevertedError);
    expect(error.hash).toBe(hash(10));
  });

  it("keeps a bundler replacement pending unless it carries the sender's operation", async () => {
    const bundler: Address = "0x00000000000000000000000000000000000000cc";
    const without = await waitForSuccessfulReceipt(
      source(receipt(hash(11)), { reason: "replaced", transaction: { from: bundler } }),
      hash(10),
      plain,
    ).catch((e) => e);
    expect(without).toBeInstanceOf(TransactionPendingError);
    expect(without.hash).toBe(hash(10));

    const including = receiptWith(hash(11), [beforeExecution(), userOpEvent(EOA, true)]);
    await expect(
      waitForSuccessfulReceipt(source(including, { reason: "replaced", transaction: { from: bundler } }), hash(10), plain),
    ).resolves.toMatchObject({ transactionHash: hash(11) });
  });

  it("accepts a sped-up (repriced) transaction", async () => {
    await expect(
      waitForSuccessfulReceipt(
        source(receipt(hash(11)), { reason: "repriced", transaction: { from: EOA } }),
        hash(10),
        plain,
      ),
    ).resolves.toMatchObject({ transactionHash: hash(11) });
  });
});

describe("scopeUserOperation", () => {
  const smartAccount: Address = "0x00000000000000000000000000000000000000aa";
  const other: Address = "0x00000000000000000000000000000000000000bb";

  it("reads the inner success flag for the smart account", () => {
    expect(scopeUserOperation({ logs: [userOpEvent(smartAccount, true)] }, smartAccount).outcome).toBe("success");
    expect(scopeUserOperation({ logs: [userOpEvent(smartAccount, false)] }, smartAccount).outcome).toBe("failed");
    expect(
      scopeUserOperation({ logs: [userOpEvent(smartAccount, true, entryPoint07Address)] }, smartAccount).outcome,
    ).toBe("success");
  });

  it("ignores other senders and events not emitted by an EntryPoint", () => {
    expect(scopeUserOperation({ logs: [userOpEvent(other, false)] }, smartAccount)).toEqual({
      outcome: "not_found",
      logs: [],
    });
    expect(scopeUserOperation({ logs: [userOpEvent(smartAccount, false, TOKEN)] }, smartAccount).outcome).toBe(
      "not_found",
    );
    expect(scopeUserOperation({ logs: [] }, smartAccount).outcome).toBe("not_found");
  });

  it("excludes validation-phase logs and other operations' logs", () => {
    const validation = transferLog(TOKEN, other, smartAccount, 9n);
    const theirs = transferLog(TOKEN, other, ESCROW, 1n);
    const ours = transferLog(TOKEN, smartAccount, ESCROW, 2n);
    const logs = [validation, beforeExecution(), ours, userOpEvent(smartAccount, true), theirs, userOpEvent(other, true)];
    const scope = scopeUserOperation({ logs }, smartAccount);
    expect(scope.outcome).toBe("success");
    expect(scope.logs).toEqual([ours, logs[3]]);
  });

  it("fails when any of the sender's operations in the bundle failed", () => {
    const logs = [beforeExecution(), userOpEvent(smartAccount, true), userOpEvent(smartAccount, false)];
    expect(scopeUserOperation({ logs }, smartAccount).outcome).toBe("failed");
  });
});
