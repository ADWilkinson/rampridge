import { APIError, NetworkError, ValidationError } from "@zkp2p/sdk";
import {
  BaseError,
  ContractFunctionRevertedError,
  InvalidInputRpcError,
  RpcRequestError,
  UserRejectedRequestError,
  encodeErrorResult,
  parseAbi,
} from "viem";
import { describe, expect, it } from "vitest";
import { PEER_ABIS } from "../../client";
import { MarketError } from "../../market";
import { cdpPolicyRefusal } from "@/wallet/__tests__/userOps";
import { SponsorshipError } from "@/wallet/errors";
import { sendMayHaveLanded } from "../chain";
import { BuyFlowError, decodeRevertName, technicalDetail, toBuyError } from "../errors";
import { BUYER, INTENT_HASH } from "./helpers";

function revert(errorName: string, args: readonly unknown[] = [], abi = PEER_ABIS.orchestrator) {
  const data = encodeErrorResult({ abi, errorName, args } as never);
  return new BaseError("Execution reverted", { cause: new ContractFunctionRevertedError({ abi, data, functionName: "signalIntent" }) });
}

/** The shape src/wallet throws (WalletError subclasses carry a string code). */
function walletError(name: string, code: string, message: string, cause?: unknown) {
  const error = new Error(message, { cause }) as Error & { code: string };
  error.name = name;
  error.code = code;
  return error;
}

describe("contract reverts", () => {
  it("decodes orchestrator and escrow errors from revert data", () => {
    expect(decodeRevertName(revert("AccountHasActiveIntent", [BUYER, INTENT_HASH]))).toBe("AccountHasActiveIntent");
    expect(decodeRevertName(revert("InsufficientDepositLiquidity", [1n, 2n, 3n], PEER_ABIS.escrow))).toBe(
      "InsufficientDepositLiquidity",
    );
  });

  it("maps the reverts a buyer can hit", () => {
    expect(toBuyError(revert("AccountHasActiveIntent", [BUYER, INTENT_HASH]), { stage: "signal" })).toMatchObject({
      code: "active_intent",
      recoverable: true,
    });
    expect(toBuyError(revert("SignatureExpired", [1n, 2n]), { stage: "signal" }).code).toBe("signature_expired");
    expect(toBuyError(revert("RateBelowMinimum", [1n, 2n]), { stage: "signal" }).code).toBe("rate_changed");
    expect(toBuyError(revert("PaymentVerificationFailed"), { stage: "fulfill" }).code).toBe(
      "payment_verification_failed",
    );
    expect(toBuyError(revert("IntentNotFound", [INTENT_HASH]), { stage: "cancel" })).toMatchObject({
      code: "intent_closed",
      recoverable: false,
    });
  });

  it("sends the player to another offer when Peer signed fee legs the orchestrator rejects", () => {
    const duplicate = revert("DuplicateReferralFeeRecipient", ["0xC141Cbe4f4a9CAbc3cc78159a9268a4e008922CD"]);
    expect(toBuyError(duplicate, { stage: "signal" })).toMatchObject({ code: "liquidity", recoverable: true });
    expect(toBuyError(revert("ReferralFeeExceedsMaximum", [1n, 2n]), { stage: "signal" }).code).toBe("liquidity");
  });

  it("decodes reverts wrapped in a wallet error", () => {
    const wrapped = walletError("CallRevertedError", "call_reverted", "The transaction would fail.", revert("AmountAboveMax", [2n, 1n]));
    expect(toBuyError(wrapped, { stage: "signal" }).code).toBe("amount_too_high");
  });
});

describe("wallet failures", () => {
  it("maps rejection and gas", () => {
    expect(toBuyError(new UserRejectedRequestError(new Error("User rejected the request.")), { stage: "signal" })).toMatchObject({
      code: "user_rejected",
      message: "You cancelled in your wallet.",
    });
    expect(toBuyError(walletError("UserRejectedError", "user_rejected", "x"), { stage: "fulfill" }).code).toBe("user_rejected");
    expect(toBuyError(walletError("InsufficientGasError", "insufficient_gas", "x"), { stage: "signal" }).code).toBe(
      "insufficient_gas",
    );
    expect(toBuyError(new Error("insufficient funds for gas * price + value"), { stage: "signal" }).code).toBe(
      "insufficient_gas",
    );
  });

  it("passes other wallet messages through and flags pending sends", () => {
    expect(toBuyError(walletError("PopupBlockedError", "popup_blocked", "Allow pop-ups."), { stage: "signal" })).toMatchObject({
      code: "wallet",
      message: "Allow pop-ups.",
    });
    expect(toBuyError(walletError("TransactionPendingError", "receipt_timeout", "x"), { stage: "signal" }).code).toBe(
      "tx_pending",
    );
  });
});

describe("Curator and attestation", () => {
  it("maps wallet screening", () => {
    expect(toBuyError(new APIError("Wallet is blocked", 403), { stage: "signal" })).toMatchObject({
      code: "wallet_blocked",
      recoverable: false,
    });
    expect(toBuyError(new APIError("Screening unavailable", 503), { stage: "signal" })).toMatchObject({
      code: "screening_unavailable",
      recoverable: true,
    });
    expect(toBuyError(new APIError("Too many", 429), { stage: "quote" }).code).toBe("rate_limited");
  });

  it("maps attestation rejections with the payee", () => {
    const mismatch = toBuyError(new APIError("UnifiedPaymentVerifier: payee mismatch", 400), {
      stage: "fulfill",
      platform: "revolut",
      payee: "@revtag",
    });
    expect(mismatch).toMatchObject({ code: "payee_mismatch", recoverable: true });
    expect(mismatch.message).toContain("@revtag");
    expect(toBuyError(new APIError("Nullifier has already been used.", 400), { stage: "fulfill" }).code).toBe(
      "nullifier_used",
    );
    expect(
      toBuyError(new APIError("Chase Zelle payment status is not completed or delivered", 404), {
        stage: "fulfill",
        platform: "zelle",
      }).code,
    ).toBe("payment_not_settled");
    expect(toBuyError(new APIError("Cash App returned status 429", 400), { stage: "fulfill", platform: "cashapp" }).code).toBe(
      "payment_session_expired",
    );
  });

  it("sends a refused or stale captured session to a fresh capture", () => {
    for (const error of [
      new APIError("Revolut session is unauthorized", 401),
      new APIError("Monobank business session is invalid or expired", 400),
      new APIError("Buyer TEE session material failed authentication", 400),
      new APIError("Venmo said no", 401),
    ]) {
      expect(toBuyError(error, { stage: "fulfill", platform: "revolut" }).code, error.message).toBe("payment_session_expired");
    }
  });

  it("names the payment-level rejections that picking another payment fixes", () => {
    const at = (message: string, status = 400) => toBuyError(new APIError(message, status), { stage: "fulfill", platform: "wise" });
    expect(at("UnifiedPaymentVerifier: payment timestamp before intent window")).toMatchObject({ code: "payment_verification_failed" });
    expect(at("UnifiedPaymentVerifier: payment timestamp before intent window").message).toContain("before this order was placed");
    expect(at("UnifiedPaymentVerifier: currency mismatch").message).toContain("different currency");
    expect(at("Wise: neither source nor target currency matches intent currency").message).toContain("another currency on both sides");
    expect(at("UnifiedPaymentVerifier: payment method mismatch").message).toContain("Wise");
    expect(at("No matching Revolut buyer payment found for index: selected transaction is missing recipient username", 404).message).toContain(
      "didn't show who",
    );
    expect(at("UnifiedPaymentVerifier: intent hash mismatch").code).toBe("payment_verification_failed");
    // The attestation service's own rate limits clear by themselves.
    expect(at("Cash App in-flight limit reached").code).not.toBe("payment_verification_failed");
    expect(at("Chime payment status is not SUCCEEDED").code).toBe("payment_not_settled");
    const xPending = toBuyError(new APIError("X Money transaction status is not Settled", 400), { stage: "fulfill", platform: "xmoney" });
    expect(xPending.code).toBe("payment_not_settled");
    expect(xPending.message).toContain("cancel it on X");
  });

  it("never says 'failed on-chain' for a signal the simulation refused before sending", () => {
    const simulated = new Error("execution reverted");
    expect(toBuyError(simulated, { stage: "signal" })).toMatchObject({ code: "liquidity", recoverable: true });
    expect(toBuyError(simulated, { stage: "fulfill" }).code).toBe("tx_failed");
  });

  it("maps SDK validation of dead intents", () => {
    // Only the SDK's indexer fallback says "expired"; OrchestratorV3 still releases an unpruned expired intent.
    expect(toBuyError(new ValidationError("Intent expired and can no longer be fulfilled", "intentHash"), { stage: "fulfill" })).toMatchObject({
      code: "network",
      recoverable: true,
    });
    expect(toBuyError(new ValidationError("Intent expired and can no longer be fulfilled", "intentHash"), { stage: "verify" }).code).toBe(
      "intent_expired",
    );
    expect(
      toBuyError(new ValidationError("Intent not found or no longer fulfillable (status: FULFILLED)", "intentHash"), {
        stage: "fulfill",
      }).code,
    ).toBe("intent_closed");
  });

  it("maps network failures and keeps own errors", () => {
    expect(toBuyError(new NetworkError("Failed to connect to API server"), { stage: "quote" }).code).toBe("network");
    expect(toBuyError(new MarketError("amount_too_low", "Too small."), { stage: "quote" })).toEqual({
      code: "amount_too_low",
      message: "Too small.",
      recoverable: true,
    });
    expect(toBuyError(new BuyFlowError("liquidity", "Gone.", true), { stage: "signal" }).code).toBe("liquidity");
    expect(toBuyError(new Error("???"), { stage: "signal" })).toMatchObject({ code: "unknown", recoverable: true });
  });
});

describe("a proof the payment verifier rejects on-chain", () => {
  const reason = (text: string) => encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: [text] });
  /** An eth_call revert as Alchemy and anvil answer it: JSON-RPC code 3 with the reason in words and as data. */
  const rpcRevert = (text: string, message = `execution reverted: ${text}`) =>
    new RpcRequestError({
      body: { method: "eth_call", params: [] },
      error: { code: 3, message, data: reason(text) },
      url: "https://base-mainnet.g.alchemy.com/v2/SECRETKEY123",
    });
  const REJECTED = {
    code: "proof_rejected",
    recoverable: true,
    message: "Peer couldn't verify this payment on-chain, so no USDC was released. Check you picked the matching payment, then try again.",
  };

  it("reads the verifier's and the witness check's reasons at the fulfil preflight", () => {
    expect(toBuyError(rpcRevert("UPV: Invalid payment amount"), { stage: "fulfill" })).toMatchObject(REJECTED);
    expect(toBuyError(rpcRevert("UPV: Snapshot amount mismatch"), { stage: "fulfill" })).toMatchObject(REJECTED);
    const witness = rpcRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
    expect(toBuyError(witness, { stage: "fulfill" })).toMatchObject(REJECTED);
    // What the store logs and reports keeps the reason, without the RPC key.
    expect(technicalDetail(witness)).toContain("{eth_call}: RPC Request failed. (execution reverted: ThresholdSigVerifierUtils: Not enough valid witness signatures)");
    expect(technicalDetail(witness)).not.toContain("SECRETKEY123");
  });

  it("decodes a reason that only arrives as revert data, from an RPC or a bundler", () => {
    const bare = rpcRevert("UPV: Snapshot rate mismatch", "execution reverted");
    expect(toBuyError(new InvalidInputRpcError(bare), { stage: "fulfill" })).toMatchObject(REJECTED);
    const bundler = walletError("CallRevertedError", "call_reverted", "The transaction would fail.", bare);
    expect(toBuyError(bundler, { stage: "fulfill" })).toMatchObject(REJECTED);
  });

  it("reads a stale snapshot's payee as a rejected proof, not a payment to someone else", () => {
    expect(toBuyError(rpcRevert("UPV: Snapshot payee mismatch"), { stage: "fulfill", payee: "@revtag" })).toMatchObject(REJECTED);
    // The attestation service's own refusal before signing still means the wrong payment.
    expect(toBuyError(new APIError("UnifiedPaymentVerifier: payee mismatch", 400), { stage: "fulfill" }).code).toBe("payee_mismatch");
  });

  it("leaves the same words alone outside proving a payment", () => {
    expect(toBuyError(rpcRevert("UPV: Invalid payment amount"), { stage: "signal" }).code).not.toBe("proof_rejected");
  });
});

describe("technicalDetail", () => {
  it("names every layer, the failed RPC method and the service's words, without URLs", () => {
    const error = new SponsorshipError({ cause: cdpPolicyRefusal() });
    const detail = technicalDetail(error);
    expect(detail).toMatch(/^SponsorshipError \[sponsorship_failed\]: The bank couldn't sponsor/);
    expect(detail).toContain("ResourceUnavailableRpcError [-32002] {pm_getPaymasterStubData}");
    expect(detail).toContain("called address not in allowlist: 0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7");
    expect(detail).not.toContain("SECRETKEY123");
    expect(technicalDetail(new Error("see https://rpc.example/v2/abc123 for more"))).toBe("Error: see https://rpc.example/… for more");
  });
});

describe("sendMayHaveLanded", () => {
  it("believes the wallet's own verdict, and otherwise only clear refusals rule a landing out", () => {
    expect(sendMayHaveLanded(new SponsorshipError({ cause: cdpPolicyRefusal() }))).toBe(false);
    expect(sendMayHaveLanded(walletError("WalletError", "unknown", "x"))).toBe(true);
    expect(sendMayHaveLanded(Object.assign(walletError("WalletError", "unknown", "x"), { mayHaveLanded: false }))).toBe(false);
    expect(sendMayHaveLanded(walletError("WalletTimeoutError", "request_timeout", "x"))).toBe(true);
    expect(sendMayHaveLanded(walletError("UserRejectedError", "user_rejected", "x"))).toBe(false);
  });
});
