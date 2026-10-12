import { skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { USDC_ADDRESS } from "@/config";
import { BALANCE_REFETCH_MS } from "./constants";
import { publicClient } from "./publicClient";

/** Query keys for wallet reads. Invalidate `walletQueryKeys.all` after any transaction. */
export const walletQueryKeys = {
  all: ["wallet"] as const,
  usdcBalance: (address: Address) => ["wallet", "usdc-balance", address.toLowerCase()] as const,
  ethBalance: (address: Address) => ["wallet", "eth-balance", address.toLowerCase()] as const,
};

/** USDC balance on Base in base units (6 decimals). */
export function fetchUsdcBalance(address: Address): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

/** ETH balance on Base in wei. */
export function fetchEthBalance(address: Address): Promise<bigint> {
  return publicClient.getBalance({ address });
}

/** Live USDC balance (base units), refetched every 15 s. Disabled while `address` is empty. */
export function useUsdcBalance(address: Address | null | undefined): UseQueryResult<bigint, Error> {
  return useQuery({
    queryKey: address ? walletQueryKeys.usdcBalance(address) : ["wallet", "usdc-balance", null],
    queryFn: address ? () => fetchUsdcBalance(address) : skipToken,
    refetchInterval: BALANCE_REFETCH_MS,
    staleTime: BALANCE_REFETCH_MS,
  });
}

/** Live ETH balance (wei), refetched every 15 s. Disabled while `address` is empty. */
export function useEthBalance(address: Address | null | undefined): UseQueryResult<bigint, Error> {
  return useQuery({
    queryKey: address ? walletQueryKeys.ethBalance(address) : ["wallet", "eth-balance", null],
    queryFn: address ? () => fetchEthBalance(address) : skipToken,
    refetchInterval: BALANCE_REFETCH_MS,
    staleTime: BALANCE_REFETCH_MS,
  });
}
