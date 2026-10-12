/**
 * The smart wallet Privy gives RampRidge's embedded users, rebuilt the way
 * @privy-io/react-auth 3.48.1 builds it (dist/esm/smart-wallets-*.mjs):
 *
 * - `smartWalletType` COINBASE_SMART_WALLET -> viem `toCoinbaseSmartAccount`
 *   with the embedded signer as its only owner. That account is ERC-4337
 *   EntryPoint v0.6. Version 1.1: the factory in the initCode of RampRidge's
 *   own sponsored user operations on Base (see REAL_RAMPRIDGE_USER_OPS).
 * - permissionless `createSmartAccountClient` with the CDP paymaster and the
 *   fee estimate Privy uses for a CDP bundler (public estimate x 1.75).
 * - RampRidge's WalletProvider calls the wrapped client's
 *   `sendTransaction({ calls })` headlessly, which is
 *   `smartAccountClient.sendTransaction({ calls })`: one user operation,
 *   `execute` for one call and `executeBatch` for several.
 *
 * The bundler and paymaster are local stand-ins (they cannot see the fork):
 *
 * - The paymaster records the exact user operation CDP would be asked to
 *   sponsor and returns no sponsorship; the account prefunds the EntryPoint
 *   instead (the only difference from production).
 * - The bundler, before bundling, `eth_call`s the account from the EntryPoint
 *   with the operation's callData (the account's `execute`/`executeBatch` as
 *   the EntryPoint runs it after validation; an undeployed account is deployed
 *   in a snapshot first), then submits `EntryPoint.handleOps` from a funded
 *   fork key, so the EntryPoint checks the owner's signature for real.
 */

import { createSmartAccountClient } from "permissionless";
import {
  custom,
  decodeFunctionData,
  encodeFunctionData,
  hexToBigInt,
  numberToHex,
  parseAbi,
  parseEventLogs,
  slice,
  size,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  entryPoint06Abi,
  entryPoint06Address,
  getUserOperationHash,
  toCoinbaseSmartAccount,
  type SmartAccount,
  type UserOperation,
} from "viem/account-abstraction";
import { base } from "viem/chains";
import { createSmartSender, type ChainReader } from "@/wallet/senders";
import type { TxSender } from "@/wallet/types";
import { forkClient, fundedAccount, revert, setEthBalance, snapshot, type ForkAccount } from "./fork";

export const COINBASE_SMART_WALLET_ABI = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);

/** Coinbase Smart Wallet factories (viem toCoinbaseSmartAccount). */
export const CSW_FACTORY = {
  "1": "0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a",
  "1.1": "0xBA5ED110eFDBa3D005bfC882d75358ACbbB85842",
} as const;

/** The CDP paymaster RampRidge's real sponsored user operations name in paymasterAndData. */
export const CDP_PAYMASTER: Address = "0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c";

/**
 * RampRidge's own sponsored smart-wallet user operations on Base mainnet
 * (the launch sell deposit, 2026-10-11): the ground truth for which account
 * type, EntryPoint and paymaster Privy uses for this app.
 */
export const REAL_RAMPRIDGE_USER_OPS: readonly Hash[] = [
  "0x0d45abc2a1d5b21cfc48d382eb95a5ca7af6c292d78f6795c04cd6a114ccf148",
  "0x184f66a778f1640b955598698a8a2dc723138f1954243085fa7069fadf1e2d44",
];

export interface DecodedCall {
  to: Address;
  value: bigint;
  data: Hex;
}

export function decodeAccountCalls(callData: Hex): { fn: "execute" | "executeBatch"; calls: DecodedCall[] } {
  const decoded = decodeFunctionData({ abi: COINBASE_SMART_WALLET_ABI, data: callData });
  if (decoded.functionName === "execute") {
    const [to, value, data] = decoded.args;
    return { fn: "execute", calls: [{ to, value, data }] };
  }
  return { fn: "executeBatch", calls: decoded.args[0].map((c) => ({ to: c.target, value: c.value, data: c.data })) };
}

export interface BundledOperation {
  userOperation: UserOperation<"0.6">;
  userOpHash: Hash;
  /** The account had no code before this operation (initCode deploys it). */
  undeployed: boolean;
  fn: "execute" | "executeBatch";
  calls: DecodedCall[];
  /** `eth_call` to the account from the EntryPoint with the operation's callData. */
  executeFromEntryPoint: { ok: true } | { ok: false; error: string };
  bundleTx: Hash;
}

export interface PrivySmartWallet {
  sender: TxSender;
  account: SmartAccount;
  owner: LocalAccount;
  /** Every user operation sent, in order. */
  operations: BundledOperation[];
  /** What the CDP paymaster would have been asked to sponsor (stub and final requests). */
  paymasterRequests: Array<{ kind: "stub" | "final"; userOperation: Record<string, unknown> }>;
}

function rpcUserOperation(raw: Record<string, Hex>): UserOperation<"0.6"> {
  return {
    sender: raw.sender as Address,
    nonce: hexToBigInt(raw.nonce!),
    initCode: raw.initCode ?? "0x",
    callData: raw.callData!,
    callGasLimit: hexToBigInt(raw.callGasLimit!),
    verificationGasLimit: hexToBigInt(raw.verificationGasLimit!),
    preVerificationGas: hexToBigInt(raw.preVerificationGas!),
    maxFeePerGas: hexToBigInt(raw.maxFeePerGas!),
    maxPriorityFeePerGas: hexToBigInt(raw.maxPriorityFeePerGas!),
    paymasterAndData: raw.paymasterAndData ?? "0x",
    signature: raw.signature!,
  };
}

/** The full v0.6 UserOperation struct EntryPoint.handleOps takes. */
function packed06(op: UserOperation<"0.6">) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: op.initCode ?? "0x",
    callData: op.callData,
    callGasLimit: op.callGasLimit,
    verificationGasLimit: op.verificationGasLimit,
    preVerificationGas: op.preVerificationGas,
    maxFeePerGas: op.maxFeePerGas,
    maxPriorityFeePerGas: op.maxPriorityFeePerGas,
    paymasterAndData: op.paymasterAndData ?? "0x",
    signature: op.signature,
  } as const;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0]! : String(error);
}

async function executeFromEntryPoint(op: UserOperation<"0.6">, bundler: ForkAccount, undeployed: boolean) {
  const snap = undeployed ? await snapshot() : null;
  try {
    if (undeployed) {
      // initCode = factory (20 bytes) ++ factory calldata
      const initCode = op.initCode ?? "0x";
      const factory = slice(initCode, 0, 20) as Address;
      const factoryData = slice(initCode, 20) as Hex;
      await forkClient.waitForTransactionReceipt({ hash: await bundler.send({ to: factory, data: factoryData }) });
    }
    await forkClient.call({ account: entryPoint06Address, to: op.sender, data: op.callData });
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: errorText(error) };
  } finally {
    if (snap) await revert(snap);
  }
}

export async function privySmartWallet(version: "1" | "1.1" = "1.1"): Promise<PrivySmartWallet> {
  const owner = privateKeyToAccount(generatePrivateKey());
  // Privy wraps its embedded signer as a local owner whose `sign` is a raw secp256k1 signature over the hash.
  const account = await toCoinbaseSmartAccount({ client: forkClient, owners: [owner], version });
  const bundler = await fundedAccount("10");
  const operations: BundledOperation[] = [];
  const paymasterRequests: PrivySmartWallet["paymasterRequests"] = [];
  const byHash = new Map<string, { op: UserOperation<"0.6">; bundleTx: Hash }>();

  const bundlerTransport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const list = Array.isArray(params) ? params : [];
      switch (method) {
        case "eth_chainId":
          return numberToHex(base.id);
        case "eth_supportedEntryPoints":
          return [entryPoint06Address];
        case "eth_estimateUserOperationGas": {
          const op = list[0] as Record<string, Hex>;
          const undeployed = Boolean(op.initCode && op.initCode !== "0x");
          return {
            preVerificationGas: numberToHex(120_000n),
            verificationGasLimit: numberToHex(undeployed ? 1_500_000n : 400_000n),
            callGasLimit: numberToHex(2_500_000n),
          };
        }
        case "eth_sendUserOperation": {
          const op = rpcUserOperation(list[0] as Record<string, Hex>);
          if (String(list[1]).toLowerCase() !== entryPoint06Address.toLowerCase()) throw new Error(`unexpected EntryPoint ${String(list[1])}`);
          const undeployed = (await forkClient.getCode({ address: op.sender }))?.length ? false : true;
          const { fn, calls } = decodeAccountCalls(op.callData);
          const executeCheck = await executeFromEntryPoint(op, bundler, undeployed);
          // No paymaster on the fork: the account prefunds the EntryPoint itself.
          await setEthBalance(op.sender, "1");
          const bundleTx = await bundler.send({
            to: entryPoint06Address,
            data: encodeFunctionData({ abi: entryPoint06Abi, functionName: "handleOps", args: [[packed06(op)], bundler.address] }),
            gas: 12_000_000n,
          });
          await forkClient.waitForTransactionReceipt({ hash: bundleTx });
          const userOpHash = getUserOperationHash({
            chainId: base.id,
            entryPointAddress: entryPoint06Address,
            entryPointVersion: "0.6",
            userOperation: op,
          });
          byHash.set(userOpHash.toLowerCase(), { op, bundleTx });
          operations.push({ userOperation: op, userOpHash, undeployed, fn, calls, executeFromEntryPoint: executeCheck, bundleTx });
          return userOpHash;
        }
        case "eth_getUserOperationReceipt": {
          const entry = byHash.get(String(list[0]).toLowerCase());
          if (!entry) return null;
          const rawReceipt = (await forkClient.request({
            method: "eth_getTransactionReceipt",
            params: [entry.bundleTx],
          })) as { logs: Array<{ address: Hex; topics: Hex[]; data: Hex }> } & Record<string, unknown>;
          const receipt = await forkClient.getTransactionReceipt({ hash: entry.bundleTx });
          const events = parseEventLogs({ abi: entryPoint06Abi, logs: receipt.logs, eventName: "UserOperationEvent" });
          const event = events.find((e) => e.args.userOpHash.toLowerCase() === String(list[0]).toLowerCase());
          if (!event) throw new Error("bundle has no UserOperationEvent for this operation");
          return {
            userOpHash: event.args.userOpHash,
            entryPoint: entryPoint06Address,
            sender: event.args.sender,
            nonce: numberToHex(event.args.nonce),
            paymaster: event.args.paymaster,
            actualGasCost: numberToHex(event.args.actualGasCost),
            actualGasUsed: numberToHex(event.args.actualGasUsed),
            success: event.args.success,
            reason: "",
            logs: rawReceipt.logs,
            receipt: rawReceipt,
          };
        }
        case "eth_getUserOperationByHash": {
          const entry = byHash.get(String(list[0]).toLowerCase());
          return entry ? { entryPoint: entryPoint06Address, transactionHash: entry.bundleTx } : null;
        }
        default:
          return forkClient.request({ method: method as never, params: params as never });
      }
    },
  });

  const record = (kind: "stub" | "final") => async (request: Record<string, unknown>) => {
    paymasterRequests.push({ kind, userOperation: request });
    return { paymasterAndData: "0x" as Hex };
  };

  const smartClient = createSmartAccountClient({
    account,
    chain: base,
    client: forkClient,
    bundlerTransport,
    pollingInterval: 250,
    paymaster: { getPaymasterStubData: record("stub") as never, getPaymasterData: record("final") as never },
    userOperation: {
      // Privy's estimate for a bundler that is neither Pimlico, ZeroDev nor Alchemy, with the CDP multiplier.
      estimateFeesPerGas: async () => {
        const fees = await forkClient.estimateFeesPerGas();
        return { maxFeePerGas: (fees.maxFeePerGas * 175n) / 100n, maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 175n) / 100n };
      },
    },
  });

  const sender = createSmartSender(
    account.address,
    {
      // src/wallet/WalletProvider.tsx: `current.sendTransaction({ calls }, { uiOptions: { showWalletUIs: false } })`.
      sendBatch: (calls) => smartClient.sendTransaction({ calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value })) }),
      signMessage: (message) => account.signMessage({ message }),
      signTypedData: (payload) =>
        account.signTypedData({
          domain: payload.domain,
          types: payload.types,
          primaryType: payload.primaryType,
          message: payload.message,
        } as never),
    },
    { reader: forkClient as unknown as ChainReader, receiptTimeoutMs: 120_000 },
  );
  return { sender, account, owner, operations, paymasterRequests };
}

/** initCode factory of a v0.6 user operation, or null when the account already existed. */
export function initCodeFactory(op: UserOperation<"0.6">): Address | null {
  const initCode = op.initCode ?? "0x";
  return size(initCode) >= 20 ? (slice(initCode, 0, 20) as Address) : null;
}

