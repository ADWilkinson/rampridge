/**
 * The fiat currencies RampRidge trades: the world's most-traded currencies
 * (BIS top 15) that Peer prices with a live on-chain oracle, so buying and
 * selling both follow the market exactly as Peer's own app does. Everything
 * else on Peer is left out on purpose, however a platform lists it.
 */
export const MAJOR_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SGD", "MXN", "CNY", "INR"] as const;

export type MajorCurrency = (typeof MAJOR_CURRENCIES)[number];

const MAJOR_SET: ReadonlySet<string> = new Set(MAJOR_CURRENCIES);

export function isMajorCurrency(code: string): code is MajorCurrency {
  return MAJOR_SET.has(code);
}
