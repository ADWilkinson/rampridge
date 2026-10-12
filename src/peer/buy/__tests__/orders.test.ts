import { describe, expect, it } from "vitest";
import { fiatToSend, fiatToSendText, netAfterReferralFees } from "../amounts";
import { decodeSignalCall, parseFulfilledAmount, parseLockExpiry, parseSignaledIntent } from "../chain";
import { getPaymentInstructions, pickMemo } from "../instructions";
import { deserializeDismissed, deserializeOrder, memoryOrderStorage, serializeOrder, withDismissed } from "../storage";
import type { BuyOrder } from "../types";
import {
  BUYER,
  ESCROW,
  INTENT_HASH,
  ORCHESTRATOR,
  PAYEE_HASH,
  RAMPRIDGE_LEG,
  fundsLockedLog,
  intentFulfilledLog,
  intentSignaledLog,
  signalCalldata,
} from "./helpers";

function order(overrides: Partial<BuyOrder> = {}): BuyOrder {
  return {
    owner: BUYER,
    intentHash: INTENT_HASH,
    depositId: "6528",
    escrow: ESCROW,
    orchestrator: ORCHESTRATOR,
    platform: "revolut",
    currency: "GBP",
    usdcGross: 128_000_000n,
    usdcExpected: 126_784_000n,
    rate: 793_000_000_000_000_000n,
    fiatToSend: 101_510_000n,
    fiatToSendText: "101.51",
    payeeHandle: "revtag",
    payeeDetailsHash: PAYEE_HASH,
    signalTxHash: null,
    signaledAt: 1_791_711_141_000,
    expiresAt: 1_791_732_741_000,
    verifyMethodId: null,
    memo: null,
    status: "active",
    fees: null,
    paidClaimedAt: null,
    ...overrides,
  };
}

describe("fiat to send", () => {
  it("rounds intent amount x rate up to the cent", () => {
    // 49.066797 USDC at 1.019019... = 49.9999998 USD -> 50.00
    expect(fiatToSend(49_066_797n, 1_019_019_019_019_019_035n, "USD")).toBe(50_000_000n);
    // 128 USDC at 0.793 = 101.504 GBP -> 101.51
    expect(fiatToSend(128_000_000n, 793_000_000_000_000_000n, "GBP")).toBe(101_510_000n);
    // Exact amounts are not bumped.
    expect(fiatToSend(100_000_000n, 10n ** 18n, "USD")).toBe(100_000_000n);
    // A real Base intent: 111.82 USDC at 0.894294... EUR = 100.000000000000000007864 EUR. Flooring to
    // 6 decimals first gave 100.00, which the attestation releases as 111.819999 USDC.
    expect(fiatToSend(111_820_000n, 894_294_401_717_045_252n, "EUR")).toBe(100_010_000n);
  });

  it("rounds zero-decimal currencies up to whole units", () => {
    expect(fiatToSend(10_000_000n, 151_234_000_000_000_000_000n, "JPY")).toBe(1_513_000_000n);
    expect(fiatToSendText(1_513_000_000n, "JPY")).toBe("1513");
  });

  it("formats the amount to type without grouping", () => {
    expect(fiatToSendText(1_234_500_000n, "USD")).toBe("1234.50");
  });

  it("nets referral fee legs, each floored", () => {
    const pointNineFive = 9_500_000_000_000_000n; // 0.95%
    expect(netAfterReferralFees(50_000_000n, [{ fee: pointNineFive }])).toBe(49_525_000n);
    expect(netAfterReferralFees(50_000_000n, [])).toBe(50_000_000n);
    expect(netAfterReferralFees(10n, [{ fee: 10n ** 18n }])).toBe(0n);
  });
});

describe("receipt parsing", () => {
  it("reads the intent from IntentSignaled for the owner and deposit", () => {
    const logs = [intentSignaledLog({ owner: "0x000000000000000000000000000000000000dEaD", intentHash: `0x${"99".repeat(32)}` }), intentSignaledLog()];
    const parsed = parseSignaledIntent(logs, BUYER, { depositId: 6528n, orchestrator: ORCHESTRATOR });
    expect(parsed).toEqual({
      intentHash: INTENT_HASH,
      orchestrator: ORCHESTRATOR,
      depositId: 6528n,
      amount: 49_066_797n,
      rate: 1_019_019_019_019_019_035n,
      signaledAt: 1_791_711_141_000,
    });
    expect(parseSignaledIntent(logs, BUYER, { depositId: 1n })).toBeNull();
    expect(parseSignaledIntent([fundsLockedLog()], BUYER)).toBeNull();
  });

  it("reads the lock expiry and the released amount", () => {
    expect(parseLockExpiry([intentSignaledLog(), fundsLockedLog()], INTENT_HASH)).toBe(1_791_732_741_000);
    expect(parseLockExpiry([fundsLockedLog()], `0x${"00".repeat(32)}`)).toBeNull();
    expect(parseFulfilledAmount([intentFulfilledLog({ amount: 7n })], INTENT_HASH)).toBe(7n);
  });
});

describe("signed call read-back", () => {
  it("reads the referral legs and signature expiry from signalIntent calldata, ignoring the ERC-8021 suffix", () => {
    const data = signalCalldata({ referralFees: [RAMPRIDGE_LEG], signatureExpiration: 1_791_711_500n });
    expect(decodeSignalCall(data)).toEqual({
      referralFees: [{ recipient: RAMPRIDGE_LEG.recipient, fee: 5_000_000_000_000_000n }],
      signatureExpiresAt: 1_791_711_500_000,
    });
  });

  it("reads a zero signature expiry (deposit gated on-chain) as no expiry", () => {
    const data = signalCalldata({ referralFees: [RAMPRIDGE_LEG], signatureExpiration: 0n });
    expect(decodeSignalCall(data)?.signatureExpiresAt).toBeNull();
  });

  it("returns null for anything that is not a signalIntent call", () => {
    expect(decodeSignalCall("0x5149")).toBeNull();
    expect(decodeSignalCall("0x")).toBeNull();
  });
});

describe("order storage", () => {
  it("round-trips bigints and rejects malformed data", () => {
    const original = order({ memo: "🍕", verifyMethodId: "chase", platform: "zelle", currency: "USD" });
    expect(deserializeOrder(serializeOrder(original))).toEqual(original);
    expect(deserializeOrder("{")).toBeNull();
    expect(deserializeOrder(JSON.stringify({ v: 1, owner: BUYER }))).toBeNull();
    expect(deserializeOrder(serializeOrder(original).replace('"v":1', '"v":99'))).toBeNull();
  });

  it("keys orders by wallet", () => {
    const storage = memoryOrderStorage();
    storage.save(order());
    expect(storage.load(BUYER.toLowerCase() as `0x${string}`)?.intentHash).toBe(INTENT_HASH);
    expect(storage.load("0x000000000000000000000000000000000000dEaD")).toBeNull();
    storage.clear(BUYER);
    expect(storage.load(BUYER)).toBeNull();
  });

  it("round-trips the quoted fees and the paid claim", () => {
    const fees = { serviceBps: 95, service: 1_216_000n, manager: 49_116n, referrer: 640_000n, referrerBps: 50, total: 1_905_116n };
    const original = order({ fees, paidClaimedAt: 1_791_712_000_000 });
    const text = serializeOrder(original);
    expect(text).toContain('"referrer":"640000"');
    expect(deserializeOrder(text)).toEqual(original);
    expect(deserializeOrder(serializeOrder(order({ fees: { ...fees, serviceBps: null, referrerBps: null } })))?.fees).toEqual({
      ...fees,
      serviceBps: null,
      referrerBps: null,
    });
  });

  it("loads orders saved before fees and the paid claim were kept", () => {
    const legacy = JSON.parse(serializeOrder(order())) as Record<string, unknown>;
    delete legacy.fees;
    delete legacy.paidClaimedAt;
    expect(deserializeOrder(JSON.stringify(legacy))).toEqual(order({ fees: null, paidClaimedAt: null }));
    const malformed = { ...legacy, fees: { service: "1", manager: "x" }, paidClaimedAt: "soon" };
    expect(deserializeOrder(JSON.stringify(malformed))).toMatchObject({ fees: null, paidClaimedAt: null });
  });

  it("records dismissed orders per wallet, once each", () => {
    const storage = memoryOrderStorage();
    const other = `0x${"77".repeat(32)}` as const;
    storage.dismiss(BUYER, INTENT_HASH);
    storage.dismiss(BUYER, INTENT_HASH.toUpperCase().replace("0X", "0x") as `0x${string}`);
    storage.dismiss(BUYER, other);
    expect([...storage.dismissed(BUYER.toLowerCase() as `0x${string}`)]).toEqual([INTENT_HASH.toLowerCase(), other]);
    expect(storage.dismissed("0x000000000000000000000000000000000000dEaD").size).toBe(0);
    // Clearing the order does not forget the dismissal.
    storage.save(order());
    storage.clear(BUYER);
    expect(storage.dismissed(BUYER).has(INTENT_HASH.toLowerCase())).toBe(true);
  });

  it("caps the dismissal list and ignores junk", () => {
    let list: string[] = [];
    for (let i = 0; i < 60; i++) list = withDismissed(list, `0x${i.toString(16).padStart(64, "0")}`);
    expect(list).toHaveLength(50);
    expect(list.at(-1)).toBe(`0x${(59).toString(16).padStart(64, "0")}`);
    expect(deserializeDismissed('["0x12", 5, "nope"]')).toEqual([]);
    expect(deserializeDismissed("{")).toEqual([]);
  });
});

describe("payment instructions", () => {
  it("gives the exact amount, payee, link and rules", () => {
    const steps = getPaymentInstructions(order());
    expect(steps).toMatchObject({
      platform: "revolut",
      amount: "101.51",
      amountText: "£101.51",
      payee: "revtag",
      payeeDisplay: "@revtag",
      payeeLabel: "Revtag",
      deepLink: "https://revolut.me/revtag",
      qrValue: "https://revolut.me/revtag",
      needsMethodChoice: false,
      expiresAt: 1_791_732_741_000,
    });
    expect(steps.rules[0]?.text).toBe("Send exactly 101.51 GBP in one payment.");
  });

  it("asks for a Zelle bank before giving a link", () => {
    const zelle = order({ platform: "zelle", currency: "USD", payeeHandle: "seller@example.com" });
    expect(getPaymentInstructions(zelle)).toMatchObject({ needsMethodChoice: true, deepLink: null });
    expect(getPaymentInstructions({ ...zelle, verifyMethodId: "chase" })).toMatchObject({
      needsMethodChoice: false,
      method: { id: "chase" },
    });
  });

  it("puts the memo in Venmo links and only picks memos where needed", () => {
    expect(pickMemo("revolut")).toBeNull();
    const memo = pickMemo("venmo", () => 0);
    expect(memo).toBe("🍕");
    const venmo = order({ platform: "venmo", currency: "USD", payeeHandle: "alice", memo });
    expect(getPaymentInstructions(venmo).deepLink).toContain(`note=${encodeURIComponent("🍕")}`);
  });

  it("withholds links until the payee handle is known", () => {
    expect(getPaymentInstructions(order({ payeeHandle: null }))).toMatchObject({ payee: null, deepLink: null });
  });

  it("shows and copies Monobank amounts in the platform's own number format, like Peer", () => {
    const uah = order({ platform: "monobank", currency: "UAH", payeeHandle: "UA213223130000026007233566001", fiatToSendText: "1234.57" });
    const steps = getPaymentInstructions(uah);
    // uk-UA groups with a no-break space and uses a decimal comma.
    expect(steps.amount).toBe("1234,57");
    expect(steps.amountText).toBe("₴1\u00a0234,57");
    expect(steps.rules[0]?.text).toContain("1\u00a0234,57 UAH");
    // Every other platform keeps plain decimals.
    expect(getPaymentInstructions(order()).amount).toBe("101.51");
  });
});
