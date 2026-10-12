import type { Address, TransactionReceipt } from "viem";
import { formatUsdc } from "@/wallet/format";

/**
 * USDC left in the player's earlier wallet (the embedded EOA behind their
 * smart wallet): what the inventory says about it, and the one action that
 * moves it to the player's wallet.
 */

/** Below a cent the earlier wallet's USDC isn't shown: moving it would cost more than it is worth. */
export const EARLIER_USDC_MIN = 10_000n;

export const EARLIER_COINS_NAME = "Coins (earlier wallet)";

export function earlierCoinsExamine(amount: string): string {
  return `${amount} USDC in your earlier wallet on Base.`;
}

export function earlierCoinsReminder(amount: string): string {
  return `You have ${amount} USDC in your earlier wallet. Click those coins in your inventory to move them to your wallet.`;
}

/** Kept short: on phones the chatbox's Hide button sits at the end of the question line. */
export function earlierMoveQuestion(amount: string): string {
  return `Move ${amount} USDC from your earlier wallet?`;
}

export const EARLIER_MOVE_YES = "Yes, move it to my wallet.";
export const EARLIER_MOVE_NO = "No, leave it there.";

/** The parts of the wallet context a move needs, read fresh at each step. */
export interface EarlierWalletLike {
  fallbackEoa: Address | null;
  sweepFallbackUsdc(): Promise<TransactionReceipt | null>;
}

export interface MoveDeps {
  readBalance(address: Address): Promise<bigint>;
  /** Yes/no question in the chatbox; resolves false when declined or dismissed. */
  confirm(question: string, yes: string, no: string): Promise<boolean>;
  /** Game message in the chatbox. */
  say(text: string): void;
  /** Plain-English text for a failure. */
  describe(err: unknown): string;
}

/**
 * Moves the earlier wallet's whole USDC balance to the player's wallet after
 * a yes/no question. One move at a time: clicks while one runs (or while the
 * question is open) are ignored, so it can never send twice.
 */
export function createEarlierMover(deps: MoveDeps): (getWallet: () => EarlierWalletLike) => Promise<void> {
  let moving = false;
  return async (getWallet) => {
    const eoa = getWallet().fallbackEoa;
    if (moving || !eoa) return;
    moving = true;
    try {
      let balance: bigint;
      try {
        balance = await deps.readBalance(eoa);
      } catch {
        deps.say("Couldn't read your earlier wallet's balance. Try again in a moment.");
        return;
      }
      if (balance <= 0n) {
        deps.say("There is no USDC left in your earlier wallet.");
        return;
      }
      const amount = formatUsdc(balance);
      if (!(await deps.confirm(earlierMoveQuestion(amount), EARLIER_MOVE_YES, EARLIER_MOVE_NO))) return;
      deps.say(`Moving ${amount} USDC to your wallet...`);
      // The wallet re-reads the balance right before sending, so a stale figure can never over-send.
      const receipt = await getWallet().sweepFallbackUsdc();
      deps.say(receipt ? "Your USDC is now in your wallet." : "There is no USDC left in your earlier wallet.");
    } catch (err) {
      deps.say(deps.describe(err));
    } finally {
      moving = false;
    }
  };
}
