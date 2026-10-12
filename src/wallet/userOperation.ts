import { isAddress, isHash, type Address, type Hash } from "viem";
import {
  entryPoint06Address,
  entryPoint07Address,
  entryPoint08Address,
  entryPoint09Address,
  formatUserOperation,
  getUserOperationHash,
  type EntryPointVersion,
  type RpcUserOperation,
} from "viem/account-abstraction";
import { WALLET_CHAIN } from "./constants";
import { AFTER_SUBMISSION_METHODS, SEND_USER_OPERATION, causeChain, requestBodies } from "./errors";

/**
 * Kept out of errors.ts, which loads with the first download: user operation
 * hashing is only needed once a send's outcome is lost.
 */

/** viem's WaitForUserOperationReceiptTimeoutError names the operation only in its message. */
const USER_OPERATION_TIMEOUT_TEXT = /User Operation with hash "(0x[0-9a-fA-F]{64})"/;

const ENTRY_POINT_VERSIONS: readonly (readonly [Address, EntryPointVersion])[] = [
  [entryPoint06Address, "0.6"],
  [entryPoint07Address, "0.7"],
  [entryPoint08Address, "0.8"],
  [entryPoint09Address, "0.9"],
];

/** The hash the bundler gives the user operation in an `eth_sendUserOperation` request (it is deterministic). */
function submittedOperationHash(params: unknown[]): Hash | null {
  const [operation, entryPoint] = params;
  if (!operation || typeof operation !== "object" || typeof entryPoint !== "string" || !isAddress(entryPoint, { strict: false })) return null;
  const version = ENTRY_POINT_VERSIONS.find(([address]) => address.toLowerCase() === entryPoint.toLowerCase())?.[1];
  if (!version) return null;
  try {
    return getUserOperationHash({
      chainId: WALLET_CHAIN.id,
      entryPointAddress: entryPoint,
      entryPointVersion: version,
      userOperation: formatUserOperation(operation as RpcUserOperation),
    });
  } catch {
    return null;
  }
}

/**
 * The user operation a failed smart-wallet send submitted (or may have), so
 * its outcome can be asked of the bundler (`eth_getUserOperationReceipt`)
 * instead of only searched for in the chain's history. Found in a receipt
 * wait that timed out, in a failed receipt or operation lookup, or computed
 * from the `eth_sendUserOperation` request whose answer was lost. Null when
 * the error carries none (the send never reached the bundler, or the wallet
 * is not a smart wallet).
 */
export function userOperationHashIn(error: unknown): Hash | null {
  const chain = causeChain(error);
  for (const entry of chain) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.name !== "WaitForUserOperationReceiptTimeoutError") continue;
    const text = [record.shortMessage, record.message].find((value): value is string => typeof value === "string") ?? "";
    const found = USER_OPERATION_TIMEOUT_TEXT.exec(text)?.[1];
    if (found) return found as Hash;
  }
  for (const entry of chain) {
    if (typeof entry !== "object" || entry === null) continue;
    for (const body of requestBodies(entry as Record<string, unknown>)) {
      const [first] = body.params;
      if (AFTER_SUBMISSION_METHODS.has(body.method) && typeof first === "string" && isHash(first)) return first;
      if (body.method === SEND_USER_OPERATION) {
        const hash = submittedOperationHash(body.params);
        if (hash) return hash;
      }
    }
  }
  return null;
}
