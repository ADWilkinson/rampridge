/**
 * The seller's spread on the live oracle rate: Peer web's range, step,
 * validation and effective-rate maths (helpers/depositRateConfig.ts,
 * NewDeposit/utils/computeSpreadRate.ts). Pure, so the form and the sell
 * machine can use it without loading the SDK; the deposit itself is built in
 * `spread.ts`.
 */

/**
 * Feature switch for seller spreads. False hides the spread control and lists
 * every order at the market rate (0%), exactly as before spreads.
 */
export const SELL_SPREAD_ENABLED = true;

/** Peer web's CREATE_SPREAD_MIN_BPS / CREATE_SPREAD_MAX_BPS for a new deposit. */
export const SPREAD_MIN_BPS = -500;
export const SPREAD_MAX_BPS = 500;
/** One press of the step buttons: 0.1%, so a seller can set the rate finely. */
export const SPREAD_STEP_BPS = 10;

/** A whole number of basis points inside Peer's range for a new deposit. */
export function isValidSpreadBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= SPREAD_MIN_BPS && bps <= SPREAD_MAX_BPS;
}

export function clampSpreadBps(bps: number): number {
  if (!Number.isFinite(bps)) return 0;
  return Math.max(SPREAD_MIN_BPS, Math.min(SPREAD_MAX_BPS, Math.round(bps)));
}

/** Parses a typed percentage ("1", "-0.75", "+2.5%"); Peer web's messages for a bad entry. */
export function parseSpreadPercent(text: string): { ok: true; bps: number } | { ok: false; message: string } {
  const trimmed = text.trim().replace(/%$/, "").trim();
  const value = Number(trimmed);
  if (!trimmed || !Number.isFinite(value)) return { ok: false, message: "Enter a valid premium or discount." };
  if (value < SPREAD_MIN_BPS / 100 || value > SPREAD_MAX_BPS / 100) {
    return { ok: false, message: "Premium or discount must be between -5.00% and +5.00%." };
  }
  return { ok: true, bps: clampSpreadBps(value * 100) };
}

/** "+0.50%", "-1.25%", "0.00%" */
export function formatSpreadPercent(bps: number): string {
  const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
  return `${sign}${(Math.abs(bps) / 100).toFixed(2)}%`;
}

/** Peer web's computeEffectiveRate: the fiat per USDC a buyer pays at this spread over the oracle rate. */
export function spreadRate(marketRate: number, spreadBps: number): number {
  if (!Number.isFinite(marketRate) || marketRate <= 0) return 0;
  const effective = marketRate * (1 + spreadBps / 10_000);
  return effective > 0 ? effective : 0;
}

