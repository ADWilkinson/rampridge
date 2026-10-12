import { describe, expect, it } from "vitest";
import {
  ARRIVAL_PATH,
  arrivalPath,
  siteUrlFor,
  escapeHtml,
  formatAmount,
  formatFiat,
  isShareId,
  platformLabel,
  shareDescription,
  shareDetail,
  shareIdFor,
  shareImageUrl,
  sharePostText,
  shareSentence,
  shareTitle,
  shareUrl,
  storedShareRecord,
  toShareRecord,
  usdcFromUnits,
  xIntentUrl,
} from "./share";
import type { ShareRecord } from "./share";

const tx = `0x${"ab".repeat(32)}`;

const bought: ShareRecord = {
  kind: "bought",
  name: "Zezima",
  usdc: "130.47",
  fiat: "100",
  currency: "GBP",
  platform: "revolut",
  tx,
  t: 1_800_000_000_000,
};

describe("share ids", () => {
  it("are ten base-62 characters, stable for the same trade and player", () => {
    const id = shareIdFor("bought", tx, "pid1");
    expect(id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(isShareId(id)).toBe(true);
    expect(shareIdFor("bought", tx.toUpperCase().replace("0X", "0x"), "pid1")).toBe(id);
  });

  it("differ by kind, transaction and player", () => {
    const ids = new Set([
      shareIdFor("bought", tx, "pid1"),
      shareIdFor("listed", tx, "pid1"),
      shareIdFor("bought", tx, "pid2"),
      shareIdFor("bought", `0x${"cd".repeat(32)}`, "pid1"),
    ]);
    expect(ids.size).toBe(4);
  });

  it("rejects anything else as an id", () => {
    for (const bad of ["", "short", "elevenchars", "with-dash12", "../../etc1", "abc def ghi", null, 42]) {
      expect(isShareId(bad)).toBe(false);
    }
  });
});

describe("share URLs", () => {
  it("builds the canonical link and card", () => {
    expect(shareUrl("Ab3dE5gH9k")).toBe("https://www.rampridge.xyz/t/Ab3dE5gH9k");
    expect(shareImageUrl("Ab3dE5gH9k")).toBe("https://www.rampridge.xyz/api/og?id=Ab3dE5gH9k");
    expect(ARRIVAL_PATH).toBe("/?from=share");
    expect(arrivalPath(302)).toBe("/?from=share&world=302");
    for (const none of [null, undefined, 0, 999, 302.5]) expect(arrivalPath(none)).toBe("/?from=share");
  });

  it("builds X's compose intent with the text and link encoded", () => {
    const url = new URL(xIntentUrl("Just bought 1.00 USDC & more: <yes>", "https://www.rampridge.xyz/t/Ab3dE5gH9k"));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("text")).toBe("Just bought 1.00 USDC & more: <yes>");
    expect(url.searchParams.get("url")).toBe("https://www.rampridge.xyz/t/Ab3dE5gH9k");
  });
});

describe("share records", () => {
  it("are shaped from a verified world event without its player id", () => {
    const record = toShareRecord({ kind: "bought", pid: "secret-pid", n: "Zezima", usdc: "130.47", fiat: "100", currency: "GBP", platform: "revolut", tx, t: 1_800_000_000_000 });
    expect(record).toEqual(bought);
    expect(JSON.stringify(storedShareRecord(record!))).not.toContain("secret-pid");
  });

  it("round-trip through storage, which drops nulls", () => {
    const listed: ShareRecord = { ...bought, kind: "listed", fiat: null, currency: null, platform: "wise" };
    const stored = storedShareRecord(listed);
    expect(stored).toEqual({ kind: "listed", name: "Zezima", usdc: "130.47", platform: "wise", tx, t: 1_800_000_000_000 });
    expect(toShareRecord(stored)).toEqual(listed);
    expect(toShareRecord(storedShareRecord(bought))).toEqual(bought);
  });

  it("refuse malformed or hostile fields", () => {
    expect(toShareRecord(null)).toBeNull();
    expect(toShareRecord({ ...bought, kind: "sold" })).toBeNull();
    expect(toShareRecord({ ...bought, usdc: "1e9" })).toBeNull();
    expect(toShareRecord({ ...bought, tx: "0x1234" })).toBeNull();
    expect(toShareRecord({ ...bought, name: "<>&\"'" })).toBeNull();
    expect(toShareRecord({ ...bought, t: -1 })).toBeNull();
    // Names are cut down to the characters display names allow.
    expect(toShareRecord({ ...bought, name: "<b>Zezima</b>" })?.name).toBe("bZezimab");
    expect(toShareRecord({ ...bought, name: "A very long name indeed" })?.name).toBe("A very long");
    // A listing never carries a fiat amount; an unknown currency is dropped.
    expect(toShareRecord({ ...bought, kind: "listed" })?.fiat).toBeNull();
    expect(toShareRecord({ ...bought, currency: "pounds" })).toMatchObject({ currency: null, fiat: null });
  });
});

describe("share wording", () => {
  it("reads like the chatbox news", () => {
    expect(shareSentence(bought)).toBe("Zezima bought 130.47 USDC for £100.00 on Revolut.");
    expect(shareTitle(bought)).toBe("Zezima bought 130.47 USDC at the Bank of RampRidge");
    expect(shareDetail({ ...bought, kind: "listed", fiat: null, platform: "cashapp", currency: "USD" })).toBe("for USD on Cash App");
    expect(shareSentence({ ...bought, currency: "CHF", fiat: "1234.5" })).toBe("Zezima bought 130.47 USDC for 1,234.50 CHF on Revolut.");
    expect(shareDescription(bought)).toContain("settled on Base by Peer");
  });

  it("formats amounts grouped to two decimals, never rounding up", () => {
    expect(formatAmount("1234567.899")).toBe("1,234,567.89");
    expect(formatAmount("0.5")).toBe("0.50");
    expect(formatAmount("007")).toBe("7.00");
    expect(formatFiat("100", "USD")).toBe("$100.00");
    expect(formatFiat("100", "EUR")).toBe("€100.00");
    expect(usdcFromUnits(130_470_000n)).toBe("130.47");
    expect(usdcFromUnits(5_000_000n)).toBe("5");
    expect(usdcFromUnits(1n)).toBe("0.000001");
    expect(platformLabel("mercadopago")).toBe("Mercado Pago");
    expect(platformLabel("newbank")).toBe("Newbank");
  });

  it("writes posts in the player's voice", () => {
    expect(sharePostText({ kind: "bought", usdc: "130.47", platform: "revolut" })).toBe(
      "Just bought 130.47 USDC in Varrock West Bank with Revolut. The bank is open:",
    );
    expect(sharePostText({ kind: "listed", usdc: "250", platform: "wise", currency: "GBP" })).toBe(
      "Selling 250.00 USDC for GBP on Wise in Varrock West Bank. Come and trade:",
    );
    expect(sharePostText({ kind: "invite" })).toBe("Meet me in Varrock West Bank. It trades real USDC now:");
    expect(sharePostText({ kind: "invite", world: 302 })).toBe("Meet me in Varrock West Bank on World 302. It trades real USDC now:");
    expect(siteUrlFor(302)).toBe("https://www.rampridge.xyz/?world=302");
    expect(siteUrlFor(null)).toBe("https://www.rampridge.xyz/");
  });
});

describe("escapeHtml", () => {
  it("escapes everything that could break out of text or an attribute", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(escapeHtml(`a' onload='x`)).toBe("a&#39; onload=&#39;x");
    expect(escapeHtml("Tom & Jerry `tick`")).toBe("Tom &amp; Jerry &#96;tick&#96;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});
