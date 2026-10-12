/** Fixed-point formatting for token amounts and 18-decimal rates. */

/**
 * Formats `value / 10^decimals` as a decimal string, truncated to
 * `maxFraction` digits with trailing zeros removed ("12.5", "0.892735").
 */
export function formatFixed(value: bigint, decimals: number, maxFraction = decimals): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let fraction = (abs % scale).toString().padStart(decimals, "0").slice(0, maxFraction);
  fraction = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const USDC_DECIMALS = 6;
export const RATE_DECIMALS = 18;

export const formatUsdc = (units: bigint) => formatFixed(units, USDC_DECIMALS);
/** Fiat per USDC, six decimal places is finer than any payment platform settles. */
export const formatRate = (rate: bigint) => formatFixed(rate, RATE_DECIMALS, 6);
