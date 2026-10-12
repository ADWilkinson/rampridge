import { describe, expect, it } from "vitest";
import { BUY_REFERRER_FEE } from "@/config";
import { BUY_STEP_TEXT } from "@/ui/interfaces/info/steps";
import { HOW_IT_WORKS_STEPS } from "./howItWorksText";

const text = HOW_IT_WORKS_STEPS.map((s) => `${s.title} ${s.body}`).join(" ");

describe("title screen How it works", () => {
  it("says proving a buy needs the Peer extension on a computer within 6 hours, as the in-game guide does", () => {
    const inGame = BUY_STEP_TEXT.find((s) => s.lead === "Prove it privately.");
    expect(inGame).toBeDefined();
    expect(HOW_IT_WORKS_STEPS[2]!.body).toBe(inGame!.body);
    expect(text).toMatch(/Chrome or Brave on a computer/);
    expect(text).toMatch(/within 6 hours/);
  });

  it("names Peer's fee and RampRidge's fee at the rate the buy flow charges", () => {
    expect(text).toContain("Peer's fee and RampRidge's 0.5% fee come out of the USDC you receive; every confirm screen lists them.");
    expect(BUY_STEP_TEXT.map((s) => s.body).join(" ")).toContain("Peer's fee and RampRidge's 0.5% fee come out of the USDC you receive");
    expect(BUY_REFERRER_FEE.feeBps / 100).toBe(0.5);
  });
});
