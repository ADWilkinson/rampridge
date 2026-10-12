import { create } from "zustand";

/**
 * The shell's latest view of the market (GET /api/market), written by
 * useMerchants and read by GameProvider for useGame().liquidCurrencies.
 */
export const useMarketStore = create<{ liquidCurrencies: ReadonlySet<string> | null }>(() => ({ liquidCurrencies: null }));
