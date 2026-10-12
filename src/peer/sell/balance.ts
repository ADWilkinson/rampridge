import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address, type PublicClient } from "viem";
import { USDC_ADDRESS } from "@/config";
import { sellQueryKeys } from "./queryKeys";

export type BalanceReader = Pick<PublicClient, "readContract">;
export type GasReader = Pick<PublicClient, "getBalance">;

/** Base USDC balance in base units. */
export function readUsdcBalance(client: BalanceReader, owner: Address): Promise<bigint> {
  return client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

/** Native ETH on Base, for wallets that pay their own gas. */
export function readGasBalance(client: GasReader, owner: Address): Promise<bigint> {
  return client.getBalance({ address: owner });
}

export interface BalanceQuery {
  /** Base units, or null while unknown. */
  value: bigint | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/** Live USDC balance (15 s refresh). Disabled until both a client and an owner exist. */
export function useUsdcBalance(
  client: BalanceReader | null | undefined,
  owner: Address | null | undefined,
  opts: { enabled?: boolean } = {},
): BalanceQuery {
  const enabled = Boolean(client && owner) && opts.enabled !== false;
  const query = useQuery({
    queryKey: sellQueryKeys.usdcBalance(owner ?? ""),
    queryFn: () => readUsdcBalance(client!, owner!),
    enabled,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  return {
    value: query.data ?? null,
    isLoading: enabled && query.isPending,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/** Native gas balance (30 s refresh), for non-sponsored wallets only. */
export function useGasBalance(
  client: GasReader | null | undefined,
  owner: Address | null | undefined,
  opts: { enabled?: boolean } = {},
): BalanceQuery {
  const enabled = Boolean(client && owner) && opts.enabled !== false;
  const query = useQuery({
    queryKey: sellQueryKeys.gasBalance(owner ?? ""),
    queryFn: () => readGasBalance(client!, owner!),
    enabled,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  return {
    value: query.data ?? null,
    isLoading: enabled && query.isPending,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
