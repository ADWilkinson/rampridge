import { describe, expect, it } from "vitest";
import { splitWarning } from "@/ui/interfaces/dialogue/script";
import { INTRO_SAFETY, introLoggedIn, introScript } from "./introScript";

function npcLine(loggedIn: boolean, node: string) {
  const n = introScript({ loggedIn }).nodes[node];
  if (!n || n.kind !== "npc") throw new Error(`${node} is not an npc line`);
  return n;
}

describe("intro script", () => {
  it("welcomes and says where to trade on one page, without promising the merchants are the best", () => {
    expect(npcLine(false, "welcome").text).toBe(
      "Welcome to the Bank of RampRidge, a peer-to-peer exchange for USDC and cash. Talk to a banker or use a bank booth, or trade a merchant's live offer.",
    );
    expect(npcLine(false, "welcome").text).not.toMatch(/best/i);
  });

  it("puts the safety rule and logging in on the second page, with only the rule in red", () => {
    const safety = npcLine(false, "safety");
    expect(safety.text).toBe(`${INTRO_SAFETY} Log in with your email or wallet when you're ready to trade.`);
    expect(splitWarning(safety)).toEqual(["", INTRO_SAFETY, " Log in with your email or wallet when you're ready to trade."]);
  });

  it("is two pages, then the options", () => {
    const script = introScript({ loggedIn: false });
    expect(Object.keys(script.nodes)).toEqual(["welcome", "safety", "done"]);
  });

  it("only says the player can trade once a wallet can send", () => {
    expect(introLoggedIn({ sender: null })).toBe(false);
    expect(npcLine(false, "safety").text).toMatch(/Log in with your email or wallet when you're ready to trade\.$/);
    expect(npcLine(true, "safety").text).toBe(`${INTRO_SAFETY} You're logged in, so you can trade whenever you're ready.`);
  });
});
