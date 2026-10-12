import { describe, expect, it } from "vitest";
import { BUY_PLATFORM_IDS, BUY_PLATFORMS } from "@/peer/platforms";
import { platformMonogram } from "./PlatformIcon";

describe("platformMonogram", () => {
  it("gives every buy platform its own badge, including Alipay, UPI and Monobank", () => {
    const monograms = BUY_PLATFORM_IDS.map((id) => platformMonogram(id, BUY_PLATFORMS[id].name));
    expect(new Set(monograms).size).toBe(monograms.length);
    expect(platformMonogram("alipay")).toBe("A");
    expect(platformMonogram("upi")).toBe("U");
    expect(platformMonogram("monobank")).toBe("mb");
  });

  it("falls back to the first letter of an unknown platform's name", () => {
    expect(platformMonogram("pix", "Pix")).toBe("P");
    expect(platformMonogram("toString")).toBe("T");
  });
});
