/**
 * SMART-WALLET SIGNAL: RampRidge's signal and cancel through the Coinbase
 * Smart Wallet Privy gives embedded users, built the way Privy builds it
 * (helpers/privySmartWallet.ts), on a Base fork at the latest block.
 *
 * - Ground truth first: RampRidge's own sponsored user operations on Base
 *   mainnet show the account type (Coinbase Smart Wallet 1.1), the EntryPoint
 *   (v0.6) and the paymaster (CDP) Privy uses for this app.
 * - Each RampRidge send becomes one v0.6 user operation, `eth_call`ed from
 *   the EntryPoint into the account (`execute`), then executed by a real
 *   `EntryPoint.handleOps` on the fork with the owner's real signature.
 * - The CDP paymaster policy cannot be queried without its key, so every
 *   `to` in every operation must be on its contract allowlist: USDC,
 *   EscrowV2, OrchestratorV3, WhitelistPolicy.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decodeFunctionData, getAddress, zeroAddress, type Hex } from "viem";
import { entryPoint06Abi, entryPoint06Address } from "viem/account-abstraction";
import { BUY_REFERRER_FEE, PEER_ATTRIBUTION } from "@/config";
import { createPeerClient } from "@/peer/client";
import type { BuyQuote } from "@/peer/market";
import {
  PRIMARY_PAIRS,
  FALLBACK_PAIRS,
  RAMPRIDGE_FEE_PRECISE,
  bareSignalCalldata,
  fillableQuotes,
  hasDuplicateRecipient,
  runSignalCase,
  suffixFor,
  webReference,
  type Pair,
  type SignalCase,
  type WebReference,
} from "./helpers/cases";
import { assertOwnFork, forkClient, mainnetClient, revert, snapshot } from "./helpers/fork";
import {
  BASE_BUILDER_CODE,
  ORCHESTRATOR,
  ORCHESTRATOR_ABI,
  PAYMASTER_ALLOWLIST,
  attributionCodes,
  gatingSigner,
  netRelease,
} from "./helpers/peer";
import {
  CDP_PAYMASTER,
  CSW_FACTORY,
  REAL_RAMPRIDGE_USER_OPS,
  decodeAccountCalls,
  initCodeFactory,
  privySmartWallet,
  type PrivySmartWallet,
} from "./helpers/privySmartWallet";

const RAMPRIDGE_CODES = [...PEER_ATTRIBUTION, BASE_BUILDER_CODE];

let forkStart: Hex;
let wallet: PrivySmartWallet;
let result: SignalCase;

beforeAll(async () => {
  await assertOwnFork();
  forkStart = await snapshot();
  wallet = await privySmartWallet("1.1");
  const client = createPeerClient({ sender: wallet.sender });
  let chosen: { pair: Pair; quote: BuyQuote; web: WebReference } | null = null;
  for (const pair of [...PRIMARY_PAIRS, ...FALLBACK_PAIRS]) {
    for (const quote of await fillableQuotes(client, pair, wallet.sender.address)) {
      const web = await webReference(client, quote, wallet.sender.address);
      if (hasDuplicateRecipient(web.withFee.params.referralFees)) continue;
      chosen = { pair, quote, web };
      break;
    }
    if (chosen) break;
  }
  if (!chosen) throw new Error("No fillable quote for the smart-wallet case");
  result = await runSignalCase({
    ...chosen,
    client,
    sender: wallet.sender,
    // The orchestrator's calldata is the single `execute` call inside the account's user operation.
    calldata: async (signal) => {
      const op = wallet.operations.find((o) => o.bundleTx === signal.txHash);
      if (!op) throw new Error("no user operation for the signal bundle");
      return op.calls[0]!.data;
    },
    cancelCalldata: async (txHash) => {
      const op = wallet.operations.find((o) => o.bundleTx === txHash);
      if (!op) throw new Error("no user operation for the cancel bundle");
      return op.calls[0]!.data;
    },
  });
});

afterAll(async () => {
  if (forkStart) await revert(forkStart);
});

describe("ground truth: RampRidge's real sponsored user operations on Base", () => {
  test("Coinbase Smart Wallet 1.1 through EntryPoint v0.6, sponsored by the CDP paymaster, calls only allowlisted contracts", async () => {
    for (const hash of REAL_RAMPRIDGE_USER_OPS) {
      const tx = await mainnetClient.getTransaction({ hash });
      expect(tx.to?.toLowerCase(), hash).toBe(entryPoint06Address.toLowerCase());
      const { functionName, args } = decodeFunctionData({ abi: entryPoint06Abi, data: tx.input });
      expect(functionName).toBe("handleOps");
      for (const op of (args as unknown as readonly [readonly { sender: Hex; initCode: Hex; callData: Hex; paymasterAndData: Hex }[]])[0]) {
        const code = await mainnetClient.getCode({ address: op.sender as `0x${string}` });
        // ERC-1967 proxy: the Coinbase Smart Wallet factory's account shape.
        expect(code?.startsWith("0x363d3d373d3d363d7f360894a13ba1a3210667c828492db9")).toBe(true);
        if (op.initCode !== "0x") expect(getAddress(op.initCode.slice(0, 42))).toBe(getAddress(CSW_FACTORY["1.1"]));
        expect(getAddress(op.paymasterAndData.slice(0, 42))).toBe(getAddress(CDP_PAYMASTER));
        const { calls } = decodeAccountCalls(op.callData);
        // No user-operation-level data suffix: Privy's data-suffix plugin is not configured.
        expect(attributionCodes(op.callData)).toEqual([]);
        for (const call of calls) {
          expect(PAYMASTER_ALLOWLIST.has(call.to.toLowerCase()), call.to).toBe(true);
          expect(attributionCodes(call.data).at(-1)).toBe(BASE_BUILDER_CODE);
        }
      }
    }
  });

  test("the account version under test is the one that factory deploys", () => {
    expect(getAddress(wallet.account.entryPoint.address)).toBe(getAddress(entryPoint06Address));
    expect(wallet.account.entryPoint.version).toBe("0.6");
    const first = wallet.operations[0]!;
    expect(first.undeployed).toBe(true);
    expect(getAddress(initCodeFactory(first.userOperation)!)).toBe(getAddress(CSW_FACTORY["1.1"]));
  });
});

describe("signalBuyIntent through the Privy smart wallet", () => {
  test("one user operation: execute(OrchestratorV3, 0, the SDK's signalIntent calldata), no batch, no user-op suffix", () => {
    const op = wallet.operations.find((o) => o.bundleTx === result.signal.txHash)!;
    expect(op).toBeDefined();
    expect(op.fn).toBe("execute");
    expect(op.calls).toHaveLength(1);
    expect(op.calls[0]!.to).toBe(ORCHESTRATOR);
    expect(op.calls[0]!.value).toBe(0n);
    expect(op.calls[0]!.data).toBe(result.sentData);
    expect(attributionCodes(op.userOperation.callData)).toEqual([]);
    expect(attributionCodes(op.calls[0]!.data)).toEqual(RAMPRIDGE_CODES);
  });

  test("eth_call execute() from the EntryPoint on the fork succeeds, and handleOps validates the owner's signature", () => {
    for (const op of wallet.operations) {
      expect(op.executeFromEntryPoint, op.userOpHash).toEqual({ ok: true });
    }
    expect(result.signalReceipt.status).toBe("success");
  });

  test("every call in every user operation targets the CDP paymaster allowlist", () => {
    expect(wallet.operations.length).toBeGreaterThanOrEqual(2);
    for (const op of wallet.operations) {
      for (const call of op.calls) expect(PAYMASTER_ALLOWLIST.has(call.to.toLowerCase()), call.to).toBe(true);
    }
    // And that is exactly what the paymaster is asked to sponsor: the same callData, from the same account.
    for (const request of wallet.paymasterRequests) {
      const callData = request.userOperation.callData as Hex;
      expect(String(request.userOperation.sender).toLowerCase()).toBe(wallet.sender.address.toLowerCase());
      for (const call of decodeAccountCalls(callData).calls) {
        expect(PAYMASTER_ALLOWLIST.has(call.to.toLowerCase()), call.to).toBe(true);
      }
    }
    const asked = new Set(wallet.paymasterRequests.map((r) => String(r.userOperation.callData)));
    for (const op of wallet.operations) expect(asked.has(op.userOperation.callData)).toBe(true);
  });

  test("Curator's signature is bound to the smart account (msg.sender), not its owner key", async () => {
    const gate = await gatingSigner(result.sent, wallet.sender.address);
    expect(gate).toBe(getAddress("0x396D31055Db28C0C6f36e8b36f18FE7227248a97"));
    expect(await gatingSigner(result.sent, wallet.owner.address)).not.toBe(gate);
    expect(result.onchain.owner).toBe(getAddress(wallet.sender.address));
    expect(result.onchain.to).toBe(getAddress(wallet.sender.address));
  });

  test("the intent matches the Peer web app's for the same quote and account, field by field", () => {
    const web = result.web.withFee.params;
    const bareOurs = bareSignalCalldata(result.sent);
    expect(bareOurs).toBe(
      bareSignalCalldata({ ...web, gatingServiceSignature: result.sent.gatingServiceSignature, signatureExpiration: result.sent.signatureExpiration }),
    );
    expect(result.sentData).toBe(`${bareOurs}${suffixFor(RAMPRIDGE_CODES).slice(2)}`);
    expect(result.onchain.amount).toBe(result.quote.signalAmount);
    expect(result.onchain.conversionRate).toBe(result.quote.rate);
    expect(result.onchain.postIntentHook).toBe(zeroAddress);
    const ours = result.onchain.referralFees.filter((l) => l.recipient.toLowerCase() === BUY_REFERRER_FEE.recipient.toLowerCase());
    expect(ours).toEqual([{ recipient: BUY_REFERRER_FEE.recipient, fee: RAMPRIDGE_FEE_PRECISE }]);
    const released = netRelease(result.onchain.amount, result.onchain.referralFees, result.managerFee);
    expect(released).toBeGreaterThanOrEqual(result.quote.usdcAmount);
    expect(released - result.quote.usdcAmount).toBeLessThanOrEqual(BigInt(result.onchain.referralFees.length + 1));
    expect(result.signal.expiresAt).toBe(Number(result.escrowLock.expiryTime) * 1000);
  });

  test("RampRidge read the intent from the account's own user operation logs in the bundle", () => {
    expect(result.signal.intentHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.signal.depositId).toBe(BigInt(result.quote.depositId));
    expect(result.signal.amount).toBe(result.onchain.amount);
  });
});

describe("cancelBuyIntent through the Privy smart wallet", () => {
  test("one user operation: execute(OrchestratorV3, 0, cancelIntent(hash)) with RampRidge's attribution", () => {
    const op = wallet.operations.find((o) => o.bundleTx === result.cancelTx)!;
    expect(op).toBeDefined();
    expect(op.fn).toBe("execute");
    expect(op.calls).toHaveLength(1);
    expect(op.calls[0]!.to).toBe(ORCHESTRATOR);
    const cancel = decodeFunctionData({ abi: ORCHESTRATOR_ABI, data: op.calls[0]!.data });
    expect(cancel.functionName).toBe("cancelIntent");
    expect(cancel.args).toEqual([result.signal.intentHash]);
    expect(attributionCodes(op.calls[0]!.data)).toEqual(RAMPRIDGE_CODES);
    expect(op.undeployed).toBe(false);
  });

  test("liquidity is restored and the lock is gone", () => {
    expect(result.afterCancel.remainingDeposits).toBe(result.afterSignal.remainingDeposits + result.onchain.amount);
    expect(result.afterCancel.outstandingIntentAmount).toBe(result.afterSignal.outstandingIntentAmount - result.onchain.amount);
    if (result.prunedDuringSignal.length === 0) expect(result.afterCancel).toEqual(result.before);
    expect(result.afterCancelEscrow).toEqual({ open: false });
    expect(result.afterCancelOwnerIntents).not.toContain(result.signal.intentHash);
    expect(result.afterCancelIntent.owner).toBe(zeroAddress);
  });

  test("the fork is still this run's", async () => {
    await assertOwnFork();
    expect(await forkClient.getChainId()).toBe(8453);
  });
});
