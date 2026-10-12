/**
 * TxSender doubles built from the app's OWN sender factories (src/wallet),
 * so every fork transaction goes through the real `sendCalls` path:
 * call normalisation, one-at-a-time sends, receipt waiting, user-operation
 * scoping and wallet error mapping.
 *
 * - `eoaSender`: an external EOA (`createExternalSender`). anvil runs with
 *   --auto-impersonate, so the address needs no key.
 * - `smartSender`: a Coinbase Smart Wallet (`createSmartSender`), the account
 *   type Privy gives embedded users. Each `sendCalls` becomes ONE ERC-4337
 *   v0.6 user operation, built and signed exactly as viem's
 *   `toCoinbaseSmartAccount` (Privy's own implementation) does, then
 *   submitted through `EntryPoint.handleOps` by an impersonated bundler.
 *   The only difference from production is gas: the account prefunds the
 *   EntryPoint itself instead of using the CDP paymaster.
 */

import {
  concat,
  decodeErrorResult,
  encodeFunctionData,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint06Abi, entryPoint06Address, toCoinbaseSmartAccount, type SmartAccount } from "viem/account-abstraction";
import { TransactionPendingError, UserRejectedError } from "@/wallet/errors";
import { createExternalSender, createSmartSender, type ChainReader } from "@/wallet/senders";
import type { Eip1193Like } from "@/wallet/provider";
import type { NormalizedCall } from "@/wallet/sequence";
import type { TxSender } from "@/wallet/types";
import { forkClient, impersonatedWallet, mined, revert, setEthBalance, snapshot } from "./anvil";

const reader = forkClient as unknown as ChainReader;

/** EIP-1193 provider straight onto the fork. */
const forkProvider: Eip1193Like = {
  request: ({ method, params }) => forkClient.request({ method: method as never, params: params as never }),
};

export function eoaSender(address: Address): TxSender {
  return createExternalSender(
    address,
    { getProvider: async () => forkProvider, switchToBase: async () => undefined },
    { reader, receiptTimeoutMs: 60_000 },
  );
}

/** An ERC-4337 v0.6 user operation, every field filled, as `EntryPoint.handleOps` takes it. */
export interface UserOperationV06 {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
}

/** What the smart-wallet double built and checked for each `sendCalls`. */
export interface SubmittedUserOperation {
  calls: NormalizedCall[];
  userOperation: UserOperationV06;
  /** The account existed before this operation (no initCode). */
  deployed: boolean;
  /** `eth_call` from the EntryPoint to the account with the operation's callData succeeded. */
  executeFromEntryPoint: "ok" | { reverted: Hex };
  bundleTx: Hash;
}

export interface SmartWalletDouble {
  sender: TxSender;
  account: SmartAccount;
  owner: LocalAccount;
  operations: SubmittedUserOperation[];
}

/** An impersonated bundler EOA (also the handleOps beneficiary). */
const BUNDLER: Address = "0x00000000000000000000000000000000000b0d1e";

function revertData(error: unknown): Hex {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const data = (current as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x")) return data as Hex;
    if (data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string") {
      return (data as { data: Hex }).data;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return "0x";
}

/**
 * `eth_call` from the EntryPoint to `account.execute(...)`/`executeBatch(...)`
 * with exactly the operation's callData, as the EntryPoint runs it after
 * validation. For an undeployed account the factory deploys it inside an anvil
 * snapshot that is reverted afterwards, so the real operation still deploys it.
 */
async function executeFromEntryPoint(account: SmartAccount, callData: Hex, deployed: boolean) {
  const snap = deployed ? null : await snapshot();
  try {
    if (!deployed) {
      const { factory, factoryData } = await account.getFactoryArgs();
      if (!factory || !factoryData) throw new Error("smart account has no factory args");
      await setEthBalance(BUNDLER, "10");
      await mined(await impersonatedWallet(BUNDLER).sendTransaction({ to: factory, data: factoryData }));
    }
    await forkClient.call({ account: entryPoint06Address, to: account.address, data: callData });
    return "ok" as const;
  } catch (error) {
    return { reverted: revertData(error) };
  } finally {
    if (snap) await revert(snap);
  }
}

export async function smartSender(version: "1" | "1.1" = "1"): Promise<SmartWalletDouble> {
  const owner = privateKeyToAccount(generatePrivateKey());
  const account = await toCoinbaseSmartAccount({ client: forkClient, owners: [owner], version });
  const operations: SubmittedUserOperation[] = [];

  const sendBatch = async (calls: NormalizedCall[]): Promise<Hash> => {
    const deployed = await account.isDeployed();
    const callData = await account.encodeCalls(calls.map((c) => ({ to: c.to, data: c.data, value: c.value })));
    const initCode: Hex = deployed
      ? "0x"
      : await account.getFactoryArgs().then(({ factory, factoryData }) => concat([factory as Address, factoryData as Hex]));
    const block = await forkClient.getBlock({ blockTag: "latest" });
    const maxPriorityFeePerGas = 1_000_000n;
    const maxFeePerGas = (block.baseFeePerGas ?? 1_000_000n) * 2n + maxPriorityFeePerGas;
    const unsigned: UserOperationV06 = {
      sender: account.address,
      nonce: await account.getNonce(),
      initCode,
      callData,
      callGasLimit: 3_000_000n,
      verificationGasLimit: deployed ? 600_000n : 1_500_000n,
      preVerificationGas: 120_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      paymasterAndData: "0x",
      signature: "0x",
    };
    const userOperation: UserOperationV06 = { ...unsigned, signature: await account.signUserOperation(unsigned) };
    const executeCheck = await executeFromEntryPoint(account, callData, deployed);

    // No paymaster on the fork: the account prefunds the EntryPoint.
    await setEthBalance(account.address, "1");
    await setEthBalance(BUNDLER, "10");
    const bundleTx = await impersonatedWallet(BUNDLER).sendTransaction({
      to: entryPoint06Address,
      data: encodeFunctionData({ abi: entryPoint06Abi, functionName: "handleOps", args: [[userOperation], BUNDLER] }),
      gas: 10_000_000n,
    });
    operations.push({ calls, userOperation, deployed, executeFromEntryPoint: executeCheck, bundleTx });
    return bundleTx;
  };

  const sender = createSmartSender(
    account.address,
    {
      sendBatch: (calls) => sendBatch(calls),
      signMessage: (message) => account.signMessage({ message }),
      signTypedData: (payload) =>
        account.signTypedData({
          domain: payload.domain,
          types: payload.types,
          primaryType: payload.primaryType,
          message: payload.message,
        } as never),
    },
    { reader, receiptTimeoutMs: 60_000 },
  );
  return { sender, account, owner, operations };
}

/** Decodes an EntryPoint v0.6 FailedOp revert, if that is what `data` is. */
export function entryPointFailure(data: Hex): string | null {
  try {
    const decoded = decodeErrorResult({ abi: entryPoint06Abi, data });
    return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
  } catch {
    return null;
  }
}

/** How a wrapped `sendCalls` fails, the way real wallets do. */
export type SendFault =
  /** The player refuses in the wallet: nothing is sent. */
  | "reject"
  /** The calls are sent and land, but the wallet times out before reporting the receipt. */
  | "lose-receipt";

/**
 * Wraps a TxSender so the n-th `sendCalls` fails with `faults[n]` (null sends
 * normally). Everything else is the wrapped sender's.
 */
export function faultySender(base: TxSender, faults: ReadonlyArray<SendFault | null>): TxSender & { sends: () => number } {
  let attempt = 0;
  let sent = 0;
  return {
    ...base,
    sends: () => sent,
    async sendCalls(calls, opts) {
      const fault = faults[attempt] ?? null;
      attempt += 1;
      if (fault === "reject") throw new UserRejectedError();
      const receipt = await base.sendCalls(calls, opts);
      sent += 1;
      if (fault === "lose-receipt") throw new TransactionPendingError(receipt.transactionHash);
      return receipt;
    },
  };
}
