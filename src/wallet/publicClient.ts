import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { BASE_RPC_URL } from "@/config";
import { FALLBACK_BASE_RPC_URL, PUBLIC_LOGS_BASE_RPC_URL, WALLET_CHAIN } from "./constants";

function uniqueUrls(urls: readonly (string | null)[]): string[] {
  return [...new Set(urls.map((url) => url?.trim() ?? "").filter(Boolean))];
}

const rpcUrls = uniqueUrls([BASE_RPC_URL, FALLBACK_BASE_RPC_URL, PUBLIC_LOGS_BASE_RPC_URL]);

/**
 * Shared read client for Base. Reads in the same tick are folded into one
 * Multicall3 call; the public Base RPC, then PublicNode, back up the
 * configured one, so a launch-day rate limit on one public RPC is not an outage.
 *
 * Typed as the generic `PublicClient` that `WalletState` and the Peer SDKs
 * take: viem's OP-stack block formatters make the Base-specific client type
 * unassignable to it even though the object is the same.
 */
export const publicClient: PublicClient = createPublicClient({
  chain: WALLET_CHAIN,
  batch: { multicall: true },
  transport: fallback(rpcUrls.map((url) => http(url))),
}) as unknown as PublicClient;

/**
 * Event-log reads (eth_getLogs) on Base, for settling a send whose outcome was
 * lost. Base's public RPC refuses eth_getLogs ("request limit reached"), so
 * the configured RPC comes first unless it is that one, then a public RPC
 * that serves logs, then Base's own as a last resort.
 */
export const historyClient: PublicClient = createPublicClient({
  chain: WALLET_CHAIN,
  transport: fallback(
    uniqueUrls([BASE_RPC_URL === FALLBACK_BASE_RPC_URL ? null : BASE_RPC_URL, PUBLIC_LOGS_BASE_RPC_URL, FALLBACK_BASE_RPC_URL]).map((url) => http(url)),
  ),
}) as unknown as PublicClient;
