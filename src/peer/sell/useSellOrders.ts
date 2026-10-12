import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isCashError, type CashBuyerProfile, type CashClient } from "@zkp2p/cash";
import type { TxSender } from "@/wallet/types";
import type { BalanceReader } from "./balance";
import { getCashClient } from "./cash";
import { sellError, toSellFlowError, type SellFlowError } from "./errors";
import {
  fetchSellOrders,
  topUpSellOrder,
  watchSellOrder,
  withdrawSellOrder,
  type SellOrderRow,
  type SellOrderTxResult,
} from "./orders";
import { readLastSellDeposit, type LastSellDeposit } from "./persistence";
import { sellQueryKeys } from "./queryKeys";

const ORDERS_REFETCH_MS = 20_000;

/**
 * The wallet's sell orders (live first), refreshed every 20 s. Each row
 * carries `explanation` (the SDK's one honest sentence) and what can be done
 * with it now. Needs a QueryClientProvider ancestor.
 */
export function useMyCashOrders(owner: string | null | undefined, opts: { client?: CashClient } = {}) {
  const client = opts.client ?? getCashClient();
  const query = useQuery<SellOrderRow[], SellFlowError>({
    queryKey: sellQueryKeys.orders(owner ?? ""),
    queryFn: () => fetchSellOrders(client, owner!),
    enabled: Boolean(owner),
    refetchInterval: ORDERS_REFETCH_MS,
    staleTime: 10_000,
    retry: (count, error) => count < 3 && error.retryable,
  });
  const orders = query.data ?? [];
  return {
    orders,
    /** Orders still waiting for or being paid by a buyer. */
    liveOrders: orders.filter((o) => o.isInFlight),
    isLoading: Boolean(owner) && query.isPending,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/**
 * Live view of one order (typically the one just created), driven by the
 * SDK's watch loop. Absorbs indexer lag right after creation; stops once the
 * order is delivered or returned.
 */
export function useWatchedSellOrder(depositId: string | null | undefined, opts: { client?: CashClient } = {}) {
  const client = opts.client ?? getCashClient();
  const [order, setOrder] = useState<SellOrderRow | null>(null);
  const [error, setError] = useState<SellFlowError | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setOrder(null);
    setError(null);
    if (!depositId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const row of watchSellOrder(client, depositId, { signal: controller.signal })) {
          if (controller.signal.aborted) return;
          setOrder(row);
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(toSellFlowError(err, { stage: "read", depositId }));
      }
    })();
    return () => controller.abort();
  }, [client, depositId, generation]);

  return {
    order,
    error,
    /** Restarts the watch after an error. */
    restart: useCallback(() => setGeneration((g) => g + 1), []),
  };
}

export type SellOrderAction =
  | { kind: "withdraw"; depositId: string; amount?: bigint }
  | { kind: "topUp"; depositId: string; amount: bigint };

/**
 * Withdraw-All, Withdraw-X and Top-up for the bank's right-click menu. Each
 * resolves with the result or null on failure (see `error`); orders and the
 * USDC balance refresh after every confirmed transaction.
 */
export function useSellOrderActions(opts: {
  sender: TxSender | null;
  publicClient?: BalanceReader | null;
  client?: CashClient;
}) {
  const client = opts.client ?? getCashClient();
  const queryClient = useQueryClient();
  const { sender, publicClient = null } = opts;
  const mutation = useMutation<SellOrderTxResult, SellFlowError, SellOrderAction>({
    mutationFn: async (action) => {
      if (!sender) throw sellError("WALLET_REQUIRED");
      const deps = { client, sender, publicClient };
      try {
        return action.kind === "withdraw"
          ? await withdrawSellOrder(deps, action.depositId, action.amount)
          : await topUpSellOrder(deps, action.depositId, action.amount);
      } catch (err) {
        throw toSellFlowError(err, { stage: action.kind, depositId: action.depositId });
      }
    },
    onSettled: (_data, _error, action) => {
      if (!sender) return;
      void queryClient.invalidateQueries({ queryKey: sellQueryKeys.orders(sender.address) });
      void queryClient.invalidateQueries({ queryKey: sellQueryKeys.order(action.depositId) });
      void queryClient.invalidateQueries({ queryKey: sellQueryKeys.usdcBalance(sender.address) });
    },
  });
  const run = useCallback(
    async (action: SellOrderAction) => {
      try {
        return await mutation.mutateAsync(action);
      } catch {
        return null;
      }
    },
    [mutation],
  );
  return {
    /** Full close without `amount`; partial withdrawal of unlocked funds with it. */
    withdraw: (depositId: string, amount?: bigint) =>
      run(amount === undefined ? { kind: "withdraw", depositId } : { kind: "withdraw", depositId, amount }),
    topUp: (depositId: string, amount: bigint) => run({ kind: "topUp", depositId, amount }),
    /** The action in flight, if any. */
    pending: mutation.isPending ? (mutation.variables ?? null) : null,
    error: mutation.error,
    lastResult: mutation.data ?? null,
    reset: mutation.reset,
  };
}

/** A buyer's protocol track record, for "examine" during a match. */
export function useBuyerProfile(address: string | null | undefined, opts: { client?: CashClient } = {}) {
  const client = opts.client ?? getCashClient();
  return useQuery<CashBuyerProfile, SellFlowError>({
    queryKey: sellQueryKeys.buyer(address ?? ""),
    queryFn: async () => {
      try {
        return await client.buyer(address!);
      } catch (err) {
        throw toSellFlowError(err, { stage: "read" });
      }
    },
    enabled: Boolean(address),
    staleTime: 60_000,
    retry: (count, error) => count < 2 && (error.retryable || (isCashError(error.cause) && error.cause.retryable)),
  });
}

/** The last deposit this wallet created here (persisted), for resuming its live view after a reload. */
export function useLastSellDeposit(owner: string | null | undefined): LastSellDeposit | null {
  const [value, setValue] = useState<LastSellDeposit | null>(() => (owner ? readLastSellDeposit(owner) : null));
  useEffect(() => {
    setValue(owner ? readLastSellDeposit(owner) : null);
  }, [owner]);
  return value;
}
