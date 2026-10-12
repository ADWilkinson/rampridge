import { describe, expect, it } from "vitest";
import { getSpreadOracleConfig } from "@zkp2p/sdk";
import { MAJOR_CURRENCIES, isMajorCurrency } from "./currencies";

describe("major currencies", () => {
  it("every major currency has a live Peer oracle, so it sells at the market rate", () => {
    for (const code of MAJOR_CURRENCIES) expect(getSpreadOracleConfig(code as never), code).toBeTruthy();
  });

  it("leaves niche currencies out", () => {
    for (const code of ["UGX", "KES", "VND", "RON", "HUF", "UAH", "ARS", "JPY", "TRY"]) expect(isMajorCurrency(code)).toBe(false);
    expect(isMajorCurrency("GBP")).toBe(true);
  });
});
