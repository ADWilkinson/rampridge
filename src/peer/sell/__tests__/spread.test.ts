import { describe, expect, it, vi } from "vitest";
import { CashError, buildCapabilities, buildMarketRateCurrencyOverride, prepareCashDepositParams, type CashClient } from "@zkp2p/cash";
import { getAttributionDataSuffix, getPaymentMethodsCatalog, resolvePaymentMethodHashFromCatalog } from "@zkp2p/sdk";
import { keccak256, stringToHex, type Hex } from "viem";
import { evaluateSell, type ResolvedLeg } from "../machine";
import { prepareSpreadSell, sellAttributionCodes } from "../spread";
import { readSpreadOrder, withSpreadOrders, isSpreadPayoutSet } from "../spreadOrders";
import { clampSpreadBps, formatSpreadPercent, isValidSpreadBps, parseSpreadPercent, spreadRate, SPREAD_STEP_BPS } from "../spreadRate";
import { useSellStore } from "../store";
import { submitSell } from "../submit";
import { sellCapabilities } from "../cash";
import { mockCashClient, mockSender, OWNER, plan } from "./helpers";

const ESCROW_V2 = "0x777777751622c2b72aff9a1ad5d2c3bc0d5dc44b" as Hex;
const catalog = getPaymentMethodsCatalog(8453, "production");
const methodHash = (platform: string) => resolvePaymentMethodHashFromCatalog(platform, catalog as never) as Hex;

/** The parts of the SDK client prepareSpreadSell uses, recording what it was asked to build. */
function fakeSdk() {
  const registerPayeeDetails = vi.fn(async ({ processorNames }: { processorNames: string[] }) => ({
    hashedOnchainIds: processorNames.map((p) => keccak256(stringToHex(`payee:${p}`))),
  }));
  const prepareCreateDeposit = vi.fn(async (_params: Record<string, unknown>) => ({
    depositDetails: [],
    prepared: { to: ESCROW_V2, data: "0xc0ffee" as Hex, value: 0n, chainId: 8453 },
  }));
  return { chainId: 8453, runtimeEnv: "production" as const, registerPayeeDetails, prepareCreateDeposit };
}

const leg = (platform: string, currencies: ResolvedLeg["currencies"], offchainId = "zezima"): ResolvedLeg =>
  ({ id: platform, platform, currencies, offchainId }) as ResolvedLeg;

describe("spread maths (Peer web's range and effective rate)", () => {
  it("steps by 0.1%, accepts two decimals and clamps to -5%..+5%", () => {
    expect(SPREAD_STEP_BPS).toBe(10);
    expect(parseSpreadPercent("0.25")).toEqual({ ok: true, bps: 25 });
    expect(parseSpreadPercent("-1.5%")).toEqual({ ok: true, bps: -150 });
    expect(parseSpreadPercent("+0.01")).toEqual({ ok: true, bps: 1 });
    expect(parseSpreadPercent("5.01")).toEqual({ ok: false, message: "Premium or discount must be between -5.00% and +5.00%." });
    expect(parseSpreadPercent("abc")).toEqual({ ok: false, message: "Enter a valid premium or discount." });
    expect(clampSpreadBps(900)).toBe(500);
    expect(clampSpreadBps(-900)).toBe(-500);
    expect(isValidSpreadBps(500)).toBe(true);
    expect(isValidSpreadBps(501)).toBe(false);
    expect(isValidSpreadBps(1.5)).toBe(false);
    expect(formatSpreadPercent(30)).toBe("+0.30%");
    expect(formatSpreadPercent(-120)).toBe("-1.20%");
    expect(formatSpreadPercent(0)).toBe("0.00%");
  });

  it("pays the seller more for a positive spread (oracle x (1 + bps/10000))", () => {
    expect(spreadRate(0.8, 100)).toBeCloseTo(0.808, 10);
    expect(spreadRate(0.8, -100)).toBeCloseTo(0.792, 10);
    expect(spreadRate(84, 10)).toBeCloseTo(84.084, 10);
    expect(spreadRate(0.8, 0)).toBe(0.8);
  });

  it("validates the order's spread and clamps the store", () => {
    useSellStore.getState().reset();
    useSellStore.getState().setSpread(1234);
    expect(useSellStore.getState().spreadBps).toBe(500);
    useSellStore.getState().setSpread(-30);
    expect(useSellStore.getState().spreadBps).toBe(-30);
    const ctx = { caps: sellCapabilities({ capabilities: () => buildCapabilities("production") }), walletConnected: true, balance: 10_000_000_000n, gas: "sponsored" as const };
    const base = { amount: "10", legs: [], checks: {}, submission: null };
    expect(evaluateSell({ ...base, spreadBps: 30 }, ctx).spreadBps).toBe(30);
    expect(evaluateSell({ ...base, spreadBps: 600 }, ctx).issues.some((i) => i.code === "SPREAD_INVALID")).toBe(true);
    useSellStore.getState().reset();
    expect(useSellStore.getState().spreadBps).toBe(0);
  });
});

describe("prepareSpreadSell", () => {
  it("builds Peer Cash's own deposit with only the oracle spread changed", async () => {
    const sdk = fakeSdk();
    const legs = [leg("revolut", ["GBP", "EUR"]), leg("venmo", ["USD"])];
    const result = await prepareSpreadSell(sdk as never, { amount: 25_000_000n, legs, spreadBps: 100 });

    // What Peer Cash itself would build for the same order (same registration, hashes, gating, range).
    const reference = fakeSdk();
    const own = await prepareCashDepositParams(reference as never, {
      amount: 25_000_000n,
      payouts: [
        { processorName: "revolut", currencies: ["GBP", "EUR"], payeeData: { offchainId: "zezima" } as never },
        { processorName: "venmo", currency: "USD", payeeData: { offchainId: "zezima" } as never },
      ],
    } as never);
    const sent = sdk.prepareCreateDeposit.mock.calls[0]![0] as typeof own & { txOverrides: { referrer: string[] } };
    const { currenciesOverride: spreadTuples, txOverrides, ...rest } = sent;
    const { currenciesOverride: ownTuples, ...ownRest } = own;
    expect(rest).toEqual(ownRest);
    expect(txOverrides).toEqual({ referrer: ["peer-cash", "peer-ref-TOFIAT", "rampridge"] });
    expect(spreadTuples).toEqual(ownTuples!.map((l) => l.map((t) => ({ ...t, oracleRateConfig: { ...t.oracleRateConfig!, spreadBps: 100 } }))));
    // Every tuple keeps the spread oracle and the 1 wei floor sentinel.
    const gbp = buildMarketRateCurrencyOverride("GBP")!;
    expect(spreadTuples![0]![0]).toEqual({ ...gbp, oracleRateConfig: { ...gbp.oracleRateConfig, spreadBps: 100 } });
    expect(spreadTuples![0]![0]!.minConversionRate).toBe(1n);

    // Approve then createDeposit, both attributed; Venmo needs a Peer Pay policy afterwards.
    expect(result.txs).toHaveLength(2);
    expect(result.txs[0]!.data.endsWith(getAttributionDataSuffix(sellAttributionCodes()).slice(2))).toBe(true);
    expect(result.txs[1]).toEqual({ to: ESCROW_V2, data: "0xc0ffee", value: 0n, chainId: 8453 });
    expect(result.accessPolicyPaymentMethods).toEqual([methodHash("venmo")]);
    expect(result.register.hashedOnchainIds).toHaveLength(2);
  });

  it("passes Alipay's single-order range, and refuses a zero or out-of-range spread", async () => {
    const sdk = fakeSdk();
    await prepareSpreadSell(sdk as never, {
      amount: 20_000_000n,
      legs: [leg("alipay", ["CNY"], "z@example.com")],
      spreadBps: -50,
      intentAmountRange: { min: 19_000_000n, max: 20_000_000n },
    });
    expect(sdk.prepareCreateDeposit.mock.calls[0]![0]).toMatchObject({ intentAmountRange: { min: 19_000_000n, max: 20_000_000n } });
    await expect(prepareSpreadSell(fakeSdk() as never, { amount: 20_000_000n, legs: [leg("wise", ["EUR"])], spreadBps: 0 })).rejects.toThrow(/Invalid spread/);
    await expect(prepareSpreadSell(fakeSdk() as never, { amount: 20_000_000n, legs: [leg("wise", ["EUR"])], spreadBps: 501 })).rejects.toThrow(/Invalid spread/);
  });

  it("maps Curator registration errors exactly as Peer Cash does", async () => {
    const sdk = fakeSdk();
    sdk.registerPayeeDetails.mockRejectedValueOnce(new Error("identityAttestation is required for wise"));
    await expect(prepareSpreadSell(sdk as never, { amount: 5_000_000n, legs: [leg("wise", ["EUR"])], spreadBps: 10 })).rejects.toMatchObject({
      code: "PAYEE_VERIFICATION_REQUIRED",
    });
    sdk.registerPayeeDetails.mockRejectedValueOnce(Object.assign(new Error("Bad Request"), { status: 400 }));
    await expect(prepareSpreadSell(sdk as never, { amount: 5_000_000n, legs: [leg("revolut", ["GBP"])], spreadBps: 10 })).rejects.toMatchObject({
      code: "PAYEE_REGISTRATION_FAILED",
    });
  });
});

describe("submitSell with a spread", () => {
  it("lists at 0% through Peer Cash's own prepare, and at a spread through the spread builder", async () => {
    const client = mockCashClient();
    client.prepare.mockResolvedValue(plan());
    const sdk = fakeSdk();
    const sender = mockSender();
    sender.sendCalls.mockRejectedValue(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    const deps = { client, sender, sdk } as never;
    const legs = [leg("revolut", ["GBP"])];
    await submitSell(deps, { amount: 5_000_000n, legs }).catch(() => undefined);
    expect(client.prepare).toHaveBeenCalledTimes(1);
    expect(sdk.prepareCreateDeposit).not.toHaveBeenCalled();
    await submitSell(deps, { amount: 5_000_000n, legs, spreadBps: 30 }).catch(() => undefined);
    expect(client.prepare).toHaveBeenCalledTimes(1);
    expect(sdk.prepareCreateDeposit).toHaveBeenCalledTimes(1);
    const tuples = (sdk.prepareCreateDeposit.mock.calls[0]![0] as { currenciesOverride: { oracleRateConfig: { spreadBps: number } }[][] }).currenciesOverride;
    expect(tuples[0]![0]!.oracleRateConfig.spreadBps).toBe(30);
  });
});

describe("spread orders (Peer Cash hides them)", () => {
  const COMPOSITE = `${ESCROW_V2.toLowerCase()}_42`;
  const gbp = buildMarketRateCurrencyOverride("GBP")!;
  function deposit(spreadBps: number) {
    return {
      id: COMPOSITE,
      depositor: OWNER,
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      remainingDeposits: "25000000",
      outstandingIntentAmount: "0",
      totalAmountTaken: "0",
      totalWithdrawn: "0",
      status: "ACTIVE",
      updatedAt: "1760000000",
      paymentMethods: [{ paymentMethodHash: methodHash("revolut"), payeeDetailsHash: keccak256(stringToHex("payee")), active: true }],
      currencies: [
        {
          paymentMethodHash: methodHash("revolut"),
          currencyCode: gbp.code,
          minConversionRate: "1",
          kind: "oracle_chainlink",
          rateSource: "ORACLE",
          spreadBps,
        },
      ],
      intents: [],
    };
  }
  function sdkWith(dep: ReturnType<typeof deposit>) {
    return {
      indexer: {
        getDepositsByIdsWithRelations: vi.fn(async () => [dep]),
        getDepositsWithRelations: vi.fn(async () => [dep]),
      },
      withdrawDeposit: { prepare: vi.fn(async (args: unknown) => ({ to: ESCROW_V2, data: "0x01", value: 0n, chainId: 8453, args })) },
      removeFunds: { prepare: vi.fn(async (args: unknown) => ({ to: ESCROW_V2, data: "0x02", value: 0n, chainId: 8453, args })) },
      pruneExpiredIntents: { prepare: vi.fn() },
      addFunds: { prepare: vi.fn(async (args: unknown) => ({ to: ESCROW_V2, data: "0x03", value: 0n, chainId: 8453, args })) },
    };
  }
  const notFound = () => new CashError({ code: "ORDER_NOT_FOUND", message: "not found", retryable: false } as never);

  it("reads, tops up and withdraws a +1% order Peer Cash refuses", async () => {
    const cash = mockCashClient();
    cash.order.mockRejectedValue(notFound());
    cash.prepareWithdraw.mockRejectedValue(notFound());
    cash.prepareTopUp.mockRejectedValue(notFound());
    cash.orders.mockResolvedValue([]);
    const sdk = sdkWith(deposit(100));
    const wrapped = withSpreadOrders(cash as unknown as CashClient, () => sdk as never);

    const order = await wrapped.order(COMPOSITE);
    expect(order.depositId.toLowerCase()).toBe(COMPOSITE);
    expect(order.totalAmount).toBe(25_000_000n);
    expect(order.payouts?.[0]?.pricing.spreadBps).toBe(100);
    expect(isSpreadPayoutSet(order.payouts ?? [])).toBe(true);
    expect((await wrapped.orders(OWNER)).map((o) => o.depositId.toLowerCase())).toEqual([COMPOSITE]);

    const topUp = await wrapped.prepareTopUp(COMPOSITE, 5_000_000n);
    expect(topUp.txs).toHaveLength(2);
    expect(sdk.addFunds.prepare).toHaveBeenCalledWith(expect.objectContaining({ depositId: 42n, amount: 5_000_000n, txOverrides: { referrer: sellAttributionCodes() } }));
    const withdraw = await wrapped.prepareWithdraw(COMPOSITE);
    expect(withdraw.steps.map((s) => s.kind)).toEqual(["withdrawDeposit"]);
    expect(sdk.withdrawDeposit.prepare).toHaveBeenCalledWith(expect.objectContaining({ depositId: 42n, txOverrides: { referrer: sellAttributionCodes() } }));
  });

  it("leaves zero-spread orders to Peer Cash and never adopts another kind of deposit", async () => {
    const own = mockCashClient();
    own.order.mockResolvedValue({ depositId: "own" });
    const sdk = sdkWith(deposit(0));
    const wrapped = withSpreadOrders(own as unknown as CashClient, () => sdk as never);
    expect(await wrapped.order(COMPOSITE)).toEqual({ depositId: "own" });
    expect(sdk.indexer.getDepositsByIdsWithRelations).not.toHaveBeenCalled();
    // A 0% deposit Peer Cash refused (not its own) stays refused.
    expect(await readSpreadOrder(sdk as never, COMPOSITE)).toBeNull();
    const refused = mockCashClient();
    refused.order.mockRejectedValue(notFound());
    await expect(withSpreadOrders(refused as unknown as CashClient, () => sdk as never).order(COMPOSITE)).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });
});

