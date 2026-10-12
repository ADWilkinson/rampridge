import { describe, expect, it } from "vitest";
import {
  ChainMismatchError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  RpcRequestError,
  TimeoutError,
  TransactionExecutionError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
  parseAbi,
} from "viem";
import {
  InsufficientPrefundError,
  PaymasterFunctionRevertedError,
  UserOperationExecutionError,
  WaitForUserOperationReceiptTimeoutError,
  type UserOperation,
} from "viem/account-abstraction";
import { base } from "viem/chains";
import {
  CallRevertedError,
  ChainSwitchError,
  InsufficientGasError,
  PopupBlockedError,
  SponsorshipError,
  TransactionPendingError,
  UserRejectedError,
  WalletError,
  WalletTimeoutError,
  isSponsorshipUnavailable,
  stackFrames,
  toWalletError,
  userOperationSubmission,
  walletErrorMessage,
  withCompletedHashes,
} from "./errors";
import { cdpPolicyRefusal, CDP_URL, ORCHESTRATOR_V3 } from "./__tests__/userOps";

const HASH = `0x${"ab".repeat(32)}` as const;

/** The request arguments viem prints into UserOperationExecutionError.message, paymaster fields included. */
const SPONSORED_USER_OPERATION: UserOperation<"0.7"> = {
  callData: "0x1234",
  callGasLimit: 1n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  nonce: 1n,
  preVerificationGas: 1n,
  sender: "0x1111111111111111111111111111111111111111",
  signature: "0x",
  verificationGasLimit: 1n,
  paymaster: "0x2222222222222222222222222222222222222222",
  paymasterData: "0xabcdef",
  paymasterVerificationGasLimit: 1n,
  paymasterPostOpGasLimit: 1n,
};

function bundlerError(code: number, message: string) {
  return new RpcRequestError({ body: { method: "eth_estimateUserOperationGas" }, error: { code, message }, url: "https://bundler" });
}

describe("toWalletError", () => {
  it("returns an existing WalletError unchanged, even when wrapped", () => {
    const original = new InsufficientGasError("0x0000000000000000000000000000000000000001");
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: original }) });
    expect(toWalletError(wrapped)).toBe(original);
  });

  it.each([
    ["viem UserRejectedRequestError", new UserRejectedRequestError(new Error("nope"))],
    ["EIP-1193 code 4001", Object.assign(new Error("whatever"), { code: 4001 })],
    ["ethers ACTION_REJECTED", Object.assign(new Error("whatever"), { code: "ACTION_REJECTED" })],
    ["Privy modal exit", new Error("User exited the modal before submitting the transaction")],
    ["Privy cross-app popup closed", new Error("User rejected request")],
    ["Privy rejection", new Error("Transaction was rejected by the user")],
    ["MetaMask signature denial", new Error("MetaMask Tx Signature: User denied transaction signature.")],
  ])("classifies %s as user_rejected", (_label, error) => {
    expect(toWalletError(error)).toBeInstanceOf(UserRejectedError);
  });

  it("finds a rejection nested inside viem's transaction wrapper", () => {
    const error = new TransactionExecutionError(new UserRejectedRequestError(new Error("denied")), {
      account: { address: "0x0000000000000000000000000000000000000001", type: "json-rpc" },
      chain: base,
    });
    expect(toWalletError(error).code).toBe("user_rejected");
  });

  it("classifies a blocked cross-app window", () => {
    expect(toWalletError(new Error("Failed to initialize signature request"))).toBeInstanceOf(PopupBlockedError);
  });

  it.each([
    ["viem InsufficientFundsError", new InsufficientFundsError()],
    ["node message", new Error("insufficient funds for gas * price + value")],
    ["bundler prefund", new Error("UserOperation reverted during simulation with reason: AA21 didn't pay prefund")],
  ])("classifies %s as insufficient_gas", (_label, error) => {
    expect(toWalletError(error)).toBeInstanceOf(InsufficientGasError);
  });

  it("classifies a paymaster refusal as sponsorship_failed", () => {
    expect(toWalletError(new Error("AA33 reverted (or OOG)"))).toBeInstanceOf(SponsorshipError);
    expect(toWalletError(new Error("Cannot sponsor transactions for externally connected wallet."))).toBeInstanceOf(
      SponsorshipError,
    );
  });

  it("classifies chain problems", () => {
    expect(toWalletError(new ChainMismatchError({ chain: base, currentChainId: 1 }))).toBeInstanceOf(ChainSwitchError);
    expect(toWalletError(Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }))).toBeInstanceOf(
      ChainSwitchError,
    );
  });

  it("treats a receipt wait timeout as pending, never as failed", () => {
    const error = toWalletError(new WaitForTransactionReceiptTimeoutError({ hash: HASH }));
    expect(error).toBeInstanceOf(TransactionPendingError);
  });

  it("keeps the revert reason of a call that would fail", () => {
    const abi = parseAbi(["function deposit()"]);
    const revert = new ContractFunctionRevertedError({ abi, functionName: "deposit", message: "Insufficient allowance" });
    const error = toWalletError(new Error("simulation failed", { cause: revert }));
    expect(error).toBeInstanceOf(CallRevertedError);
    expect((error as CallRevertedError).reason).toBe("Insufficient allowance");
  });

  it("classifies a contract revert in a sponsored user operation as a revert, with its reason", () => {
    const revert = new ExecutionRevertedError({
      cause: bundlerError(-32521, "execution reverted: DepositAmountTooLow"),
      message: "execution reverted: DepositAmountTooLow",
    });
    const error = new UserOperationExecutionError(revert, SPONSORED_USER_OPERATION);
    expect(error.message).toMatch(/paymaster/);
    const walletError = toWalletError(error, { sending: true });
    expect(walletError).toBeInstanceOf(CallRevertedError);
    expect((walletError as CallRevertedError).reason).toBe("DepositAmountTooLow");
  });

  it("still classifies genuine paymaster and prefund failures inside a user operation", () => {
    const paymaster = new UserOperationExecutionError(
      new PaymasterFunctionRevertedError({ cause: bundlerError(-32500, "AA33 reverted") }),
      SPONSORED_USER_OPERATION,
    );
    expect(toWalletError(paymaster)).toBeInstanceOf(SponsorshipError);
    const prefund = new UserOperationExecutionError(
      new InsufficientPrefundError({ cause: bundlerError(-32500, "AA21 didn't pay prefund") }),
      SPONSORED_USER_OPERATION,
    );
    expect(toWalletError(prefund)).toBeInstanceOf(InsufficientGasError);
  });

  it("does not show raw revert data as a reason", () => {
    const error = toWalletError(new Error("execution reverted: 0x8baa579f"));
    expect(error).toBeInstanceOf(CallRevertedError);
    expect((error as CallRevertedError).reason).toBeNull();
  });

  it("classifies wallet timeouts outside a send as retry-with-care", () => {
    const error = toWalletError(new Error("Request timeout"));
    expect(error).toBeInstanceOf(WalletTimeoutError);
    expect(error.message).toMatch(/before trying again/);
  });

  it.each([
    ["Privy cross-app window timeout", new Error("Request timeout")],
    ["viem RPC timeout", new TimeoutError({ body: { method: "eth_sendRawTransaction" }, url: "https://rpc" })],
  ])("treats a %s during a send as possibly broadcast", (_label, failure) => {
    const error = toWalletError(failure, { sending: true });
    expect(error).toBeInstanceOf(TransactionPendingError);
    expect((error as TransactionPendingError).hash).toBeNull();
    expect(error.message).toMatch(/before trying again/);
  });

  it("falls back to unknown with the first line of the original message", () => {
    const error = toWalletError(new Error("Something odd\nstack-ish detail"));
    expect(error.code).toBe("unknown");
    expect(error.message).toBe("Something odd");
    expect(toWalletError(undefined).message).toMatch(/Something went wrong/);
  });
});

describe("isSponsorshipUnavailable", () => {
  it("matches Privy's pre-broadcast sponsorship refusals only", () => {
    expect(isSponsorshipUnavailable(new Error("Sponsoring is only supported for wallets on the TEE stack"))).toBe(true);
    expect(isSponsorshipUnavailable(new Error("Cannot sponsor transactions for externally connected wallet."))).toBe(true);
    expect(isSponsorshipUnavailable(new Error("execution reverted"))).toBe(false);
  });
});

describe("walletErrorMessage", () => {
  it("returns the typed message", () => {
    expect(walletErrorMessage(new UserRejectedError())).toBe("You cancelled the request in your wallet.");
  });

  it("warns when earlier steps already confirmed", () => {
    const error = withCompletedHashes(new UserRejectedError(), [HASH]);
    expect(error.completedHashes).toEqual([HASH]);
    expect(walletErrorMessage(error)).toMatch(/already confirmed on Base/);
  });

  it("does not overwrite hashes recorded closer to the failure", () => {
    const error = withCompletedHashes(new WalletError("unknown", "x"), [HASH]);
    withCompletedHashes(error, []);
    expect(error.completedHashes).toEqual([HASH]);
  });
});

describe("smart-wallet failures (Privy -> permissionless -> CDP bundler and paymaster)", () => {
  it("reports a paymaster policy refusal as sponsorship, with the paymaster's reason and no URL", () => {
    const error = toWalletError(cdpPolicyRefusal());
    expect(error).toBeInstanceOf(SponsorshipError);
    expect(error.mayHaveLanded).toBe(false);
    expect(error.message).toBe("The bank couldn't sponsor this transaction, so nothing was sent. Try again later.");
    expect((error as SponsorshipError).reason).toBe(
      `request denied - policy rejected: called address not in allowlist: ${ORCHESTRATOR_V3}`,
    );
    expect(JSON.stringify((error as SponsorshipError).reason)).not.toContain("SECRET");
  });

  it("treats any failed paymaster call as sponsorship, even a timeout", () => {
    const error = toWalletError(new TimeoutError({ body: { method: "pm_getPaymasterData" }, url: CDP_URL }), { sending: true });
    expect(error).toBeInstanceOf(SponsorshipError);
    expect(error.mayHaveLanded).toBe(false);
  });

  it.each([
    ["a paymaster policy refusal", cdpPolicyRefusal(), "not_submitted"],
    [
      "a gas estimate that reverts",
      new UserOperationExecutionError(
        new ExecutionRevertedError({ cause: bundlerError(-32521, "execution reverted"), message: "execution reverted" }),
        SPONSORED_USER_OPERATION,
      ),
      "not_submitted",
    ],
    ["a signer failure", new Error("Unable to request embedded owner for eth_accounts"), "not_submitted"],
    [
      "a bundler refusing eth_sendUserOperation",
      new UserOperationExecutionError(
        new RpcRequestError({ body: { method: "eth_sendUserOperation" }, error: { code: -32500, message: "AA25 invalid account nonce" }, url: CDP_URL }),
        SPONSORED_USER_OPERATION,
      ),
      "not_submitted",
    ],
    [
      "eth_sendUserOperation timing out",
      new UserOperationExecutionError(new TimeoutError({ body: { method: "eth_sendUserOperation" }, url: CDP_URL }), SPONSORED_USER_OPERATION),
      "unknown",
    ],
    [
      "eth_sendUserOperation failing inside the bundler",
      new RpcRequestError({ body: { method: "eth_sendUserOperation" }, error: { code: -32603, message: "internal error" }, url: CDP_URL }),
      "unknown",
    ],
    [
      "eth_sendUserOperation answered with a 503",
      new HttpRequestError({ body: { method: "eth_sendUserOperation" }, status: 503, url: CDP_URL }),
      "unknown",
    ],
    ["the receipt wait timing out", new WaitForUserOperationReceiptTimeoutError({ hash: HASH }), "submitted"],
    [
      "polling for the receipt failing",
      new HttpRequestError({ body: { method: "eth_getUserOperationReceipt" }, status: 500, url: CDP_URL }),
      "submitted",
    ],
  ])("places %s at the right submission stage", (_label, error, stage) => {
    expect(userOperationSubmission(error)).toBe(stage);
  });

  it("marks only possibly-submitted failures as mayHaveLanded", () => {
    expect(toWalletError(new Error("odd"), { sending: true }).mayHaveLanded).toBe(true);
    expect(toWalletError(new Error("odd")).mayHaveLanded).toBe(false);
    expect(toWalletError(new Error("Request timeout")).mayHaveLanded).toBe(false);
    expect(toWalletError(new Error("Request timeout"), { sending: true }).mayHaveLanded).toBe(true);
    expect(new TransactionPendingError(null).mayHaveLanded).toBe(true);
    expect(new UserRejectedError().mayHaveLanded).toBe(false);
    expect(new WalletError("unknown", "x", { mayHaveLanded: false }).mayHaveLanded).toBe(false);
  });
});

describe("stackFrames", () => {
  it("keeps the frames and drops the message lines, where viem quotes the request URL and body", () => {
    const frames = stackFrames(cdpPolicyRefusal());
    expect(frames).toMatch(/^at /);
    expect(frames).not.toContain("SECRETKEY123");
    expect(frames).not.toContain("Request body");
    expect(frames?.split("\n").every((line) => line.startsWith("at "))).toBe(true);
  });

  it("keeps Safari and Firefox frames, and has nothing for a value without a stack", () => {
    const error = new Error("x");
    error.stack = "Error: x\nsignal@https://www.rampridge.xyz/assets/index-abc.js:1:2345\n@https://www.rampridge.xyz/assets/index-abc.js:3:4";
    expect(stackFrames(error)).toBe(
      "signal@https://www.rampridge.xyz/assets/index-abc.js:1:2345\n@https://www.rampridge.xyz/assets/index-abc.js:3:4",
    );
    expect(stackFrames("a string")).toBeUndefined();
    expect(stackFrames(Object.assign(new Error("y"), { stack: "Error: y" }))).toBeUndefined();
  });
});
