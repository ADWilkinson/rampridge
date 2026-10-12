/**
 * Exact amount formatting for the Peer flows. Everything stays in bigint base
 * units until it becomes display text, so no float ever touches a price or an
 * amount a player will send or receive.
 *
 * Unit conventions used across src/peer:
 * - USDC: 6-decimal base units.
 * - Fiat: 6-decimal base units, the unit Curator quotes in (250.00 USD is
 *   250_000_000n).
 * - Rates: 18-decimal fixed point, fiat per 1 USDC.
 */

import { formatUnits, parseUnits } from "viem";
import { USDC_DECIMALS } from "@/config";
import { FIAT_CURRENCIES, type FiatCode } from "./platforms";

export const FIAT_DECIMALS = 6;
export const RATE_DECIMALS = 18;
export const RATE_ONE = 10n ** 18n;

export type Rounding = "floor" | "ceil" | "half-up";

const DECIMAL_INPUT = /^\d+(?:\.\d*)?$|^\.\d+$/;

/** Parses a plain decimal string ("12", "12.5", ".5") into base units. Returns null when invalid or too precise. */
export function tryParseAmount(text: string, decimals: number): bigint | null {
  const trimmed = text.trim().replace(/,/g, "");
  if (!DECIMAL_INPUT.test(trimmed)) return null;
  const fraction = trimmed.split(".")[1] ?? "";
  if (fraction.length > decimals) return null;
  try {
    return parseUnits(trimmed.startsWith(".") ? `0${trimmed}` : trimmed, decimals);
  } catch {
    return null;
  }
}

function parseOrThrow(text: string, decimals: number, label: string): bigint {
  const value = tryParseAmount(text, decimals);
  if (value === null) throw new Error(`Invalid ${label} amount: "${text}"`);
  return value;
}

export function parseUsdc(text: string): bigint {
  return parseOrThrow(text, USDC_DECIMALS, "USDC");
}

/** Fiat text to 6-decimal base units. */
export function parseFiat(text: string): bigint {
  return parseOrThrow(text, FIAT_DECIMALS, "fiat");
}

/**
 * Keeps only what a numeric amount field should hold: digits and one dot,
 * capped at `maxDecimals` fraction digits. For controlled inputs.
 */
export function sanitizeAmountInput(text: string, maxDecimals = 2): string {
  const cleaned = text.replace(/[^\d.]/g, "");
  const dot = cleaned.indexOf(".");
  if (dot === -1) return cleaned.replace(/^0+(?=\d)/, "");
  const whole = cleaned.slice(0, dot).replace(/^0+(?=\d)/, "");
  const fraction = cleaned.slice(dot + 1).replace(/\./g, "").slice(0, maxDecimals);
  return maxDecimals === 0 ? whole : `${whole || "0"}.${fraction}`;
}

/** Rounds base units to `keepDecimals` places (still expressed in `decimals` base units). */
export function roundToDecimals(
  value: bigint,
  decimals: number,
  keepDecimals: number,
  rounding: Rounding = "floor",
): bigint {
  if (keepDecimals >= decimals) return value;
  const step = 10n ** BigInt(decimals - keepDecimals);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const remainder = abs % step;
  let rounded = abs - remainder;
  if (remainder > 0n) {
    if (rounding === "ceil" && !negative) rounded += step;
    if (rounding === "floor" && negative) rounded += step;
    if (rounding === "half-up" && remainder * 2n >= step) rounded += step;
  }
  return negative ? -rounded : rounded;
}

/** Ceil to `keepDecimals` places, the rule for any amount a buyer must send. */
export function ceilToDecimals(value: bigint, decimals: number, keepDecimals: number): bigint {
  return roundToDecimals(value, decimals, keepDecimals, "ceil");
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface DecimalFormatOptions {
  /** Fraction digits always shown (padded with zeros). Default 0. */
  minFraction?: number;
  /** Fraction digits kept after rounding. Default `decimals`. */
  maxFraction?: number;
  rounding?: Rounding;
  /** Thousands separators. Default true. */
  group?: boolean;
}

/** Exact decimal text for base units, e.g. formatDecimal(1234567n, 6, { maxFraction: 2 }) === "1.23". */
export function formatDecimal(value: bigint, decimals: number, opts: DecimalFormatOptions = {}): string {
  const maxFraction = Math.min(opts.maxFraction ?? decimals, decimals);
  const minFraction = Math.min(opts.minFraction ?? 0, maxFraction);
  const rounded = roundToDecimals(value, decimals, maxFraction, opts.rounding ?? "floor");
  const negative = rounded < 0n;
  const text = formatUnits(negative ? -rounded : rounded, decimals);
  const [wholeRaw = "0", fractionRaw = ""] = text.split(".");
  let fraction = fractionRaw.slice(0, maxFraction).replace(/0+$/, "");
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, "0");
  const whole = opts.group === false ? wholeRaw : groupThousands(wholeRaw);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * USDC for display. Defaults to 2 places rounded down, so a player is never
 * shown more than they will receive.
 */
export function formatUsdc(value: bigint, opts: DecimalFormatOptions = {}): string {
  return formatDecimal(value, USDC_DECIMALS, { minFraction: 2, maxFraction: 2, rounding: "floor", ...opts });
}

/** "125.40 USDC" */
export function formatUsdcText(value: bigint, opts: DecimalFormatOptions = {}): string {
  return `${formatUsdc(value, opts)} USDC`;
}

/** Display decimals for a fiat currency (ISO minor units, capped at 2). */
export function fiatDisplayDecimals(currency: FiatCode): number {
  return Math.min(FIAT_CURRENCIES[currency].decimals, 2);
}

export interface FiatFormatOptions extends DecimalFormatOptions {
  /** "symbol" -> "£101.50", "code" -> "101.50 GBP", "both" -> "£101.50 GBP", "none" -> "101.50". */
  style?: "symbol" | "code" | "both" | "none";
}

function decorateFiat(amount: string, currency: FiatCode, style: FiatFormatOptions["style"]): string {
  const { symbol } = FIAT_CURRENCIES[currency];
  switch (style ?? "symbol") {
    case "code":
      return `${amount} ${currency}`;
    case "both":
      return `${symbol}${amount} ${currency}`;
    case "none":
      return amount;
    default:
      return `${symbol}${amount}`;
  }
}

/** Fiat 6-decimal base units for display, e.g. "£101.50". */
export function formatFiat(value: bigint, currency: FiatCode, opts: FiatFormatOptions = {}): string {
  const places = fiatDisplayDecimals(currency);
  const amount = formatDecimal(value, FIAT_DECIMALS, {
    minFraction: places,
    maxFraction: places,
    rounding: "half-up",
    ...opts,
  });
  return decorateFiat(amount, currency, opts.style);
}

/** Same as formatFiat for a plain decimal string ("101.5"). Returns the input unchanged when it does not parse. */
export function formatFiatDecimal(amount: string, currency: FiatCode, opts: FiatFormatOptions = {}): string {
  const parsed = tryParseAmount(amount, FIAT_DECIMALS);
  return parsed === null ? amount : formatFiat(parsed, currency, opts);
}

/** An 18-decimal rate as a decimal string, 4 places by default ("1.0190"). */
export function formatRate(rate: bigint, opts: DecimalFormatOptions = {}): string {
  return formatDecimal(rate, RATE_DECIMALS, { minFraction: 2, maxFraction: 4, rounding: "half-up", ...opts });
}

/** "1.0190 GBP per USDC" */
export function formatRateText(rate: bigint, currency: FiatCode, opts: DecimalFormatOptions = {}): string {
  return `${formatRate(rate, opts)} ${currency} per USDC`;
}

/** Fiat per USDC from two amounts (fiat and USDC, both 6 decimals) as an 18-decimal rate. */
export function rateFromAmounts(fiat: bigint, usdc: bigint): bigint {
  if (usdc <= 0n) return 0n;
  return (fiat * RATE_ONE) / usdc;
}

/** Fiat base units for a USDC amount at an 18-decimal rate, rounded down. */
export function fiatForUsdc(usdc: bigint, rate: bigint): bigint {
  return (usdc * rate) / RATE_ONE;
}

const COMPACT_STEPS: ReadonlyArray<{ exponent: bigint; suffix: string }> = [
  { exponent: 12n, suffix: "T" },
  { exponent: 9n, suffix: "B" },
  { exponent: 6n, suffix: "M" },
  { exponent: 3n, suffix: "K" },
];

/**
 * Compact form of whole units, truncated (never rounded up): 999 -> "999",
 * 1_250 -> "1.2K", 3_400_000 -> "3.4M". Fractions below 1 unit are dropped.
 */
export function formatCompact(value: bigint, decimals: number, fractionDigits = 1): string {
  const negative = value < 0n;
  const whole = (negative ? -value : value) / 10n ** BigInt(decimals);
  const sign = negative ? "-" : "";
  for (const { exponent, suffix } of COMPACT_STEPS) {
    const unit = 10n ** exponent;
    if (whole < unit) continue;
    const scaled = formatDecimal(whole, Number(exponent), {
      maxFraction: fractionDigits,
      rounding: "floor",
      group: true,
    });
    return `${sign}${scaled}${suffix}`;
  }
  return `${sign}${whole.toString()}`;
}

/** "0x1234…abcd" */
export function shortAddress(address: string, chars = 4): string {
  if (address.length <= 2 + chars * 2) return address;
  return `${address.slice(0, 2 + chars)}…${address.slice(-chars)}`;
}
