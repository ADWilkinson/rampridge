/**
 * The player's wallet for the fork e2e: RampRidge's real external-wallet
 * TxSender (src/wallet/senders.ts createExternalSender: gas check, Base
 * chain check, sequential sends, receipt waiting and error mapping) over an
 * EIP-1193 provider that forwards to the local anvil fork.
 *
 * Nothing is ever signed: anvil runs with --auto-impersonate, so
 * eth_sendTransaction from the buyer address is accepted unsigned. No
 * transaction produced here is valid on Base mainnet.
 */

import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { createExternalSender } from "@/wallet/senders";
import type { Eip1193Like } from "@/wallet/provider";
import type { TxSender } from "@/wallet/types";

export interface ForkSenderLog {
  sent: Array<{ to: string; data: string; hash: string }>;
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

export function createForkSender(address: Address, forkRpcUrl: string): { sender: TxSender; log: ForkSenderLog } {
  const log: ForkSenderLog = { sent: [] };
  let id = 0;
  const rpc = async (method: string, params: unknown): Promise<unknown> => {
    const response = await fetch(forkRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    if (body.error) throw Object.assign(rpcError(body.error.code, body.error.message), { data: body.error.data });
    return body.result;
  };

  const provider: Eip1193Like = {
    async request({ method, params }) {
      switch (method) {
        case "eth_chainId":
          return "0x2105";
        case "eth_accounts":
        case "eth_requestAccounts":
          return [address];
        case "eth_sendTransaction": {
          const [tx] = (params as Array<{ from?: string; to?: string; data?: string }>) ?? [];
          if (!tx || tx.from?.toLowerCase() !== address.toLowerCase()) throw rpcError(4100, "Unknown sender");
          const hash = (await rpc("eth_sendTransaction", [tx])) as string;
          log.sent.push({ to: tx.to ?? "", data: tx.data ?? "0x", hash });
          return hash;
        }
        case "personal_sign":
        case "eth_sign":
        case "eth_signTypedData_v4":
          throw rpcError(4200, "The fork e2e wallet does not sign");
        default:
          return rpc(method, params);
      }
    },
  };

  const reader = createPublicClient({ chain: base, transport: http(forkRpcUrl, { retryCount: 0 }) });
  const sender = createExternalSender(
    address,
    { getProvider: async () => provider, switchToBase: async () => undefined },
    { reader: reader as never, receiptTimeoutMs: 120_000 },
  );
  return { sender, log };
}
