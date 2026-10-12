import { formatUnits } from "viem";
import { USDC_DECIMALS } from "@/config";

export type UsdcParseResult =
  | { ok: true; units: bigint }
  | { ok: false; reason: "empty" | "invalid" | "precision" };

const DECIMAL = /^(?:\d+\.?\d*|\.\d+)$/;

/** Parses typed USDC ("1,250.5", ".5") into 6-decimal base units without floats. */
export function parseUsdcAmount(text: string): UsdcParseResult {
  const cleaned = text.replace(/[,\s_]/g, "");
  if (!cleaned) return { ok: false, reason: "empty" };
  if (!DECIMAL.test(cleaned)) return { ok: false, reason: "invalid" };
  const [whole = "", fraction = ""] = cleaned.split(".");
  if (fraction.length > USDC_DECIMALS) return { ok: false, reason: "precision" };
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const units = BigInt(whole || "0") * scale + BigInt(fraction.padEnd(USDC_DECIMALS, "0") || "0");
  return { ok: true, units };
}

export interface UsdcFormatOptions {
  /** Minimum fraction digits (default 2). */
  minDecimals?: number;
  /** Maximum fraction digits, truncated toward zero (default 6). */
  maxDecimals?: number;
  /** Thousands separators (default false). */
  group?: boolean;
}

/** Exact USDC text, truncated (never rounded up): 1_234_500_000n -> "1234.50". */
export function formatUsdcAmount(units: bigint, opts: UsdcFormatOptions = {}): string {
  const { minDecimals = 2, maxDecimals = USDC_DECIMALS, group = false } = opts;
  const negative = units < 0n;
  const [whole = "0", rawFraction = ""] = formatUnits(negative ? -units : units, USDC_DECIMALS).split(".");
  let fraction = rawFraction.slice(0, maxDecimals).replace(/0+$/, "");
  if (fraction.length < minDecimals) fraction = fraction.padEnd(minDecimals, "0");
  const wholeText = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  return `${negative ? "-" : ""}${wholeText}${fraction ? `.${fraction}` : ""}`;
}

/** Text for an amount input (no trailing zeros, no grouping), e.g. a "Max" button. */
export function formatUsdcInput(units: bigint): string {
  return formatUsdcAmount(units, { minDecimals: 0 });
}

/** USDC base units as a JS number of whole USDC. Display maths only. */
export function usdcToNumber(units: bigint): number {
  return Number(formatUnits(units, USDC_DECIMALS));
}
