import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { create } from "zustand";
// Types only: the buy module itself (and the Peer SDK under it) loads on demand, below.
import type { ActiveBuyOrder, BuyFlowStore } from "@/peer/buy";
import type { TxSender } from "@/wallet/types";
import { noteChunkFailure } from "./update";

/**
 * The shell's view of the buy flow, kept out of the first download. The buy
 * module (`@/peer/buy`) holds the one buy store, and under it the Peer SDK,
 * hundreds of kilobytes the title and the world don't need. It loads the
 * first time the shell has a wallet to bind or an order to watch (after a
 * login, or for a returning player once their wallet is back), or when a
 * trading interface loads it. Until then the shell reads "no order", which is
 * what the store itself reads before its first recovery.
 *
 * The interfaces import `@/peer/buy` directly: it is one module, so they and
 * the shell always share the same store.
 */

export type BuyModule = typeof import("@/peer/buy");

export const useBuyModule = create<{ mod: BuyModule | null }>(() => ({ mod: null }));

let loading: Promise<BuyModule> | null = null;

/** Loads the buy module (once). A failed download is retried on the next call. */
export function loadBuyFlow(): Promise<BuyModule> {
  const ready = useBuyModule.getState().mod;
  if (ready) return Promise.resolve(ready);
  loading ??= import("@/peer/buy").then(
    (mod) => {
      useBuyModule.setState({ mod });
      return mod;
    },
    (err: unknown) => {
      loading = null;
      console.warn("[buy] the buy flow did not load", err);
      void noteChunkFailure();
      throw err;
    },
  );
  return loading;
}

const loadQuietly = () => void loadBuyFlow().catch(() => undefined);

/** The buy store's state, or null while the buy module hasn't loaded. */
export function getBuyFlow(): BuyFlowStore | null {
  return useBuyModule.getState().mod?.buyStore.getState() ?? null;
}

/** Subscribes to buy store changes, now or as soon as the buy module loads. */
export function subscribeBuyFlow(listener: (state: BuyFlowStore, prev: BuyFlowStore) => void): () => void {
  let stopped = false;
  let off: (() => void) | null = null;
  const attach = (mod: BuyModule | null) => {
    if (!mod || stopped || off) return;
    off = mod.buyStore.subscribe(listener);
  };
  attach(useBuyModule.getState().mod);
  const offModule = off ? null : useBuyModule.subscribe((s) => attach(s.mod));
  return () => {
    stopped = true;
    off?.();
    offModule?.();
  };
}

const noop = () => undefined;

/** A value from the buy store, or `fallback` while the buy module hasn't loaded. `select` must return stable values. */
export function useBuyFlowState<T>(select: (state: BuyFlowStore) => T, fallback: T): T {
  const mod = useBuyModule((s) => s.mod);
  const subscribe = useCallback((onChange: () => void) => (mod ? mod.buyStore.subscribe(onChange) : noop), [mod]);
  const read = () => (mod ? select(mod.buyStore.getState()) : fallback);
  return useSyncExternalStore(subscribe, read, read);
}

/** `useBindBuySender` from the buy module: binds the wallet to the buy flow, loading the module when there is one. */
export function useBindBuySender(sender: TxSender | null): void {
  const mod = useBuyModule((s) => s.mod);
  useEffect(() => {
    if (mod) mod.buyStore.getState().bindSender(sender);
    else if (sender) loadQuietly();
  }, [mod, sender]);
}

/** `useActiveBuyOrder` from the buy module, reading no order until it has loaded (an address loads it). */
export function useActiveBuyOrder(address: Address | null | undefined): ActiveBuyOrder {
  const key = address ? address.toLowerCase() : null;
  const mod = useBuyModule((s) => s.mod);
  useEffect(() => {
    if (mod) mod.buyStore.getState().watchOwner((key as Address | null) ?? null);
    else if (key) loadQuietly();
  }, [mod, key]);
  const order = useBuyFlowState((s) => (key && s.owner === key ? s.order : null), null);
  const loading = useBuyFlowState((s) => Boolean(key && s.owner === key && s.recovering), false);
  const refresh = useCallback(() => getBuyFlow()?.recover() ?? Promise.resolve(), []);
  return { order, loading, refresh };
}
