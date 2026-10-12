import { useQuery } from "@tanstack/react-query";
import type { CashClient, CashFillStats, CurrencyType } from "@zkp2p/cash";
import {
  estimateReceive,
  etaFromFillStats,
  fetchFillStats,
  fetchSellRate,
  getCashClient,
  type SellEta,
  type SellRate,
} from "./cash";
import { sellQueryKeys } from "./queryKeys";
import { spreadRate } from "./spreadRate";

const RATE_REFRESH_MS = 30_000;
const FILL_STATS_STALE_MS = 15 * 60_000;

export interface SellEstimateInput {
  /** USDC base units; the receive estimate is skipped while null or zero. */
  amount: bigint | null | undefined;
  currency: CurrencyType | null | undefined;
  platform?: string | null;
  /** All currencies of a multi-currency leg, for its combined fill stats. Defaults to `[currency]`. */
  currencies?: readonly CurrencyType[];
  /** The seller's spread on the oracle rate, basis points (default 0, the market rate). */
  spreadBps?: number;
  client?: CashClient;
}

export interface SellEstimate {
  /** Live oracle rate (the market rate); arrives first. */
  rate: SellRate | null;
  /** The seller's price: the oracle rate with the spread applied (equals `rate.rate` at 0%). */
  yourRate: number | null;
  /** `amount × yourRate` in fiat units, truncated to cents. Approximate: each buyer's signal binds the then-current rate. */
  receive: number | null;
  /** Historical fill speed; arrives second and fails open to null. */
  eta: SellEta | null;
  isLoadingRate: boolean;
  isLoadingEta: boolean;
  rateError: Error | null;
}

/**
 * Progressive estimate: the rate query renders first and refreshes every 30 s
 * so it tracks the market; the fill-stats query (cached 15 min by the SDK and
 * here) adds the ETA when it lands. Typing an amount never refetches.
 */
export function useSellEstimate(input: SellEstimateInput): SellEstimate {
  const client = input.client ?? getCashClient();
  const currency = input.currency ?? null;
  const platform = input.platform ?? null;
  const rateQuery = useQuery({
    queryKey: sellQueryKeys.rate(currency ?? "", platform),
    queryFn: () => fetchSellRate(client, { currency: currency!, platform }),
    enabled: Boolean(currency),
    staleTime: RATE_REFRESH_MS,
    refetchInterval: RATE_REFRESH_MS,
  });
  const stats = useFillStats({ enabled: Boolean(currency && platform), client });
  const rate = rateQuery.data ?? null;
  const yourRate = rate ? spreadRate(rate.rate, input.spreadBps ?? 0) : null;
  const receive = yourRate && input.amount ? estimateReceive(input.amount, yourRate) : null;
  const eta =
    stats.data && platform && currency ? etaFromFillStats(stats.data, platform, input.currencies ?? [currency]) : null;
  return {
    rate,
    yourRate,
    receive,
    eta,
    isLoadingRate: Boolean(currency) && rateQuery.isPending,
    isLoadingEta: Boolean(currency && platform) && stats.isPending,
    rateError: rateQuery.error,
  };
}

/** Raw 30-day fill evidence per corridor, e.g. to rank or gate payout methods. */
export function useFillStats(opts: { enabled?: boolean; client?: CashClient } = {}) {
  const client = opts.client ?? getCashClient();
  return useQuery<CashFillStats>({
    queryKey: sellQueryKeys.fillStats(),
    queryFn: () => fetchFillStats(client),
    enabled: opts.enabled !== false,
    staleTime: FILL_STATS_STALE_MS,
    retry: 1,
  });
}
