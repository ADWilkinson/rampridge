import type { Address, TransactionReceipt } from "viem";
import { fetchUsdcBalance } from "./balances";
import { WalletError } from "./errors";
import { addressesEqual, formatUsdc } from "./format";
import { usdcTransferCall } from "./transfer";
import type { TxSender } from "./types";

/**
 * Moves the whole USDC balance of `from` to `to` in one transfer. Resolves
 * null when there is nothing to move. The balance is read immediately before
 * sending, so a stale UI figure can never over-send. The transfer is the
 * same attributed call a player's Send uses (`usdcTransferCall`).
 */
export async function sweepUsdc(
  from: TxSender,
  to: Address,
  readBalance: (address: Address) => Promise<bigint> = fetchUsdcBalance,
): Promise<TransactionReceipt | null> {
  if (addressesEqual(from.address, to)) {
    throw new WalletError("invalid_request", "Those funds are already in your wallet.");
  }
  const balance = await readBalance(from.address);
  if (balance <= 0n) return null;
  return from.sendCalls([usdcTransferCall(to, balance)], { label: `Move ${formatUsdc(balance)} USDC to your smart wallet` });
}

const PIN_KEY_PREFIX = "rampridge:wallet:embedded-pin:";

/**
 * The embedded EOA this tab already used as the player's wallet (see
 * `SelectionInput.pinnedEmbeddedAddress`). Tab-scoped: a new tab starts on the
 * smart wallet. Storage can be unavailable (private mode, blocked site data),
 * in which case the pin lives only in memory.
 */
export function readEmbeddedPin(userId: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(PIN_KEY_PREFIX + userId) ?? null;
  } catch {
    return null;
  }
}

export function writeEmbeddedPin(userId: string, address: Address): void {
  try {
    globalThis.sessionStorage?.setItem(PIN_KEY_PREFIX + userId, address);
  } catch {
    // Pin stays in memory for this page load.
  }
}
