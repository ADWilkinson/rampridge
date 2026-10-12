/**
 * The classic OSRS bank scam is "doubling money": give me your coins and
 * I'll give back twice as many. This room trades real money, so when someone
 * in public chat talks about doubling, the game answers in the chatbox, like
 * the original's own warnings, at most once every two minutes per player.
 */

export const DOUBLING_WARNING = "Nobody can double your coins. Trades only settle through the bank.";
export const DOUBLING_WARNING_COOLDOWN_MS = 2 * 60_000;

const DOUBLING = /doubl(e|ing)\s*(your\s*)?(money|coins|usdc|gp)/i;

/** Whether a public chat line talks about doubling someone's money. */
export function isDoublingTalk(text: string): boolean {
  return DOUBLING.test(text);
}

/**
 * Decides when to post DOUBLING_WARNING: returns it for a doubling line
 * unless one was posted within the cooldown, otherwise null.
 */
export function createDoublingWarning(cooldownMs = DOUBLING_WARNING_COOLDOWN_MS): (text: string, now: number) => string | null {
  let lastAt: number | null = null;
  return (text, now) => {
    if (!isDoublingTalk(text)) return null;
    if (lastAt !== null && now - lastAt < cooldownMs) return null;
    lastAt = now;
    return DOUBLING_WARNING;
  };
}
