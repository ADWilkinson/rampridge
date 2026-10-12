/**
 * A Privy-style Coinbase Smart Wallet TxSender on the golden fork, built from
 * the app's own `createSmartSender` (src/wallet/senders.ts): every
 * `sendCalls` becomes ONE ERC-4337 v0.6 user operation, signed exactly as
 * viem's `toCoinbaseSmartAccount` (Privy's implementation) signs it, and is
 * submitted through `EntryPoint.handleOps` by an impersonated bundler. The
 * only difference from production is gas: the account prefunds the
 * EntryPoint instead of the CDP paymaster sponsoring it.
 */

import { concat, encodeFunctionData, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint06Abi, entryPoint06Address, toCoinbaseSmartAccount } from "viem/account-abstraction";
import { createSmartSender, type ChainReader } from "@/wallet/senders";
import type { NormalizedCall } from "@/wallet/sequence";
import type { TxSender } from "@/wallet/types";
import type { Rpc } from "./decode";

const BUNDLER: Address = "0x00000000000000000000000000000000000b0d1e";

export interface SmartSenderDouble {
  sender: TxSender;
  /** Calls each user operation carried, in order. */
  batches: NormalizedCall[][];
  bundleTxs: Hash[];
}

export async function coinbaseSmartSender(client: PublicClient, fork: Rpc): Promise<SmartSenderDouble> {
  const owner = privateKeyToAccount(generatePrivateKey());
  const account = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1" });
  const batches: NormalizedCall[][] = [];
  const bundleTxs: Hash[] = [];

  const sendBatch = async (calls: NormalizedCall[]): Promise<Hash> => {
    const deployed = await account.isDeployed();
    const callData = await account.encodeCalls(calls.map((c) => ({ to: c.to, data: c.data, value: c.value })));
    const initCode: Hex = deployed
      ? "0x"
      : await account.getFactoryArgs().then(({ factory, factoryData }) => concat([factory as Address, factoryData as Hex]));
    const block = await client.getBlock({ blockTag: "latest" });
    const maxPriorityFeePerGas = 1_000_000n;
    const maxFeePerGas = (block.baseFeePerGas ?? 1_000_000n) * 2n + maxPriorityFeePerGas;
    const unsigned = {
      sender: account.address,
      nonce: await account.getNonce(),
      initCode,
      callData,
      callGasLimit: 3_000_000n,
      verificationGasLimit: deployed ? 600_000n : 1_500_000n,
      preVerificationGas: 120_000n,
      maxFeePerGas,
      maxPriorityFeePerGas,
      paymasterAndData: "0x" as Hex,
      signature: "0x" as Hex,
    };
    const userOperation = { ...unsigned, signature: await account.signUserOperation(unsigned as never) };
    await fork("anvil_setBalance", [account.address, "0xde0b6b3a7640000"]);
    await fork("anvil_setBalance", [BUNDLER, "0x8ac7230489e80000"]);
    const hash = await fork<Hash>("eth_sendTransaction", [
      {
        from: BUNDLER,
        to: entryPoint06Address,
        data: encodeFunctionData({ abi: entryPoint06Abi, functionName: "handleOps", args: [[userOperation], BUNDLER] }),
        gas: "0x989680",
      },
    ]);
    batches.push(calls);
    bundleTxs.push(hash);
    return hash;
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
    { reader: client as unknown as ChainReader, receiptTimeoutMs: 120_000 },
  );
  return { sender, batches, bundleTxs };
}
