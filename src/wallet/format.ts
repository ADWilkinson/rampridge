import { USDC_DECIMALS } from "@/config";

/** `0x1234…abcd`. Returns "" for an empty value and the input unchanged when it is too short to shorten. */
export function shortAddress(address: string | null | undefined, head = 4, tail = 4): string {
  if (!address) return "";
  const body = address.startsWith("0x") ? address.slice(2) : address;
  if (body.length <= head + tail + 1) return address;
  const prefix = address.startsWith("0x") ? "0x" : "";
  return `${prefix}${body.slice(0, head)}…${body.slice(-tail)}`;
}

/** Case-insensitive address equality that treats missing values as unequal. */
export function addressesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats a base-unit integer as a decimal string. Digits beyond
 * `maxFractionDigits` are truncated, never rounded up, so a balance is never
 * shown as larger than it is.
 */
export function formatUnitsTruncated(
  amount: bigint,
  decimals: number,
  options: { minFractionDigits?: number; maxFractionDigits?: number; grouping?: boolean } = {},
): string {
  const { minFractionDigits = 0, maxFractionDigits = decimals, grouping = true } = options;
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = (absolute / scale).toString();
  let fraction = (absolute % scale).toString().padStart(decimals, "0").slice(0, Math.max(0, maxFractionDigits));
  while (fraction.length > minFractionDigits && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  fraction = fraction.padEnd(minFractionDigits, "0");
  const wholeText = grouping ? groupThousands(whole) : whole;
  const text = fraction ? `${wholeText}.${fraction}` : wholeText;
  const isZero = /^[0.,]*$/.test(text);
  return negative && !isZero ? `-${text}` : text;
}

/** USDC base units (6 decimals) to `1,234.56`. */
export function formatUsdc(amount: bigint, fractionDigits = 2): string {
  return formatUnitsTruncated(amount, USDC_DECIMALS, {
    minFractionDigits: fractionDigits,
    maxFractionDigits: fractionDigits,
  });
}

/** Wei to ETH with at most `maxFractionDigits` decimals (truncated), trailing zeros trimmed: `0.0012`. */
export function formatEth(wei: bigint, maxFractionDigits = 6): string {
  return formatUnitsTruncated(wei, 18, { maxFractionDigits });
}
