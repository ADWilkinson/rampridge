import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { CashClient } from "@zkp2p/cash";
import { buyStore, type BuyFlowStore } from "@/peer/buy";
import { getBestPricesByPlatform, getBuyQuotes, getDepositQuote } from "@/peer/market";
import { getCashClient } from "@/peer/sell";
import { useGame } from "../context";
import { isVerificationError, verifyNeedsComputer } from "./model";
import { errorOrigin, watchErrorOrigin } from "./origin";

/**
 * Everything the buy interfaces read from the network, injectable so the dev
 * harness can drive the real flow with fakes. Production uses the app's
 * global buy store and the live Peer market.
 */
export interface BuyUiDeps {
  store: StoreApi<BuyFlowStore>;
  getBuyQuotes: typeof getBuyQuotes;
  getBestPricesByPlatform: typeof getBestPricesByPlatform;
  getDepositQuote: typeof getDepositQuote;
  /** Peer Cash client for the player's sell orders. */
  cashClient: () => CashClient;
  /** Clock for expiry checks. */
  now: () => number;
  /** True when this browser can't prove a payment (no Peer extension, and it can't be installed here). */
  verifyNeedsComputer: () => boolean;
}

const LIVE: BuyUiDeps = {
  store: buyStore,
  getBuyQuotes,
  getBestPricesByPlatform,
  getDepositQuote,
  cashClient: getCashClient,
  now: Date.now,
  verifyNeedsComputer: () => verifyNeedsComputer(),
};

const DepsContext = createContext<BuyUiDeps>(LIVE);

/** Dev and test wiring only; the shell never needs it. */
export function BuyUiDepsProvider({ value, children }: { value: Partial<BuyUiDeps>; children: ReactNode }) {
  const merged = useMemo(() => ({ ...LIVE, ...value }), [value]);
  return <DepsContext.Provider value={merged}>{children}</DepsContext.Provider>;
}

export function useBuyDeps(): BuyUiDeps {
  return useContext(DepsContext);
}

/**
 * The buy flow bound to the game's wallet: binds `sender` (idempotent per
 * address, recovers the open order) and returns state plus actions.
 */
export function useBuy(): BuyFlowStore {
  const { store } = useBuyDeps();
  const { sender } = useGame();
  useEffect(() => watchErrorOrigin(store), [store]);
  useEffect(() => {
    store.getState().bindSender(sender);
  }, [store, sender]);
  return useStore(store);
}

/**
 * True when this browser can't prove a payment, so the buyer must be told,
 * before placing an order or paying, that verifying needs a computer.
 * Re-read on every render: the extension can appear after the page loads.
 */
export function useNeedsComputer(): boolean {
  return useBuyDeps().verifyNeedsComputer();
}

/** True when the buy flow is in an error raised while proving the player's payment (they have said they paid). */
export function useVerificationError(buy: Pick<BuyFlowStore, "step" | "error" | "errorReturnStep">): boolean {
  const { store } = useBuyDeps();
  return isVerificationError(buy, errorOrigin(store));
}
