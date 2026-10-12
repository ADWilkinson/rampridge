/**
 * The anvil Base fork: clients, account funding and state snapshots.
 */

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  http,
  parseEther,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { USDC_ADDRESS } from "@/config";

export const FORK_RPC_URL = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8547";

const transport = http(FORK_RPC_URL, { retryCount: 0, timeout: 60_000 });

/** Reads against the fork (no multicall batching, so revert data stays per call). */
export const forkClient: PublicClient = createPublicClient({ chain: base, transport }) as unknown as PublicClient;

export const testClient = createTestClient({ chain: base, mode: "anvil", transport });

/** Sends as any address: anvil runs with --auto-impersonate. */
export function impersonatedWallet(address: Address) {
  return createWalletClient({ account: address, chain: base, transport });
}

/** Raw JSON-RPC against the fork. */
export function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  return forkClient.request({ method: method as never, params: params as never }) as Promise<T>;
}

/**
 * Accounts holding Base USDC at recent blocks, EOAs first. The first one with
 * enough balance at the fork block funds the test wallets.
 */
const USDC_WHALES: readonly Address[] = [
  "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A",
  "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A",
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
];

export function usdcBalance(owner: Address): Promise<bigint> {
  return forkClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function setEthBalance(address: Address, ether = "10"): Promise<void> {
  await testClient.setBalance({ address, value: parseEther(ether) });
}

export async function mined(hash: Hash) {
  const receipt = await forkClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`Fork transaction ${hash} reverted`);
  return receipt;
}

/** Moves `amount` USDC to `to` from a whale, impersonated. */
export async function fundUsdc(to: Address, amount: bigint): Promise<void> {
  for (const whale of USDC_WHALES) {
    if ((await usdcBalance(whale)) < amount) continue;
    await setEthBalance(whale, "1");
    const hash = await impersonatedWallet(whale).writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amount],
    });
    await mined(hash);
    return;
  }
  throw new Error("No USDC whale on the fork holds enough USDC");
}

export async function snapshot(): Promise<Hex> {
  return testClient.snapshot();
}

export async function revert(id: Hex): Promise<void> {
  await testClient.revert({ id });
}

/** A fresh random address (no key): anvil impersonates it. */
export function randomAddress(): Address {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Address;
}
