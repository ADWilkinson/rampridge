import { zeroAddress, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { EXPIRED_ORDER_ADOPT_MS, recoverBuyOrder } from "../recovery";
import { BUYER, ESCROW, INTENT_HASH, QUOTE_FEES, fakeClient, pvIntentView, storedOrder } from "./helpers";

/** A payment method hash the SDK catalog does not know: every method it lists is now a buy platform. */
const UNKNOWN_METHOD: Hex = `0x${"5e".repeat(32)}`;
const NOW = 1_791_711_741_000;
/** The default intent's escrow lock expiry (FundsLocked / getDepositIntent), ms. */
const LOCK_EXPIRY = 1_791_732_741_000;
/** The default intent's signal time, ms. */
const SIGNALED = 1_791_711_141_000;
const lookupPayee = vi.fn(async () => "madouche");

function recover(fc: ReturnType<typeof fakeClient>, stored = storedOrder({ signaledAt: NOW - 600_000 })) {
  return recoverBuyOrder({ client: fc.client, owner: BUYER, stored, now: NOW, lookupPayee, dismissed: new Set() });
}

function adopt(fc: ReturnType<typeof fakeClient>, now = NOW, dismissed: ReadonlySet<string> = new Set()) {
  return recoverBuyOrder({ client: fc.client, owner: BUYER, stored: null, now, lookupPayee, dismissed });
}

describe("recovering a stored order the ProtocolViewer did not list", () => {
  // getPvAccountIntents drops an orchestrator whose read failed, so an empty list proves nothing.
  it("keeps it open while the escrow still holds the lock, whatever the indexer says", async () => {
    const fc = fakeClient();
    fc.intentByHash.mockResolvedValue({ status: "SIGNALED" });
    const result = await recover(fc);
    expect(result).toMatchObject({ kind: "active", verified: true, order: { intentHash: INTENT_HASH, status: "active" } });
  });

  it("keeps it unconfirmed when neither the indexer nor the escrow can be read", async () => {
    const fc = fakeClient();
    fc.intentByHash.mockRejectedValue(new Error("Indexer request failed: 429"));
    fc.readContract.mockRejectedValue(new Error("rate limited"));
    expect(await recover(fc)).toMatchObject({ kind: "active", verified: false, order: { intentHash: INTENT_HASH } });
  });

  it("stops it being payable when the lock is gone but the indexer still shows it signalled", async () => {
    const fc = fakeClient();
    fc.chain.gone.add(INTENT_HASH.toLowerCase());
    fc.intentByHash.mockResolvedValue({ status: "SIGNALED" });
    expect(await recover(fc)).toMatchObject({ kind: "active", verified: false, order: { expiresAt: NOW } });
  });

  it("stops it being payable when the lock is gone and the indexer is down", async () => {
    const fc = fakeClient();
    fc.chain.gone.add(INTENT_HASH.toLowerCase());
    fc.intentByHash.mockRejectedValue(new Error("Indexer request failed: 503"));
    expect(await recover(fc)).toMatchObject({ kind: "active", verified: false, order: { expiresAt: NOW } });
  });

  it("keeps a fresh order a lagging node cannot see yet", async () => {
    const fc = fakeClient();
    fc.chain.gone.add(INTENT_HASH.toLowerCase());
    const result = await recover(fc, storedOrder({ signaledAt: NOW - 30_000 }));
    expect(result).toMatchObject({ kind: "active", verified: false, order: { expiresAt: LOCK_EXPIRY } });
  });

  it("reports it closed only when the lock is gone and the indexer says pruned", async () => {
    const fc = fakeClient();
    fc.chain.gone.add(INTENT_HASH.toLowerCase());
    fc.intentByHash.mockResolvedValue({ status: "PRUNED" });
    expect(await recover(fc)).toMatchObject({ kind: "closed", order: { status: "cancelled" } });
  });

  it("does not trust a pruned status the escrow contradicts", async () => {
    const fc = fakeClient();
    fc.intentByHash.mockResolvedValue({ status: "PRUNED" });
    expect(await recover(fc)).toMatchObject({ kind: "active", verified: true });
  });

  it("reports it fulfilled from the indexer", async () => {
    const fc = fakeClient();
    fc.chain.gone.add(INTENT_HASH.toLowerCase());
    fc.intentByHash.mockResolvedValue({ status: "FULFILLED", fulfillTxHash: `0x${"cd".repeat(32)}`, takerAmountNetFees: "48600663" });
    expect(await recover(fc)).toMatchObject({ kind: "fulfilled", usdcReceived: 48_600_663n, txHash: `0x${"cd".repeat(32)}` });
  });

  it("settles the stored order before adopting a different live one", async () => {
    const fc = fakeClient();
    const other: Hex = `0x${"77".repeat(32)}`;
    fc.accountIntents.mockResolvedValue([pvIntentView({ intentHash: other })]);
    fc.intentByHash.mockResolvedValue({ status: "SIGNALED" });
    expect(await recover(fc)).toMatchObject({ kind: "active", order: { intentHash: INTENT_HASH } });
  });
});

describe("recovering a listed order that cannot be rebuilt", () => {
  it("keeps the stored order when the chain's payment method is not one this app shows", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([
      pvIntentView({ paymentMethod: UNKNOWN_METHOD }),
    ]);
    const stored = storedOrder({ signaledAt: NOW - 600_000, expiresAt: NOW + 60_000, memo: "for pizza" });
    const result = await recover(fc, stored);
    expect(result).toMatchObject({
      kind: "active",
      verified: false,
      order: { intentHash: INTENT_HASH, memo: "for pizza", expiresAt: 1_791_732_741_000 },
    });
  });

  it("keeps the stored order when the indexer fallback has no payee details", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockRejectedValue(new Error("ProtocolViewer read failed"));
    fc.ownerIntents.mockResolvedValue([
      {
        intentHash: INTENT_HASH,
        depositId: `0x777777779d229cdF3110e9de47943791c26300Ef_6528`,
        amount: "49066797",
        conversionRate: "1019019019019019035",
        paymentMethodHash: "0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d",
        fiatCurrency: "0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e",
        signalTimestamp: "1791711141",
        expiryTime: "1791732741",
        orchestratorAddress: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
      },
    ]);
    const result = await recover(fc);
    expect(result).toMatchObject({ kind: "active", verified: false, order: { intentHash: INTENT_HASH, payeeHandle: "stored-handle" } });
  });

  it("returns none only when there is no stored order and nothing live", async () => {
    const fc = fakeClient();
    expect(await adopt(fc)).toEqual({ kind: "none" });
  });
});

describe("what the buyer receives", () => {
  // The ProtocolViewer only reports referral legs (Peer's 0.95% here); OrchestratorV3 also takes the
  // rate manager's fee at release, so a net rebuilt from the legs alone overstates the USDC.
  const NET_WITH_MANAGER_FEE = 48_551_547n;

  it("keeps the stored net of a known order instead of re-deriving it from the referral legs", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    const result = await recover(fc, storedOrder({ signaledAt: NOW - 600_000, usdcExpected: NET_WITH_MANAGER_FEE }));
    expect(result).toMatchObject({ kind: "active", verified: true, order: { usdcExpected: NET_WITH_MANAGER_FEE, usdcGross: 49_066_797n } });
  });

  it("uses the indexer's net (all fees) when nothing is stored", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    fc.intentByHash.mockResolvedValue({ status: "SIGNALED", takerAmountNetFees: NET_WITH_MANAGER_FEE.toString() });
    expect(await adopt(fc)).toMatchObject({ kind: "active", order: { usdcExpected: NET_WITH_MANAGER_FEE } });
  });

  it("falls back to the referral legs only when neither storage nor the indexer knows", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    fc.intentByHash.mockRejectedValue(new Error("Indexer request failed: 503"));
    expect(await adopt(fc)).toMatchObject({ kind: "active", order: { usdcExpected: 48_600_663n } });
  });

  describe("a rate-manager deposit rebuilt from the chain alone", () => {
    // 0.1%: floor(49_066_797 x 0.001) = 49_066 taken at release on top of Peer's 0.95% leg.
    const MANAGER_FEE = 1_000_000_000_000_000n;
    const MANAGER = "0x2222222222222222222222222222222222222222";
    const managerReads = (fc: ReturnType<typeof fakeClient>) =>
      fc.readContract.mock.calls.filter(([req]) => (req as { functionName: string }).functionName === "getManagerFee");

    it("subtracts the manager fee the escrow reports", async () => {
      const fc = fakeClient();
      fc.accountIntents.mockResolvedValue([pvIntentView()]);
      fc.intentByHash.mockRejectedValue(new Error("Indexer request failed: 503"));
      fc.chain.managerFee = { recipient: MANAGER, fee: MANAGER_FEE };
      expect(await adopt(fc)).toMatchObject({ kind: "active", order: { usdcExpected: 48_600_663n - 49_066n } });
      expect(managerReads(fc)[0]?.[0]).toMatchObject({ address: ESCROW, args: [6528n] });
    });

    it("prefers the fee the indexer snapshotted at signal time over the escrow's current one", async () => {
      const fc = fakeClient();
      fc.accountIntents.mockResolvedValue([pvIntentView()]);
      fc.intentByHash.mockResolvedValue({ status: "SIGNALED", managerFee: MANAGER_FEE.toString() });
      fc.chain.managerFee = { recipient: MANAGER, fee: 3n * MANAGER_FEE };
      expect(await adopt(fc)).toMatchObject({ kind: "active", order: { usdcExpected: 48_600_663n - 49_066n } });
      expect(managerReads(fc)).toHaveLength(0);
    });

    it("takes nothing for a fee with no recipient, as the orchestrator does", async () => {
      const fc = fakeClient();
      fc.accountIntents.mockResolvedValue([pvIntentView()]);
      fc.chain.managerFee = { recipient: zeroAddress, fee: MANAGER_FEE };
      expect(await adopt(fc)).toMatchObject({ kind: "active", order: { usdcExpected: 48_600_663n } });
    });

    it("keeps the figure from the legs when the escrow read fails", async () => {
      const fc = fakeClient();
      fc.accountIntents.mockResolvedValue([pvIntentView()]);
      const served = fc.readContract.getMockImplementation() as (req: { functionName: string }) => Promise<unknown>;
      fc.readContract.mockImplementation(async (req: { functionName: string }) => {
        if (req.functionName === "getManagerFee") throw new Error("rate limited");
        return served(req);
      });
      expect(await adopt(fc)).toMatchObject({ kind: "active", order: { usdcExpected: 48_600_663n } });
    });

    it("subtracts it for an expired order adopted while its USDC is still locked", async () => {
      const fc = fakeClient();
      fc.accountIntents.mockResolvedValue([pvIntentView()]);
      fc.chain.managerFee = { recipient: MANAGER, fee: MANAGER_FEE };
      expect(await adopt(fc, LOCK_EXPIRY + 3_600_000)).toMatchObject({ kind: "active", order: { usdcExpected: 48_600_663n - 49_066n } });
    });

    it("never reads it for the player's own stored order, whose confirmed net already includes it", async () => {
      const fc = fakeClient();
      fc.accountIntents.mockResolvedValue([pvIntentView()]);
      fc.chain.managerFee = { recipient: MANAGER, fee: MANAGER_FEE };
      await recover(fc, storedOrder({ signaledAt: NOW - 600_000, usdcExpected: NET_WITH_MANAGER_FEE }));
      expect(managerReads(fc)).toHaveLength(0);
    });
  });

  it("keeps the quoted fees and the paid claim for the same intent, and has none for an order rebuilt from the chain", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    const mine = await recover(fc, storedOrder({ signaledAt: NOW - 600_000, paidClaimedAt: NOW - 60_000 }));
    expect(mine).toMatchObject({ kind: "active", order: { fees: QUOTE_FEES, paidClaimedAt: NOW - 60_000 } });

    const other: Hex = `0x${"77".repeat(32)}`;
    const rebuilt = await recover(fc, storedOrder({ intentHash: other, status: "fulfilled" }));
    expect(rebuilt).toMatchObject({ kind: "active", order: { intentHash: INTENT_HASH, fees: null, paidClaimedAt: null } });
  });
});

describe("an expired order with no stored copy (new device, cleared storage)", () => {
  const AFTER_EXPIRY = LOCK_EXPIRY + 3_600_000;

  it("is adopted while the escrow still locks its USDC, so a player who paid in time can verify", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    const result = await adopt(fc, AFTER_EXPIRY);
    expect(result).toMatchObject({
      kind: "active",
      verified: true,
      order: { intentHash: INTENT_HASH, status: "active", expiresAt: LOCK_EXPIRY, payeeHandle: "madouche", fees: null },
    });
    if (result.kind === "active") expect(result.order.expiresAt).toBeLessThan(AFTER_EXPIRY);
  });

  it("is not adopted once the player dismissed it", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    expect(await adopt(fc, AFTER_EXPIRY, new Set([INTENT_HASH.toLowerCase()]))).toEqual({ kind: "none" });
  });

  it("is not adopted when its USDC is no longer locked", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    fc.chain.gone.add(INTENT_HASH.toLowerCase());
    fc.intentByHash.mockResolvedValue({ status: "SIGNALED", expiryTime: String(LOCK_EXPIRY / 1000) });
    expect(await adopt(fc, AFTER_EXPIRY)).toEqual({ kind: "none" });
  });

  it("is not adopted more than a day after it was signalled", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    expect(await adopt(fc, SIGNALED + EXPIRED_ORDER_ADOPT_MS + 1)).toEqual({ kind: "none" });
    expect(await adopt(fc, SIGNALED + EXPIRED_ORDER_ADOPT_MS - 1)).toMatchObject({ kind: "active" });
  });

  it("still leaves a live order adoptable after a dismissal of another", async () => {
    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    expect(await adopt(fc, NOW, new Set([`0x${"77".repeat(32)}`]))).toMatchObject({ kind: "active", order: { intentHash: INTENT_HASH } });
  });
});
