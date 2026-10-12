/**
 * The anvil fork (latest Base block, no impersonation) and the read-only Base
 * mainnet proxy the parity suites read real Peer transactions from.
 *
 * Every fork transaction is signed by a key the test generated; accounts get
 * gas with anvil_setBalance. TxSenders are built with RampRidge's own sender
 * factory (src/wallet/senders.ts), so the app's real send path runs.
 */

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  hexToBigInt,
  http,
  isHex,
  parseEther,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { inject } from "vitest";
import { USDC_ADDRESS } from "@/config";
import type { Eip1193Like } from "@/wallet/provider";
import { createExternalSender, type ChainReader } from "@/wallet/senders";
import type { TxSender } from "@/wallet/types";

export const FORK_RPC_URL = process.env.PARITY_FORK_RPC_URL ?? "http://127.0.0.1:8558";
export const MAINNET_RPC_URL = process.env.PARITY_MAINNET_RPC_URL ?? "http://127.0.0.1:8559";

const forkTransport = http(FORK_RPC_URL, { retryCount: 0, timeout: 120_000 });

/** Reads and receipts on the fork (no multicall batching, so revert data stays per call). */
export const forkClient = createPublicClient({ chain: base, transport: forkTransport }) as unknown as PublicClient;
export const testClient = createTestClient({ chain: base, mode: "anvil", transport: forkTransport });

/** Base mainnet, read-only (the proxy refuses send and sign methods). */
export const mainnetClient = createPublicClient({
  chain: base,
  transport: http(MAINNET_RPC_URL, { retryCount: 2, timeout: 120_000, batch: { batchSize: 25 } }),
}) as unknown as PublicClient;

const FORK_MARKER: Address = "0x00000000000000000000000000000000ba11ad01";

/**
 * Throws unless the fork is still the one this run's global setup started and
 * marked: another local test run reusing the port (and reverting snapshots on
 * it) would otherwise corrupt state silently.
 */
export async function assertOwnFork(): Promise<void> {
  const expected = inject("parityForkMarker");
  const actual = await forkClient.getBalance({ address: FORK_MARKER });
  if (!expected || actual !== BigInt(expected)) {
    throw new Error(`The fork at ${FORK_RPC_URL} is not this run's (marker mismatch): another process is using the port.`);
  }
}

export async function setEthBalance(address: Address, ether = "1"): Promise<void> {
  await testClient.setBalance({ address, value: parseEther(ether) });
}

export function usdcBalance(owner: Address): Promise<bigint> {
  return forkClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function snapshot(): Promise<Hex> {
  return testClient.snapshot();
}

export async function revert(id: Hex): Promise<void> {
  await testClient.revert({ id });
}

export async function blockTimestamp(blockNumber?: bigint): Promise<bigint> {
  const block = blockNumber === undefined ? await forkClient.getBlock() : await forkClient.getBlock({ blockNumber });
  return block.timestamp;
}

/** A funded fork account whose key the test holds. */
export interface ForkAccount {
  account: LocalAccount;
  address: Address;
  /** Sends a transaction on the fork, signed locally (never impersonated). */
  send(tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint }): Promise<Hash>;
}

export async function fundedAccount(ether = "1"): Promise<ForkAccount> {
  const account = privateKeyToAccount(generatePrivateKey());
  await setEthBalance(account.address, ether);
  const wallet = createWalletClient({ account, chain: base, transport: forkTransport });
  return {
    account,
    address: account.address,
    send: (tx) => wallet.sendTransaction({ ...tx, account, chain: base }),
  };
}

function bigintParam(value: unknown): bigint | undefined {
  return typeof value === "string" && isHex(value) ? hexToBigInt(value) : undefined;
}

/**
 * An injected-wallet stand-in on the fork: the EIP-1193 surface an external
 * wallet gives RampRidge, signing with the account's own key. Reads pass
 * through to the fork.
 */
export function localKeyProvider(fork: ForkAccount): Eip1193Like {
  return {
    async request({ method, params }) {
      const list = Array.isArray(params) ? params : [];
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [fork.address];
        case "eth_chainId":
          return `0x${base.id.toString(16)}`;
        case "eth_sendTransaction": {
          const tx = (list[0] ?? {}) as Record<string, unknown>;
          if (typeof tx.from === "string" && tx.from.toLowerCase() !== fork.address.toLowerCase()) {
            throw Object.assign(new Error("from is not this wallet"), { code: 4100 });
          }
          return fork.send({
            to: tx.to as Address,
            data: (tx.data ?? tx.input ?? "0x") as Hex,
            value: bigintParam(tx.value) ?? 0n,
            ...(bigintParam(tx.gas) !== undefined ? { gas: bigintParam(tx.gas) } : {}),
          });
        }
        case "personal_sign":
          return fork.account.signMessage({ message: { raw: list[0] as Hex } });
        case "eth_signTypedData_v4": {
          const typed = typeof list[1] === "string" ? JSON.parse(list[1]) : list[1];
          const { EIP712Domain: _domain, ...types } = typed.types ?? {};
          return fork.account.signTypedData({ ...typed, types });
        }
        default:
          return forkClient.request({ method: method as never, params: params as never });
      }
    },
  };
}

/** RampRidge's external-wallet TxSender (createExternalSender) backed by a fork key. */
export function eoaSender(fork: ForkAccount): TxSender {
  const provider = localKeyProvider(fork);
  return createExternalSender(
    fork.address,
    { getProvider: async () => provider, switchToBase: async () => undefined },
    { reader: forkClient as unknown as ChainReader, receiptTimeoutMs: 120_000 },
  );
}
