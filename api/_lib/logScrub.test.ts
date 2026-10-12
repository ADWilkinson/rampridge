import { describe, expect, it } from "vitest";
import { scrubStack, scrubText, uaClass } from "./logScrub";

const scrub = (text: string) => scrubText(text, 1_000);

describe("scrubText", () => {
  it("removes addresses, hashes and keys", () => {
    expect(scrub("owner 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 mismatch")).toBe("owner 0x[address] mismatch");
    expect(scrub(`intent 0x${"1f".repeat(32)} not found`)).toBe("intent 0x[hex] not found");
    expect(scrub("calldata 0xa9059cbb000000000000000000000000")).toBe("calldata 0x[hex]");
    expect(scrub("short 0xdeadbeef stays")).toBe("short 0xdeadbeef stays");
  });

  it("removes tokens and secrets", () => {
    expect(scrub("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-DEF_ghi")).toBe("token [jwt]");
    expect(scrub("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [token]");
    expect(scrub("user did:privy:cmcq3o9ro00e2k10lklib7oo1 failed")).toBe("user did:privy:[token] failed");
    expect(scrub("apiKey=fake_key_0123456789abcdefXYZ bad")).toBe("apiKey=[token] bad");
    // Ordinary long words survive.
    expect(scrub("dynamicallyImportedModuleFailed to load")).toBe("dynamicallyImportedModuleFailed to load");
  });

  it("keeps our own URLs' paths and only the origin of anyone else's", () => {
    expect(scrub("GET https://www.rampridge.xyz/t/AbCdEf1234?ref=x#y failed")).toBe(
      "GET https://www.rampridge.xyz/t/AbCdEf1234 failed",
    );
    expect(scrub("HTTP request failed. URL: https://base-mainnet.g.alchemy.com/v2/not-a-real-key")).toBe(
      "HTTP request failed. URL: https://base-mainnet.g.alchemy.com/…",
    );
    expect(scrub("see https://api.zkp2p.xyz/v3/sign?payee=bob")).toBe("see https://api.zkp2p.xyz/…");
    expect(scrub("blocked chrome-extension://abcdefghijklmnop/inject.js")).toBe("blocked chrome-extension://abcdefghijklmnop/…");
  });

  it("removes payee handles, emails, payment links and long numbers", () => {
    expect(scrub("No payment to @john-smith-22 found")).toBe("No payment to @[handle] found");
    expect(scrub("Send to $CashTag99 now")).toBe("Send to $[handle] now");
    expect(scrub("Zelle bob.smith+x@example.com")).toBe("Zelle [email]");
    expect(scrub("pay revolut.me/johnsmith today")).toBe("pay revolut.me/… today");
    expect(scrub("Call +1 (415) 555-0123")).toBe("Call [number]");
    expect(scrub("CVU 0000003100010000000001")).toBe("CVU [number]");
    // Small numbers and scoped packages are not personal data.
    expect(scrub("status 500 after 12000 ms")).toBe("status 500 after 12000 ms");
    expect(scrub("in @privy-io/react-auth")).toBe("in @privy-io/react-auth");
  });

  it("collapses whitespace and truncates", () => {
    expect(scrubText("a\n\n  b", 100)).toBe("a b");
    expect(scrubText("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("scrubStack", () => {
  it("keeps V8 frames only, dropping the message lines", () => {
    const stack = [
      "Error: payout to @john failed",
      "  second message line 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "    at fulfil (https://www.rampridge.xyz/assets/AppRoot-DxYz1234.js:12:345)",
      "    at https://rpc.example/v2/KEY123456789abcdefghijk:1:2",
      "    at async Promise.all (index 0)",
    ].join("\n");
    expect(scrubStack(stack, 10, 2_000)).toBe(
      [
        "at fulfil (https://www.rampridge.xyz/assets/AppRoot-DxYz1234.js:12:345)",
        "at https://rpc.example/…",
        "at async Promise.all (index 0)",
      ].join("\n"),
    );
  });

  it("keeps Safari and Firefox frames", () => {
    const stack = [
      "fulfil@https://www.rampridge.xyz/assets/AppRoot-DxYz1234.js:12:345",
      "@https://www.rampridge.xyz/assets/index-B3x9aQ1z.js:1:99",
      "[native code]",
    ].join("\n");
    expect(scrubStack(stack, 10, 2_000)).toBe(stack);
  });

  it("limits frames and length", () => {
    const frames = Array.from({ length: 30 }, (_, i) => `    at f${i} (https://www.rampridge.xyz/assets/a.js:1:${i})`).join("\n");
    expect(scrubStack(frames, 3, 2_000).split("\n")).toHaveLength(3);
    expect(scrubStack(frames, 30, 50).length).toBe(50);
  });
});

describe("uaClass", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", "ios-safari"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1", "ios-chrome"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/11.10", "ios-inapp"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36", "android-chrome"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Mobile Safari/537.36 TwitterAndroid", "android-inapp"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0", "windows-edge"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0", "mac-firefox"],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0 Safari/537.36", "bot"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "ios-inapp"],
    ["Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15", "ios-firefox"],
    ["Twitterbot/1.0", "bot"],
    [null, "unknown"],
  ])("%s -> %s", (ua, expected) => {
    expect(uaClass(ua)).toBe(expected);
  });
});
