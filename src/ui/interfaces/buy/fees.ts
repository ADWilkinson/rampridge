import { formatUsdc } from "@/peer/format";
import type { BuyQuoteFees } from "@/peer/market";

/**
 * The fee line on every buy confirm screen, naming who takes what:
 * "1.19 USDC Peer + 0.13 USDC rate manager + 0.67 USDC RampRidge (0.5%)".
 * Peer's part is the total less the rate manager's and RampRidge's, so a
 * seller's rate-manager fee is never presented as Peer's. All of it is
 * already taken from the USDC the player receives.
 */
export function feeBreakdown(fees: BuyQuoteFees): string {
  const ours = fees.referrer > 0n ? fees.referrer : 0n;
  const manager = fees.manager > 0n ? fees.manager : 0n;
  const rest = fees.total - ours - manager;
  const peer = rest > 0n ? rest : 0n;
  const parts = [`${formatUsdc(peer)} USDC Peer`];
  if (manager > 0n) parts.push(`${formatUsdc(manager)} USDC rate manager`);
  if (ours > 0n) {
    const rate = fees.referrerBps !== null ? ` (${trimPercent(fees.referrerBps / 100)}%)` : "";
    parts.push(`${formatUsdc(ours)} USDC RampRidge${rate}`);
  }
  return parts.join(" + ");
}

function trimPercent(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}
