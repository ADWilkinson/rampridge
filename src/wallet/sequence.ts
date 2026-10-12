import { decodeEventLog, isHash, parseAbi, toEventSelector, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";
import {
  entryPoint06Address,
  entryPoint07Address,
  entryPoint08Address,
  entryPoint09Address,
} from "viem/account-abstraction";
import {
  TransactionPendingError,
  TransactionRevertedError,
  UserRejectedError,
  WalletError,
  toWalletError,
  withCompletedHashes,
} from "./errors";
import { addressesEqual } from "./format";
import type { WalletCall } from "./types";

/** A call with every field filled in, ready for any wallet API. */
export interface NormalizedCall {
  to: Address;
  data: Hex;
  value: bigint;
}

export function normalizeCalls(calls: readonly WalletCall[]): NormalizedCall[] {
  if (calls.length === 0) throw new WalletError("invalid_request", "There is nothing to send.");
  return calls.map((call) => ({ to: call.to, data: call.data ?? "0x", value: call.value ?? 0n }));
}

/**
 * Checks what a wallet's send resolved with. The send itself succeeded, so a
 * missing hash leaves the outcome unknown: the error keeps `mayHaveLanded`.
 */
export function assertHash(value: unknown): Hash {
  if (typeof value === "string" && isHash(value)) return value;
  throw new WalletError("unknown", "Your wallet did not return a transaction hash.", { mayHaveLanded: true });
}

/** What viem's `onReplaced` reports when a wallet or bundler replaced the transaction (same sender and nonce). */
export interface ReceiptReplacement {
  reason: "cancelled" | "replaced" | "repriced";
  /** The replacement transaction. */
  transaction: { from: Address };
}

/** The slice of a viem PublicClient that receipt waiting needs (kept narrow for tests). */
export interface ReceiptSource {
  waitForTransactionReceipt(args: {
    hash: Hash;
    timeout?: number;
    onReplaced?: (replacement: ReceiptReplacement) => void;
  }): Promise<TransactionReceipt>;
}

export interface ReceiptExpectation {
  /**
   * The TxSender address: `msg.sender` for a plain transaction, and the
   * user operation `sender` for a bundled one (the smart account, or the
   * embedded EOA itself when Privy sponsors it through EIP-7702).
   */
  sender: Address;
  /** The hash is an ERC-4337 bundle, so the receipt must contain the sender's UserOperationEvent. */
  requireUserOperation?: boolean;
  timeoutMs: number;
}

/**
 * Waits for the receipt and resolves only when the sender's call succeeded.
 *
 * - A failed or abandoned wait becomes `TransactionPendingError(hash)`: the
 *   transaction may still land, so callers must not resend blindly.
 * - A mined revert, or a user operation that reverted inside a successful
 *   bundle, becomes `TransactionRevertedError`.
 * - A wallet cancellation (0-value self-send on the same nonce) becomes
 *   `UserRejectedError`; any other replacement that dropped the call becomes
 *   `TransactionRevertedError` (or pending when a bundler replaced it).
 *
 * When the receipt carries the sender's user operation, the returned
 * receipt's `logs` are narrowed to that operation (`transactionHash` and
 * `status` stay the bundle's), because a bundle can include other accounts'
 * operations and events.
 */
export async function waitForSuccessfulReceipt(
  client: ReceiptSource,
  hash: Hash,
  expectation: ReceiptExpectation,
): Promise<TransactionReceipt> {
  const seen: { replacement?: ReceiptReplacement } = {};
  let receipt: TransactionReceipt;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: expectation.timeoutMs,
      onReplaced: (replacement) => {
        seen.replacement = replacement;
      },
    });
  } catch (error) {
    throw new TransactionPendingError(hash, { cause: error });
  }

  const scope = scopeUserOperation(receipt, expectation.sender);
  const { replacement } = seen;
  if (replacement && replacement.reason !== "repriced" && scope.outcome === "not_found") {
    // viem resolves with the replacement's receipt, which is not this call.
    if (!addressesEqual(replacement.transaction.from, expectation.sender)) throw new TransactionPendingError(hash);
    if (replacement.reason === "cancelled") throw new UserRejectedError();
    throw new TransactionRevertedError(hash, null);
  }
  if (receipt.status === "reverted") throw new TransactionRevertedError(receipt.transactionHash, receipt);
  if (scope.outcome === "failed") {
    throw new TransactionRevertedError(receipt.transactionHash, { ...receipt, logs: scope.logs });
  }
  if (scope.outcome === "not_found") {
    if (expectation.requireUserOperation) throw new TransactionPendingError(receipt.transactionHash);
    return receipt;
  }
  return { ...receipt, logs: scope.logs };
}

export interface SequentialSendOptions {
  calls: readonly NormalizedCall[];
  /** Runs before each call, for example to re-check the wallet's chain. */
  beforeEach?: (index: number) => Promise<void>;
  sendOne: (call: NormalizedCall, index: number) => Promise<Hash>;
  waitForReceipt: (hash: Hash) => Promise<TransactionReceipt>;
}

/**
 * Sends calls one at a time, waiting for each to confirm before the next
 * (later calls usually depend on earlier ones, e.g. approve then deposit).
 * Any failure is rethrown as a `WalletError` carrying the hashes that already
 * confirmed, so a partial batch is never reported as a clean failure.
 */
export async function sendSequentially(options: SequentialSendOptions): Promise<TransactionReceipt> {
  const completed: Hash[] = [];
  let lastReceipt: TransactionReceipt | null = null;
  for (const [index, call] of options.calls.entries()) {
    try {
      await options.beforeEach?.(index);
      const hash = await options.sendOne(call, index);
      lastReceipt = await options.waitForReceipt(hash);
      completed.push(hash);
    } catch (error) {
      throw withCompletedHashes(toWalletError(error, { sending: true }), completed);
    }
  }
  if (!lastReceipt) throw new WalletError("invalid_request", "There is nothing to send.");
  return lastReceipt;
}

const userOperationEventAbi = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const USER_OPERATION_EVENT = toEventSelector("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
const BEFORE_EXECUTION = toEventSelector("BeforeExecution()");

const ENTRY_POINTS = new Set(
  [entryPoint06Address, entryPoint07Address, entryPoint08Address, entryPoint09Address].map((address) =>
    address.toLowerCase(),
  ),
);

type ReceiptLog = TransactionReceipt["logs"][number];

export interface UserOperationScope {
  /** The sender's `UserOperationEvent.success`; `not_found` when the receipt has no user operation for it. */
  outcome: "success" | "failed" | "not_found";
  /** Logs emitted while executing the sender's user operation(s), each ending with its UserOperationEvent. */
  logs: ReceiptLog[];
}

function decodeUserOperationEvent(log: ReceiptLog): { sender: Address; success: boolean } | null {
  try {
    const { args } = decodeEventLog({
      abi: userOperationEventAbi,
      eventName: "UserOperationEvent",
      data: log.data,
      topics: log.topics,
      strict: true,
    });
    return { sender: args.sender, success: args.success };
  } catch {
    return null;
  }
}

/**
 * Finds the sender's user operation inside a bundle receipt. A bundled user
 * operation can revert inside the account while the bundle transaction itself
 * succeeds, so the EntryPoint's `UserOperationEvent.success` is the real
 * outcome. The EntryPoint emits `BeforeExecution` once after validation, then
 * executes each operation in order and closes it with its `UserOperationEvent`,
 * so an operation's logs are the ones between the previous boundary and its
 * event (the same slicing bundlers use for `eth_getUserOperationReceipt`).
 * Only events emitted by a known EntryPoint count.
 */
export function scopeUserOperation(receipt: Pick<TransactionReceipt, "logs">, sender: Address): UserOperationScope {
  const logs: ReceiptLog[] = [];
  let start = 0;
  let found = false;
  let failed = false;
  receipt.logs.forEach((log, index) => {
    if (!ENTRY_POINTS.has(log.address.toLowerCase())) return;
    const topic = log.topics[0]?.toLowerCase();
    if (topic === BEFORE_EXECUTION) {
      start = index + 1;
      return;
    }
    if (topic !== USER_OPERATION_EVENT) return;
    const event = decodeUserOperationEvent(log);
    if (event && addressesEqual(event.sender, sender)) {
      found = true;
      if (!event.success) failed = true;
      logs.push(...receipt.logs.slice(start, index + 1));
    }
    start = index + 1;
  });
  return { outcome: found ? (failed ? "failed" : "success") : "not_found", logs };
}
