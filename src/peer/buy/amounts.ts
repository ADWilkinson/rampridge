/**
 * Order amount math. The seller's attestation checks the buyer paid at least
 * intent amount x rate, so the amount shown is always rounded up: overpaying
 * by under a cent is harmless (release is capped at the intent amount),
 * underpaying by any fraction releases less USDC.
 */

import { FIAT_DECIMALS, RATE_ONE, fiatDisplayDecimals, formatDecimal } from "../format";
import type { FiatCode } from "../platforms";

/**
 * Fiat to send for an intent: gross USDC x rate / 1e18, rounded up to the
 * currency's smallest sendable unit (cents; whole units for JPY, VND, UGX).
 * Returns 6-decimal fiat base units. The exact product is rounded up in one
 * step: flooring it to 6 decimals first can land exactly on a cent and show
 * one cent too little, which releases one base unit less than the intent.
 */
export function fiatToSend(intentAmount: bigint, rate: bigint, currency: FiatCode): bigint {
  const step = 10n ** BigInt(FIAT_DECIMALS - fiatDisplayDecimals(currency));
  const unit = RATE_ONE * step;
  return ((intentAmount * rate + unit - 1n) / unit) * step;
}

/** Plain decimal text of a fiat amount to send, without grouping ("1234.50"). */
export function fiatToSendText(amount: bigint, currency: FiatCode): string {
  const places = fiatDisplayDecimals(currency);
  return formatDecimal(amount, FIAT_DECIMALS, {
    minFraction: places,
    maxFraction: places,
    rounding: "ceil",
    group: false,
  });
}

/** Fee legs are 18-decimal fractions of the gross amount, each floored on-chain. */
export function netAfterReferralFees(gross: bigint, fees: ReadonlyArray<{ fee: bigint }>): bigint {
  let total = 0n;
  for (const { fee } of fees) {
    if (fee <= 0n) continue;
    total += (gross * fee) / RATE_ONE;
    if (total >= gross) return 0n;
  }
  return gross - total;
}
