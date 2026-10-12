import { describe, expect, it } from "vitest";
import type { StallSummary } from "@shared/protocol";
import { buildMenu, formatUsdc, merchantExamine, platformName, playerExamine, stallSuffix, stallTag } from "./menu";

const stall: StallSummary = {
  depositId: "0xabc_1",
  escrow: "0xabc",
  platform: "revolut",
  currency: "gbp",
  available: "1240.55",
  rate: "0.79",
};

const label = (o: { verb: string; targetName: string }) => `${o.verb}${o.targetName ? ` ${o.targetName}` : ""}`;

describe("menus", () => {
  it("bankers offer Talk-to, Bank, Exchange, Examine above Walk here", () => {
    const menu = buildMenu([{ kind: "banker", npcIndex: 0, name: "Banker", serves: true }], { x: 1, y: 2 });
    expect(menu.map(label)).toEqual(["Talk-to Banker", "Bank Banker", "Exchange Banker", "Examine Banker", "Walk here"]);
    expect(menu[0]!.kind).toBe("npc");
    expect(menu[0]!.interact).toBe("talk");
  });

  it("booths are objects with Bank, Exchange, Collect, Examine", () => {
    const menu = buildMenu([{ kind: "booth", boothIndex: 2 }], null);
    expect(menu.map(label)).toEqual(["Bank Bank booth", "Exchange Bank booth", "Collect Bank booth", "Examine Bank booth"]);
    expect(menu.every((o) => o.kind === "object")).toBe(true);
  });

  it("merchants offer Trade and Examine", () => {
    const menu = buildMenu([{ kind: "merchant", merchantId: "revolut:GBP", name: "Revolut merchant" }], null);
    expect(menu.map((o) => o.interact)).toEqual(["trade", "examine"]);
  });

  it("plain players rank below Walk here, like the original", () => {
    const menu = buildMenu([{ kind: "player", pid: "a", name: "Zezima", stall: null }], { x: 5, y: 5 });
    expect(menu.map(label)).toEqual(["Walk here", "Follow Zezima", "Examine Zezima"]);
  });

  it("players with a stall lead with Trade-with and the stall info", () => {
    const menu = buildMenu(
      [
        { kind: "player", pid: "a", name: "Zezima", stall },
        { kind: "banker", npcIndex: 1, name: "Banker", serves: true },
      ],
      { x: 5, y: 5 },
    );
    expect(menu[0]!.verb).toBe("Trade-with");
    expect(menu[0]!.interact).toBe("trade-stall");
    expect(menu[0]!.suffix).toBe("(1,240 USDC @ 0.79 GBP, Revolut)");
    expect(menu.map((o) => o.verb)).toEqual(["Trade-with", "Follow", "Examine", "Talk-to", "Bank", "Exchange", "Examine", "Walk here"]);
  });

  it("a merchant sharing a player's tile yields: Walk here first, the player's options above the merchant's", () => {
    const menu = buildMenu(
      [
        { kind: "merchant", merchantId: "revolut:GBP", name: "Revolut trader", sharesTile: true },
        { kind: "player", pid: "a", name: "Zezima", stall: null },
      ],
      { x: 5, y: 5 },
    );
    expect(menu.map(label)).toEqual(["Walk here", "Follow Zezima", "Examine Zezima", "Trade Revolut trader", "Examine Revolut trader"]);
  });

  it("a merchant sharing a stall holder's tile ranks below the stall and Walk here", () => {
    const menu = buildMenu(
      [
        { kind: "merchant", merchantId: "revolut:GBP", name: "Revolut trader", sharesTile: true },
        { kind: "player", pid: "a", name: "Zezima", stall },
      ],
      { x: 5, y: 5 },
    );
    expect(menu.map((o) => o.verb)).toEqual(["Trade-with", "Follow", "Examine", "Walk here", "Trade", "Examine"]);
    expect(menu[0]!.target).toEqual({ kind: "player", pid: "a" });
  });

  it("a merchant on its own tile still trades on left-click", () => {
    const menu = buildMenu([{ kind: "merchant", merchantId: "wise:EUR", name: "Wise trader", sharesTile: false }], { x: 1, y: 1 });
    expect(menu.map(label)).toEqual(["Trade Wise trader", "Examine Wise trader", "Walk here"]);
  });

  it("formats stall tags", () => {
    expect(stallTag(stall)).toBe("Selling 1,240 USDC");
    expect(stallSuffix({ ...stall, platform: "cashapp", currency: "usd", rate: "1" })).toBe("(1,240 USDC @ 1 USD, Cash App)");
    expect(formatUsdc("1234567.9")).toBe("1,234,567");
    expect(formatUsdc("0.5")).toBe("0");
  });

  it("names every platform a merchant or stall can trade on", () => {
    expect(platformName("alipay")).toBe("Alipay");
    expect(platformName("upi")).toBe("UPI");
    expect(platformName("monobank")).toBe("Monobank");
    expect(platformName("xmoney")).toBe("X Money");
    expect(platformName("cashapp")).toBe("Cash App");
    expect(stallSuffix({ ...stall, platform: "upi", currency: "inr", rate: "88.4" })).toBe("(1,240 USDC @ 88.4 INR, UPI)");
    expect(stallSuffix({ ...stall, platform: "alipay", currency: "cny", rate: "7.1234" })).toBe("(1,240 USDC @ 7.123 CNY, Alipay)");
    expect(merchantExamine("Monobank trader", "monobank", "uah")).toBe("Monobank trader: sells USDC for UAH paid by Monobank.");
    expect(playerExamine("Woox", { ...stall, platform: "xmoney", currency: "usd", rate: "1.02" })).toBe(
      "Woox is selling 1,240 USDC for USD by X Money at 1.02 USD each.",
    );
  });

  it("gives a banker who serves no booth only Examine (the door guard)", () => {
    const menu = buildMenu([{ kind: "banker", npcIndex: 4, name: "Banker", serves: false }], null);
    expect(menu.map((o) => o.verb)).toEqual(["Examine"]);
  });
});
