/**
 * SELL on the Base fork: the app's own sell modules (submitSell, the order
 * reads, top-up and withdraw) against Peer's deployed EscrowV2 and
 * WhitelistPolicy, through an EOA TxSender built with the app's sender stack.
 * Covers every sell platform and every major currency the Sell form offers
 * (shared/currencies.ts), each priced by Peer Cash's live oracle at 0% spread,
 * and the seller's optional spread on that oracle (+/- bps, src/peer/sell/spread.ts).
 */

import { buildMarketRateCurrencyOverride, createCashClient, ORACLE_MIN_CONVERSION_RATE_SENTINEL, type CurrencyType } from "@zkp2p/cash";
import { CHAINLINK_ORACLE_ADAPTER, PYTH_ORACLE_ADAPTER } from "@zkp2p/sdk";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decodeFunctionData, erc20Abi, getAddress, parseAbi, type Abi, type Address, type Hex } from "viem";
import { MAJOR_CURRENCIES, isMajorCurrency } from "@shared/currencies";
import { BASE_RPC_URL, PEER_REFERRAL_CODE, PEER_REFERRER, USDC_ADDRESS } from "@/config";
import { getCashClient, sellCapabilities } from "@/peer/sell/cash";
import { fetchSellOrder, topUpSellOrder, withdrawSellOrder } from "@/peer/sell/orders";
import { createPendingSellStore, memoryStorage } from "@/peer/sell/persistence";
import { reconcilePendingSell, retryAccessPolicy, submitSell, type SellDeps } from "@/peer/sell/submit";
import { toReceive, type ListedSell, type ResolvedLeg, type SubmitSteps } from "@/peer/sell/machine";
import { getSellSdkClient } from "@/peer/sell/spread";
import { withSpreadOrders } from "@/peer/sell/spreadOrders";
import { forkClient, fundUsdc, randomAddress, setEthBalance, usdcBalance } from "./helpers/anvil";
import { installOffchain, recordedRequests, testPayeeHash, uninstallOffchain } from "./helpers/offchain";
import {
  ESCROW,
  GATING_SERVICE,
  PAYMASTER_ALLOWLIST,
  PEER_PAY_GROUPS,
  WHITELIST_POLICY,
  attributionCodes,
  currencyHash,
  paymentMethodHash,
  txInput,
} from "./helpers/peer";
import { PEER_CONTRACT_ABIS } from "./helpers/offchain";
import { eoaSender, faultySender } from "./helpers/senders";

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
const SELL_ATTRIBUTION = ["peer-cash", "peer-ref-TOFIAT", "rampridge"];
const CHAINLINK_ADAPTER = CHAINLINK_ORACLE_ADAPTER.toLowerCase();

const WHITELIST_ABI = parseAbi([
  "function configureDeposit(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bool _enabled, bytes32[] _groupIds, address[] _takers)",
  "function enabled(address, uint256, bytes32) view returns (bool)",
  "function getAllowedGroups(address _escrow, uint256 _depositId, bytes32 _paymentMethod) view returns (bytes32[])",
]);

function onchainId(depositId: string): bigint {
  const raw = depositId.split("_").at(-1);
  if (!raw) throw new Error(`bad deposit id ${depositId}`);
  return BigInt(raw);
}

function readEscrow<T>(functionName: string, args: unknown[]): Promise<T> {
  return forkClient.readContract({ address: ESCROW, abi: PEER_CONTRACT_ABIS.escrow, functionName, args } as never) as Promise<T>;
}

interface OnchainDeposit {
  depositor: Address;
  token: Address;
  intentAmountRange: { min: bigint; max: bigint };
  acceptingIntents: boolean;
  remainingDeposits: bigint;
  outstandingIntentAmount: bigint;
  retainOnEmpty: boolean;
}

async function newSeller(usdc: bigint): Promise<{ address: Address; deps: SellDeps }> {
  const address = randomAddress();
  await setEthBalance(address, "1");
  await fundUsdc(address, usdc);
  const storage = memoryStorage();
  return {
    address,
    deps: {
      client: getCashClient(),
      sender: eoaSender(address),
      publicClient: forkClient,
      pending: createPendingSellStore(storage),
      storage,
    },
  };
}

/** Every transaction a mined hash covers, checked for target and attribution. */
async function expectAttributed(hash: Hex, codes: readonly string[]): Promise<Address> {
  const { to, input } = await txInput(hash);
  expect(to).not.toBeNull();
  expect(PAYMASTER_ALLOWLIST.has((to ?? "").toLowerCase())).toBe(true);
  expect(attributionCodes(input).slice(0, codes.length)).toEqual(codes);
  return getAddress(to as Address);
}

beforeAll(async () => {
  await installOffchain();
});

afterAll(() => {
  uninstallOffchain();
});

describe("sell: Revolut (no access policy)", () => {
  let seller: Address;
  let deps: SellDeps;
  let depositId = "";
  const startBalance = USDC(60);

  test("prepare -> sendCalls -> finalizePreparedCashout lists the deposit exactly as prepared", async () => {
    ({ address: seller, deps } = await newSeller(startBalance));
    const steps: SubmitSteps[] = [];
    const listed = await submitSell(
      deps,
      { amount: USDC(20), legs: [{ platform: "revolut", currencies: ["GBP", "EUR"], offchainId: "rampridgefork" }] },
      (s) => steps.push(s),
    );

    depositId = listed.depositId;
    expect(depositId).toMatch(new RegExp(`^${ESCROW.toLowerCase()}_\\d+$`));
    expect(listed.amount).toBe(USDC(20));
    expect(listed.txHashes.accessPolicy).toEqual([]);
    expect(steps.at(-1)).toEqual({ approve: "done", createDeposit: "done", accessPolicy: "skipped" });
    // Fully listed: no pending record left to block the next sell.
    expect(deps.pending?.read(seller)).toBeNull();

    // The payee was "registered" once, with the normalised handle, and never sent to Curator.
    const registrations = recordedRequests((r) => r.url.includes("/makers/create"));
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.served).toBe("fork");
    expect(registrations[0]?.body).toMatchObject({ processorName: "revolut", offchainId: "rampridgefork" });

    const id = onchainId(depositId);
    const deposit = await readEscrow<OnchainDeposit>("getDeposit", [id]);
    expect(deposit.depositor.toLowerCase()).toBe(seller.toLowerCase());
    expect(deposit.token.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
    expect(deposit.remainingDeposits).toBe(USDC(20));
    expect(deposit.outstandingIntentAmount).toBe(0n);
    expect(deposit.acceptingIntents).toBe(true);
    expect(deposit.intentAmountRange).toEqual({ min: USDC(1), max: USDC(20) });
    expect(deposit.retainOnEmpty).toBe(false);

    const methods = await readEscrow<Hex[]>("getDepositPaymentMethods", [id]);
    expect(methods).toEqual([paymentMethodHash("revolut")]);
    const methodData = await readEscrow<{ intentGatingService: Address; payeeDetails: Hex }>("getDepositPaymentMethodData", [
      id,
      paymentMethodHash("revolut"),
    ]);
    expect(methodData.payeeDetails).toBe(testPayeeHash("revolut", "rampridgefork"));
    expect(methodData.intentGatingService.toLowerCase()).toBe(GATING_SERVICE.toLowerCase());

    // Market-rate pricing: each currency follows the Chainlink oracle with zero spread.
    const currencies = await readEscrow<Hex[]>("getDepositCurrencies", [id, paymentMethodHash("revolut")]);
    expect([...currencies].sort()).toEqual([currencyHash("GBP"), currencyHash("EUR")].sort());
    for (const currency of currencies) {
      const oracle = await readEscrow<{ adapter: Address; spreadBps: number }>("getDepositOracleRateConfig", [
        id,
        paymentMethodHash("revolut"),
        currency,
      ]);
      expect(oracle.adapter.toLowerCase()).toBe(CHAINLINK_ADAPTER);
      expect(oracle.spreadBps).toBe(0);
      const rate = await readEscrow<bigint>("getEffectiveRate", [id, paymentMethodHash("revolut"), currency]);
      expect(rate).toBeGreaterThan(0n);
    }

    // USDC moved from the seller into the escrow, nothing else.
    expect(await usdcBalance(seller)).toBe(startBalance - USDC(20));

    // The deposit transaction carries Peer Cash, the TOFIAT referral marker and the app code.
    const createTx = listed.txHashes.createDeposit;
    if (!createTx) throw new Error("no createDeposit hash");
    expect(await expectAttributed(createTx, SELL_ATTRIBUTION)).toBe(ESCROW);
  });

  test("the order reads back through the app's order view as awaiting a buyer", async () => {
    const row = await fetchSellOrder(deps.client, depositId);
    expect(row.state).toBe("awaiting-buyer");
    expect(row.totalAmount).toBe(USDC(20));
    expect(row.availableAmount).toBe(USDC(20));
    expect(row.canWithdraw).toBe(true);
    expect(row.canTopUp).toBe(true);
    expect(row.payouts?.map((p) => [p.platform, p.currency, p.pricing.marketRate]).sort()).toEqual([
      ["revolut", "EUR", true],
      ["revolut", "GBP", true],
    ]);
  });

  test("top up adds to the same deposit (approve + addFunds)", async () => {
    const result = await topUpSellOrder({ client: getCashClient(), sender: deps.sender, publicClient: forkClient }, depositId, USDC(5));
    expect(result.steps.map((s) => s.kind)).toEqual(["approve", "addFunds"]);
    const deposit = await readEscrow<OnchainDeposit>("getDeposit", [onchainId(depositId)]);
    expect(deposit.remainingDeposits).toBe(USDC(25));
    expect(await usdcBalance(seller)).toBe(startBalance - USDC(25));
    expect(await expectAttributed(result.txHash, SELL_ATTRIBUTION)).toBe(ESCROW);
  });

  test("withdraw part returns exactly that amount and keeps the order live", async () => {
    const result = await withdrawSellOrder({ client: getCashClient(), sender: deps.sender }, depositId, USDC(7));
    expect(result.steps.map((s) => s.kind)).toEqual(["removeFunds"]);
    const deposit = await readEscrow<OnchainDeposit>("getDeposit", [onchainId(depositId)]);
    expect(deposit.remainingDeposits).toBe(USDC(18));
    expect(deposit.depositor.toLowerCase()).toBe(seller.toLowerCase());
    expect(await usdcBalance(seller)).toBe(startBalance - USDC(18));
    expect(await expectAttributed(result.txHash, SELL_ATTRIBUTION)).toBe(ESCROW);
    const row = await fetchSellOrder(deps.client, depositId);
    expect(row.state).toBe("awaiting-buyer");
    expect(row.availableAmount).toBe(USDC(18));
  });

  test("withdraw all closes the deposit and returns every remaining USDC", async () => {
    const escrowBefore = await usdcBalance(ESCROW);
    const result = await withdrawSellOrder({ client: getCashClient(), sender: deps.sender }, depositId);
    expect(result.steps.map((s) => s.kind)).toEqual(["withdrawDeposit"]);
    expect(await usdcBalance(seller)).toBe(startBalance);
    expect(await usdcBalance(ESCROW)).toBe(escrowBefore - USDC(18));
    const deposit = await readEscrow<OnchainDeposit>("getDeposit", [onchainId(depositId)]);
    expect(deposit.remainingDeposits).toBe(0n);
    expect(deposit.depositor).toBe("0x0000000000000000000000000000000000000000");
    expect(await expectAttributed(result.txHash, SELL_ATTRIBUTION)).toBe(ESCROW);
  });
});

describe("sell: Venmo (Peer Pay access policy)", () => {
  test("lists the deposit, then restricts buyers to the Peer Pay group in its own transaction", async () => {
    const { address: seller, deps } = await newSeller(USDC(30));
    const steps: SubmitSteps[] = [];
    const listed = await submitSell(
      deps,
      { amount: USDC(12.5), legs: [{ platform: "venmo", currencies: ["USD"], offchainId: "rampridge-fork" }] },
      (s) => steps.push(s),
    );
    expect(steps.at(-1)).toEqual({ approve: "done", createDeposit: "done", accessPolicy: "done" });
    expect(listed.txHashes.accessPolicy).toHaveLength(1);
    expect(deps.pending?.read(seller)).toBeNull();

    const id = onchainId(listed.depositId);
    const venmo = paymentMethodHash("venmo");
    const methodData = await readEscrow<{ payeeDetails: Hex }>("getDepositPaymentMethodData", [id, venmo]);
    expect(methodData.payeeDetails).toBe(testPayeeHash("venmo", "rampridge-fork"));

    const policyTx = listed.txHashes.accessPolicy[0] as Hex;
    const { to, input } = await txInput(policyTx);
    expect(to?.toLowerCase()).toBe(WHITELIST_POLICY.toLowerCase());
    expect(attributionCodes(input).slice(0, 3)).toEqual(SELL_ATTRIBUTION);
    const call = decodeFunctionData({ abi: WHITELIST_ABI, data: input });
    expect(call.functionName).toBe("configureDeposit");
    const [escrowArg, depositArg, methodArg, enabledArg, groupsArg, takersArg] = call.args as readonly [
      Address,
      bigint,
      Hex,
      boolean,
      readonly Hex[],
      readonly Address[],
    ];
    expect([escrowArg.toLowerCase(), depositArg, methodArg, enabledArg]).toEqual([ESCROW.toLowerCase(), id, venmo, true]);
    expect([...groupsArg]).toEqual(PEER_PAY_GROUPS);
    expect([...takersArg]).toEqual([]);

    const enabled = await forkClient.readContract({
      address: WHITELIST_POLICY,
      abi: WHITELIST_ABI,
      functionName: "enabled",
      args: [ESCROW, id, venmo],
    });
    const groups = await forkClient.readContract({
      address: WHITELIST_POLICY,
      abi: WHITELIST_ABI,
      functionName: "getAllowedGroups",
      args: [ESCROW, id, venmo],
    });
    expect(enabled).toBe(true);
    expect(groups.map((g) => g.toLowerCase())).toEqual(PEER_PAY_GROUPS.map((g) => g.toLowerCase()));

    // Close it out: everything returns.
    await withdrawSellOrder({ client: getCashClient(), sender: deps.sender }, listed.depositId);
    expect(await usdcBalance(seller)).toBe(USDC(30));
  });

  test("a stranger cannot withdraw someone else's deposit", async () => {
    const { deps } = await newSeller(USDC(5));
    const listed = await submitSell(deps, {
      amount: USDC(2),
      legs: [{ platform: "revolut", currencies: ["USD"], offchainId: "rampridgefork2" }],
    });
    const stranger = randomAddress();
    await setEthBalance(stranger, "1");
    await expect(withdrawSellOrder({ client: getCashClient(), sender: eoaSender(stranger) }, listed.depositId)).rejects.toMatchObject({
      name: "SellFlowError",
    });
    const deposit = await readEscrow<OnchainDeposit>("getDeposit", [onchainId(listed.depositId)]);
    expect(deposit.remainingDeposits).toBe(USDC(2));
    // USDC left at the escrow for the stranger: none.
    expect(
      await forkClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [stranger] }),
    ).toBe(0n);
  });
});

describe("sell: interrupted submissions recover from the chain", () => {
  const venmo = (handle: string) => [{ platform: "venmo", currencies: ["USD" as const], offchainId: handle }];

  async function policyEnabled(depositId: string): Promise<boolean> {
    return forkClient.readContract({
      address: WHITELIST_POLICY,
      abi: WHITELIST_ABI,
      functionName: "enabled",
      args: [ESCROW, onchainId(depositId), paymentMethodHash("venmo")],
    });
  }

  test("the wallet loses the deposit receipt: recovery finds the deposit and finishes its policy, never a second deposit", async () => {
    const { address: seller, deps: base } = await newSeller(USDC(20));
    const sender = faultySender(base.sender, ["lose-receipt"]);
    const deps: SellDeps = { ...base, sender };

    const error = await submitSell(deps, { amount: USDC(10), legs: venmo("rampridge-lost") }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "SellFlowError", recovery: { action: "reconcile" } });
    expect(sender.sends()).toBe(1);
    // Nothing new can start while the attempt is unresolved.
    await expect(submitSell(deps, { amount: USDC(5), legs: venmo("rampridge-lost") })).rejects.toMatchObject({
      code: "PENDING_SUBMISSION_EXISTS",
    });

    const reconciled = await reconcilePendingSell(deps);
    if (reconciled.status !== "needsAccessPolicy") throw new Error(`expected needsAccessPolicy, got ${reconciled.status}`);
    expect(await policyEnabled(reconciled.depositId)).toBe(false);

    const listed = await retryAccessPolicy(deps);
    expect(listed.depositId).toBe(reconciled.depositId);
    expect(listed.txHashes.accessPolicy).toHaveLength(1);
    expect(await policyEnabled(listed.depositId)).toBe(true);
    expect(deps.pending?.read(seller)).toBeNull();

    // Exactly one deposit, holding exactly the order amount.
    const orders = await getCashClient().orders(seller);
    expect(orders.map((o) => [o.depositId, o.totalAmount])).toEqual([[listed.depositId, USDC(10)]]);
    expect(await usdcBalance(seller)).toBe(USDC(10));
    await withdrawSellOrder({ client: getCashClient(), sender: base.sender }, listed.depositId);
  });

  test("the player rejects the buyer restriction: the order is live and Retry attaches the policy", async () => {
    const { address: seller, deps: base } = await newSeller(USDC(20));
    const deps: SellDeps = { ...base, sender: faultySender(base.sender, [null, "reject"]) };
    const error = await submitSell(deps, { amount: USDC(8), legs: venmo("rampridge-reject") }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ACCESS_POLICY_CONFIGURATION_FAILED" });
    const pending = deps.pending?.read(seller);
    expect(pending?.stage).toBe("deposited");
    const depositId = pending?.depositId ?? "";
    expect((await readEscrow<OnchainDeposit>("getDeposit", [onchainId(depositId)])).remainingDeposits).toBe(USDC(8));
    expect(await policyEnabled(depositId)).toBe(false);

    const listed = await retryAccessPolicy({ ...deps, sender: base.sender });
    expect(listed.depositId).toBe(depositId);
    expect(await policyEnabled(depositId)).toBe(true);
    expect(deps.pending?.read(seller)).toBeNull();
    await withdrawSellOrder({ client: getCashClient(), sender: base.sender }, depositId);
    expect(await usdcBalance(seller)).toBe(USDC(20));
  });

  test("the policy lands but its receipt is lost: recovery reads it from the chain and never sends it again", async () => {
    const { address: seller, deps: base } = await newSeller(USDC(20));
    const sender = faultySender(base.sender, [null, "lose-receipt"]);
    const deps: SellDeps = { ...base, sender };
    await submitSell(deps, { amount: USDC(6), legs: venmo("rampridge-policy-lost") }).catch(() => undefined);
    expect(sender.sends()).toBe(2);
    const reconciled = await reconcilePendingSell(deps);
    if (reconciled.status !== "listed") throw new Error(`expected listed, got ${reconciled.status}`);
    expect(reconciled.listed.txHashes.accessPolicy).toHaveLength(1);
    expect(await policyEnabled(reconciled.listed.depositId)).toBe(true);
    expect(sender.sends()).toBe(2);
    expect(deps.pending?.read(seller)).toBeNull();
    await withdrawSellOrder({ client: getCashClient(), sender: base.sender }, reconciled.listed.depositId);
  });
});

// ---------------------------------------------------------------------------
// Every sell platform and every major currency, all at Peer Cash's oracle rate
// ---------------------------------------------------------------------------

const caps = sellCapabilities(getCashClient());

/**
 * What the Sell form offers: Peer Cash 0.7.2's capabilities narrowed to the
 * major currencies (shared/currencies.ts). Monobank (UAH), JPY, HKD, TRY, ZAR
 * and every other non-major currency are not sold.
 */
const SELL_MATRIX: Readonly<Record<string, readonly CurrencyType[]>> = {
  alipay: ["CNY"],
  cashapp: ["USD"],
  chime: ["USD"],
  monzo: ["GBP"],
  paypal: ["AUD", "CAD", "EUR", "GBP", "NZD", "SGD", "USD"],
  revolut: ["AUD", "CAD", "CHF", "CNY", "EUR", "GBP", "MXN", "NZD", "SGD", "USD"],
  upi: ["INR"],
  venmo: ["USD"],
  wise: ["AUD", "CAD", "CHF", "CNY", "EUR", "GBP", "INR", "MXN", "NZD", "SGD", "USD"],
  xmoney: ["USD"],
  zelle: ["USD"],
};

interface OracleConfig {
  adapter: Address;
  adapterConfig: Hex;
  spreadBps: number;
  maxStaleness: number;
}

interface CurrencyTuple {
  code: Hex;
  minConversionRate: bigint;
  oracleRateConfig: OracleConfig;
}

/** Address and hex case and number widths differ between the SDK's constants and decoded values. */
function normalizeOracle(config: OracleConfig): [string, string, number, number] {
  return [config.adapter.toLowerCase(), config.adapterConfig.toLowerCase(), Number(config.spreadBps), Number(config.maxStaleness)];
}

interface CreateDepositArgs {
  paymentMethods: readonly Hex[];
  currencies: readonly (readonly CurrencyTuple[])[];
  [field: string]: unknown;
}

/** createDeposit calldata decoded (any ERC-8021 suffix is ignored). */
function decodeCreateDeposit(data: Hex): CreateDepositArgs {
  const call = decodeFunctionData({ abi: PEER_CONTRACT_ABIS.escrow as Abi, data });
  expect(call.functionName).toBe("createDeposit");
  const [params] = call.args as unknown as [CreateDepositArgs];
  return params;
}

/** The createDeposit arguments a mined deposit transaction carried. */
async function createDepositParams(hash: Hex): Promise<CreateDepositArgs> {
  return decodeCreateDeposit((await txInput(hash)).input);
}

/** A mined transaction's target (lowercase) and calldata, comparable with a prepared one. */
async function sentTx(hash: Hex): Promise<{ to: string | null; data: Hex }> {
  const { to, input } = await txInput(hash);
  return { to: to?.toLowerCase() ?? null, data: input };
}

/** The sender's transaction just before `hash` (an EOA's approve before its createDeposit). */
async function previousTxFrom(hash: Hex): Promise<{ to: string | null; data: Hex }> {
  const tx = await forkClient.getTransaction({ hash });
  for (let block = tx.blockNumber - 1n; block >= tx.blockNumber - 5n; block--) {
    const { transactions } = await forkClient.getBlock({ blockNumber: block, includeTransactions: true });
    const prev = transactions.find((t) => t.from.toLowerCase() === tx.from.toLowerCase() && t.nonce === tx.nonce - 1);
    if (prev) return { to: prev.to?.toLowerCase() ?? null, data: prev.input };
  }
  throw new Error(`no transaction before ${hash} from ${tx.from}`);
}

/** A prepared transaction in the same shape. */
function preparedTx(tx: { to: string; data: Hex }): { to: string; data: Hex } {
  return { to: tx.to.toLowerCase(), data: tx.data };
}

/**
 * Every currency of one payment method is Peer Cash's market-rate tuple
 * (`buildMarketRateCurrencyOverride`): written with the minConversionRate
 * sentinel (1) and the oracle adapter at 0 bps spread (or the seller's
 * spread, nothing else changed), stored with that adapter, spread and
 * staleness on the escrow (the adapter packs its config around the same
 * feed), and priced by the escrow from the live feed.
 */
async function expectOracleTuples(listed: ListedSell, platform: string, currencies: readonly CurrencyType[], spread = 0): Promise<void> {
  const createTx = listed.txHashes.createDeposit;
  if (!createTx) throw new Error("no createDeposit hash");
  const id = onchainId(listed.depositId);
  const method = paymentMethodHash(platform);
  const expectedCodes = currencies.map((c) => currencyHash(c).toLowerCase()).sort();

  const params = await createDepositParams(createTx);
  const written = params.currencies[params.paymentMethods.findIndex((m) => m.toLowerCase() === method.toLowerCase())] ?? [];
  expect(written.map((t) => t.code.toLowerCase()).sort()).toEqual(expectedCodes);
  const onchain = await readEscrow<Hex[]>("getDepositCurrencies", [id, method]);
  expect(onchain.map((c) => c.toLowerCase()).sort()).toEqual(expectedCodes);

  for (const currency of currencies) {
    const expected = buildMarketRateCurrencyOverride(currency);
    if (!expected?.oracleRateConfig) throw new Error(`Peer Cash has no oracle for ${currency}`);
    expect(expected.oracleRateConfig.spreadBps).toBe(0);
    const code = currencyHash(currency);
    const tuple = written.find((t) => t.code.toLowerCase() === code.toLowerCase());
    if (!tuple) throw new Error(`${platform} ${currency} was not written`);
    expect([currency, tuple.minConversionRate]).toEqual([currency, ORACLE_MIN_CONVERSION_RATE_SENTINEL]);
    expect([currency, ...normalizeOracle(tuple.oracleRateConfig)]).toEqual([
      currency,
      ...normalizeOracle({ ...expected.oracleRateConfig, spreadBps: spread }),
    ]);

    const [oracle, minRate] = await Promise.all([
      readEscrow<OracleConfig>("getDepositOracleRateConfig", [id, method, code]),
      readEscrow<bigint>("getDepositCurrencyMinRate", [id, method, code]),
    ]);
    const [adapter, adapterConfig, spreadBps, maxStaleness] = normalizeOracle(oracle);
    const [wantAdapter, wantConfig, , wantStaleness] = normalizeOracle(expected.oracleRateConfig);
    expect([currency, adapter, spreadBps, maxStaleness]).toEqual([currency, wantAdapter, spread, wantStaleness]);
    expect([CHAINLINK_ADAPTER, PYTH_ORACLE_ADAPTER.toLowerCase()]).toContain(adapter);
    // The adapter stores its own packed form of the config (the feed, then its decimals and direction): same feed.
    expect([currency, adapterConfig.includes(wantConfig.slice(26, 66))]).toEqual([currency, true]);
    // Written as Peer Cash's sentinel; the escrow reports the oracle's live rate for it.
    expect([currency, minRate > ORACLE_MIN_CONVERSION_RATE_SENTINEL]).toEqual([currency, true]);
  }
}

function policyEnabledFor(depositId: string, platform: string): Promise<boolean> {
  return forkClient.readContract({
    address: WHITELIST_POLICY,
    abi: WHITELIST_ABI,
    functionName: "enabled",
    args: [ESCROW, onchainId(depositId), paymentMethodHash(platform)],
  });
}

describe("sell: one deposit per sell platform, every major currency it offers on one leg", () => {
  const ORDERS: { platform: string; handle: string; amount: bigint }[] = [
    { platform: "venmo", handle: "rampridge-fork-all", amount: USDC(2) },
    { platform: "cashapp", handle: "rampridgeforkall", amount: USDC(2) },
    { platform: "chime", handle: "$rampridgeforkall", amount: USDC(2) },
    { platform: "revolut", handle: "rampridgeforkall", amount: USDC(2) },
    { platform: "wise", handle: "rampridgeforkall", amount: USDC(2) },
    { platform: "zelle", handle: "fork-all@rampridge.xyz", amount: USDC(2) },
    { platform: "paypal", handle: "rampridgeforkall", amount: USDC(2) },
    { platform: "monzo", handle: "rampridgeforkall", amount: USDC(2) },
    { platform: "alipay", handle: "fork-all@rampridge.xyz", amount: USDC(10) },
    { platform: "upi", handle: "rampridge@okaxis", amount: USDC(2) },
    { platform: "xmoney", handle: "rampridgefork", amount: USDC(2) },
  ];

  test("the Sell form offers exactly the major-currency matrix, every currency at the oracle rate", () => {
    expect(Object.fromEntries(caps.platforms.map((p) => [p.platform, [...p.currencies].sort()]))).toEqual(SELL_MATRIX);
    expect(caps.currencies).toEqual([...MAJOR_CURRENCIES].sort());
    // Peer Cash itself lists more (JPY, HKD, ...): the majors filter is what leaves them out.
    expect(getCashClient().capabilities().platforms.some((p) => p.currencies.some((c) => !isMajorCurrency(c)))).toBe(true);
    for (const currency of caps.currencies) {
      expect([currency, buildMarketRateCurrencyOverride(currency)?.oracleRateConfig?.spreadBps]).toEqual([currency, 0]);
    }
    expect(caps.platforms.filter((p) => p.payeeEnrollment).map((p) => p.platform)).toEqual(["zelle"]);
    expect(caps.platforms.filter((p) => p.singleOrder).map((p) => [p.platform, p.singleOrder?.minAmount])).toEqual([["alipay", USDC(10)]]);
    expect(ORDERS.map((o) => o.platform).sort()).toEqual(Object.keys(SELL_MATRIX).sort());
  });

  test.each(ORDERS)("$platform lists with its payee, range, oracle tuples and access policy", async ({ platform, handle, amount }) => {
    const currencies = [...(SELL_MATRIX[platform] ?? [])];
    const { address: seller, deps } = await newSeller(amount + USDC(1));
    const before = recordedRequests((r) => r.url.includes("/makers/create")).length;
    const listed = await submitSell(deps, { amount, legs: [{ platform, currencies, offchainId: handle }] });
    const id = onchainId(listed.depositId);
    expect(listed.legs).toEqual([{ platform, currencies }]);

    // Registered once through the stub, never with Curator.
    const registrations = recordedRequests((r) => r.url.includes("/makers/create")).slice(before);
    expect(registrations.map((r) => [r.served, (r.body as { processorName?: string }).processorName])).toEqual([["fork", platform]]);

    const deposit = await readEscrow<OnchainDeposit>("getDeposit", [id]);
    expect(deposit.depositor.toLowerCase()).toBe(seller.toLowerCase());
    expect(deposit.remainingDeposits).toBe(amount);
    expect(deposit.retainOnEmpty).toBe(false);
    // Alipay fills in one order (Peer's single-order rule); every other platform takes 1 USDC up to the whole order.
    expect(deposit.intentAmountRange).toEqual(platform === "alipay" ? { min: amount - USDC(1), max: amount } : { min: USDC(1), max: amount });

    expect(await readEscrow<Hex[]>("getDepositPaymentMethods", [id])).toEqual([paymentMethodHash(platform)]);
    const methodData = await readEscrow<{ intentGatingService: Address; payeeDetails: Hex }>("getDepositPaymentMethodData", [
      id,
      paymentMethodHash(platform),
    ]);
    expect(methodData.intentGatingService.toLowerCase()).toBe(GATING_SERVICE.toLowerCase());
    expect(methodData.payeeDetails).toBe(testPayeeHash(platform, handle));
    await expectOracleTuples(listed, platform, currencies);

    // Peer Pay restricts Venmo and PayPal only; Cash App and the rest stay public.
    const peerPay = platform === "venmo" || platform === "paypal";
    expect(listed.txHashes.accessPolicy).toHaveLength(peerPay ? 1 : 0);
    expect(await policyEnabledFor(listed.depositId, platform)).toBe(peerPay);
    const createTx = listed.txHashes.createDeposit;
    if (!createTx) throw new Error("no createDeposit hash");
    expect(await expectAttributed(createTx, SELL_ATTRIBUTION)).toBe(ESCROW);

    await withdrawSellOrder({ client: getCashClient(), sender: deps.sender }, listed.depositId);
    expect(await usdcBalance(seller)).toBe(amount + USDC(1));
  });

  test("Alipay below its 10 USDC single-order minimum is refused before anything is sent", async () => {
    const { address: seller, deps } = await newSeller(USDC(10));
    await expect(
      submitSell(deps, { amount: USDC(9), legs: [{ platform: "alipay", currencies: ["CNY"], offchainId: "fork-min@rampridge.xyz" }] }),
    ).rejects.toMatchObject({ name: "SellFlowError" });
    expect(await usdcBalance(seller)).toBe(USDC(10));
    expect(deps.pending?.read(seller)).toBeNull();
  });
});

describe("sell: one order across two platforms (Venmo USD + Wise EUR, GBP)", () => {
  test("one deposit, every leg at the oracle rate, the Peer Pay policy on Venmo only, and Peer Cash reads it back", async () => {
    const startBalance = USDC(30);
    const { address: seller, deps } = await newSeller(startBalance);
    const legs: ResolvedLeg[] = [
      { platform: "venmo", currencies: ["USD"], offchainId: "rampridge-fork-mixed" },
      { platform: "wise", currencies: ["EUR", "GBP"], offchainId: "rampridgeforkmixed" },
    ];
    const listed = await submitSell(deps, { amount: USDC(20), legs, spreadBps: 0 });
    expect(listed.spreadBps ?? 0).toBe(0);

    // A 0% order is Peer Cash's own prepare, byte for byte: the approve and the createDeposit as sent.
    const createHash = listed.txHashes.createDeposit;
    if (!createHash) throw new Error("no createDeposit hash");
    const reference = await getCashClient().prepare({ amount: USDC(20), receive: toReceive(legs) });
    const [refApprove, refCreate] = reference.txs;
    if (!refApprove || !refCreate) throw new Error("Peer Cash prepared no approve + createDeposit");
    expect(await sentTx(createHash)).toEqual(preparedTx(refCreate));
    expect(await previousTxFrom(createHash)).toEqual(preparedTx(refApprove));

    expect(listed.legs.map((leg) => [leg.platform, leg.currencies])).toEqual([
      ["venmo", ["USD"]],
      ["wise", ["EUR", "GBP"]],
    ]);
    const id = onchainId(listed.depositId);
    expect(await readEscrow<Hex[]>("getDepositPaymentMethods", [id])).toEqual([paymentMethodHash("venmo"), paymentMethodHash("wise")]);
    expect((await readEscrow<OnchainDeposit>("getDeposit", [id])).intentAmountRange).toEqual({ min: USDC(1), max: USDC(20) });
    await expectOracleTuples(listed, "venmo", ["USD"]);
    await expectOracleTuples(listed, "wise", ["EUR", "GBP"]);
    expect(listed.txHashes.accessPolicy).toHaveLength(1);
    expect(await policyEnabledFor(listed.depositId, "venmo")).toBe(true);
    expect(await policyEnabledFor(listed.depositId, "wise")).toBe(false);
    expect(await usdcBalance(seller)).toBe(startBalance - USDC(20));
    const createTx = listed.txHashes.createDeposit;
    if (!createTx) throw new Error("no createDeposit hash");
    expect(await expectAttributed(createTx, SELL_ATTRIBUTION)).toBe(ESCROW);

    expect((await getCashClient().orders(seller)).map((o) => o.depositId)).toContain(listed.depositId);
    const row = await fetchSellOrder(getCashClient(), listed.depositId);
    expect(row.state).toBe("awaiting-buyer");
    expect(row.totalAmount).toBe(USDC(20));
    expect(row.payouts?.map((p) => [p.platform, p.currency, p.pricing.marketRate, p.pricing.spreadBps]).sort()).toEqual([
      ["venmo", "USD", true, 0],
      ["wise", "EUR", true, 0],
      ["wise", "GBP", true, 0],
    ]);

    const result = await withdrawSellOrder({ client: getCashClient(), sender: deps.sender }, listed.depositId);
    expect(result.steps.map((s) => s.kind)).toEqual(["withdrawDeposit"]);
    expect(await expectAttributed(result.txHash, SELL_ATTRIBUTION)).toBe(ESCROW);
    expect(await usdcBalance(seller)).toBe(startBalance);
  });
});

// ---------------------------------------------------------------------------
// The seller's spread on the oracle rate (Peer web: -500..+500 bps)
// ---------------------------------------------------------------------------

describe("sell: a seller spread on the oracle rate", () => {
  const SPREAD_ORDERS: { spreadBps: number; legs: ResolvedLeg[] }[] = [
    { spreadBps: 100, legs: [{ platform: "revolut", currencies: ["EUR", "GBP"], offchainId: "rampridgeforkspreadup" }] },
    {
      spreadBps: -100,
      legs: [
        { platform: "venmo", currencies: ["USD"], offchainId: "rampridge-fork-spread-down" },
        { platform: "wise", currencies: ["EUR"], offchainId: "rampridgeforkspreaddown" },
      ],
    },
  ];

  test.each(SPREAD_ORDERS)(
    "$spreadBps bps: Peer Cash's deposit with only the spread changed, read back, topped up and withdrawn through the spread path",
    async ({ spreadBps, legs }) => {
      // The production SDK client: on this suite BASE_RPC_URL is the fork, and installOffchain answers Curator's
      // makers/create and the indexer, exactly as for Peer Cash.
      expect(BASE_RPC_URL).toBe(process.env.FORK_RPC_URL);
      const forkSdk = getSellSdkClient();
      const rawCash = createCashClient({
        environment: "production",
        rpcUrl: BASE_RPC_URL,
        referralCode: PEER_REFERRAL_CODE,
        referrer: PEER_REFERRER,
      });
      const spreadCash = withSpreadOrders(rawCash, () => forkSdk);

      const startBalance = USDC(40);
      const amount = USDC(20);
      const { address: seller, deps } = await newSeller(startBalance);
      const listed = await submitSell({ ...deps, sdk: forkSdk }, { amount, legs, spreadBps });
      expect(listed.spreadBps).toBe(spreadBps);
      expect(listed.depositId).toMatch(new RegExp(`^${ESCROW.toLowerCase()}_\\d+$`));
      const id = onchainId(listed.depositId);
      const createTx = listed.txHashes.createDeposit;
      if (!createTx) throw new Error("no createDeposit hash");
      expect(await expectAttributed(createTx, SELL_ATTRIBUTION)).toBe(ESCROW);
      expect(await usdcBalance(seller)).toBe(startBalance - amount);
      expect(deps.pending?.read(seller)).toBeNull();

      // Parity: Peer Cash's own prepare for the same order, with only spreadBps changed on every oracle tuple.
      const reference = await rawCash.prepare({ amount, receive: toReceive(legs) });
      const [refApprove, refCreate] = reference.txs;
      if (!refApprove || !refCreate) throw new Error("Peer Cash prepared no approve + createDeposit");
      const sent = await sentTx(createTx);
      expect(sent.to).toBe(preparedTx(refCreate).to);
      const want = decodeCreateDeposit(refCreate.data);
      expect(decodeCreateDeposit(sent.data)).toEqual({
        ...want,
        currencies: want.currencies.map((leg) => leg.map((t) => ({ ...t, oracleRateConfig: { ...t.oracleRateConfig, spreadBps } }))),
      });
      expect(attributionCodes(sent.data)).toEqual(attributionCodes(refCreate.data));
      expect(await previousTxFrom(createTx)).toEqual(preparedTx(refApprove));
      expect(reference.accessPolicyPaymentMethods).toEqual(
        legs.filter((l) => l.platform === "venmo" || l.platform === "paypal").map((l) => paymentMethodHash(l.platform)),
      );

      for (const leg of legs) {
        await expectOracleTuples(listed, leg.platform, leg.currencies, spreadBps);
        // The buyer pays oracle x (1 + spreadBps / 10000) fiat per USDC.
        for (const currency of leg.currencies) {
          const effective = await readEscrow<bigint>("getEffectiveRate", [id, paymentMethodHash(leg.platform), currencyHash(currency)]);
          const market = await rawCash.estimate({ amount: USDC(1), currency }, { includeEta: false });
          expect([currency, Number(effective) / 1e18 / (market.rate * (1 + spreadBps / 10_000))]).toEqual([currency, expect.closeTo(1, 6)]);
        }
        // Peer Pay restricts Venmo and PayPal only, at any spread.
        expect(await policyEnabledFor(listed.depositId, leg.platform)).toBe(leg.platform === "venmo" || leg.platform === "paypal");
      }
      expect(listed.txHashes.accessPolicy).toHaveLength(legs.some((l) => l.platform === "venmo" || l.platform === "paypal") ? 1 : 0);

      // Peer Cash 0.7.2 alone hides a spread order; the spread wrapper (and the app's client) read it back.
      await expect(rawCash.order(listed.depositId)).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
      expect((await rawCash.orders(seller)).map((o) => o.depositId)).not.toContain(listed.depositId);
      const expectedPayouts = legs.flatMap((l) => l.currencies.map((c) => [l.platform, c, spreadBps])).sort();
      const order = await spreadCash.order(listed.depositId);
      expect(order.totalAmount).toBe(amount);
      expect(order.isInFlight).toBe(true);
      expect((order.payouts ?? []).map((p) => [p.platform, p.currency, p.pricing.spreadBps]).sort()).toEqual(expectedPayouts);
      expect((await spreadCash.orders(seller)).map((o) => o.depositId)).toContain(listed.depositId);
      const row = await fetchSellOrder(getCashClient(), listed.depositId);
      expect(row.state).toBe("awaiting-buyer");
      expect(row.availableAmount).toBe(amount);
      expect((row.payouts ?? []).map((p) => [p.platform, p.currency, p.pricing.spreadBps]).sort()).toEqual(expectedPayouts);

      // Top up (approve + addFunds) and withdraw all through the spread path, attributed like Peer Cash.
      const top = await topUpSellOrder({ client: spreadCash, sender: deps.sender, publicClient: forkClient }, listed.depositId, USDC(5));
      expect(top.steps.map((s) => s.kind)).toEqual(["approve", "addFunds"]);
      expect(await expectAttributed(top.txHash, SELL_ATTRIBUTION)).toBe(ESCROW);
      expect((await readEscrow<OnchainDeposit>("getDeposit", [id])).remainingDeposits).toBe(USDC(25));
      expect(await usdcBalance(seller)).toBe(startBalance - USDC(25));
      for (const leg of legs) await expectOracleTuples(listed, leg.platform, leg.currencies, spreadBps);

      const escrowBefore = await usdcBalance(ESCROW);
      const result = await withdrawSellOrder({ client: spreadCash, sender: deps.sender }, listed.depositId);
      expect(result.steps.map((s) => s.kind)).toEqual(["withdrawDeposit"]);
      expect(await expectAttributed(result.txHash, SELL_ATTRIBUTION)).toBe(ESCROW);
      expect(await usdcBalance(seller)).toBe(startBalance);
      expect(await usdcBalance(ESCROW)).toBe(escrowBefore - USDC(25));
      expect((await readEscrow<OnchainDeposit>("getDeposit", [id])).depositor).toBe("0x0000000000000000000000000000000000000000");
    },
  );

  test("a spread outside Peer's -500..+500 bps is refused before anything is sent", async () => {
    const { address: seller, deps } = await newSeller(USDC(10));
    const legs: ResolvedLeg[] = [{ platform: "revolut", currencies: ["EUR"], offchainId: "rampridgeforkspreadbad" }];
    await expect(submitSell({ ...deps, sdk: getSellSdkClient() }, { amount: USDC(5), legs, spreadBps: 501 })).rejects.toMatchObject({
      name: "SellFlowError",
    });
    expect(await usdcBalance(seller)).toBe(USDC(10));
    expect(deps.pending?.read(seller)).toBeNull();
  });
});
