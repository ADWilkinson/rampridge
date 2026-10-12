import { describe, expect, it } from "vitest";
import { SHARE_WELCOME, WELCOME, parseArrival, takeWelcome, takeWorldRequest, worldWelcome } from "./arrival";

describe("share arrivals", () => {
  it("spots the marker and removes only it", () => {
    expect(parseArrival("?from=share")).toEqual({ fromShare: true, world: null, search: "" });
    expect(parseArrival("?from=share&utm_source=x")).toEqual({ fromShare: true, world: null, search: "?utm_source=x" });
    expect(parseArrival("?utm_source=x&from=share")).toEqual({ fromShare: true, world: null, search: "?utm_source=x" });
  });

  it("leaves other visits alone", () => {
    expect(parseArrival("")).toEqual({ fromShare: false, world: null, search: "" });
    expect(parseArrival("?from=elsewhere")).toEqual({ fromShare: false, world: null, search: "?from=elsewhere" });
    expect(parseArrival("?fromshare")).toEqual({ fromShare: false, world: null, search: "?fromshare=" });
  });

  it("welcomes normally outside a browser", () => {
    expect(takeWelcome()).toBe(WELCOME);
    expect(SHARE_WELCOME).toBe("You followed a trade to the Bank of RampRidge.");
  });
});

describe("world requests", () => {
  it("reads ?world=302 from a link or a shared trade, and drops it from the address", () => {
    expect(parseArrival("?world=302")).toEqual({ fromShare: false, world: 302, search: "" });
    expect(parseArrival("?from=share&world=303&utm_source=x")).toEqual({ fromShare: true, world: 303, search: "?utm_source=x" });
  });

  it("ignores anything that is not a world number, but still tidies it away", () => {
    for (const bad of ["?world=1", "?world=999", "?world=abc", "?world=302.5", "?world="]) {
      expect(parseArrival(bad)).toEqual({ fromShare: false, world: null, search: "" });
    }
  });

  it("asks the server to choose when the visit named no world", () => {
    expect(takeWorldRequest()).toBe("auto");
  });

  it("names the world in the welcome", () => {
    expect(worldWelcome(WELCOME, 302)).toBe("Welcome to RampRidge. You are on World 302.");
    expect(worldWelcome(SHARE_WELCOME, 301)).toBe("You followed a trade to the Bank of RampRidge. You are on World 301.");
  });

  it("says when the world a link asked for had no room", () => {
    expect(worldWelcome(WELCOME, 303, 302)).toBe("Welcome to RampRidge. World 302 has no room, so you are on World 303.");
    expect(worldWelcome(WELCOME, 302, 302)).toBe("Welcome to RampRidge. You are on World 302.");
    expect(worldWelcome(WELCOME, 301, "auto")).toBe("Welcome to RampRidge. You are on World 301.");
  });
});
