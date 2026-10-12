import { APIError, type PeerMetadataRow } from "@zkp2p/sdk";
import {
  RpcRequestError,
  TimeoutError,
  UserRejectedRequestError,
  encodeErrorResult,
  parseAbi,
  zeroAddress,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { WaitForUserOperationReceiptTimeoutError } from "viem/account-abstraction";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CDP_URL, beforeExecution, cdpPolicyRefusal, receiptWith, userOpEvent } from "@/wallet/__tests__/userOps";
import { createSmartSender } from "@/wallet/senders";
import type { WalletCall } from "@/wallet/types";
import { PEER_ABIS } from "../../client";
import { normalizeQuote, type BuyQuoteResult } from "../../market";
import { createBuyStore, type BuyDeps } from "../store";
import { memoryOrderStorage } from "../storage";
import type { BuyOrder } from "../types";
import {
  BUYER,
  ESCROW,
  FEE_WALLET,
  INTENT_HASH,
  ORCHESTRATOR,
  PAYEE_HASH,
  QUOTE_FEES,
  RAMPRIDGE_LEG,
  captureMessage,
  deferred,
  fakeClient,
  fakeExtension,
  fakeSender,
  flush,
  fundsLockedLog,
  intentFulfilledLog,
  intentSignaledLog,
  orchestratorIntent,
  pvIntentView,
  rawQuote,
  receipt,
  isSignalCall,
  signalCalldata,
  storedOrder,
} from "./helpers";

/** A payment method hash the SDK catalog does not know: every method it lists is now a buy platform. */
const UNKNOWN_METHOD: Hex = `0x${"5e".repeat(32)}`;

// Launch telemetry is a no-op off production; here its two entry points are recorded instead.
const telemetry = vi.hoisted(() => ({ track: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telemetry")>()),
  track: telemetry.track,
  report: telemetry.report,
}));

const NOW = 1_791_711_200_000;
const OWNER = BUYER.toLowerCase();

const paidRow = (index = 0): PeerMetadataRow => ({
  hidden: true,
  originalIndex: index,
  amount: "-5000",
  currency: "USD",
  state: "COMPLETED",
  recipient: "madouche",
  params: { TRANSACTION_ID: `tx-${index}` },
});

function setup(opts: { extension?: Parameters<typeof fakeExtension>[0]; canInstall?: boolean; deps?: Partial<BuyDeps> } = {}) {
  const fc = fakeClient();
  const ext = fakeExtension(opts.extension);
  const storage = memoryOrderStorage();
  let now = NOW;
  // Fresh prices are good for ten minutes from when they are fetched.
  const quoteResult = (): BuyQuoteResult => ({
    fiatAmount: 50_000_000n,
    currency: "USD",
    quotes: [normalizeQuote(rawQuote(), "USD", now + 600_000)!],
    nearby: { below: [], above: [] },
    expiresAt: now + 600_000,
  });
  const quotes = vi.fn(async () => quoteResult());
  const fetchPayeeHandle = vi.fn(async () => "madouche");
  // The background re-read: ticks and focus events are fired by hand.
  const poll = { ticks: new Set<() => void>(), focus: new Set<() => void>(), intervalMs: 0 };
  const warn = vi.fn();
  const openInstallPage = vi.fn();
  const store = createBuyStore({
    warn,
    openInstallPage,
    extensionPollMs: 5_000,
    getClient: () => fc.client,
    extension: ext.sdk,
    storage,
    quotes,
    fetchPayeeHandle,
    canInstallExtension: () => opts.canInstall ?? true,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    random: () => 0,
    indexerTimeoutMs: 3_000,
    signalReconcileMs: 20_000,
    pollIntervalMs: 15_000,
    every: (ms, run) => {
      poll.intervalMs = ms;
      poll.ticks.add(run);
      return () => poll.ticks.delete(run);
    },
    onFocus: (run) => {
      poll.focus.add(run);
      return () => poll.focus.delete(run);
    },
    ...opts.deps,
  });
  const route = async (calls: WalletCall[]): Promise<TransactionReceipt> => {
    const data = calls[0]?.data;
    if (isSignalCall(data)) return receipt([intentSignaledLog(), fundsLockedLog()]);
    if (data === "0xf0f0") return receipt([intentFulfilledLog()]);
    return receipt([]);
  };
  const sender = fakeSender(route);
  const tick = async () => {
    for (const run of poll.ticks) run();
    await flush(40);
  };
  return { store, fc, ext, storage, sender, quotes, fetchPayeeHandle, poll, tick, warn, openInstallPage, advance: (ms: number) => (now += ms) };
}

async function toConfirming(ctx: ReturnType<typeof setup>) {
  ctx.store.getState().bindSender(ctx.sender);
  await flush();
  await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
  const quote = ctx.store.getState().quotes[0];
  ctx.store.getState().selectQuote(quote!.id);
}

async function toAwaitingPayment(ctx: ReturnType<typeof setup>) {
  await toConfirming(ctx);
  await ctx.store.getState().confirm();
}

async function toSelectPayment(ctx: ReturnType<typeof setup>) {
  await toAwaitingPayment(ctx);
  await ctx.store.getState().markPaid();
  ctx.ext.emit(captureMessage("revolut", [paidRow(0), paidRow(1)]));
}

describe("buy flow", () => {
  const feeQuoteSetup = () => {
    const ctx = setup();
    const feeQuote = normalizeQuote(rawQuote({ referrerFeeAmount: "245333", referrerFeeBps: 50 }), "USD", NOW + 600_000)!;
    ctx.quotes.mockImplementation(async () => ({
      fiatAmount: 50_000_000n,
      currency: "USD",
      quotes: [feeQuote],
      nearby: { below: [], above: [] },
      expiresAt: NOW + 600_000,
    }));
    const prepared = (data: Hex) => ({ to: ORCHESTRATOR, data, value: 0n, chainId: 8453 });
    return { ctx, feeQuote, prepared };
  };

  it("signals RampRidge's integrator fee when the quote priced it in, and records the quoted fees", async () => {
    const { ctx, feeQuote, prepared } = feeQuoteSetup();
    const peerLeg = { recipient: "0x0000000000000000000000000000000000000fee" as const, fee: 9_500_000_000_000_000n };
    ctx.fc.signalPrepare.mockResolvedValue(prepared(signalCalldata({ referralFees: [peerLeg, RAMPRIDGE_LEG] })));
    await toAwaitingPayment(ctx);
    expect(ctx.fc.signalPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        referrerFeeConfig: { recipient: FEE_WALLET, feeBps: 50 },
        txOverrides: { referrer: ["rampridge", "peer-ref-TOFIAT"] },
      }),
    );
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState().order).toMatchObject({ fees: feeQuote.fees, paidClaimedAt: null });
    expect(ctx.storage.load(BUYER)?.fees).toEqual(feeQuote.fees);
  });

  it.each([
    ["dropped", []],
    ["changed", [{ ...RAMPRIDGE_LEG, fee: 2_500_000_000_000_000n }]],
    ["duplicated", [RAMPRIDGE_LEG, RAMPRIDGE_LEG]],
  ])("re-quotes instead of sending when Curator %s RampRidge's fee leg", async (_label, legs) => {
    const { ctx, prepared } = feeQuoteSetup();
    ctx.fc.signalPrepare.mockResolvedValue(prepared(signalCalldata({ referralFees: legs })));
    await toAwaitingPayment(ctx);
    expect(ctx.sender.sendCalls).not.toHaveBeenCalled();
    // The only offer failed, so Back leads to the amount form rather than to the same dead offer.
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "idle", quotes: [], error: { code: "rate_changed" }, order: null });
    expect(ctx.storage.load(BUYER)).toBeNull();
    await ctx.store.getState().retry();
    expect(ctx.quotes).toHaveBeenCalledTimes(2);
  });

  it("drops an offer that failed as stale, so Back shows the next one instead of the same dead offer", async () => {
    const ctx = setup();
    const offer = (depositId: number) => normalizeQuote(rawQuote({ intent: { ...rawQuote().intent, depositId } as never }), "USD", NOW + 600_000)!;
    ctx.quotes.mockResolvedValue({
      fiatAmount: 50_000_000n,
      currency: "USD",
      quotes: [offer(6528), offer(7000)],
      nearby: { below: [], above: [] },
      expiresAt: NOW + 600_000,
    });
    // The best deposit was drained after it was quoted.
    vi.mocked(ctx.fc.client.getPvDepositById).mockImplementation(
      async (id) => ({ availableLiquidity: String(id).endsWith("_6528") ? 1n : 1_000_000_000n }) as never,
    );
    await toAwaitingPayment(ctx);
    expect(ctx.sender.sendCalls).not.toHaveBeenCalled();
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "quoted", error: { code: "liquidity" }, selectedQuote: null });
    ctx.store.getState().back();
    expect(ctx.store.getState().step).toBe("quoted");
    expect(ctx.store.getState().quotes.map((q) => q.depositId)).toEqual(["7000"]);
  });

  describe("a deposit listed with Galleon's TOFIAT referral code", () => {
    // Curator pays the TOFIAT owner (RampRidge's fee wallet) an integration share out of Peer's
    // fee, so with RampRidge's own fee it signs two legs to one wallet, which the orchestrator
    // rejects. Seen live on Base for usdctofiat deposits 6528-6530 (fork suite, tests/fork).
    const PEER_SHARE = { recipient: "0x0000000000000000000000000000000000000fee" as const, fee: 4_500_000_000_000_000n };
    const tofiatSetup = () => {
      const { ctx, prepared } = feeQuoteSetup();
      // Live quotes net out the service, manager and referrer fees: 49_066_797 - 466_134 - 49_116 - 245_333.
      const quote = normalizeQuote(
        rawQuote({ tokenAmount: "48306214", referrerFeeAmount: "245333", referrerFeeBps: 50, totalFeeAmount: "760583" }),
        "USD",
        NOW + 600_000,
      )!;
      ctx.quotes.mockImplementation(async () => ({
        fiatAmount: 50_000_000n,
        currency: "USD",
        quotes: [quote],
        nearby: { below: [], above: [] },
        expiresAt: NOW + 600_000,
      }));
      return { ctx, quote, prepared };
    };

    it("re-signs without RampRidge's fee and lands the order with the fee left to the buyer", async () => {
      const { ctx, quote, prepared } = tofiatSetup();
      ctx.fc.signalPrepare
        .mockResolvedValueOnce(prepared(signalCalldata({ referralFees: [PEER_SHARE, RAMPRIDGE_LEG, RAMPRIDGE_LEG] })))
        .mockResolvedValueOnce(prepared(signalCalldata({ referralFees: [PEER_SHARE, RAMPRIDGE_LEG] })));
      await toAwaitingPayment(ctx);
      expect(ctx.fc.signalPrepare).toHaveBeenCalledTimes(2);
      expect(ctx.fc.signalPrepare.mock.calls[0]?.[0]).toMatchObject({ referrerFeeConfig: { recipient: FEE_WALLET, feeBps: 50 } });
      expect(ctx.fc.signalPrepare.mock.calls[1]?.[0]).not.toHaveProperty("referrerFeeConfig");
      expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
      expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", error: null });
      expect(ctx.store.getState().order).toMatchObject({
        usdcExpected: quote.usdcAmount + quote.fees.referrer,
        fees: { ...quote.fees, referrer: 0n, referrerBps: null, total: quote.fees.total - quote.fees.referrer },
      });
    });

    it("re-quotes when the re-signed legs would leave the buyer less than quoted", async () => {
      const { ctx, prepared } = tofiatSetup();
      ctx.fc.signalPrepare
        .mockResolvedValueOnce(prepared(signalCalldata({ referralFees: [PEER_SHARE, RAMPRIDGE_LEG, RAMPRIDGE_LEG] })))
        .mockResolvedValueOnce(
          prepared(signalCalldata({ referralFees: [{ ...PEER_SHARE, fee: 10_000_000_000_000_000n }, RAMPRIDGE_LEG] })),
        );
      await toAwaitingPayment(ctx);
      expect(ctx.sender.sendCalls).not.toHaveBeenCalled();
      expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "idle", error: { code: "rate_changed" } });
    });
  });

  it("re-quotes when the signed call cannot be read back", async () => {
    const { ctx } = feeQuoteSetup();
    await toAwaitingPayment(ctx);
    expect(ctx.sender.sendCalls).not.toHaveBeenCalled();
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "rate_changed" } });
  });

  it("runs quote -> signal -> pay -> verify -> fulfil", async () => {
    const ctx = setup();
    ctx.store.getState().bindSender(ctx.sender);
    await flush();
    expect(ctx.store.getState()).toMatchObject({ owner: OWNER, step: "idle", recovering: false });

    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    expect(ctx.quotes).toHaveBeenCalledWith(expect.objectContaining({ fiatAmount: "50", currency: "USD", recipient: BUYER }));
    expect(ctx.store.getState().step).toBe("quoted");

    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    expect(ctx.store.getState().step).toBe("confirming");

    await ctx.store.getState().confirm();
    expect(ctx.fc.signalPrepare).toHaveBeenCalledWith({
      depositId: 6528n,
      amount: 49_066_797n,
      toAddress: BUYER,
      processorName: "revolut",
      payeeDetails: PAYEE_HASH,
      fiatCurrencyCode: "USD",
      conversionRate: 1_019_019_019_019_019_035n,
      escrowAddress: ESCROW,
      postIntentHook: zeroAddress,
      preIntentHookData: "0x",
      data: "0x",
      txOverrides: { referrer: ["rampridge", "peer-ref-TOFIAT"] },
    });
    expect(ctx.fc.ethCall).toHaveBeenCalled();
    expect(ctx.sender.sendCalls).toHaveBeenCalledWith([{ to: ORCHESTRATOR, data: "0x5149", value: 0n }], {
      label: "Reserve USDC",
    });
    const order = ctx.store.getState().order!;
    expect(ctx.store.getState().step).toBe("awaitingPayment");
    expect(order).toMatchObject({
      intentHash: INTENT_HASH,
      orchestrator: ORCHESTRATOR,
      usdcGross: 49_066_797n,
      // Curator's tokenAmount (48_600_663) less the 49_116 rate-manager fee the release also pays.
      usdcExpected: 48_551_547n,
      fiatToSend: 50_000_000n,
      fiatToSendText: "50.00",
      payeeHandle: "madouche",
      expiresAt: 1_791_732_741_000,
      signalTxHash: `0x${"ab".repeat(32)}`,
      status: "active",
    });
    expect(ctx.storage.load(BUYER)?.intentHash).toBe(INTENT_HASH);

    await ctx.store.getState().markPaid();
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "capturing" });
    expect(ctx.ext.sdk.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "transfer_revolut", platform: "revolut", captureMode: "buyerTee" }),
    );

    ctx.ext.emit(captureMessage("revolut", [paidRow(0), { ...paidRow(1), amount: "700" }]));
    expect(ctx.store.getState().step).toBe("selectPayment");
    expect(ctx.store.getState().payments.map((p) => p.index)).toEqual([0]);

    ctx.fc.intentByHash.mockResolvedValue({ status: "FULFILLED", takerAmountNetFees: "48600663" });
    await ctx.store.getState().choosePayment(0);
    expect(ctx.fc.fulfillPrepare).toHaveBeenCalledWith({
      intentHash: INTENT_HASH,
      proof: {
        proofType: "buyerTee",
        encryptedSessionMaterial: "enc",
        params: { TRANSACTION_ID: "tx-0", index: 0 },
        actionType: "transfer_revolut",
        actionPlatform: "revolut",
      },
      attestationServiceUrl: "https://attestation-service.zkp2p.xyz",
      postIntentHookData: "0x",
      orchestratorAddress: ORCHESTRATOR,
      txOverrides: { referrer: ["rampridge", "peer-ref-TOFIAT"] },
    });
    expect(ctx.store.getState()).toMatchObject({
      step: "completed",
      completion: {
        intentHash: INTENT_HASH,
        usdcReceived: 48_600_663n,
        fiatSent: 50_000_000n,
        platform: "revolut",
        // The receipt's IntentFulfilled gave the released amount, so the indexer was not waited on.
        indexed: false,
      },
      order: { status: "fulfilled" },
    });
    expect(ctx.storage.load(BUYER)).toBeNull();
  });

  it("completes from the release receipt without waiting on a lagging indexer", async () => {
    const ctx = setup();
    await toSelectPayment(ctx);
    const reads = ctx.fc.intentByHash.mock.calls.length;
    await ctx.store.getState().choosePayment(0);
    expect(ctx.store.getState()).toMatchObject({ step: "completed", completion: { indexed: false, usdcReceived: 48_600_663n } });
    expect(ctx.fc.intentByHash.mock.calls.length).toBe(reads);
  });

  it("takes the released amount from the indexer when the receipt lacks IntentFulfilled", async () => {
    const ctx = setup();
    await toSelectPayment(ctx);
    (ctx.sender.sendCalls as Mock).mockImplementation(async () => receipt([]));
    ctx.fc.intentByHash.mockResolvedValue({ status: "FULFILLED", takerAmountNetFees: "40000000" });
    await ctx.store.getState().choosePayment(0);
    expect(ctx.store.getState()).toMatchObject({ step: "completed", completion: { indexed: true, usdcReceived: 40_000_000n } });
  });

  it("reports what the player actually paid when it differs from the order", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    // A short payment: $40.00 against $50.00 owed.
    ctx.ext.emit(captureMessage("revolut", [{ ...paidRow(0), amount: "-4000" }]));
    await ctx.store.getState().choosePayment(0);
    expect(ctx.store.getState()).toMatchObject({ step: "completed", completion: { fiatSent: 40_000_000n } });
  });

  it("resumes an open order instead of signalling a second one", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    ctx.fc.accountIntents.mockResolvedValue([pvIntentView()]);
    await ctx.store.getState().confirm();
    expect(ctx.fc.signalPrepare).not.toHaveBeenCalled();
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      notice: "You already had an open order, so here it is.",
      order: { intentHash: INTENT_HASH, usdcExpected: 48_600_663n, payeeHandle: "madouche", fiatToSendText: "50.00" },
    });
  });

  it("recovers the open order on login, keeping the stored memo and method", async () => {
    const ctx = setup();
    const stored: BuyOrder = {
      owner: BUYER,
      intentHash: INTENT_HASH,
      depositId: "6528",
      escrow: ESCROW,
      orchestrator: ORCHESTRATOR,
      platform: "revolut",
      currency: "USD",
      usdcGross: 49_066_797n,
      usdcExpected: 48_600_663n,
      rate: 1_019_019_019_019_019_035n,
      fiatToSend: 50_000_000n,
      fiatToSendText: "50.00",
      payeeHandle: "stored-handle",
      payeeDetailsHash: PAYEE_HASH,
      signalTxHash: null,
      signaledAt: NOW - 60_000,
      expiresAt: NOW + 3_600_000,
      verifyMethodId: null,
      memo: null,
      status: "active",
      fees: QUOTE_FEES,
      paidClaimedAt: null,
    };
    ctx.storage.save(stored);
    ctx.fc.accountIntents.mockResolvedValue([pvIntentView()]);
    ctx.store.getState().bindSender(ctx.sender);
    expect(ctx.store.getState().step).toBe("awaitingPayment");
    await flush(30);
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      recovering: false,
      order: { intentHash: INTENT_HASH, payeeHandle: "stored-handle", expiresAt: 1_791_732_741_000 },
    });
  });

  it("closes a stored order the chain no longer has", async () => {
    const ctx = setup();
    ctx.storage.save({
      owner: BUYER,
      intentHash: INTENT_HASH,
      depositId: "6528",
      escrow: ESCROW,
      orchestrator: null,
      platform: "revolut",
      currency: "USD",
      usdcGross: 1n,
      usdcExpected: 1n,
      rate: 10n ** 18n,
      fiatToSend: 1n,
      fiatToSendText: "0.01",
      payeeHandle: "x",
      payeeDetailsHash: PAYEE_HASH,
      signalTxHash: null,
      signaledAt: NOW - 3_600_000,
      expiresAt: NOW + 3_600_000,
      verifyMethodId: null,
      memo: null,
      status: "active",
      fees: null,
      paidClaimedAt: null,
    });
    ctx.fc.intentByHash.mockResolvedValue({ status: "PRUNED" });
    ctx.fc.chain.gone.add(INTENT_HASH.toLowerCase());
    ctx.store.getState().bindSender(ctx.sender);
    await flush(30);
    expect(ctx.store.getState()).toMatchObject({ step: "cancelled", order: { status: "cancelled" } });
    expect(ctx.storage.load(BUYER)).toBeNull();
  });

  it("ignores other open intents until the contract says one blocks, then offers to cancel it", async () => {
    const ctx = setup();
    const OTHER: Hex = `0x${"77".repeat(32)}`;
    ctx.fc.accountIntents.mockResolvedValue([
      pvIntentView({
        intentHash: OTHER,
        paymentMethod: UNKNOWN_METHOD,
      }),
    ]);
    await toConfirming(ctx);
    expect(ctx.store.getState()).toMatchObject({ step: "confirming", blockingIntent: null });

    const data = encodeErrorResult({
      abi: PEER_ABIS.orchestrator,
      errorName: "AccountHasActiveIntent",
      args: [BUYER, OTHER],
    } as never);
    ctx.fc.ethCall.mockRejectedValueOnce(Object.assign(new Error("execution reverted"), { data }));
    await ctx.store.getState().confirm();
    expect(ctx.sender.sendCalls).not.toHaveBeenCalled();
    expect(ctx.store.getState()).toMatchObject({
      step: "error",
      blockingIntent: OTHER,
      error: { code: "active_intent" },
    });

    await ctx.store.getState().cancelOrder();
    expect(ctx.fc.cancelPrepare).toHaveBeenCalledWith(expect.objectContaining({ intentHash: OTHER }));
    expect(ctx.store.getState()).toMatchObject({ step: "cancelled", blockingIntent: null });
  });

  it("does not resurface stale expired intents at login", async () => {
    const ctx = setup();
    const stale = pvIntentView();
    stale.intent.timestamp = 1_774_482_827n;
    ctx.fc.accountIntents.mockResolvedValue([stale]);
    ctx.fc.readContract.mockResolvedValue({ expiryTime: 1_774_504_427n });
    ctx.store.getState().bindSender(ctx.sender);
    await flush(30);
    expect(ctx.store.getState()).toMatchObject({ step: "idle", order: null });
  });

  it("walks the extension from install to connection to capture", async () => {
    let available = false;
    let connected = false;
    const ctx = setup({
      extension: {
        isAvailable: () => available,
        getState: async () => (connected ? "ready" : "needs_connection"),
        requestConnection: async () => {
          connected = true;
          return true;
        },
      },
    });
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "needsInstall" });
    available = true;
    await ctx.store.getState().startVerification();
    expect(ctx.store.getState().verifying).toBe("needsConnection");
    await ctx.store.getState().connectExtension();
    expect(ctx.store.getState().verifying).toBe("capturing");
  });

  it("reports unsupported browsers", async () => {
    const ctx = setup({ extension: { isAvailable: () => false }, canInstall: false });
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    expect(ctx.store.getState().verifying).toBe("unsupportedBrowser");
  });

  it("never asks a player who said they paid to pay again when no sent payments are captured", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    ctx.ext.emit(captureMessage("revolut", [{ ...paidRow(0), state: "PENDING" }]));
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "awaitingPayment", error: { code: "no_payments" } });
    expect(ctx.store.getState().error?.message).toMatch(/^No completed Revolut payments found yet\..*don't pay again/);
    expect(ctx.store.getState().error?.message).not.toMatch(/Send the payment/);
    await ctx.store.getState().retry();
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "capturing" });
  });

  it("names the extension's own capture error and logs it, and lets the live tab's capture replace a stale cancel", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    ctx.ext.emit({ ...captureMessage("revolut"), buyerTeeCapture: null, errorMessage: "Attestation timestamp skew exceeds 300000ms" });
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "capture_failed", detail: "Attestation timestamp skew exceeds 300000ms" } });
    expect(ctx.store.getState().error?.message).toMatch(/clock/);
    expect(ctx.warn).toHaveBeenCalledWith("[buy] capture failed", "Attestation timestamp skew exceeds 300000ms");
    // The live tab finishes after an abandoned one posted its cancel: the list still shows.
    ctx.ext.emit(captureMessage("revolut", [paidRow(0)]));
    expect(ctx.store.getState()).toMatchObject({ step: "selectPayment", error: null, errorReturnStep: null });
    expect(ctx.ext.listeners.size).toBe(0);
  });

  it("asks for an extension update instead of capturing with a build too old for the platform", async () => {
    const ctx = setup({ extension: { getVersion: async () => "0.6.2" } });
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "needsUpdate", pending: null });
    expect(ctx.ext.sdk.authenticate).not.toHaveBeenCalled();
  });

  it.each([
    ["the platform refused the login", new APIError("Revolut session is unauthorized", 401)],
    ["Peer rotated its enclave key", new APIError("Buyer TEE session material failed authentication", 400)],
    ["Cash App replayed a session", new APIError("Cash App returned status 400", 503)],
  ])("recaptures instead of replaying a captured session when %s", async (_label, error) => {
    const ctx = setup();
    await toSelectPayment(ctx);
    ctx.fc.fulfillPrepare.mockRejectedValueOnce(error);
    await ctx.store.getState().choosePayment(0);
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "awaitingPayment", error: { code: "payment_session_expired" } });
    expect(ctx.ext.listeners.size).toBe(0);
    await ctx.store.getState().retry();
    // "Check again" opens a fresh capture; the refused session is never sent again.
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "capturing" });
    expect(ctx.ext.sdk.authenticate).toHaveBeenCalledTimes(2);
    expect(ctx.fc.fulfillPrepare).toHaveBeenCalledTimes(1);
  });

  it("never re-proves or resends a release whose receipt timed out, and completes when it lands", async () => {
    const ctx = setup();
    await toSelectPayment(ctx);
    const pending = Object.assign(new Error("Still confirming."), { name: "TransactionPendingError", code: "receipt_timeout" });
    (ctx.sender.sendCalls as Mock).mockRejectedValueOnce(pending);
    await ctx.store.getState().choosePayment(0);
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "awaitingPayment", error: { code: "tx_pending" } });
    // "Check again" while it is still pending re-reads the chain only.
    await ctx.store.getState().retry();
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "tx_pending" } });
    expect(ctx.fc.fulfillPrepare).toHaveBeenCalledTimes(1);
    // It lands: the background re-read completes the order with no click.
    ctx.fc.chain.gone.add(INTENT_HASH.toLowerCase());
    ctx.fc.intentByHash.mockResolvedValue({ status: "FULFILLED", fulfillTxHash: `0x${"cd".repeat(32)}`, takerAmountNetFees: "48600663" });
    await ctx.tick();
    expect(ctx.store.getState()).toMatchObject({ step: "completed", error: null, completion: { usdcReceived: 48_600_663n } });
    expect(ctx.fc.fulfillPrepare).toHaveBeenCalledTimes(1);
  });

  it("settles an order released in another tab of this browser instead of leaving it payable", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    // Another tab sharing this storage released the order and forgot it.
    ctx.storage.clear(BUYER);
    ctx.fc.chain.gone.add(INTENT_HASH.toLowerCase());
    ctx.fc.intentByHash.mockResolvedValue({ status: "FULFILLED", takerAmountNetFees: "48600663" });
    await ctx.tick();
    expect(ctx.store.getState()).toMatchObject({ step: "completed", order: { status: "fulfilled" } });
  });

  it("returns to the payment list after a payee mismatch", async () => {
    const ctx = setup();
    await toSelectPayment(ctx);
    ctx.fc.fulfillPrepare.mockRejectedValueOnce(new APIError("UnifiedPaymentVerifier: payee mismatch", 400));
    await ctx.store.getState().choosePayment(1);
    const state = ctx.store.getState();
    expect(state).toMatchObject({ step: "error", errorReturnStep: "selectPayment", error: { code: "payee_mismatch" } });
    expect(state.error?.message).toContain("@madouche");
    ctx.store.getState().back();
    expect(ctx.store.getState()).toMatchObject({ step: "selectPayment" });
    expect(ctx.store.getState().payments).toHaveLength(2);
  });

  it("requires a Zelle bank before verifying", async () => {
    const ctx = setup();
    const zelleQuote = rawQuote({ paymentMethod: "zelle" });
    zelleQuote.intent = { ...zelleQuote.intent, processorName: "zelle" };
    ctx.quotes.mockResolvedValue({
      fiatAmount: 50_000_000n,
      currency: "USD",
      quotes: [normalizeQuote(zelleQuote, "USD", NOW + 600_000)!],
      nearby: { below: [], above: [] },
      expiresAt: NOW + 600_000,
    });
    await toAwaitingPayment(ctx);
    expect(ctx.store.getState().order?.platform).toBe("zelle");
    await ctx.store.getState().markPaid();
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "method_required" } });
    ctx.store.getState().back();
    ctx.store.getState().setVerifyMethod("citi");
    await ctx.store.getState().markPaid();
    expect(ctx.ext.sdk.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "transfer_zelle_citi", platform: "zelle" }),
    );
  });

  it("cancels an open order", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    await ctx.store.getState().cancelOrder();
    expect(ctx.fc.cancelPrepare).toHaveBeenCalledWith({
      intentHash: INTENT_HASH,
      orchestratorAddress: ORCHESTRATOR,
      txOverrides: { referrer: ["rampridge", "peer-ref-TOFIAT"] },
    });
    expect(ctx.store.getState()).toMatchObject({ step: "cancelled", order: { status: "cancelled" } });
    expect(ctx.storage.load(BUYER)).toBeNull();
  });

  it("keeps the order through reset and refuses new quotes while it is open", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    ctx.store.getState().reset();
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH } });
    await ctx.store.getState().requestQuotes({ fiatAmount: "10", currency: "USD" });
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "active_intent" } });
    ctx.store.getState().back();
    expect(ctx.store.getState().step).toBe("awaitingPayment");
  });

  it("lets the player retry after rejecting in the wallet", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    (ctx.sender.sendCalls as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new UserRejectedRequestError(new Error("User rejected the request.")),
    );
    await ctx.store.getState().confirm();
    expect(ctx.store.getState()).toMatchObject({
      step: "error",
      errorReturnStep: "confirming",
      error: { code: "user_rejected", recoverable: true },
    });
    await ctx.store.getState().retry();
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH } });
  });

  it("refreshes prices when the quote expired", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    ctx.advance(600_001);
    await ctx.store.getState().confirm();
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "quoted", error: { code: "quote_expired" } });
    await ctx.store.getState().retry();
    expect(ctx.quotes).toHaveBeenCalledTimes(2);
    expect(ctx.store.getState().step).toBe("quoted");
  });

  it("needs a wallet to confirm", async () => {
    const ctx = setup();
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    expect(ctx.quotes).toHaveBeenCalledWith(expect.objectContaining({ recipient: null }));
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    await ctx.store.getState().confirm();
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "not_connected" }, errorReturnStep: "confirming" });
  });

  it("still verifies an expired order, and lets the player dismiss it or buy again", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    ctx.advance(1_791_732_741_000 - NOW);
    await ctx.store.getState().markPaid();
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "capturing" });
    ctx.store.getState().back();

    ctx.store.getState().dismissOrder();
    expect(ctx.store.getState()).toMatchObject({ step: "idle", order: null });
    expect(ctx.storage.load(BUYER)).toBeNull();
  });

  it("refuses new quotes until an expired order is verified or dismissed, then never re-adopts it", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    ctx.store.getState().dismissOrder();
    expect(ctx.store.getState().step).toBe("awaitingPayment");
    ctx.advance(1_791_732_741_000 - NOW);
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    expect(ctx.store.getState()).toMatchObject({
      step: "error",
      errorReturnStep: "awaitingPayment",
      error: { code: "active_intent", message: "Verify or dismiss your expired order first." },
    });
    expect(ctx.storage.load(BUYER)?.intentHash).toBe(INTENT_HASH);
    expect(ctx.quotes).toHaveBeenCalledTimes(1);

    ctx.store.getState().back();
    ctx.store.getState().dismissOrder();
    expect(ctx.storage.load(BUYER)).toBeNull();
    expect(ctx.storage.dismissed(BUYER).has(INTENT_HASH.toLowerCase())).toBe(true);
    // The intent is still locked on-chain, but a dismissed order is not adopted again.
    ctx.fc.accountIntents.mockResolvedValue([pvIntentView()]);
    await ctx.store.getState().recover();
    expect(ctx.store.getState()).toMatchObject({ step: "idle", order: null });
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    expect(ctx.store.getState()).toMatchObject({ step: "quoted", order: null });
  });

  it("does not re-adopt a dismissed order in this session even when storage drops the dismissal", async () => {
    const ctx = setup();
    ctx.storage.dismiss = () => {};
    await toAwaitingPayment(ctx);
    ctx.advance(1_791_732_741_000 - NOW + 60_000);
    ctx.store.getState().dismissOrder();
    expect(ctx.storage.dismissed(BUYER).size).toBe(0);
    ctx.fc.accountIntents.mockResolvedValue([pvIntentView()]);
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    await ctx.store.getState().confirm();
    expect(ctx.fc.signalPrepare).toHaveBeenCalledTimes(2);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", notice: null });
  });

  it("shows a paid-in-time expired order found on a new device instead of forgetting it", async () => {
    const ctx = setup();
    ctx.advance(1_791_732_741_000 - NOW + 3_600_000);
    ctx.fc.accountIntents.mockResolvedValue([pvIntentView()]);
    ctx.store.getState().bindSender(ctx.sender);
    await flush(40);
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      notice: "Your last order expired. If you already paid, verify it now. Otherwise dismiss it.",
      order: { intentHash: INTENT_HASH, status: "active", expiresAt: 1_791_732_741_000 },
    });
    await ctx.store.getState().markPaid();
    ctx.ext.emit(captureMessage("revolut", []));
    expect(ctx.store.getState()).toMatchObject({
      step: "error",
      error: {
        code: "no_payments",
        message: "No payment for this offer was found yet. If you paid before it expired, wait a minute, then check again.",
      },
    });
  });

  it("shows an expired order found while confirming rather than signalling over it", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    ctx.advance(1_791_732_741_000 - NOW + 60_000);
    ctx.fc.accountIntents.mockResolvedValue([pvIntentView()]);
    ctx.store.setState({ selectedQuote: { ...ctx.store.getState().selectedQuote!, expiresAt: Number.MAX_SAFE_INTEGER } });
    await ctx.store.getState().confirm();
    expect(ctx.fc.signalPrepare).not.toHaveBeenCalled();
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      notice: "Your last order expired. If you already paid, verify it now. Otherwise dismiss it.",
      order: { intentHash: INTENT_HASH },
    });
  });

  it("drops a stale capture when the player goes back", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    ctx.store.getState().back();
    expect(ctx.ext.listeners.size).toBe(0);
    ctx.ext.emit(captureMessage("revolut", [paidRow(0)]));
    expect(ctx.store.getState().step).toBe("awaitingPayment");
  });

  it("forgets everything when the wallet changes", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    ctx.store.getState().bindSender(null);
    expect(ctx.store.getState()).toMatchObject({ owner: null, step: "idle", order: null });
    expect(ctx.storage.load(BUYER)?.intentHash).toBe(INTENT_HASH as Hex);
  });
});

describe("login mid-flow", () => {
  it("re-quotes for the wallet after logging in from the confirm screen", async () => {
    const ctx = setup();
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    ctx.store.getState().bindSender(ctx.sender);
    await flush(40);
    expect(ctx.quotes).toHaveBeenLastCalledWith(expect.objectContaining({ recipient: BUYER }));
    expect(ctx.store.getState()).toMatchObject({ owner: OWNER, step: "quoted" });
  });
});

describe("a smart-wallet signal (Privy user operation through the CDP bundler and paymaster)", () => {
  const BUNDLE: Hash = `0x${"9a".repeat(32)}`;

  /** The real smart sender over a scripted Privy client; mined bundles carry this buyer's signal. */
  function smartSetup(script: (ctx: ReturnType<typeof setup>) => Mock) {
    const ctx = setup();
    const sendBatch = script(ctx);
    const reader = {
      getBalance: vi.fn(async () => 0n),
      request: vi.fn(async () => null),
      waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) =>
        receiptWith(hash, [beforeExecution(), intentSignaledLog(), fundsLockedLog(), userOpEvent(BUYER, true)]),
      ),
    };
    const sender = createSmartSender(BUYER, { sendBatch, signMessage: vi.fn(), signTypedData: vi.fn() }, { reader });
    const confirm = async () => {
      ctx.store.getState().bindSender(sender);
      await flush();
      await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
      ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
      await ctx.store.getState().confirm();
    };
    const chainChecked = () =>
      ctx.fc.readContract.mock.calls.some(([req]) => (req as { functionName: string }).functionName === "getAccountIntents");
    return { ctx, sendBatch, confirm, chainChecked };
  }

  it("shows a paymaster refusal at once, with no chain wait, and lets the same offer be retried", async () => {
    const { ctx, sendBatch, confirm, chainChecked } = smartSetup(() =>
      vi.fn().mockRejectedValueOnce(cdpPolicyRefusal()).mockResolvedValueOnce(BUNDLE),
    );
    await confirm();
    expect(ctx.store.getState()).toMatchObject({
      step: "error",
      errorReturnStep: "confirming",
      notice: null,
      error: { code: "wallet", recoverable: true, message: "The bank couldn't sponsor this transaction, so nothing was sent. Try again later." },
    });
    expect(ctx.store.getState().selectedQuote).not.toBeNull();
    expect(chainChecked()).toBe(false);
    expect(ctx.advance(0)).toBe(NOW);

    // The real reason reaches the console (and the error's detail), without the paymaster URL's key.
    const detail = ctx.store.getState().error?.detail ?? "";
    expect(detail).toMatch(/pm_getPaymasterStubData.*called address not in allowlist/);
    expect(ctx.warn).toHaveBeenCalledWith("[buy] signal failed", detail);
    expect(JSON.stringify(ctx.warn.mock.calls)).not.toContain("SECRETKEY123");

    await ctx.store.getState().retry();
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH, signalTxHash: BUNDLE } });
  });

  it("does not wait on the chain for a bundler timeout before submission", async () => {
    const { ctx, confirm, chainChecked } = smartSetup(() =>
      vi.fn().mockRejectedValueOnce(new TimeoutError({ body: { method: "eth_estimateUserOperationGas" }, url: CDP_URL })),
    );
    await confirm();
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "confirming", error: { code: "wallet" } });
    expect(chainChecked()).toBe(false);
  });

  it("settles from the chain when the user operation was submitted and its receipt wait timed out", async () => {
    // The operation lands although Privy gave up waiting for its receipt.
    const { ctx, sendBatch, confirm, chainChecked } = smartSetup((c) =>
      vi.fn(async () => {
        c.fc.chain.orchestratorIntents.push(orchestratorIntent());
        throw new WaitForUserOperationReceiptTimeoutError({ hash: BUNDLE });
      }),
    );
    await confirm();
    expect(chainChecked()).toBe(true);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH, signalTxHash: null } });
  });

  it("never signals again while a submitted user operation is still unaccounted for", async () => {
    const { ctx, sendBatch, confirm } = smartSetup(() =>
      vi.fn().mockRejectedValue(new WaitForUserOperationReceiptTimeoutError({ hash: BUNDLE })),
    );
    await confirm();
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "tx_pending" } });
    ctx.store.getState().back();
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    await ctx.store.getState().confirm();
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "tx_pending" } });
  });
});

describe("a signal whose outcome the wallet could not report", () => {
  const sendCalls = (ctx: ReturnType<typeof setup>) => ctx.sender.sendCalls as Mock;
  const TX: Hex = `0x${"cd".repeat(32)}`;
  const pendingError = (hash: Hex | null) =>
    Object.assign(new Error("Your transaction was submitted but is not confirmed yet."), {
      name: "TransactionPendingError",
      code: "receipt_timeout",
      hash,
    });
  const walletTimeout = () =>
    Object.assign(new Error("Your wallet did not respond in time."), { name: "WalletTimeoutError", code: "request_timeout" });

  it("never signals a second intent after a receipt it could not read", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    sendCalls(ctx).mockResolvedValueOnce(receipt([]));
    ctx.fc.waitForReceipt.mockResolvedValue(receipt([]));
    await ctx.store.getState().confirm();
    expect(ctx.store.getState()).toMatchObject({
      step: "error",
      errorReturnStep: "idle",
      error: { code: "tx_pending", recoverable: true },
      selectedQuote: null,
      quotes: [],
    });

    // The intent shows up on the orchestrator: checking again adopts it instead of resending.
    ctx.fc.chain.orchestratorIntents.push(orchestratorIntent());
    await ctx.store.getState().retry();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.fc.signalPrepare).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      order: { intentHash: INTENT_HASH, usdcExpected: 48_551_547n, expiresAt: 1_791_732_741_000, status: "active" },
    });
    expect(ctx.storage.load(BUYER)?.intentHash).toBe(INTENT_HASH);
  });

  it("waits for a submitted transaction the wallet timed out on", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    sendCalls(ctx).mockRejectedValueOnce(pendingError(TX));
    ctx.fc.waitForReceipt.mockResolvedValue(receipt([intentSignaledLog(), fundsLockedLog()]));
    await ctx.store.getState().confirm();
    expect(ctx.fc.waitForReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: TX }));
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH } });
  });

  it("finds the new intent on the orchestrator when the wallet gave no hash", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    ctx.fc.chain.orchestratorIntents.push(
      orchestratorIntent({ intentHash: `0x${"11".repeat(32)}`, timestamp: 1_700_000_000n }),
      orchestratorIntent({ intentHash: `0x${"22".repeat(32)}`, depositId: 9n }),
    );
    sendCalls(ctx).mockImplementationOnce(async () => {
      ctx.fc.chain.orchestratorIntents.push(orchestratorIntent());
      throw walletTimeout();
    });
    await ctx.store.getState().confirm();
    expect(ctx.fc.waitForReceipt).not.toHaveBeenCalled();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      order: { intentHash: INTENT_HASH, signalTxHash: null },
    });
  });

  it("offers the same quote again only once the transaction is proven reverted", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    sendCalls(ctx).mockRejectedValueOnce(pendingError(TX));
    ctx.fc.waitForReceipt.mockResolvedValue(receipt([], "reverted"));
    await ctx.store.getState().confirm();
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "confirming", error: { code: "tx_failed" } });
    expect(ctx.store.getState().selectedQuote).not.toBeNull();
    await ctx.store.getState().retry();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(2);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH } });
  });

  it("re-checks an unresolved send before signalling a fresh quote", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    sendCalls(ctx).mockRejectedValueOnce(walletTimeout());
    await ctx.store.getState().confirm();
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "tx_pending" } });

    ctx.store.getState().back();
    expect(ctx.store.getState().step).toBe("idle");
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    ctx.fc.chain.orchestratorIntents.push(orchestratorIntent());
    await ctx.store.getState().confirm();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      notice: "Your earlier order went through, so here it is.",
      order: { intentHash: INTENT_HASH },
    });
  });

  it("keeps blocking a second intent while the earlier send is still unknown", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    sendCalls(ctx).mockRejectedValueOnce(walletTimeout());
    await ctx.store.getState().confirm();
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "tx_pending" } });

    ctx.store.getState().back();
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    await ctx.store.getState().confirm();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "confirming", error: { code: "tx_pending" } });

    // Still nothing on-chain a minute later: still no second send.
    ctx.advance(60_000);
    await ctx.store.getState().retry();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "tx_pending" } });

    // The earlier send lands after all: it is adopted, never doubled.
    ctx.fc.chain.orchestratorIntents.push(orchestratorIntent());
    await ctx.store.getState().retry();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      notice: "Your earlier order went through, so here it is.",
      order: { intentHash: INTENT_HASH },
    });
  });

  it("lets a new order through once the earlier send's signature has lapsed with no intent on-chain", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    const expiresAtSeconds = BigInt(Math.floor(NOW / 1000) + 300);
    ctx.fc.signalPrepare.mockResolvedValue({
      to: ORCHESTRATOR,
      data: signalCalldata({ signatureExpiration: expiresAtSeconds }),
      value: 0n,
      chainId: 8453,
    });
    sendCalls(ctx).mockRejectedValueOnce(walletTimeout());
    await ctx.store.getState().confirm();
    expect(ctx.store.getState()).toMatchObject({ step: "error", error: { code: "tx_pending" } });

    // Past the signature's expiry but within the clock margin: still blocked.
    ctx.advance(10 * 60_000);
    ctx.store.getState().back();
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    await ctx.store.getState().confirm();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ error: { code: "tx_pending" } });

    // Past expiry plus the margin, and the orchestrator shows no intent: the earlier send can never land.
    ctx.advance(20 * 60_000);
    ctx.store.getState().back();
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    ctx.fc.signalPrepare.mockResolvedValue({ to: ORCHESTRATOR, data: "0x5149", value: 0n, chainId: 8453 });
    await ctx.store.getState().confirm();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(2);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH } });
  });

  it("does not lapse an unresolved send while the orchestrator cannot be read", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    ctx.fc.signalPrepare.mockResolvedValue({
      to: ORCHESTRATOR,
      data: signalCalldata({ signatureExpiration: BigInt(Math.floor(NOW / 1000) + 300) }),
      value: 0n,
      chainId: 8453,
    });
    sendCalls(ctx).mockRejectedValueOnce(walletTimeout());
    await ctx.store.getState().confirm();
    ctx.advance(60 * 60_000);
    const read = ctx.fc.readContract.getMockImplementation() as (req: { functionName: string }) => Promise<unknown>;
    ctx.fc.readContract.mockImplementation(async (req: { functionName: string }) => {
      if (req.functionName === "getAccountIntents") throw new Error("rate limited");
      return read(req);
    });
    ctx.store.getState().back();
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    await ctx.store.getState().confirm();
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ error: { code: "tx_pending" } });
  });

  it("still lets the player retry a send the wallet refused", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    sendCalls(ctx).mockRejectedValueOnce(
      Object.assign(new Error("Finish the request already open in your wallet first."), { name: "WalletBusyError", code: "busy" }),
    );
    await ctx.store.getState().confirm();
    expect(ctx.fc.waitForReceipt).not.toHaveBeenCalled();
    expect(ctx.store.getState()).toMatchObject({ step: "error", errorReturnStep: "confirming", error: { code: "wallet" } });
    await ctx.store.getState().retry();
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH } });
  });
});

describe("recovery races", () => {
  it("does not let a slow login recovery wipe an order signalled meanwhile", async () => {
    const ctx = setup();
    const slow = deferred<unknown[]>();
    ctx.fc.accountIntents.mockImplementationOnce(() => slow.promise);
    ctx.store.getState().bindSender(ctx.sender);
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    await ctx.store.getState().confirm();
    expect(ctx.store.getState().step).toBe("awaitingPayment");

    slow.resolve([]);
    await flush(40);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH } });
    expect(ctx.storage.load(BUYER)?.intentHash).toBe(INTENT_HASH);
  });

  it("keeps a stored order when the chain listing misses it", async () => {
    const ctx = setup();
    ctx.storage.save(storedOrder({ signaledAt: NOW - 600_000, expiresAt: NOW + 5 * 3_600_000, memo: "lunch" }));
    ctx.fc.intentByHash.mockResolvedValue({ status: "SIGNALED" });
    ctx.store.getState().bindSender(ctx.sender);
    await flush(40);
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      notice: null,
      order: { intentHash: INTENT_HASH, status: "active", memo: "lunch" },
    });
    expect(ctx.storage.load(BUYER)?.memo).toBe("lunch");
  });

  it("keeps a listed order that cannot be rebuilt", async () => {
    const ctx = setup();
    ctx.storage.save(storedOrder({ signaledAt: NOW - 600_000, memo: "lunch" }));
    ctx.fc.accountIntents.mockResolvedValue([
      pvIntentView({ paymentMethod: UNKNOWN_METHOD }),
    ]);
    ctx.store.getState().bindSender(ctx.sender);
    await flush(40);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH } });
    expect(ctx.storage.load(BUYER)?.memo).toBe("lunch");
  });
});

describe("what a reload or recovery keeps", () => {
  it("remembers that the player said they paid, across a reload and chain recovery", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    expect(ctx.store.getState().order?.paidClaimedAt).toBeNull();
    ctx.advance(5_000);
    await ctx.store.getState().markPaid();
    expect(ctx.store.getState().order?.paidClaimedAt).toBe(NOW + 5_000);
    expect(ctx.storage.load(BUYER)?.paidClaimedAt).toBe(NOW + 5_000);

    // A second check keeps the first claim.
    ctx.advance(5_000);
    ctx.store.getState().back();
    await ctx.store.getState().startVerification();
    expect(ctx.store.getState().order?.paidClaimedAt).toBe(NOW + 5_000);

    // Reload: the order comes back from storage, then from the chain, still marked paid.
    ctx.fc.accountIntents.mockResolvedValue([pvIntentView()]);
    ctx.store.getState().bindSender(null);
    ctx.store.getState().bindSender(ctx.sender);
    await flush(40);
    expect(ctx.store.getState()).toMatchObject({
      step: "awaitingPayment",
      order: { intentHash: INTENT_HASH, paidClaimedAt: NOW + 5_000, fees: QUOTE_FEES },
    });
  });

  it("keeps the confirmed net when the chain's referral legs omit the manager fee", async () => {
    const ctx = setup();
    const confirmedNet = 48_551_547n;
    ctx.storage.save(storedOrder({ signaledAt: NOW - 600_000, usdcExpected: confirmedNet }));
    ctx.fc.accountIntents.mockResolvedValue([pvIntentView()]);
    ctx.store.getState().bindSender(ctx.sender);
    await flush(40);
    expect(ctx.store.getState().order?.usdcExpected).toBe(confirmedNet);
    expect(ctx.storage.load(BUYER)?.usdcExpected).toBe(confirmedNet);
  });
});

describe("background re-reads of an open order", () => {
  it("shows a seller's release without a reload, without flagging a visible check", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    expect(ctx.poll.intervalMs).toBe(15_000);
    expect(ctx.poll.ticks.size).toBe(1);
    const flagged: boolean[] = [];
    const unsubscribe = ctx.store.subscribe((s) => flagged.push(s.recovering));

    // Nothing changed on-chain: the order object is left alone.
    const before = ctx.store.getState().order;
    await ctx.tick();
    expect(ctx.store.getState().order).toBe(before);

    ctx.fc.chain.gone.add(INTENT_HASH.toLowerCase());
    ctx.fc.intentByHash.mockResolvedValue({ status: "FULFILLED", fulfillTxHash: `0x${"cd".repeat(32)}`, takerAmountNetFees: "48600663" });
    await ctx.tick();
    unsubscribe();
    expect(ctx.store.getState()).toMatchObject({
      step: "completed",
      completion: { usdcReceived: 48_600_663n, fulfillTxHash: `0x${"cd".repeat(32)}` },
    });
    expect(flagged.every((r) => r === false)).toBe(true);
    expect(ctx.storage.load(BUYER)).toBeNull();
  });

  it("re-reads when the window regains focus, ending a capture for an order that was cancelled", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "capturing" });
    ctx.fc.chain.gone.add(INTENT_HASH.toLowerCase());
    ctx.fc.intentByHash.mockResolvedValue({ status: "PRUNED" });
    for (const run of ctx.poll.focus) run();
    await flush(40);
    expect(ctx.store.getState()).toMatchObject({ step: "cancelled", order: { status: "cancelled" } });
    expect(ctx.ext.listeners.size).toBe(0);
  });

  it("only re-reads while an order is open and nothing is in flight, and stops on logout", async () => {
    const ctx = setup();
    ctx.store.getState().bindSender(ctx.sender);
    await flush();
    const reads = () => ctx.fc.accountIntents.mock.calls.length;
    const idleReads = reads();
    await ctx.tick();
    expect(reads()).toBe(idleReads);

    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    await ctx.store.getState().confirm();
    const openReads = reads();
    ctx.store.setState({ pending: "fulfill" });
    await ctx.tick();
    expect(reads()).toBe(openReads);
    ctx.store.setState({ pending: null });
    await ctx.tick();
    expect(reads()).toBe(openReads + 1);

    ctx.store.getState().bindSender(null);
    expect(ctx.poll.ticks.size).toBe(0);
    expect(ctx.poll.focus.size).toBe(0);
  });
});

describe("transactions in flight", () => {
  const holdNextSend = (ctx: ReturnType<typeof setup>) => {
    const held = deferred<TransactionReceipt>();
    (ctx.sender.sendCalls as Mock).mockImplementationOnce(() => held.promise);
    return held;
  };

  it("ignores verification, cancel and a second pick while a release is in flight", async () => {
    const ctx = setup();
    await toSelectPayment(ctx);
    const held = holdNextSend(ctx);
    const first = ctx.store.getState().choosePayment(0);
    await vi.waitFor(() => expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(2));
    expect(ctx.store.getState()).toMatchObject({ step: "fulfilling", pending: "fulfill" });

    await ctx.store.getState().startVerification();
    await ctx.store.getState().markPaid();
    await ctx.store.getState().connectExtension();
    expect(ctx.store.getState()).toMatchObject({ step: "fulfilling", pending: "fulfill" });
    ctx.ext.emit(captureMessage("revolut", [paidRow(0)]));
    await ctx.store.getState().choosePayment(0);
    await ctx.store.getState().cancelOrder();
    expect(ctx.fc.fulfillPrepare).toHaveBeenCalledTimes(1);
    expect(ctx.fc.cancelPrepare).not.toHaveBeenCalled();

    held.resolve(receipt([intentFulfilledLog()]));
    await first;
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(2);
    expect(ctx.store.getState()).toMatchObject({ step: "completed", completion: { usdcReceived: 48_600_663n } });
  });

  it("does not write a release that finishes after logout into the next session", async () => {
    const ctx = setup();
    await toSelectPayment(ctx);
    const held = holdNextSend(ctx);
    const first = ctx.store.getState().choosePayment(0);
    await vi.waitFor(() => expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(2));
    ctx.store.getState().bindSender(null);
    expect(ctx.store.getState()).toMatchObject({ owner: null, step: "idle" });

    held.resolve(receipt([intentFulfilledLog()]));
    await first;
    await flush(40);
    expect(ctx.store.getState()).toMatchObject({ owner: null, step: "idle", order: null, completion: null });
    expect(ctx.storage.load(BUYER)).toBeNull();
  });

  it("stores a signal that lands after logout without showing it to the next session", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    const held = holdNextSend(ctx);
    const confirming = ctx.store.getState().confirm();
    await vi.waitFor(() => expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1));
    ctx.store.getState().bindSender(null);

    held.resolve(receipt([intentSignaledLog(), fundsLockedLog()]));
    await confirming;
    expect(ctx.store.getState()).toMatchObject({ owner: null, step: "idle", order: null });
    expect(ctx.storage.load(BUYER)?.intentHash).toBe(INTENT_HASH);
  });

  it("ignores a second confirm while the first signal is in flight", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    const held = holdNextSend(ctx);
    const first = ctx.store.getState().confirm();
    await vi.waitFor(() => expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1));
    ctx.store.setState({ step: "confirming" });
    await ctx.store.getState().confirm();
    held.resolve(receipt([intentSignaledLog(), fundsLockedLog()]));
    await first;
    expect(ctx.fc.signalPrepare).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", order: { intentHash: INTENT_HASH } });
  });
});

describe("launch telemetry", () => {
  const sendCalls = (ctx: ReturnType<typeof setup>) => ctx.sender.sendCalls as Mock;
  const tracked = () => telemetry.track.mock.calls.map(([event]) => event as string);
  const reported = () => telemetry.report.mock.calls.map(([error, context]) => ({ message: (error as { message: string }).message, context }));
  /** An eth_call revert from the fulfil preflight, as Alchemy answers it. */
  const verifierRevert = (reason: string) =>
    new RpcRequestError({
      body: { method: "eth_call", params: [] },
      error: { code: 3, message: `execution reverted: ${reason}`, data: encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: [reason] }) },
      url: "https://base-mainnet.g.alchemy.com/v2/SECRETKEY123",
    });

  beforeEach(() => {
    telemetry.track.mockClear();
    telemetry.report.mockClear();
  });

  it("counts quote, signal, the first verification of an order and the release, and reports nothing", async () => {
    const ctx = setup();
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    // Going back and verifying again is the same order.
    ctx.store.getState().back();
    await ctx.store.getState().markPaid();
    ctx.ext.emit(captureMessage("revolut", [paidRow(0)]));
    await ctx.store.getState().choosePayment(0);
    expect(ctx.store.getState().step).toBe("completed");
    expect(tracked()).toEqual(["quote", "signal_ok", "verify_start", "fulfil_ok"]);
    expect(telemetry.report).not.toHaveBeenCalled();
  });

  it("does not count or report a player saying no in their wallet", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    sendCalls(ctx).mockRejectedValueOnce(new UserRejectedRequestError(new Error("User rejected the request.")));
    await ctx.store.getState().confirm();
    expect(ctx.store.getState().error?.code).toBe("user_rejected");
    expect(tracked()).toEqual(["quote"]);
    expect(telemetry.report).not.toHaveBeenCalled();
  });

  it("counts a failed signal and reports its redacted cause chain", async () => {
    const ctx = setup();
    await toConfirming(ctx);
    sendCalls(ctx).mockRejectedValueOnce(
      Object.assign(new Error("Finish the request already open in your wallet first."), { name: "WalletBusyError", code: "busy" }),
    );
    await ctx.store.getState().confirm();
    expect(tracked()).toEqual(["quote", "signal_fail"]);
    expect(reported()).toEqual([{ context: "buy.signal", message: ctx.store.getState().error?.detail }]);
    expect(reported()[0]?.message).toContain("WalletBusyError [busy]");
  });

  it("counts a paymaster refusal as a gas failure with what the paymaster said, and the signal as failed", async () => {
    const ctx = setup();
    const sendBatch = vi.fn().mockRejectedValueOnce(cdpPolicyRefusal());
    const reader = { getBalance: vi.fn(async () => 0n), request: vi.fn(async () => null), waitForTransactionReceipt: vi.fn() };
    const sender = createSmartSender(BUYER, { sendBatch, signMessage: vi.fn(), signTypedData: vi.fn() }, { reader });
    ctx.store.getState().bindSender(sender);
    await flush();
    await ctx.store.getState().requestQuotes({ fiatAmount: "50", currency: "USD" });
    ctx.store.getState().selectQuote(ctx.store.getState().quotes[0]!.id);
    await ctx.store.getState().confirm();
    expect(tracked()).toEqual(["quote", "gas_fail", "signal_fail"]);
    const [gas, signal] = reported();
    expect(gas).toEqual({
      context: "sponsorship",
      message: "request denied - policy rejected: called address not in allowlist: 0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
    });
    expect(signal?.context).toBe("buy.signal");
    expect(JSON.stringify(telemetry.report.mock.calls)).not.toContain("SECRETKEY123");
  });

  it("counts a proof the verifier rejects as a failed release, keeps the order open and lets the same payment be retried", async () => {
    const ctx = setup();
    await toSelectPayment(ctx);
    telemetry.track.mockClear();
    ctx.fc.ethCall.mockRejectedValueOnce(verifierRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures"));
    await ctx.store.getState().choosePayment(0);
    const failed = ctx.store.getState();
    expect(failed).toMatchObject({
      step: "error",
      errorReturnStep: "selectPayment",
      order: { status: "active" },
      error: { code: "proof_rejected", recoverable: true },
    });
    expect(failed.error?.detail).toContain("Not enough valid witness signatures");
    // Nothing was sent, and the chain is not asked whether a release landed.
    expect(ctx.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(ctx.fc.intentByHash).not.toHaveBeenCalled();
    expect(tracked()).toEqual(["fulfil_fail"]);
    expect(reported()).toEqual([{ context: "buy.fulfill", message: failed.error?.detail }]);

    await ctx.store.getState().retry();
    expect(ctx.store.getState().step).toBe("completed");
    expect(tracked()).toEqual(["fulfil_fail", "fulfil_ok"]);
  });

  it("counts a release the wallet lost track of but the chain shows as a success, not a failure", async () => {
    const ctx = setup();
    await toSelectPayment(ctx);
    telemetry.track.mockClear();
    sendCalls(ctx).mockRejectedValueOnce(Object.assign(new Error("Timed out"), { name: "TransactionPendingError", code: "receipt_timeout" }));
    ctx.fc.intentByHash.mockResolvedValue({ status: "FULFILLED", takerAmountNetFees: "48600663" });
    await ctx.store.getState().choosePayment(0);
    expect(ctx.store.getState().step).toBe("completed");
    expect(tracked()).toEqual(["fulfil_ok"]);
  });
});

describe("looking for the Peer extension (Peer web's version poll and InstallExtension)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The live interval, so fake timers drive the look-out. */
  const intervals: Partial<BuyDeps> = {
    every: (ms, run) => {
      const id = setInterval(run, ms);
      return () => clearInterval(id);
    },
    // The chain re-read stays out of the way.
    pollIntervalMs: 3_600_000,
  };

  /** A Peer extension that is missing until `install()`; every look is counted. */
  function missing(overrides: Parameters<typeof fakeExtension>[0] = {}) {
    let available = false;
    const isAvailable = vi.fn(() => available);
    const requestConnection = vi.fn(async () => true);
    return {
      extension: { isAvailable, getState: async () => "needs_connection" as const, requestConnection, ...overrides },
      isAvailable,
      requestConnection,
      install: () => {
        available = true;
      },
    };
  }

  it("looks at once and every 5 s while the payment scroll is open, without a click, until PeerAuth appears", async () => {
    vi.useFakeTimers();
    const ext = missing();
    const ctx = setup({ extension: ext.extension, deps: intervals });
    await toAwaitingPayment(ctx);
    expect(ctx.store.getState().extension).toBeNull();

    const close = ctx.store.getState().watchExtension();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", verifying: null, extension: "needs_install", awaitingInstall: false });
    const looks = ext.isAvailable.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ext.isAvailable.mock.calls.length).toBe(looks + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ext.isAvailable.mock.calls.length).toBe(looks + 2);

    // Installed from another tab: found on the next look, with no click and no verification started.
    ext.install();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", verifying: null, extension: "needs_connection" });
    expect(ctx.ext.sdk.authenticate).not.toHaveBeenCalled();
    expect(ext.requestConnection).not.toHaveBeenCalled();

    // Usable now: the look-out stops although the scroll is still open.
    const found = ext.isAvailable.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ext.isAvailable.mock.calls.length).toBe(found);
    close();
  });

  it("stops looking when the screen closes", async () => {
    vi.useFakeTimers();
    const ext = missing();
    const ctx = setup({ extension: ext.extension, deps: intervals });
    await toAwaitingPayment(ctx);
    const close = ctx.store.getState().watchExtension();
    await vi.advanceTimersByTimeAsync(5_000);
    close();
    close(); // idempotent
    const looks = ext.isAvailable.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ext.isAvailable.mock.calls.length).toBe(looks);
  });

  it("keeps one look-out for two open screens and stops only when both close", async () => {
    vi.useFakeTimers();
    const ext = missing();
    const ctx = setup({ extension: ext.extension, deps: intervals });
    await toAwaitingPayment(ctx);
    const closePayment = ctx.store.getState().watchExtension();
    const closeVerify = ctx.store.getState().watchExtension();
    await vi.advanceTimersByTimeAsync(0);
    const looks = ext.isAvailable.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ext.isAvailable.mock.calls.length).toBe(looks + 1);
    closePayment();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ext.isAvailable.mock.calls.length).toBe(looks + 2);
    closeVerify();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ext.isAvailable.mock.calls.length).toBe(looks + 2);
  });

  it("on Verify, the install prompt moves on to connecting as soon as PeerAuth appears, without a click", async () => {
    vi.useFakeTimers();
    const ext = missing();
    const ctx = setup({ extension: ext.extension, deps: intervals });
    await toAwaitingPayment(ctx);
    const close = ctx.store.getState().watchExtension();
    await ctx.store.getState().markPaid();
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "needsInstall", extension: "needs_install" });
    await vi.advanceTimersByTimeAsync(5_000);
    // Looked and found nothing: the prompt stays put (no "checking" flash).
    expect(ctx.store.getState()).toMatchObject({ verifying: "needsInstall", pending: null });
    ext.install();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ctx.store.getState().verifying).toBe("needsInstall");
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "needsConnection", extension: "needs_connection" });
    // Connecting is the player's click: the look-out never asks for it.
    expect(ext.requestConnection).not.toHaveBeenCalled();
    close();
  });

  it("after Add to Chrome, looks at once, shows the wait, and goes straight on to capture when the install is already connected", async () => {
    vi.useFakeTimers();
    const ext = missing({ getState: async () => "ready" as const });
    const ctx = setup({ extension: ext.extension, deps: intervals });
    await toAwaitingPayment(ctx);
    const close = ctx.store.getState().watchExtension();
    await ctx.store.getState().markPaid();
    const looks = ext.isAvailable.mock.calls.length;
    ctx.store.getState().openExtensionInstall();
    expect(ctx.openInstallPage).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState().awaitingInstall).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(ext.isAvailable.mock.calls.length).toBe(looks + 1);
    expect(ctx.store.getState()).toMatchObject({ verifying: "needsInstall", awaitingInstall: true });
    ext.install();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "capturing", awaitingInstall: false });
    expect(ctx.ext.sdk.authenticate).toHaveBeenCalledTimes(1);
    close();
  });

  it("also looks when the page regains focus (back from the Web Store tab)", async () => {
    const ext = missing();
    const ctx = setup({ extension: ext.extension });
    await toAwaitingPayment(ctx);
    const listening = ctx.poll.focus.size;
    const close = ctx.store.getState().watchExtension();
    await flush(20);
    expect(ctx.poll.focus.size).toBe(listening + 1);
    ext.install();
    for (const run of ctx.poll.focus) run();
    await flush(40);
    expect(ctx.store.getState().extension).toBe("needs_connection");
    // Found: the focus listener goes with the timer.
    expect(ctx.poll.focus.size).toBe(listening);
    close();
  });

  it("keeps looking at an extension too old for the order's platform until it is updated, and never prompts it", async () => {
    vi.useFakeTimers();
    let version = "0.6.2";
    const getVersion = vi.fn(async () => version);
    const requestConnection = vi.fn(async () => true);
    const ctx = setup({ extension: { getState: async () => "needs_connection", getVersion, requestConnection }, deps: intervals });
    await toAwaitingPayment(ctx);
    const close = ctx.store.getState().watchExtension();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.store.getState()).toMatchObject({ step: "awaitingPayment", extension: "needs_update" });
    // Opening the store for an update awaits no install: an updated extension needs a reload.
    ctx.store.getState().openExtensionInstall();
    expect(ctx.openInstallPage).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState().awaitingInstall).toBe(false);
    const reads = getVersion.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getVersion.mock.calls.length).toBe(reads + 2);
    version = "0.7.2";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctx.store.getState().extension).toBe("needs_connection");
    const updated = getVersion.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getVersion.mock.calls.length).toBe(updated);
    expect(requestConnection).not.toHaveBeenCalled();
    close();
  });

  it("asks for the update first when verifying with an old, unconnected extension", async () => {
    const ctx = setup({ extension: { getState: async () => "needs_connection", getVersion: async () => "0.6.2" } });
    await toAwaitingPayment(ctx);
    await ctx.store.getState().markPaid();
    expect(ctx.store.getState()).toMatchObject({ step: "verifying", verifying: "needsUpdate", pending: null, extension: "needs_update" });
    expect(ctx.ext.sdk.authenticate).not.toHaveBeenCalled();
  });

  it("flags nothing to install on a browser that can't run it, and doesn't keep looking", async () => {
    vi.useFakeTimers();
    const isAvailable = vi.fn(() => false);
    const ctx = setup({ extension: { isAvailable }, canInstall: false, deps: intervals });
    await toAwaitingPayment(ctx);
    const close = ctx.store.getState().watchExtension();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.store.getState().extension).toBe("unsupported_browser");
    const looks = isAvailable.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(isAvailable.mock.calls.length).toBe(looks);
    close();
  });

  it("forgets what it knew when the wallet logs out", async () => {
    vi.useFakeTimers();
    const ext = missing();
    const ctx = setup({ extension: ext.extension, deps: intervals });
    await toAwaitingPayment(ctx);
    const close = ctx.store.getState().watchExtension();
    await ctx.store.getState().markPaid();
    ctx.store.getState().openExtensionInstall();
    ctx.store.getState().bindSender(null);
    expect(ctx.store.getState()).toMatchObject({ awaitingInstall: false, extension: null, order: null });
    close();
    const looks = ext.isAvailable.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ext.isAvailable.mock.calls.length).toBe(looks);
  });
});
