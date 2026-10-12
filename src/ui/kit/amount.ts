/**
 * Amount entry logic behind the Grand Exchange style buttons (+1, +10, +100,
 * +1K, "...") and the chatbox "Enter amount:" prompt. Pure: no DOM.
 *
 * Amounts are numbers with a fixed number of decimals (0 for whole units,
 * 2 for fiat). Every result is rounded to that precision and clamped to the
 * allowed range, so floating-point drift never reaches the UI.
 */

export interface AmountRules {
  /** Smallest allowed amount (default 0). */
  min?: number;
  /** Largest allowed amount (default: no limit). */
  max?: number;
  /** Decimal places kept (default 0). */
  decimals?: number;
}

/** The original quantity buttons. */
export const DEFAULT_STEPS: readonly number[] = [1, 10, 100, 1_000];

/** "+1", "+10", "+100", "+1K", "+10K", "+1M" */
export function stepLabel(step: number): string {
  const sign = step < 0 ? "-" : "+";
  const n = Math.abs(step);
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${sign}${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${sign}${n / 1_000}K`;
  return `${sign}${n}`;
}

/**
 * Rounds half up at `decimals` places in decimal terms (1.005 -> 1.01), by
 * shifting the exponent in the number's string form instead of multiplying.
 */
export function roundTo(value: number, decimals = 0): number {
  if (!Number.isFinite(value)) return value;
  const d = Math.max(0, Math.floor(decimals));
  const [mant, exp] = String(value).split("e");
  const shifted = Math.round(Number(`${mant}e${Number(exp ?? 0) + d}`));
  const [mant2, exp2] = String(shifted).split("e");
  return Number(`${mant2}e${Number(exp2 ?? 0) - d}`);
}

/** Rounds to the rule's precision and clamps into [min, max]. */
export function clampAmount(value: number, rules: AmountRules = {}): number {
  const { min = 0, max = Number.POSITIVE_INFINITY, decimals = 0 } = rules;
  if (!Number.isFinite(value)) return min;
  const rounded = roundTo(value, decimals);
  return Math.min(max, Math.max(min, rounded));
}

/** Adds a step (which may be negative) and clamps, e.g. the +10 button. */
export function stepAmount(value: number, step: number, rules: AmountRules = {}): number {
  return clampAmount(roundTo(value, rules.decimals ?? 0) + step, rules);
}

const SUFFIX: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

/**
 * Parses what a player types at "Enter amount:". Accepts grouping commas,
 * spaces and the client's k/m/b suffixes ("1.5k" = 1,500). Returns null for
 * anything else, including negatives and more decimals than allowed after
 * applying the suffix.
 */
export function parseAmount(input: string, rules: AmountRules = {}): number | null {
  const decimals = rules.decimals ?? 0;
  const cleaned = input.trim().toLowerCase().replace(/[,\s_]/g, "");
  const m = /^(\d+(?:\.\d*)?|\.\d+)([kmb])?$/.exec(cleaned);
  if (!m) return null;
  const base = Number(m[1]);
  const mult = m[2] ? (SUFFIX[m[2]] ?? 1) : 1;
  const value = base * mult;
  if (!Number.isFinite(value)) return null;
  if (Math.abs(roundTo(value, decimals) - value) > 1e-9 * Math.max(1, value)) return null;
  return roundTo(value, decimals);
}

/**
 * Keeps only what the prompt accepts while typing: digits, one dot (a whole
 * amount still takes "1.5k"), then an optional k/m/b suffix that ends input.
 */
export function filterAmountKeystrokes(input: string): string {
  let out = "";
  let dot = false;
  let suffix = false;
  for (const ch of input.toLowerCase()) {
    if (suffix) break;
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !dot) {
      dot = true;
      out += ch;
    } else if ((ch === "k" || ch === "m" || ch === "b") && /\d/.test(out)) {
      suffix = true;
      out += ch;
    }
  }
  return out;
}

/** Amount shown in an input box: grouped, with the rule's decimals only when needed. */
export function formatAmount(value: number, decimals = 0): string {
  const v = roundTo(value, decimals);
  const hasFraction = decimals > 0 && Math.abs(v - Math.trunc(v)) > 0;
  return v.toLocaleString("en-US", {
    minimumFractionDigits: hasFraction ? decimals : 0,
    maximumFractionDigits: decimals,
  });
}
