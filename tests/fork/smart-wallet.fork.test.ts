/**
 * The smart-wallet path on the Base fork. Embedded players transact through
 * a Privy Coinbase Smart Wallet: every `sendCalls` is ONE ERC-4337 v0.6 user
 * operation. Here the app's own `createSmartSender` drives an account built
 * by viem's `toCoinbaseSmartAccount` (what Privy uses); each operation's
 * callData is first `eth_call`ed from the EntryPoint against the account
 * (execute / executeBatch), then submitted through `EntryPoint.handleOps`.
 * Every call target must also be on the CDP paymaster allowlist, or the
 * sponsored operation would be refused in production.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildMarketRateCurrencyOverride } from "@zkp2p/cash";
import { decodeFunctionData, erc20Abi, getAddress, parseAbi, parseEventLogs, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint06Abi, entryPoint06Address } from "viem/account-abstraction";
import { PEER_ABIS, createPeerClient } from "@/peer/client";
import { cancelBuyIntent, fulfillBuyIntent, readEscrowIntent, signalBuyIntent, type SignalResult } from "@/peer/buy/chain";
import { toBuyError } from "@/peer/buy/errors";
import type { BuyQuote } from "@/peer/market";
import { BUY_PLATFORMS } from "@/peer/platforms";
import { getCashClient } from "@/peer/sell/cash";
import { fetchSellOrder, withdrawSellOrder } from "@/peer/sell/orders";
import { createPendingSellStore, memoryStorage } from "@/peer/sell/persistence";
import { submitSell } from "@/peer/sell/submit";
import { forkClient, fundUsdc, usdcBalance } from "./helpers/anvil";
import { fillableQuotes, forkAttestationService, readDeposit, readIntent, trustWitnessOnFork, verifierFor } from "./helpers/buy";
import { installOffchain, recordedRequests, setAttestationHandler, uninstallOffchain } from "./helpers/offchain";
import { ESCROW, ORCHESTRATOR, PAYMASTER_ALLOWLIST, WHITELIST_POLICY, currencyHash, paymentMethodHash } from "./helpers/peer";
import { entryPointFailure, smartSender, type SmartWalletDouble, type SubmittedUserOperation } from "./helpers/senders";
import { USDC_ADDRESS } from "@/config";

const COINBASE_ACCOUNT_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

/** What a user operation asks the account to run, decoded from its callData. */
function decodedCalls(op: SubmittedUserOperation): { to: Address; value: bigint; data: Hex }[] {
  const call = decodeFunctionData({ abi: COINBASE_ACCOUNT_ABI, data: op.userOperation.callData });
  if (call.functionName === "execute") {
    const [to, value, data] = call.args;
    return [{ to, value, data }];
  }
  return call.args[0].map((c) => ({ to: c.target, value: c.value, data: c.data }));
}

async function expectSponsorable(op: SubmittedUserOperation): Promise<void> {
  // The calls the app asked for are exactly what the account will run.
  expect(decodedCalls(op).map((c) => [getAddress(c.to), c.value, c.data])).toEqual(
    op.calls.map((c) => [getAddress(c.to), c.value, c.data]),
  );
  for (const call of op.calls) expect(PAYMASTER_ALLOWLIST.has(call.to.toLowerCase())).toBe(true);
  const check = op.executeFromEntryPoint;
  if (check !== "ok") throw new Error(`execute() from the EntryPoint reverted: ${entryPointFailure(check.reverted) ?? check.reverted}`);
  const receipt = await forkClient.getTransactionReceipt({ hash: op.bundleTx });
  const events = parseEventLogs({ abi: entryPoint06Abi, logs: receipt.logs, eventName: "UserOperationEvent" }).filter(
    (e) => getAddress(e.address) === getAddress(entryPoint06Address),
  );
  expect(events.map((e) => [getAddress(e.args.sender), e.args.success])).toEqual([[getAddress(op.userOperation.sender), true]]);
}

/** Every user operation built in this file, for the allowlist check at the end. */
const allOperations: SubmittedUserOperation[] = [];

beforeAll(async () => {
  await installOffchain();
});

afterAll(() => {
  uninstallOffchain();
});

describe.each(["1", "1.1"] as const)("Coinbase Smart Wallet v%s", (version) => {
  let wallet: SmartWalletDouble;
  let quote: BuyQuote;
  let signal: SignalResult;

  beforeAll(async () => {
    wallet = await smartSender(version);
  });

  test("the first user operation deploys the account and signals a real Curator-signed intent", async () => {
    expect(await wallet.account.isDeployed()).toBe(false);
    const client = createPeerClient({ sender: wallet.sender });
    expect(getAddress(client.walletClient.account?.address ?? "0x")).toBe(getAddress(wallet.account.address));
    const { quotes } = await fillableQuotes(client, wallet.account.address);
    const failures: string[] = [];
    for (const candidate of quotes) {
      try {
        signal = await signalBuyIntent(client, wallet.sender, candidate);
        quote = candidate;
        break;
      } catch (error) {
        failures.push(`${candidate.id}: ${toBuyError(error, { stage: "signal" }).code} ${String(error).slice(0, 300)}`);
      }
    }
    if (!signal) throw new Error(`no quote signalled from the smart wallet:\n${failures.join("\n")}`);

    // Curator signed for the smart account: it is msg.sender on the orchestrator.
    const signed = recordedRequests((r) => r.url.endsWith("/v3/sign") && r.status === 200).at(-1);
    expect(signed?.body).toMatchObject({ callerAddress: wallet.account.address, toAddress: wallet.account.address });

    const op = wallet.operations.at(-1);
    if (!op) throw new Error("no user operation was built");
    expect(op.deployed).toBe(false);
    expect(op.userOperation.initCode).not.toBe("0x");
    expect(op.calls).toHaveLength(1);
    expect(getAddress(op.calls[0]?.to ?? "0x")).toBe(ORCHESTRATOR);
    expect(decodeFunctionData({ abi: COINBASE_ACCOUNT_ABI, data: op.userOperation.callData }).functionName).toBe("execute");
    await expectSponsorable(op);

    expect(await wallet.account.isDeployed()).toBe(true);
    const intent = await readIntent(signal.intentHash);
    expect(getAddress(intent.owner)).toBe(getAddress(wallet.account.address));
    expect(getAddress(intent.to)).toBe(getAddress(wallet.account.address));
    expect(intent.amount).toBe(quote.signalAmount);
    // The app's receipt came back scoped to this account's operation: the intent was read from it.
    expect(signal.txHash).toBe(op.bundleTx);
  });

  test("cancel is a second user operation on the deployed account and frees the seller's USDC", async () => {
    const before = await readDeposit(quote.depositId);
    const client = createPeerClient({ sender: wallet.sender });
    await cancelBuyIntent(client, wallet.sender, signal.intentHash, signal.orchestrator);
    const op = wallet.operations.at(-1);
    if (!op) throw new Error("no user operation was built");
    expect(op.deployed).toBe(true);
    expect(op.userOperation.initCode).toBe("0x");
    await expectSponsorable(op);
    expect((await readDeposit(quote.depositId)).remainingDeposits).toBe(before.remainingDeposits + quote.signalAmount);
    expect(await readEscrowIntent(client, quote.escrow, quote.depositId, signal.intentHash)).toEqual({ open: false });
  });

  test("sell: approve + createDeposit run as ONE batched operation, the Venmo policy as another, withdraw as a third", async () => {
    const owner = wallet.account.address;
    await fundUsdc(owner, USDC(15));
    const storage = memoryStorage();
    const deps = {
      client: getCashClient(),
      sender: wallet.sender,
      publicClient: forkClient,
      pending: createPendingSellStore(storage),
      storage,
    };
    const opsBefore = wallet.operations.length;
    const listed = await submitSell(deps, {
      amount: USDC(10),
      legs: [{ platform: "venmo", currencies: ["USD"], offchainId: `rampridge-sw-${version.replace(".", "")}` }],
    });
    const [depositOp, policyOp] = wallet.operations.slice(opsBefore);
    if (!depositOp || !policyOp) throw new Error("expected a deposit and a policy user operation");

    expect(decodeFunctionData({ abi: COINBASE_ACCOUNT_ABI, data: depositOp.userOperation.callData }).functionName).toBe("executeBatch");
    expect(depositOp.calls.map((c) => getAddress(c.to))).toEqual([getAddress(USDC_ADDRESS), ESCROW]);
    await expectSponsorable(depositOp);
    expect(policyOp.calls.map((c) => getAddress(c.to))).toEqual([getAddress(WHITELIST_POLICY)]);
    await expectSponsorable(policyOp);
    expect(listed.txHashes.createDeposit).toBe(depositOp.bundleTx);
    expect(listed.txHashes.accessPolicy).toEqual([policyOp.bundleTx]);
    expect(await usdcBalance(owner)).toBe(USDC(5));

    const deposit = await readDeposit(listed.depositId.split("_").at(-1) ?? "");
    expect(getAddress(deposit.depositor)).toBe(getAddress(owner));
    expect(deposit.remainingDeposits).toBe(USDC(10));

    await withdrawSellOrder({ client: getCashClient(), sender: wallet.sender }, listed.depositId);
    const withdrawOp = wallet.operations.at(-1);
    if (!withdrawOp) throw new Error("no withdraw operation");
    expect(withdrawOp.calls.map((c) => getAddress(c.to))).toEqual([ESCROW]);
    await expectSponsorable(withdrawOp);
    expect(await usdcBalance(owner)).toBe(USDC(15));
  });

  test("sell, multi-currency: Wise GBP + EUR at the market rate is ONE batched operation Peer Cash reads back unattributed", async () => {
    const owner = wallet.account.address;
    await fundUsdc(owner, USDC(12));
    const before = await usdcBalance(owner);
    const storage = memoryStorage();
    const deps = {
      client: getCashClient(),
      sender: wallet.sender,
      publicClient: forkClient,
      pending: createPendingSellStore(storage),
      storage,
    };
    const opsBefore = wallet.operations.length;
    const listed = await submitSell(deps, {
      amount: USDC(12),
      legs: [{ platform: "wise", currencies: ["GBP", "EUR"], offchainId: `rampridgeswmulti${version.replace(".", "")}` }],
    });
    // Wise has no access policy: the deposit is the only operation.
    const ops = wallet.operations.slice(opsBefore);
    expect(ops).toHaveLength(1);
    const [depositOp] = ops;
    if (!depositOp) throw new Error("no deposit operation");
    expect(decodeFunctionData({ abi: COINBASE_ACCOUNT_ABI, data: depositOp.userOperation.callData }).functionName).toBe("executeBatch");
    expect(depositOp.calls.map((c) => getAddress(c.to))).toEqual([getAddress(USDC_ADDRESS), ESCROW]);
    await expectSponsorable(depositOp);
    expect(listed.legs).toEqual([{ platform: "wise", currencies: ["GBP", "EUR"] }]);
    expect(listed.txHashes.accessPolicy).toEqual([]);
    expect(await usdcBalance(owner)).toBe(before - USDC(12));

    // Both currencies follow Peer Cash's oracle at zero spread.
    const id = BigInt(listed.depositId.split("_").at(-1) ?? "0");
    for (const currency of ["GBP", "EUR"] as const) {
      const oracle = (await forkClient.readContract({
        address: ESCROW,
        abi: PEER_ABIS.escrow,
        functionName: "getDepositOracleRateConfig",
        args: [id, paymentMethodHash("wise"), currencyHash(currency)],
      } as never)) as { adapter: Address; spreadBps: number };
      const expected = buildMarketRateCurrencyOverride(currency)?.oracleRateConfig;
      expect([currency, oracle.adapter.toLowerCase(), oracle.spreadBps]).toEqual([currency, expected?.adapter.toLowerCase(), 0]);
    }

    // The indexer can't attribute a smart-wallet batch, and a market-rate order needs no attribution to read back.
    const row = await fetchSellOrder(getCashClient(), listed.depositId);
    expect(row.state).toBe("awaiting-buyer");
    expect(row.payouts?.map((p) => [p.platform, p.currency, p.pricing.marketRate]).sort()).toEqual([
      ["wise", "EUR", true],
      ["wise", "GBP", true],
    ]);
    expect((await getCashClient().orders(owner)).map((o) => o.depositId)).toContain(listed.depositId);

    await withdrawSellOrder({ client: getCashClient(), sender: wallet.sender }, listed.depositId);
    const withdrawOp = wallet.operations.at(-1);
    if (!withdrawOp) throw new Error("no withdraw operation");
    expect(withdrawOp.calls.map((c) => getAddress(c.to))).toEqual([ESCROW]);
    await expectSponsorable(withdrawOp);
    expect(await usdcBalance(owner)).toBe(before);
  });

  test("buy end to end: signal, then fulfil from the smart wallet releases the USDC to it", async () => {
    const client = createPeerClient({ sender: wallet.sender });
    const { quotes } = await fillableQuotes(client, wallet.account.address);
    let bought: { quote: BuyQuote; signal: SignalResult } | null = null;
    for (const candidate of quotes) {
      try {
        bought = { quote: candidate, signal: await signalBuyIntent(client, wallet.sender, candidate) };
        break;
      } catch {
        // Liquidity moved: try the next offer.
      }
    }
    if (!bought) throw new Error("no quote signalled from the smart wallet");
    const witness = privateKeyToAccount(generatePrivateKey());
    const { attestationVerifier } = await verifierFor(paymentMethodHash(bought.quote.platform));
    await trustWitnessOnFork(attestationVerifier, witness.address);
    const method = BUY_PLATFORMS[bought.quote.platform].verifyMethods[0];
    if (!method) throw new Error("no verify method");
    const before = await usdcBalance(wallet.account.address);
    setAttestationHandler(forkAttestationService(witness));
    const result = await fulfillBuyIntent(client, wallet.sender, bought.signal.intentHash, bought.signal.orchestrator, {
      proofType: "buyerTee",
      encryptedSessionMaterial: "fork-test-session-material",
      params: { id: `fork-sw-${version}`, index: 0 },
      actionType: method.actionType,
      actionPlatform: method.actionPlatform,
    }).finally(() => setAttestationHandler(null));
    const op = wallet.operations.at(-1);
    if (!op) throw new Error("no fulfil operation");
    expect(op.calls.map((c) => getAddress(c.to))).toEqual([ORCHESTRATOR]);
    await expectSponsorable(op);
    const expected = bought.signal.referrerFeeWaived ? bought.quote.usdcAmount + bought.quote.fees.referrer : bought.quote.usdcAmount;
    expect(result.released).not.toBeNull();
    expect((result.released ?? 0n) - expected).toBeGreaterThanOrEqual(0n);
    expect((result.released ?? 0n) - expected).toBeLessThanOrEqual(1n);
    expect(await usdcBalance(wallet.account.address)).toBe(before + (result.released ?? 0n));
    allOperations.push(...wallet.operations);
  });
});

describe("the CDP paymaster allowlist", () => {
  const ABIS = [
    { address: getAddress(USDC_ADDRESS), abi: erc20Abi },
    { address: ESCROW, abi: PEER_ABIS.escrow },
    { address: ORCHESTRATOR, abi: PEER_ABIS.orchestrator },
    { address: getAddress(WHITELIST_POLICY), abi: parseAbi(["function configureDeposit(address,uint256,bytes32,bool,bytes32[],address[])"]) },
  ];

  test("every sponsored call is one of the expected functions on an allowlisted contract", () => {
    expect(allOperations.length).toBeGreaterThan(0);
    const used = new Set<string>();
    for (const op of allOperations) {
      for (const call of op.calls) {
        const target = ABIS.find((a) => a.address === getAddress(call.to));
        if (!target) throw new Error(`call to ${call.to} is not on the paymaster allowlist`);
        const { functionName } = decodeFunctionData({ abi: target.abi, data: call.data } as never) as { functionName: string };
        used.add(`${target.address === ESCROW ? "EscrowV2" : target.address === ORCHESTRATOR ? "OrchestratorV3" : target.address === WHITELIST_POLICY ? "WhitelistPolicy" : "USDC"}.${functionName}`);
      }
    }
    expect([...used].sort()).toEqual(
      [
        "EscrowV2.createDeposit",
        "EscrowV2.withdrawDeposit",
        "OrchestratorV3.cancelIntent",
        "OrchestratorV3.fulfillIntent",
        "OrchestratorV3.signalIntent",
        "USDC.approve",
        "WhitelistPolicy.configureDeposit",
      ].sort(),
    );
  });
});
