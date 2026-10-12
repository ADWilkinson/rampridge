import { vi, type Mock } from "vitest";
import { CashError, deriveCashOrder, type CashClient, type CashErrorCode, type CashOrder, type PrepareResult } from "@zkp2p/cash";
import type { Address, Hex, TransactionReceipt, WalletClient } from "viem";
import type { TxSender, WalletCall, WalletKind } from "@/wallet/types";
import { createPendingSellStore, memoryStorage, type KeyValueStorage, type PendingSellStore } from "../persistence";

export const OWNER = "0x1111111111111111111111111111111111111111" as Address;
export const ESCROW = "0x2222222222222222222222222222222222222222" as Address;
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
export const VENMO_METHOD = `0x${"ab".repeat(32)}` as Hex;
export const PAYPAL_METHOD = `0x${"cd".repeat(32)}` as Hex;

export function hash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

export function receipt(txHash: Hex, status: "success" | "reverted" = "success"): TransactionReceipt {
  return { transactionHash: txHash, status, logs: [] } as unknown as TransactionReceipt;
}

export function plan(opts: { accessPolicyPaymentMethods?: Hex[]; steps?: PrepareResult["steps"] } = {}): PrepareResult {
  const methods = opts.accessPolicyPaymentMethods ?? [];
  return {
    txs: [
      { to: USDC, data: "0x095ea7b3", value: 0n, chainId: 8453 },
      { to: ESCROW, data: "0xdeadbeef", value: 0n, chainId: 8453 },
    ],
    steps: opts.steps ?? [
      { kind: "approve", description: "Approve" },
      { kind: "createDeposit", description: "Create" },
    ],
    register: { hashedOnchainIds: [hash(99)] },
    accessPolicyRequired: methods.length > 0,
    accessPolicyPaymentMethods: methods,
  };
}

export type MockCashClient = {
  [K in keyof CashClient]: Mock;
};

/** A CashClient whose every method is a vi.fn; set behaviour per test. */
export function mockCashClient(): MockCashClient & CashClient {
  const methods = [
    "prepareVenmoGmailConnect",
    "openVenmoGmailConnect",
    "isVenmoGmailConnected",
    "capabilities",
    "fillStats",
    "sourceCapabilities",
    "quoteSource",
    "executeSourceQuote",
    "relayStatus",
    "nearIntentsCapabilities",
    "quoteNearIntentsSource",
    "submitNearIntentsDeposit",
    "nearIntentsStatus",
    "estimate",
    "cashout",
    "prepare",
    "finalizePreparedCashout",
    "prepareAccessPolicy",
    "order",
    "buyer",
    "orders",
    "watch",
    "withdraw",
    "prepareWithdraw",
    "topUp",
    "prepareTopUp",
  ] as const;
  const client = Object.fromEntries(methods.map((m) => [m, vi.fn()])) as unknown as MockCashClient & CashClient;
  client.orders.mockResolvedValue([]);
  client.prepareAccessPolicy.mockImplementation((_depositId: string, method: Hex) => ({
    to: ESCROW,
    data: method,
    value: 0n,
    chainId: 8453,
  }));
  return client;
}

export type MockSender = TxSender & { sendCalls: Mock<(calls: WalletCall[], opts?: { label?: string }) => Promise<TransactionReceipt>> };

export function mockSender(kind: WalletKind = "smart", sponsored = kind === "smart"): MockSender {
  return {
    address: OWNER,
    kind,
    sponsored,
    sendCalls: vi.fn(),
    signMessage: vi.fn(),
    walletClient: {} as WalletClient,
  } as MockSender;
}

export function pendingStore(storage: KeyValueStorage = memoryStorage()): PendingSellStore {
  return createPendingSellStore(storage);
}

export function cashError(code: CashErrorCode, cause?: unknown, retryable = false): CashError {
  return new CashError({ code, message: code, retryable, remediation: "" }, cause === undefined ? undefined : { cause });
}

export function order(depositId: string, amount: bigint, updatedAt: number, extra: { taken?: bigint; withdrawn?: bigint } = {}): CashOrder {
  return deriveCashOrder(depositId, [], {
    remainingAmount: amount - (extra.taken ?? 0n) - (extra.withdrawn ?? 0n),
    takenAmount: extra.taken ?? 0n,
    withdrawnAmount: extra.withdrawn ?? 0n,
    status: "ACTIVE",
    updatedAt,
  });
}

export function userRejection(): Error {
  return Object.assign(new Error("User rejected the request."), { code: 4001 });
}
