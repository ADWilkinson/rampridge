/**
 * Peer's single-order rule (packages/core depositConfig.singleOrderDeposit):
 * an Alipay deposit fills in one order, so it has a minimum, its intent range
 * is the whole deposit (less a 1 USDC gap) and the seller sees Peer's risk
 * control warning. Peer Cash's `prepare()` takes the range as
 * `intentAmountRange`; every other platform keeps Peer Cash's default range.
 */

import { errors } from "@zkp2p/cash";

/** A new single-order deposit's minimum order sits this far below its maximum (the whole deposit). */
export const SINGLE_ORDER_MIN_GAP = 1_000_000n;

export interface SingleOrderPolicy {
  minAmount: bigint;
  warning: string;
}

const SINGLE_ORDER_POLICIES: Record<string, SingleOrderPolicy> = {
  alipay: {
    minAmount: 10_000_000n,
    warning:
      "Alipay risk control (风控) can block your account if several buyers pay you in one day. Each Alipay deposit fills in one order, so create no more than 3 a day.",
  },
};

export function singleOrderPolicy(platform: string): SingleOrderPolicy | null {
  return Object.hasOwn(SINGLE_ORDER_POLICIES, platform) ? (SINGLE_ORDER_POLICIES[platform] ?? null) : null;
}

/** The binding rule across an order's platforms (the highest minimum), or null when none applies. */
export function singleOrderRule(platforms: readonly string[]): (SingleOrderPolicy & { platform: string }) | null {
  let rule: (SingleOrderPolicy & { platform: string }) | null = null;
  for (const platform of platforms) {
    const policy = singleOrderPolicy(platform);
    if (policy && (!rule || policy.minAmount > rule.minAmount)) rule = { platform, ...policy };
  }
  return rule;
}

/** Peer's calculateSingleOrderLimits: max is the whole deposit, min is 1 USDC below it; null below the minimum. */
export function singleOrderRange(amount: bigint, rule: SingleOrderPolicy): { min: bigint; max: bigint } | null {
  if (amount < rule.minAmount) return null;
  return { min: amount - SINGLE_ORDER_MIN_GAP, max: amount };
}

/** The intent range an order needs, or undefined for Peer Cash's default (1 USDC to the whole amount). */
export function intentAmountRangeFor(amount: bigint, platforms: readonly string[]): { min: bigint; max: bigint } | undefined {
  const rule = singleOrderRule(platforms);
  if (!rule) return undefined;
  const range = singleOrderRange(amount, rule);
  if (!range) throw errors.amountBelowMinimum(amount, rule.minAmount);
  return range;
}
