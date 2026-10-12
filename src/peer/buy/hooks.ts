import { useCallback, useEffect } from "react";
import type { Address } from "viem";
import { useStore } from "zustand";
import type { TxSender } from "@/wallet/types";
import { createBuyStore } from "./store";
import type { BuyFlowStore, BuyOrder } from "./types";

/**
 * The app's single buy flow. It lives outside React so an extension capture
 * or a pending transaction survives the bank window closing and reopening.
 */
export const buyStore = createBuyStore();

/**
 * Binds the logged-in wallet to the buy flow and recovers its open order.
 * Mount once near the app root (on login) so recovery runs even before the
 * bank opens; `useBuyFlow` also binds, so either is enough.
 */
export function useBindBuySender(sender: TxSender | null): void {
  useEffect(() => {
    buyStore.getState().bindSender(sender);
  }, [sender]);
}

/** Buy flow state and actions for the bank UI, bound to `sender`. */
export function useBuyFlow(sender: TxSender | null): BuyFlowStore {
  useBindBuySender(sender);
  return useStore(buyStore);
}

export interface ActiveBuyOrder {
  /** The open (or just finished) order for `address`, null if none. */
  order: BuyOrder | null;
  /** A chain check for the order is running. */
  loading: boolean;
  /** Re-reads the chain for the order. */
  refresh: () => Promise<void>;
}

/**
 * The open buy order for an address (for example to draw an Exchange slot).
 * Watches the address read-only when no wallet is bound yet; a bound sender
 * always takes precedence.
 */
export function useActiveBuyOrder(address: Address | null | undefined): ActiveBuyOrder {
  const key = address ? address.toLowerCase() : null;
  useEffect(() => {
    buyStore.getState().watchOwner((key as Address | null) ?? null);
  }, [key]);
  const order = useStore(buyStore, (s) => (key && s.owner === key ? s.order : null));
  const loading = useStore(buyStore, (s) => Boolean(key && s.owner === key && s.recovering));
  const refresh = useCallback(() => buyStore.getState().recover(), []);
  return { order, loading, refresh };
}
