import type { GameContextValue } from "@/ui/interfaces/context";
import type { DialogueScript } from "@/ui/interfaces/dialogue/script";

/** The door banker who greets first-time visitors. */
export const INTRO_SPEAKER = "Banker";

/**
 * Whether the intro may tell the player they can trade. That needs a wallet
 * that can send (`sender`), not just a loaded wallet service: `walletReady`
 * is true for a guest as soon as Privy has loaded, when they still have to
 * log in.
 */
export function introLoggedIn(game: Pick<GameContextValue, "sender">): boolean {
  return game.sender !== null;
}

/** The safety rule, drawn in red within the second page. */
export const INTRO_SAFETY = "Never send money to anyone outside the bank interfaces. Trades only settle through the bank.";

/**
 * First-visit welcome in two pages: what the bank is and where to trade,
 * then the one safety rule (in red) and how to log in. The login sentence
 * changes once the player has a wallet that can trade (see `introLoggedIn`).
 */
export function introScript({ loggedIn }: { loggedIn: boolean }): DialogueScript {
  const login = loggedIn ? "You're logged in, so you can trade whenever you're ready." : "Log in with your email or wallet when you're ready to trade.";
  return {
    id: "intro",
    npcName: INTRO_SPEAKER,
    npcHead: { npc: "banker" },
    start: "welcome",
    nodes: {
      welcome: {
        kind: "npc",
        text: "Welcome to the Bank of RampRidge, a peer-to-peer exchange for USDC and cash. Talk to a banker or use a bank booth, or trade a merchant's live offer.",
        next: { type: "goto", node: "safety" },
      },
      safety: {
        kind: "npc",
        text: `${INTRO_SAFETY} ${login}`,
        warning: INTRO_SAFETY,
        next: { type: "goto", node: "done" },
      },
      done: {
        kind: "options",
        options: [
          { label: "Show me how it works", action: { type: "open", target: { id: "how-it-works" } } },
          { label: "Got it", action: { type: "close" } },
        ],
      },
    },
  };
}
