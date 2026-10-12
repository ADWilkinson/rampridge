import type { MerchantTarget } from "@/ui/interfaces/context";
import type { DialogueScript } from "./script";

/**
 * The banker's "Talk-to" conversation: the original greeting and options,
 * each handing over to the matching bank interface, plus a two-page
 * explanation of how Peer settles trades.
 */
export function bankerScript(npcName: string): DialogueScript {
  return {
    id: `banker:${npcName}`,
    npcName,
    npcHead: { npc: "banker" },
    start: "greet",
    nodes: {
      greet: { kind: "npc", text: "Good day, how may I help you?", next: { type: "goto", node: "menu" } },
      menu: {
        kind: "options",
        options: [
          { label: "I'd like to access my bank account, please.", action: { type: "open", target: { id: "bank" } } },
          { label: "I'd like to buy some coins.", action: { type: "open", target: { id: "exchange", side: "buy" } } },
          { label: "I'd like to sell my coins.", action: { type: "open", target: { id: "sell" } } },
          { label: "What is this place?", action: { type: "goto", node: "ask" } },
          { label: "Nothing, thanks.", action: { type: "close" } },
        ],
      },
      ask: { kind: "player", text: "What is this place?", next: { type: "goto", node: "buying" } },
      buying: {
        kind: "npc",
        text: "This bank is a Peer exchange. To buy, you pay the seller directly with your usual app, then prove it privately with the Peer extension on a computer.",
        next: { type: "goto", node: "settling" },
      },
      settling: {
        kind: "npc",
        text: "The contract on Base then releases the USDC to you. Sellers lock USDC in that contract, and buyers claim it by paying them.",
        next: { type: "goto", node: "after" },
      },
      after: {
        kind: "options",
        options: [
          { label: "Show me how it works", action: { type: "open", target: { id: "how-it-works" } } },
          { label: "I'd like to ask something else.", action: { type: "goto", node: "menu" } },
          { label: "Nothing, thanks.", action: { type: "close" } },
        ],
      },
    },
  };
}

/**
 * A merchant stands in for the live order book of one platform and currency.
 * `platformName` is the display name ("Revolut"); without a merchant target
 * there is nothing to trade, so the merchant says so and the dialogue ends.
 */
export function merchantScript(npcName: string, merchant: MerchantTarget | undefined, platformName: string | null): DialogueScript {
  if (!merchant) {
    return {
      id: `merchant:${npcName}:none`,
      npcName,
      start: "none",
      nodes: {
        none: { kind: "npc", text: "I've nothing to trade right now. Try one of the bankers.", next: { type: "close" } },
      },
    };
  }
  return {
    id: `merchant:${merchant.merchantId}`,
    npcName,
    npcHead: { merchantId: merchant.merchantId },
    start: "offer",
    nodes: {
      offer: {
        kind: "npc",
        text: `I've got USDC for ${merchant.currency} on ${platformName ?? merchant.platform}. Want to trade?`,
        next: { type: "goto", node: "choose" },
      },
      choose: {
        kind: "options",
        options: [
          { label: "Trade", action: { type: "open", target: { id: "trade", target: merchant } } },
          { label: "Not now", action: { type: "close" } },
        ],
      },
    },
  };
}
