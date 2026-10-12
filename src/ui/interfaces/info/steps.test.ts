import { describe, expect, it } from "vitest";
import { BUY_REFERRER_FEE } from "@/config";
import { DEFAULT_INTENT_TTL_MS } from "@/peer/buy/chain";
import { bankerScript } from "@/ui/interfaces/dialogue/scripts";
import { BUY_STEP_TEXT, SELL_STEP_TEXT } from "./steps";

const buyText = BUY_STEP_TEXT.map((s) => `${s.lead} ${s.body}`).join(" ");

describe("How it works", () => {
  it("has five buying steps and three selling steps", () => {
    expect(BUY_STEP_TEXT).toHaveLength(5);
    expect(SELL_STEP_TEXT).toHaveLength(3);
  });

  it("says before any trade that proving a buy needs the Peer extension on a computer, within the order's time limit", () => {
    const prove = BUY_STEP_TEXT[3]!;
    expect(prove.lead).toBe("Prove it privately.");
    expect(prove.body).toBe(
      "Using the Peer extension in Chrome or Brave on a computer, pick that payment from your account within 6 hours. Peer checks it inside a secure enclave.",
    );
    // The time limit in the copy is the one the buy flow's orders really have.
    expect(DEFAULT_INTENT_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("names both fees, with RampRidge's at the rate the buy flow charges", () => {
    expect(buyText).toMatch(/Peer's fee and RampRidge's 0\.5% fee come out of the USDC you receive; every confirm screen lists them\./);
    expect(BUY_REFERRER_FEE.feeBps / 100).toBe(0.5);
  });

  it("matches the banker's own explanation of buying", () => {
    const buying = bankerScript("Banker").nodes.buying;
    expect(buying?.kind === "npc" && buying.text).toMatch(/prove it privately with the Peer extension on a computer\.$/);
  });
});
