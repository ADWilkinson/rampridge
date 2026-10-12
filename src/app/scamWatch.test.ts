import { describe, expect, it } from "vitest";
import { DOUBLING_WARNING, DOUBLING_WARNING_COOLDOWN_MS, createDoublingWarning, isDoublingTalk } from "./scamWatch";

describe("isDoublingTalk", () => {
  it("catches the doubling pitches", () => {
    for (const text of [
      "doubling money!!",
      "Doubling coins at the booth",
      "double your money, trade me",
      "I DOUBLE YOUR USDC",
      "doubling gp 100% legit",
      "doubleyourcoins",
      "Doubling  your  money",
    ]) {
      expect(isDoublingTalk(text), text).toBe(true);
    }
  });

  it("leaves ordinary bank chat alone", () => {
    for (const text of [
      "double check the rate first",
      "my money arrived",
      "doubled my order size today",
      "selling usdc on revolut",
      "double click the banker",
      "",
    ]) {
      expect(isDoublingTalk(text), text).toBe(false);
    }
  });
});

describe("createDoublingWarning", () => {
  it("warns at most once every two minutes", () => {
    const warn = createDoublingWarning();
    expect(warn("doubling money", 0)).toBe(DOUBLING_WARNING);
    expect(warn("double your coins", 1_000)).toBeNull();
    expect(warn("doubling gp", DOUBLING_WARNING_COOLDOWN_MS - 1)).toBeNull();
    expect(warn("doubling gp", DOUBLING_WARNING_COOLDOWN_MS)).toBe(DOUBLING_WARNING);
  });

  it("ignores other lines without starting the cooldown", () => {
    const warn = createDoublingWarning();
    expect(warn("hello", 0)).toBeNull();
    expect(warn("doubling usdc", 1)).toBe(DOUBLING_WARNING);
  });
});
