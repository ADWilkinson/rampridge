/**
 * Peer SDK client for production Base. One client per wallet address: the
 * SDK reads `walletClient.account.address` as the `/v3/sign` caller, so the
 * signature Curator returns is bound to that address and the same address
 * must send the transaction. This app always sends through `TxSender`, never
 * through the SDK's wallet client.
 */

import { Zkp2pClient, getContracts, type ApiAdapterOptions } from "@zkp2p/sdk";
import { createWalletClient, http, type Abi, type Address } from "viem";
import { base } from "viem/chains";
import { BASE_RPC_URL, CHAIN_ID, PEER_API_URL } from "@/config";
import type { TxSender } from "@/wallet/types";

export const PEER_RUNTIME_ENV = "production" as const;

/** Curator API timeout for quotes, signing and maker reads. */
export const PEER_API_TIMEOUT_MS = 15_000;

/**
 * Stand-in account for logged-out reads and quotes. It never signs: reads go
 * through the public client and quotes only need a syntactically valid
 * address for `user` and `recipient`.
 */
export const READ_ONLY_ACCOUNT: Address = "0x0000000000000000000000000000000000000001";

/** Options for the SDK's standalone `api*` adapters. */
export const PEER_API_OPTIONS: ApiAdapterOptions = {
  baseApiUrl: PEER_API_URL,
  timeoutMs: PEER_API_TIMEOUT_MS,
  runtimeEnv: PEER_RUNTIME_ENV,
};

const contracts = getContracts(CHAIN_ID, PEER_RUNTIME_ENV);

function requireAbi(abi: Abi | undefined, name: string): Abi {
  if (!abi) throw new Error(`Peer SDK has no ${name} ABI for Base production`);
  return abi;
}

/** ABIs the buy flow decodes receipts and reverts with. */
export const PEER_ABIS = {
  orchestrator: requireAbi(contracts.abis.orchestratorV3, "OrchestratorV3"),
  escrow: requireAbi(contracts.abis.escrowV2 ?? contracts.abis.escrow, "EscrowV2"),
} as const;

const clients = new Map<string, Zkp2pClient>();

function build(account: Address, sender: TxSender | null): Zkp2pClient {
  const walletClient =
    sender?.walletClient ??
    createWalletClient({ account, chain: base, transport: http(BASE_RPC_URL, { batch: false }) });
  return new Zkp2pClient({
    walletClient,
    chainId: CHAIN_ID,
    runtimeEnv: PEER_RUNTIME_ENV,
    baseApiUrl: PEER_API_URL,
    rpcUrl: BASE_RPC_URL,
    timeouts: { api: PEER_API_TIMEOUT_MS },
  });
}

/**
 * The production Peer client for a sender (memoised per sender address), or
 * a read-only client when there is no sender.
 */
export function createPeerClient({ sender }: { sender?: TxSender | null } = {}): Zkp2pClient {
  const account = sender?.address ?? READ_ONLY_ACCOUNT;
  if (sender && sender.walletClient.account?.address.toLowerCase() !== account.toLowerCase()) {
    throw new Error("TxSender.walletClient account does not match TxSender.address");
  }
  const key = sender ? account.toLowerCase() : "read-only";
  let client = clients.get(key);
  if (!client) {
    client = build(account, sender ?? null);
    clients.set(key, client);
  }
  return client;
}

export function getReadOnlyPeerClient(): Zkp2pClient {
  return createPeerClient();
}

/** Drops memoised clients (e.g. on logout). */
export function clearPeerClients(): void {
  clients.clear();
}
