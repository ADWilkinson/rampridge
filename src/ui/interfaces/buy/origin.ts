import type { StoreApi } from "zustand/vanilla";
import type { BuyFlowStore, BuyStep } from "@/peer/buy";

/**
 * The step the buy flow was in when its current error arrived. The store
 * keeps where back() returns to but not where the error came from, and a
 * release that fails after its payment list timed out returns to
 * "awaitingPayment" just as a failed cancel does. Watching transitions tells
 * the two apart, so a player who has paid is never shown the payment
 * instructions again.
 */
const origins = new WeakMap<StoreApi<BuyFlowStore>, { from: BuyStep | null }>();

/** Starts watching `store` (idempotent). The world hook and every buy interface call it. */
export function watchErrorOrigin(store: StoreApi<BuyFlowStore>): void {
  if (origins.has(store)) return;
  const record: { from: BuyStep | null } = { from: null };
  origins.set(store, record);
  store.subscribe((state, prev) => {
    if (state.step !== "error") record.from = null;
    else if (prev.step !== "error") record.from = prev.step;
  });
}

/** Where the current error came from, or null when unknown (not watched yet, or no error). */
export function errorOrigin(store: StoreApi<BuyFlowStore>): BuyStep | null {
  return origins.get(store)?.from ?? null;
}
