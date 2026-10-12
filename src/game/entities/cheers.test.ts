import { describe, expect, it } from "vitest";
import { hashString, mix } from "../util/hash";
import { CHEER_LINES, cheerLine } from "./cheers";

const MERCHANTS = ["venmo:USD", "revolut:EUR", "revolut:GBP", "cashapp:USD", "wise:EUR", "zelle:USD", "wise:GBP", "paypal:USD"];
const PLAYERS = ["p1", "p2", "p3", "-Nx3abcDEF", "guest-7781"];

describe("cheerLine", () => {
  it("congratulates a settled trade", () => {
    for (const m of MERCHANTS) for (const p of PLAYERS) expect(["gz!", "Nice trade!"]).toContain(cheerLine("trade", m, p));
  });

  it("greets a new sell order with a stall line, never a trade line", () => {
    for (const m of MERCHANTS) {
      for (const p of PLAYERS) {
        const line = cheerLine("listing", m, p);
        expect(CHEER_LINES.listing).toContain(line);
        expect(line).not.toMatch(/trade|gz/i);
      }
    }
    expect(CHEER_LINES.listing).toContain("New stall!");
  });

  it("is the same on every client and varies between merchants", () => {
    for (const kind of ["trade", "listing"] as const) {
      expect(cheerLine(kind, "wise:EUR", "p3")).toBe(cheerLine(kind, "wise:EUR", "p3"));
      const said = new Set(MERCHANTS.map((m) => cheerLine(kind, m, "p3")));
      expect(said.size).toBe(CHEER_LINES[kind].length);
    }
  });

  it("keeps the trade line each merchant already said before kinds existed", () => {
    const before = ["gz!", "Nice trade!"];
    for (const m of MERCHANTS) {
      for (const p of PLAYERS) expect(cheerLine("trade", m, p)).toBe(before[mix(hashString(m), hashString(p)) % before.length]);
    }
  });
});
