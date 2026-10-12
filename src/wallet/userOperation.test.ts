import { describe, expect, it, vi } from "vitest";
import { HttpRequestError, RpcRequestError, TimeoutError, type Hash, type Hex } from "viem";
import {
  UserOperationExecutionError,
  WaitForUserOperationReceiptTimeoutError,
  entryPoint06Address,
  formatUserOperation,
  getUserOperationHash,
  type RpcUserOperation,
} from "viem/account-abstraction";
import { WALLET_CHAIN } from "./constants";
import { TransactionPendingError } from "./errors";
import { userOperationStatus, type BundlerRequest } from "./senders";
import { userOperationHashIn } from "./userOperation";

const OP_HASH = `0x${"ab".repeat(32)}` as Hash;
const TX = `0x${"12".repeat(32)}` as Hash;
const BUNDLER_URL = "https://api.developer.coinbase.com/rpc/v1/base/SECRETKEY123";

/** A signed v0.6 user operation as permissionless sends it (JSON-RPC hex). */
const RPC_OPERATION: RpcUserOperation<"0.6"> = {
  sender: "0x1111111111111111111111111111111111111111",
  nonce: "0x18f3a0c2d11000000000000000000",
  initCode: "0x",
  callData: "0xb61d27f6" as Hex,
  callGasLimit: "0x493e0",
  verificationGasLimit: "0x61a80",
  preVerificationGas: "0x186a0",
  maxFeePerGas: "0x2faf080",
  maxPriorityFeePerGas: "0xf4240",
  paymasterAndData: `0x${"22".repeat(20)}${"00".repeat(77)}` as Hex,
  signature: `0x${"33".repeat(65)}` as Hex,
};

const expectedHash = getUserOperationHash({
  chainId: WALLET_CHAIN.id,
  entryPointAddress: entryPoint06Address,
  entryPointVersion: "0.6",
  userOperation: formatUserOperation(RPC_OPERATION) as never,
});

const sendBody = { jsonrpc: "2.0", id: 7, method: "eth_sendUserOperation", params: [RPC_OPERATION, entryPoint06Address] };

describe("userOperationHashIn", () => {
  it("reads the hash from a receipt wait that timed out, however deep it is wrapped", () => {
    const timeout = new WaitForUserOperationReceiptTimeoutError({ hash: OP_HASH });
    expect(userOperationHashIn(timeout)).toBe(OP_HASH);
    expect(userOperationHashIn(new TransactionPendingError(null, { cause: new Error("privy", { cause: timeout }) }))).toBe(OP_HASH);
  });

  it("reads it from a failed receipt or operation lookup", () => {
    const receipt = new HttpRequestError({ body: { method: "eth_getUserOperationReceipt", params: [OP_HASH] }, status: 502, url: BUNDLER_URL });
    expect(userOperationHashIn(receipt)).toBe(OP_HASH);
    const byHash = new RpcRequestError({ body: { method: "eth_getUserOperationByHash", params: [OP_HASH] }, error: { code: -32603, message: "internal" }, url: BUNDLER_URL });
    expect(userOperationHashIn(byHash)).toBe(OP_HASH);
  });

  it("computes it from an eth_sendUserOperation whose answer was lost", () => {
    // An HTTP error keeps the request body; a timeout prints it into its details.
    const lost = new HttpRequestError({ body: sendBody, status: 502, url: BUNDLER_URL });
    expect(userOperationHashIn(new UserOperationExecutionError(lost, {} as never))).toBe(expectedHash);
    const timedOut = new TimeoutError({ body: sendBody, url: BUNDLER_URL });
    expect(userOperationHashIn(timedOut)).toBe(expectedHash);
  });

  it("is null when the send never reached the bundler", () => {
    expect(userOperationHashIn(new Error("socket hang up"))).toBeNull();
    expect(userOperationHashIn(new HttpRequestError({ body: { method: "eth_estimateUserOperationGas", params: [RPC_OPERATION] }, status: 500, url: BUNDLER_URL }))).toBeNull();
    // An unknown EntryPoint can't be hashed for.
    const odd = new HttpRequestError({ body: { ...sendBody, params: [RPC_OPERATION, "0x0000000000000000000000000000000000000001"] }, status: 502, url: BUNDLER_URL });
    expect(userOperationHashIn(odd)).toBeNull();
  });
});

describe("userOperationStatus", () => {
  function bundler(answers: Partial<Record<string, unknown>>): BundlerRequest & ReturnType<typeof vi.fn> {
    return vi.fn(async ({ method }: { method: string }) => {
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    }) as never;
  }

  it("reports an included operation with its bundle transaction", async () => {
    const request = bundler({ eth_getUserOperationReceipt: { success: true, receipt: { transactionHash: TX } } });
    await expect(userOperationStatus(request, OP_HASH)).resolves.toEqual({ status: "included", success: true, transactionHash: TX });
    expect(request).toHaveBeenCalledWith({ method: "eth_getUserOperationReceipt", params: [OP_HASH] });
    const reverted = bundler({ eth_getUserOperationReceipt: { success: false, receipt: { transactionHash: TX } } });
    await expect(userOperationStatus(reverted, OP_HASH)).resolves.toEqual({ status: "included", success: false, transactionHash: TX });
  });

  it("tells a queued operation from one the bundler has no record of", async () => {
    await expect(userOperationStatus(bundler({ eth_getUserOperationByHash: { userOperation: {} } }), OP_HASH)).resolves.toEqual({ status: "queued" });
    await expect(userOperationStatus(bundler({}), OP_HASH)).resolves.toEqual({ status: "absent" });
  });

  it("is unknown when the bundler can't be asked", async () => {
    await expect(userOperationStatus(bundler({ eth_getUserOperationReceipt: new Error("502") }), OP_HASH)).resolves.toEqual({ status: "unknown" });
  });
});
