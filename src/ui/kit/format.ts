/**
 * Number and time formatting with the original client's rules. Pure: no DOM.
 */

export type StackTier = "units" | "thousands" | "millions";

export interface StackLabel {
  /** Text drawn in the slot's top-left corner, e.g. "99999", "100K", "10M". */
  text: string;
  tier: StackTier;
  /** CSS colour for the tier: yellow, white, green. */
  color: string;
}

export const STACK_COLORS: Readonly<Record<StackTier, string>> = {
  units: "#ffff00",
  thousands: "#ffffff",
  millions: "#00ff80",
};

/**
 * The inventory stack label: the exact count in yellow below 100,000, whole
 * thousands with "K" in white below 10,000,000, whole millions with "M" in
 * green from there. Counts are floored, never rounded up, like the client.
 */
export function formatStack(quantity: number): StackLabel {
  const n = Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
  if (n < 100_000) return { text: String(n), tier: "units", color: STACK_COLORS.units };
  if (n < 10_000_000) return { text: `${Math.floor(n / 1_000)}K`, tier: "thousands", color: STACK_COLORS.thousands };
  return { text: `${Math.floor(n / 1_000_000)}M`, tier: "millions", color: STACK_COLORS.millions };
}

/** Whether the client draws a count on a slot: always for stackables, otherwise only when not 1. */
export function showsStack(quantity: number, stackable: boolean): boolean {
  return stackable || quantity !== 1;
}

/** "1,234,567" with grouping, used in examine text and interfaces. */
export function formatNumber(value: number, fractionDigits = 0): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * Exact amount from a decimal string or number, grouped, with fixed decimals:
 * formatDecimal("125.4", 2) -> "125.40". Strings are handled without float
 * rounding so on-chain amounts stay exact.
 */
export function formatDecimal(value: string | number, decimals = 2): string {
  const raw = typeof value === "number" ? (Number.isFinite(value) ? value.toFixed(Math.max(decimals, 0) + 2) : "0") : value.trim();
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m) return formatNumber(0, decimals);
  const sign = m[1] && /[1-9]/.test(`${m[2] ?? ""}${m[3] ?? ""}`) ? "-" : "";
  const whole = (m[2] ?? "").replace(/^0+(?=\d)/, "") || "0";
  const frac = (m[3] ?? "").padEnd(decimals, "0").slice(0, decimals);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimals > 0 ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/** "0x1234...abcd" */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 3) return address;
  return `${address.slice(0, lead)}...${address.slice(-tail)}`;
}

/**
 * Remaining time as a clock: "4:05", "14:59", "1:02:03". Negative input is
 * treated as zero. Seconds are rounded up so "0:00" only shows at expiry.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Remaining time in words: "2 hours", "14 minutes", "45 seconds". */
export function formatDurationWords(ms: number): string {
  const total = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (total >= 60) {
    const m = Math.floor(total / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  return `${total} second${total === 1 ? "" : "s"}`;
}

/**
 * Orb value colour: green when full through yellow to red when empty, the
 * same ramp the client uses for hitpoints and run energy text.
 */
export function orbTextColor(fraction: number): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const r = Math.round(255 * Math.min(1, 2 * (1 - f)));
  const g = Math.round(255 * Math.min(1, 2 * f));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}00`;
}
