import { describe, expect, it } from "vitest";
import { buildCapabilities, CashError } from "@zkp2p/cash";
import {
  estimateReceive,
  etaFromFillStats,
  fetchSellRate,
  fillStatsKey,
  formatDuration,
  preferredCurrency,
  sellCapabilities,
} from "../cash";
import { classifySendFailure, provenNotBroadcast, toSellFlowError } from "../errors";
import { createPendingSellStore, memoryStorage, readLastSellDeposit, rememberLastSellDeposit } from "../persistence";
import { cashError, mockCashClient, OWNER, PAYPAL_METHOD, userRejection } from "./helpers";

describe("sellCapabilities", () => {
  const caps = sellCapabilities({ capabilities: () => buildCapabilities("production") });

  it("enforces the 1 USDC recommended minimum over the dust floor", () => {
    expect(caps.minAmount).toBe(1_000_000n);
    expect(caps.hardMinAmount).toBe(10_000n);
    expect(caps.maxAmount).toBeNull();
  });

  it("flags identity-attestation and credential registration routes", () => {
    const byId = Object.fromEntries(caps.platforms.map((p) => [p.platform, p]));
    expect(byId.wise).toMatchObject({ requiresIdentityAttestation: true, registration: "peerExtensionIdentity", name: "Wise" });
    expect(byId.paypal?.registration).toBe("peerExtensionIdentity");
    expect(byId.cashapp).toMatchObject({ requiresIdentityAttestation: false, registration: "peerExtensionCredential" });
    expect(byId.revolut).toMatchObject({ registration: null, payeeLabel: "Revtag" });
    expect(byId.venmo?.currencies).toEqual(["USD"]);
  });
});

describe("estimates and ETA", () => {
  it("reads the rate for 1 USDC without ETA and scales locally", async () => {
    const client = mockCashClient();
    client.estimate.mockResolvedValue({ kind: "oracle-estimate", currency: "GBP", amount: 1_000_000n, rate: 0.7912, receiveAmount: 0.7912, asOf: 1 });
    const rate = await fetchSellRate(client, { currency: "GBP", platform: "revolut" });
    expect(client.estimate).toHaveBeenCalledWith({ amount: 1_000_000n, currency: "GBP", platform: "revolut" }, { includeEta: false });
    expect(rate).toEqual({ currency: "GBP", platform: "revolut", rate: 0.7912, asOf: 1, stale: false });
    expect(estimateReceive(125_400_000n, rate.rate)).toBe(99.21);
  });

  it("keys fill stats like the SDK and gates liquidity", () => {
    expect(fillStatsKey("revolut", ["USD", "EUR", "GBP"])).toBe("revolut:EUR+GBP+USD");
    const stats = { "venmo:USD": { fills: 40, medianFillSeconds: 1500 }, "monzo:GBP": { fills: 3, medianFillSeconds: 7200 } };
    expect(etaFromFillStats(stats, "venmo", ["USD"])).toEqual({ seconds: 1500, fills: 40, liquidity: "active", label: "Usually fills in ~25 min" });
    expect(etaFromFillStats(stats, "monzo", ["GBP"]).liquidity).toBe("slow");
    expect(etaFromFillStats(stats, "zelle", ["USD"])).toMatchObject({ liquidity: "unproven", seconds: null });
    expect(formatDuration(30)).toBe("~30 sec");
    expect(formatDuration(3 * 3600)).toBe("~3 hr");
    expect(formatDuration(86_400)).toBe("~1 day");
  });

  it("picks a sensible default currency", () => {
    expect(preferredCurrency(["AUD", "EUR", "GBP", "USD"], "en-GB")).toBe("GBP");
    expect(preferredCurrency(["AUD", "EUR", "GBP", "USD"], "en")).toBe("USD");
    expect(preferredCurrency(["CNY"], "en-US")).toBe("CNY");
    expect(preferredCurrency([], "en-US")).toBeNull();
  });
});

describe("toSellFlowError", () => {
  it("carries the deposit and policy from an SDK access-policy recovery", () => {
    const sdk = new CashError({
      code: "ACCESS_POLICY_CONFIGURATION_FAILED",
      message: "x",
      retryable: false,
      remediation: "",
      recovery: { kind: "configure-cashout-access-policy", depositId: "0xe_1", groupIds: [], paymentMethod: PAYPAL_METHOD },
    });
    const err = toSellFlowError(sdk);
    expect(err).toMatchObject({ code: "ACCESS_POLICY_CONFIGURATION_FAILED", depositId: "0xe_1", paymentMethod: PAYPAL_METHOD });
    expect(err.recovery.action).toBe("retryAccessPolicy");
  });

  it("is stage-aware for wallet failures", () => {
    expect(toSellFlowError(userRejection(), { stage: "send" }).code).toBe("USER_REJECTED");
    expect(toSellFlowError(userRejection(), { stage: "policy", depositId: "d" })).toMatchObject({
      code: "ACCESS_POLICY_CONFIGURATION_FAILED",
      depositId: "d",
    });
    expect(toSellFlowError(new Error("boom"), { stage: "send" }).recovery.action).toBe("reconcile");
    expect(toSellFlowError(new Error("boom"), { stage: "prepare" }).recovery.action).toBe("retry");
    expect(toSellFlowError(cashError("TRANSACTION_SUBMISSION_UNKNOWN")).recovery.action).toBe("reconcile");
    expect(toSellFlowError(cashError("SIGNER_CHAIN_MISMATCH")).recovery.action).toBe("reconnectWallet");
  });

  it("only treats named pre-send wallet errors as proof nothing was broadcast", () => {
    const nested = { name: "TransactionExecutionError", cause: { name: "InsufficientFundsError" } };
    expect(provenNotBroadcast(nested)).toBe("insufficientFunds");
    expect(provenNotBroadcast({ name: "EstimateGasExecutionError" })).toBe("notSent");
    expect(provenNotBroadcast({ name: "WaitForTransactionReceiptTimeoutError" })).toBeNull();
    expect(provenNotBroadcast(new Error("anything"))).toBeNull();
  });

  it("believes a wallet error that says whether its send could have landed", () => {
    const failure = (mayHaveLanded: boolean) =>
      Object.assign(new Error("Requested resource not available."), { name: "WalletError", code: "unknown", mayHaveLanded });
    expect(classifySendFailure(failure(false))).toMatchObject({ kind: "notSent", message: "Requested resource not available." });
    expect(classifySendFailure(failure(true))).toMatchObject({ kind: "unknown" });
    // Without the flag an unrecognised code stays unknown.
    expect(classifySendFailure(Object.assign(new Error("odd"), { code: "unknown" }))).toMatchObject({ kind: "unknown" });
  });
});

describe("persistence", () => {
  it("round-trips the pending record and ignores corrupt or foreign data", () => {
    const storage = memoryStorage();
    const store = createPendingSellStore(storage);
    store.write({
      v: 1,
      owner: OWNER,
      stage: "sending",
      startedAt: 1,
      amount: "100",
      legs: [{ platform: "venmo", currencies: ["USD"] }],
      knownDepositIds: null,
      accessPolicyPaymentMethods: [PAYPAL_METHOD],
      policyTxHashes: {},
    });
    expect(store.read(OWNER.toUpperCase().replace("0X", "0x"))?.amount).toBe("100");
    storage.setItem(`rampridge:sell:pending:${OWNER.toLowerCase()}`, "{not json");
    expect(store.read(OWNER)).toBeNull();
    storage.setItem(`rampridge:sell:pending:${OWNER.toLowerCase()}`, JSON.stringify({ v: 1, owner: "0xsomeoneelse" }));
    expect(store.read(OWNER)).toBeNull();
  });

  it("remembers the last deposit per wallet", () => {
    const storage = memoryStorage();
    rememberLastSellDeposit(OWNER, { depositId: "0xe_3", txHash: null, at: 5 }, storage);
    expect(readLastSellDeposit(OWNER, storage)).toEqual({ depositId: "0xe_3", txHash: null, at: 5 });
    expect(readLastSellDeposit("0x9999999999999999999999999999999999999999", storage)).toBeNull();
  });
});
