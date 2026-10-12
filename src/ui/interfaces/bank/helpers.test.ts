import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CashFill, CashPayoutInfo } from "@zkp2p/cash";
import type { SellIssue } from "@/peer/sell";
import {
  buyerHold,
  buyerLine,
  depositLabel,
  EXTENSION_DESKTOP_ONLY,
  EXTENSION_INSTALL_HINT,
  errorBlocksForm,
  errorButtons,
  examineLines,
  examineSentence,
  fiatText,
  fillRows,
  filterOrders,
  formIssue,
  holdMessage,
  isPeerPayOnly,
  itemMenuOptions,
  legSetupIssue,
  legStatus,
  liveBuyer,
  newlyActiveSteps,
  onlyPeerPay,
  orderSentence,
  orderStack,
  payoutGroups,
  PEER_PAY_ONLY_PLATFORMS,
  PEER_PAY_ONLY_TEXT,
  preciseRate,
  rateModeText,
  rateText,
  remainingAmount,
  reviewLegs,
  reviewWarning,
  shortAddr,
  stepRows,
  usdcInputText,
  usdcNumber,
  usdcText,
  usdcUnitsFromNumber,
  wholeUsdc,
} from "./helpers";

const U = (n: number) => BigInt(Math.round(n * 1_000_000));

function payout(platform: string, currency: string, extra: Partial<CashPayoutInfo> = {}): CashPayoutInfo {
  return {
    platform,
    platformHash: "0x01",
    currency,
    payeeHash: "0x02",
    active: true,
    pricing: { marketRate: true, oracleRate: currency === "GBP" ? 0.786 : 1 },
    ...extra,
  };
}

function row(extra: Partial<Parameters<typeof examineLines>[0]["row"]> = {}) {
  return {
    state: "awaiting-buyer" as const,
    totalAmount: U(500),
    filledAmount: 0n,
    pendingAmount: 0n,
    returnedAmount: 0n,
    availableAmount: U(500),
    isInFlight: true,
    ...extra,
  };
}

describe("money formatting", () => {
  it("shows USDC truncated to cents with grouping, never rounded up", () => {
    expect(usdcText(1_250_409_999n)).toBe("1,250.40");
    expect(usdcText(0n)).toBe("0.00");
    expect(usdcText(U(12_500))).toBe("12,500.00");
  });

  it("uses symbols the RuneScape fonts draw, and ISO codes otherwise", () => {
    expect(fiatText(196.5, "GBP")).toBe("£196.50");
    expect(fiatText(1234.5, "USD")).toBe("$1,234.50");
    expect(fiatText(10, "EUR")).toBe("€10.00");
    expect(fiatText(1234.5, "AUD")).toBe("1,234.50 AUD");
    expect(fiatText(85.4, "inr")).toBe("85.40 INR");
  });

  it("formats rates with four decimals, two for large rates", () => {
    expect(rateText(0.786, "GBP")).toBe("1 USDC = 0.7860 GBP");
    expect(rateText(16288.5, "IDR")).toBe("1 USDC = 16,288.50 IDR");
  });

  it("converts between pad numbers and USDC units exactly", () => {
    expect(usdcInputText(250)).toBe("250");
    expect(usdcInputText(99.5)).toBe("99.5");
    expect(usdcInputText(0.05)).toBe("0.05");
    expect(usdcInputText(0)).toBe("");
    expect(usdcUnitsFromNumber(12.34)).toBe(12_340_000n);
    expect(usdcUnitsFromNumber(0)).toBeNull();
    expect(usdcNumber(1_250_409_999n)).toBe(1250.4);
    expect(usdcNumber(null)).toBe(0);
  });

  it("shortens addresses with ASCII dots and labels deposit ids", () => {
    expect(shortAddr("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234...5678");
    expect(shortAddr("")).toBe("");
    expect(depositLabel("0x2f121cddca6d652f35e8b3e560f9760898888888_1300")).toBe("#1300 (0x2f12...8888)");
    expect(depositLabel("weird")).toBe("weird");
  });
});

describe("stack sizing", () => {
  it("sizes the coin stack to what is left, in whole USDC", () => {
    expect(remainingAmount({ totalAmount: U(250), filledAmount: U(120), returnedAmount: 0n })).toBe(U(130));
    expect(orderStack({ totalAmount: U(250), filledAmount: U(120), returnedAmount: 0n })).toEqual({ quantity: 130, placeholder: false, spriteQuantity: 130 });
    expect(orderStack({ totalAmount: U(3.5), filledAmount: 0n, returnedAmount: 0n }).quantity).toBe(3);
  });

  it("keeps a sub-dollar remainder visible as a real (not placeholder) stack", () => {
    const stack = orderStack({ totalAmount: U(10), filledAmount: U(9.5), returnedAmount: 0n });
    expect(stack).toEqual({ quantity: 0, placeholder: false, spriteQuantity: 1 });
  });

  it("draws an empty order as a placeholder with the original pile", () => {
    expect(orderStack({ totalAmount: U(100), filledAmount: U(100), returnedAmount: 0n })).toEqual({ quantity: 0, placeholder: true, spriteQuantity: 100 });
    expect(remainingAmount({ totalAmount: U(10), filledAmount: U(8), returnedAmount: U(5) })).toBe(0n);
  });

  it("floors whole USDC and caps at a safe integer", () => {
    expect(wholeUsdc(U(1.999999))).toBe(1);
    expect(wholeUsdc(-5n)).toBe(0);
    expect(wholeUsdc(10n ** 30n)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("filters bank tabs by whether the order is still live", () => {
    const rows = [{ isInFlight: true, id: 1 }, { isInFlight: false, id: 2 }];
    expect(filterOrders(rows, "all").map((r) => r.id)).toEqual([1, 2]);
    expect(filterOrders(rows, "open").map((r) => r.id)).toEqual([1]);
    expect(filterOrders(rows, "completed").map((r) => r.id)).toEqual([2]);
  });
});

describe("examine text", () => {
  it("states what is left, the state, fills, payout legs, rate mode and the order's sentence", () => {
    const lines = examineLines({
      row: row({ state: "delivering", totalAmount: U(250), filledAmount: U(120), pendingAmount: U(50), availableAmount: U(80) }),
      payouts: [payout("revolut", "GBP"), payout("revolut", "EUR")],
      advertised: true,
    });
    expect(lines).toEqual([
      "130.00 USDC left of 250.00 USDC.",
      "Part filled, a buyer is paying.",
      "Filled: 120.00 USDC. Held for a buyer: 50.00 USDC.",
      "Paid by Revolut in GBP or EUR.",
      "Rate: Market rate (0% spread), now 0.7860 GBP per USDC.",
      "120.00 USDC of 250.00 USDC sold. A buyer is paying for 50.00 USDC. 80.00 USDC is still for sale.",
      "Advertised as your stall.",
    ]);
  });

  it("labels each platform's rate when an order has several payout methods, and paused legs", () => {
    const lines = examineLines({
      row: row({ returnedAmount: U(20) }),
      payouts: [payout("venmo", "USD"), payout("wise", "EUR", { active: false, pricing: { marketRate: false, fixedAtCreation: true, fixedRate: 0.92 } })],
    });
    expect(lines).toContain("Filled: 0.00 USDC. Returned: 20.00 USDC.");
    expect(lines).toContain("Paid by Venmo in USD.");
    expect(lines).toContain("Paid by Wise in EUR (paused).");
    expect(lines).toContain("Rate (Venmo): Market rate (0% spread), now 1.0000 USD per USDC.");
    expect(lines).toContain("Rate (Wise): Fixed at 0.9200 EUR per USDC.");
    // Venmo is one of the payouts only Peer Pay merchants buy from.
    expect(lines).toContain(PEER_PAY_ONLY_TEXT);
    expect(examineLines({ row: row(), payouts: [payout("revolut", "GBP")] })).not.toContain(PEER_PAY_ONLY_TEXT);
  });

  it("says each fact once for an offer waiting for a buyer", () => {
    const lines = examineLines({ row: row(), payouts: [payout("revolut", "GBP")] });
    expect(lines[0]).toBe("500.00 USDC left of 500.00 USDC.");
    expect(lines[1]).toBe("Waiting for a buyer.");
    expect(lines.at(-1)).toBe("You can withdraw it at any time.");
    expect(lines.join(" ")).not.toContain("is for sale, waiting for a buyer");
  });

  it("says payout details are loading rather than inventing them", () => {
    const lines = examineLines({ row: row(), payouts: null, payoutsLoading: true });
    expect(lines).toContain("Loading payout details...");
    expect(lines.some((l) => l.startsWith("Rate"))).toBe(false);
  });

  it("only describes pricing the chain reports", () => {
    expect(rateModeText(null)).toBeNull();
    expect(rateModeText({ marketRate: false })).toBeNull();
    expect(rateModeText({ marketRate: true })).toBe("Market rate (0% spread)");
    expect(rateModeText({ marketRate: false, spreadBps: 150 })).toBe("Market rate +1.50%");
  });

  it("describes the paying buyer's Peer record without overstating it", () => {
    const a = "0x1234567890abcdef1234567890abcdef12345678";
    expect(buyerLine(a, null, true)).toBe("Checking the record of the buyer paying now (0x1234...5678)...");
    expect(buyerLine(a, null)).toBe("A buyer (0x1234...5678) is paying now.");
    expect(buyerLine(a, { fulfilled: 0, pruned: 0 })).toBe("The buyer paying now (0x1234...5678) has no finished trades on Peer yet.");
    expect(buyerLine(a, { fulfilled: 13, pruned: 1 })).toBe("The buyer paying now (0x1234...5678) has paid for 13 of 14 trades on Peer.");
  });

  it("tells an expired buyer hold apart from a live one, and says what Withdraw-All does", () => {
    const now = 10_000;
    const signalled = (n: number, expiresAt: number, extra: Partial<CashFill> = {}): CashFill => ({
      intentHash: `0x${n}`,
      status: "SIGNALED",
      amount: U(80),
      buyer: `0x${String(n).repeat(40)}`,
      signaledAt: n,
      expiresAt,
      ...extra,
    });
    // List rows carry no fills, so a hold is unknown until the order's own read loads.
    expect(buyerHold({ pendingAmount: U(80), fills: [] }, now)).toBe("unknown");
    expect(buyerHold({ pendingAmount: 0n, fills: [] }, now)).toBe("none");
    expect(buyerHold({ pendingAmount: U(80), fills: [signalled(1, now + 60)] }, now)).toBe("live");
    expect(buyerHold({ pendingAmount: U(80), fills: [signalled(1, now - 60)] }, now)).toBe("expired");
    expect(buyerHold({ pendingAmount: U(80), fills: [signalled(1, now + 60, { isExpired: true })] }, now)).toBe("expired");
    expect(liveBuyer([signalled(1, now - 60), signalled(2, now + 60)], now)).toBe(`0x${"2".repeat(40)}`);
    expect(liveBuyer([signalled(1, now - 60)], now)).toBeNull();

    const expired = row({ state: "matched", totalAmount: U(300), pendingAmount: U(80), availableAmount: U(220) });
    const lines = examineLines({ row: expired, payouts: null, hold: "expired" });
    expect(lines).toEqual([
      "300.00 USDC left of 300.00 USDC.",
      "A buyer's time ran out.",
      "Filled: 0.00 USDC. Held by an expired buyer: 80.00 USDC.",
      "The buyer's time ran out. Withdraw-All returns everything left, including the 80.00 USDC they held.",
    ]);
    expect(lines.join(" ")).not.toContain("is paying");
    expect(examineSentence(expired, "live")).toBe("A buyer is paying for 80.00 USDC. It goes to them once Peer proves their payment. 220.00 USDC is still for sale.");
  });

  it("describes every order state in the bank's own words, with cents", () => {
    const sentence = (extra: Partial<Parameters<typeof orderSentence>[0]>) => orderSentence({ ...row(), ...extra });
    expect(sentence({})).toBe("500.00 USDC is for sale, waiting for a buyer. You can withdraw it at any time.");
    // A partial withdrawal leaves less for sale than the order once held.
    expect(sentence({ totalAmount: U(500), returnedAmount: U(100), availableAmount: U(400) })).toBe(
      "400.00 USDC is for sale, waiting for a buyer. You can withdraw it at any time.",
    );
    expect(sentence({ state: "matched", pendingAmount: U(500), availableAmount: 0n })).toBe(
      "A buyer is paying for 500.00 USDC. It goes to them once Peer proves their payment.",
    );
    expect(sentence({ state: "delivering", filledAmount: U(120), pendingAmount: 0n, availableAmount: U(380) })).toBe(
      "120.00 USDC of 500.00 USDC sold. 380.00 USDC is still for sale.",
    );
    expect(sentence({ state: "delivered", filledAmount: U(1250.4), totalAmount: U(1250.4), availableAmount: 0n })).toBe(
      "Sold out: buyers paid for all 1,250.40 USDC.",
    );
    expect(sentence({ state: "returned", filledAmount: U(120), returnedAmount: U(380), availableAmount: 0n })).toBe(
      "120.00 USDC sold and 380.00 USDC returned to your wallet.",
    );
    expect(sentence({ state: "returned", returnedAmount: U(500), availableAmount: 0n })).toBe("No buyer paid. 500.00 USDC returned to your wallet.");
    expect(sentence({ state: "returned", availableAmount: 0n })).toBe("No buyer paid. This offer is closed.");
  });

  it("never uses the library's cash-out and fill wording", () => {
    const states = ["awaiting-buyer", "matched", "delivering", "delivered", "returned"] as const;
    for (const state of states) {
      const text = orderSentence({ ...row(), state, filledAmount: U(120), pendingAmount: U(50), returnedAmount: U(10), availableAmount: U(320) });
      expect(text).not.toMatch(/cash-out|fill/i);
    }
  });

  it("groups payouts by platform", () => {
    const groups = payoutGroups([payout("revolut", "GBP"), payout("revolut", "EUR"), payout("venmo", "USD")]);
    expect(groups.map((g) => [g.name, g.currencies, g.pricingCurrency])).toEqual([
      ["Revolut", ["GBP", "EUR"], "GBP"],
      ["Venmo", ["USD"], "USD"],
    ]);
  });
});

describe("item menu", () => {
  const live = {
    canWithdraw: true,
    canTopUp: true,
    availableAmount: U(500),
    isInFlight: true,
    totalAmount: U(500),
    filledAmount: 0n,
    returnedAmount: 0n,
    order: { withdrawn: false },
  };
  const ctx = { advertised: false, busy: false, hold: null };

  it("offers the bank's options in order for a live order", () => {
    expect(itemMenuOptions(live, ctx).map((o) => o.verb)).toEqual(["Withdraw-All", "Withdraw-X", "Top-up", "Advertise", "Examine"]);
  });

  it("swaps Advertise for Stop advertising on the advertised order", () => {
    expect(itemMenuOptions(live, { ...ctx, advertised: true }).map((o) => o.verb)).toContain("Stop advertising");
  });

  it("removes every money action while anything is in flight", () => {
    expect(itemMenuOptions(live, { ...ctx, busy: true }).map((o) => o.verb)).toEqual(["Examine"]);
  });

  it("replaces money actions with one explaining entry while the order is held", () => {
    expect(itemMenuOptions(live, { ...ctx, hold: "unconfirmed" }).map((o) => [o.action, o.verb])).toEqual([
      ["hold", "Unconfirmed"],
      ["advertise", "Advertise"],
      ["examine", "Examine"],
    ]);
    expect(itemMenuOptions(live, { ...ctx, hold: "updating" }).map((o) => o.verb)).toEqual(["Updating...", "Advertise", "Examine"]);
    expect(itemMenuOptions(live, { ...ctx, hold: "checking" }).map((o) => o.verb)).toEqual(["Checking...", "Advertise", "Examine"]);
    expect(holdMessage("unconfirmed")).toBe("An earlier withdrawal or top-up on this offer hasn't been confirmed.");
  });

  it("offers Withdraw-All once the order's read shows the buyer's time ran out", () => {
    // List row: any hold counts as live, so the SDK offers no withdraw.
    const listRow = { ...live, canWithdraw: false, availableAmount: U(420), totalAmount: U(500) };
    expect(itemMenuOptions(listRow, { ...ctx, hold: "checking" }).map((o) => o.verb)).toEqual(["Checking...", "Advertise", "Examine"]);
    // Single-order read with an expired fill: the SDK allows withdraw (it prunes the intent first).
    const detail = { ...listRow, canWithdraw: true };
    expect(itemMenuOptions(detail, ctx).map((o) => o.verb)).toEqual(["Withdraw-All", "Withdraw-X", "Top-up", "Advertise", "Examine"]);
  });

  it("leaves out Advertise for an order only Peer Pay merchants can buy from", () => {
    const verbs = (payouts: { platform: string }[] | null, advertised = false) =>
      itemMenuOptions({ ...live, payouts }, { ...ctx, advertised }).map((o) => o.verb);
    expect(verbs([{ platform: "venmo" }])).toEqual(["Withdraw-All", "Withdraw-X", "Top-up", "Examine"]);
    expect(verbs([{ platform: "venmo" }, { platform: "paypal" }])).not.toContain("Advertise");
    // Any player-takeable payout keeps the order advertisable.
    expect(verbs([{ platform: "venmo" }, { platform: "revolut" }])).toContain("Advertise");
    // Unknown payouts (a list row) keep the original menu.
    expect(verbs(null)).toContain("Advertise");
    // An order already advertised can still be taken down.
    expect(verbs([{ platform: "paypal" }], true)).toContain("Stop advertising");
  });

  it("offers only Examine for a finished order", () => {
    const done = { ...live, canWithdraw: false, canTopUp: false, availableAmount: 0n, isInFlight: false, filledAmount: U(500) };
    expect(itemMenuOptions(done, ctx).map((o) => o.verb)).toEqual(["Examine"]);
  });
});

type LegInput = Parameters<typeof legStatus>[0];

function leg(extra: Partial<LegInput> = {}): LegInput {
  return {
    platform: "revolut",
    payee: "zezima",
    offchainId: "zezima",
    check: { status: "done", key: "k", result: { kind: "valid", offchainId: "zezima", payeeHash: null, confirmed: true } },
    issues: [],
    registration: null,
    canRegister: false,
    platformInfo: {
      platform: "revolut",
      name: "Revolut",
      currencies: ["GBP"],
      payeeHint: "Revtag",
      payeeLabel: "Revtag",
      payeePlaceholder: "revtag",
      requiresIdentityAttestation: false,
      registration: null,
      payeeEnrollment: null,
      singleOrder: null,
    },
    ...extra,
  };
}

const wise = {
  platform: "wise",
  name: "Wise",
  currencies: ["EUR" as const],
  payeeHint: "Wisetag",
  payeeLabel: "Wisetag",
  payeePlaceholder: "wisetag",
  requiresIdentityAttestation: true,
  registration: "peerExtensionIdentity" as const,
  payeeEnrollment: null,
  singleOrder: null,
};

describe("leg validation summaries", () => {
  const ext = { extensionSupported: true };

  it("says Handle found in green only when Peer confirmed the account exists", () => {
    expect(legStatus(leg(), ext)).toEqual({ tone: "good", text: "Handle found", actions: [] });
  });

  it("warns in yellow with the exact handle when Peer accepted it without confirming the account", () => {
    const zelle = leg({
      platform: "zelle",
      payee: " Zezima@Example.com ",
      offchainId: "zezima@example.com",
      platformInfo: null,
      check: { status: "done", key: "k", result: { kind: "valid", offchainId: "zezima@example.com", payeeHash: null, confirmed: false } },
    });
    expect(legStatus(zelle, ext)).toEqual({
      tone: "warn",
      text: "Peer can't confirm this account exists. Buyers will pay exactly: zezima@example.com",
      actions: [],
    });
    const xmoney = leg({
      platform: "xmoney",
      payee: "@zezima_rs",
      offchainId: "zezima_rs",
      platformInfo: null,
      check: { status: "done", key: "k", result: { kind: "valid", offchainId: "zezima_rs", payeeHash: null, confirmed: false } },
    });
    expect(legStatus(xmoney, ext).text).toBe("Peer can't confirm this account exists. Buyers will pay exactly: @zezima_rs");
  });

  it("shows nothing before a platform or handle is chosen", () => {
    expect(legStatus(leg({ platform: "" }), ext).text).toBe("");
    expect(legStatus(leg({ payee: " " }), ext).text).toBe("");
  });

  it("reports a check in flight", () => {
    expect(legStatus(leg({ check: { status: "checking", key: "k" } }), ext)).toMatchObject({ tone: "pending", text: "Checking your handle..." });
  });

  it("explains a local format problem with the module's message", () => {
    const issue: SellIssue = { code: "PAYEE_INVALID", severity: "error", legId: "1", message: "Use your Revtag." };
    expect(legStatus(leg({ offchainId: null, issues: [issue] }), ext)).toEqual({ tone: "bad", text: "Use your Revtag.", actions: [] });
  });

  it("says a handle was not found, with a re-check when it cannot be registered", () => {
    const status = legStatus(leg({ check: { status: "done", key: "k", result: { kind: "notFound", offchainId: "x", message: "m", registration: null } } }), ext);
    expect(status).toEqual({ tone: "bad", text: "That handle was not found on Revolut.", actions: ["recheck"] });
  });

  it("offers Peer verification through the extension when the sell module supports it", () => {
    const status = legStatus(
      leg({ platformInfo: wise, platform: "wise", canRegister: true, check: { status: "done", key: "k", result: { kind: "needsIdentityAttestation", offchainId: "x", message: "m", registration: "peerExtensionIdentity" } } }),
      ext,
    );
    expect(status).toEqual({ tone: "warn", text: "This handle needs a one-time Peer verification.", actions: ["register"] });
  });

  it("links to peer.xyz when this browser cannot run the extension", () => {
    const status = legStatus(
      leg({ platformInfo: wise, platform: "wise", canRegister: true, check: { status: "done", key: "k", result: { kind: "needsIdentityAttestation", offchainId: "x", message: "m", registration: "peerExtensionIdentity" } } }),
      { extensionSupported: false },
    );
    expect(status.actions).toEqual(["registerWeb", "recheck"]);
    expect(status.text).toBe(`This handle needs a one-time Peer verification. ${EXTENSION_DESKTOP_ONLY}`);
  });

  it("offers to install PeerAuth at the moment a handle needs it, then to look for it again", () => {
    const needs = leg({
      platformInfo: wise,
      platform: "wise",
      canRegister: true,
      check: { status: "done", key: "k", result: { kind: "needsIdentityAttestation", offchainId: "x", message: "m", registration: "peerExtensionIdentity" } },
    });
    const missing = legStatus(needs, { extensionSupported: true, extension: "needs_install" });
    expect(missing.actions).toEqual(["install"]);
    expect(missing.text).toBe("This handle needs a one-time Peer verification. It runs through the Peer extension (PeerAuth): install it in Chrome first.");
    const opened = legStatus(needs, { extensionSupported: true, extension: "needs_install", installPending: true });
    expect(opened.actions).toEqual(["install", "installed"]);
    expect(opened.text).toBe(`This handle needs a one-time Peer verification. ${EXTENSION_INSTALL_HINT}`);
    // Found (approval or registration follow in the extension itself).
    expect(legStatus(needs, { extensionSupported: true, extension: "needs_connection" }).actions).toEqual(["register"]);
    expect(legStatus(needs, { extensionSupported: true, extension: "ready" }).actions).toEqual(["register"]);
    // A Cash App handle Peer doesn't know yet registers the same way.
    const cashapp = leg({
      platform: "cashapp",
      canRegister: true,
      platformInfo: { ...wise, platform: "cashapp", name: "Cash App", requiresIdentityAttestation: false, registration: "peerExtensionCredential" },
      check: { status: "done", key: "k", result: { kind: "notFound", offchainId: "x", message: "m", registration: "peerExtensionCredential" } },
    });
    expect(legStatus(cashapp, { extensionSupported: true, extension: "needs_install" }).actions).toEqual(["install"]);
  });

  it("shows registration progress with a cancel, and failures with the next step", () => {
    expect(legStatus(leg({ platformInfo: wise, platform: "wise", registration: { phase: "awaitingCapture", error: null } }), ext)).toEqual({
      tone: "pending",
      text: "Log in to Wise in the tab Peer opened.",
      actions: ["cancelRegistration"],
    });
    const missing = { code: "EXTENSION_MISSING", message: "Install the PeerAuth extension in desktop Chrome, then try again." } as never;
    expect(legStatus(leg({ platformInfo: wise, platform: "wise", canRegister: true, registration: { phase: "failed", error: missing } }), ext)).toEqual({
      tone: "bad",
      text: "Install the PeerAuth extension in desktop Chrome, then try again.",
      actions: ["install"],
    });
    expect(legStatus(leg({ platformInfo: wise, platform: "wise", canRegister: true, registration: { phase: "failed", error: missing } }), { ...ext, extension: "ready" }).actions).toEqual([
      "register",
    ]);
  });

  it("offers a retry only for retryable check failures", () => {
    const retryable = leg({ check: { status: "done", key: "k", result: { kind: "error", message: "Couldn't check.", retryable: true } } });
    const final = leg({ check: { status: "done", key: "k", result: { kind: "error", message: "No.", retryable: false } } });
    expect(legStatus(retryable, ext).actions).toEqual(["recheck"]);
    expect(legStatus(final, ext).actions).toEqual([]);
  });

  it("surfaces a leg's setup issue that the handle line does not explain", () => {
    const issues: SellIssue[] = [
      { code: "PAYEE_CHECKING", severity: "pending", legId: "1", message: "Checking..." },
      { code: "CURRENCY_REQUIRED", severity: "error", legId: "1", message: "Choose a currency." },
    ];
    expect(legSetupIssue(issues)?.code).toBe("CURRENCY_REQUIRED");
    expect(legSetupIssue(issues.slice(0, 1))).toBeNull();
  });

  it("leaves Zelle enrolment to its checkbox, and still shows a currency problem under the leg", () => {
    const currency: SellIssue = { code: "CURRENCY_UNSUPPORTED", severity: "error", legId: "1", message: "Zelle can't pay out in EUR." };
    const enrol: SellIssue = { code: "PAYEE_ENROLLMENT_REQUIRED", severity: "error", legId: "1", message: "Confirm this Zelle email is enrolled." };
    expect(legSetupIssue([enrol])).toBeNull();
    expect(legSetupIssue([enrol, currency])).toEqual(currency);
  });

  it("puts Alipay's minimum deposit on the order line, above Deposit", () => {
    const single: SellIssue = { code: "AMOUNT_BELOW_SINGLE_ORDER_MIN", severity: "error", message: "Alipay orders must be at least 10 USDC." };
    expect(formIssue([{ code: "PAYEE_ENROLLMENT_REQUIRED", severity: "error", legId: "1", message: "x" }, single])).toEqual(single);
  });

  it("picks one order-level line, errors before pending, never gas or login", () => {
    const issues: SellIssue[] = [
      { code: "NO_GAS", severity: "error", message: "gas" },
      { code: "BALANCE_UNKNOWN", severity: "pending", message: "Checking your USDC balance..." },
      { code: "PAYEE_REQUIRED", severity: "error", legId: "1", message: "Enter your Revtag." },
      { code: "AMOUNT_ABOVE_BALANCE", severity: "error", message: "You only have 500.00 USDC." },
    ];
    expect(formIssue(issues)?.message).toBe("You only have 500.00 USDC.");
    expect(formIssue(issues.slice(0, 3))?.code).toBe("BALANCE_UNKNOWN");
    expect(formIssue([{ code: "WALLET_REQUIRED", severity: "error", message: "Log in to trade." }])).toBeNull();
  });
});

describe("Peer Pay only payouts", () => {
  it("knows Venmo and PayPal deposits go to Peer Pay merchants only", () => {
    expect(isPeerPayOnly("venmo")).toBe(true);
    expect(isPeerPayOnly("PayPal")).toBe(true);
    expect(isPeerPayOnly("revolut")).toBe(false);
    expect(isPeerPayOnly("")).toBe(false);
    expect(isPeerPayOnly(null)).toBe(false);
    expect(onlyPeerPay([{ platform: "venmo" }, { platform: "paypal" }])).toBe(true);
    expect(onlyPeerPay([{ platform: "venmo" }, { platform: "wise" }])).toBe(false);
    expect(onlyPeerPay([])).toBe(false);
    expect(onlyPeerPay(null)).toBe(false);
    expect(PEER_PAY_ONLY_TEXT).toBe("Venmo and PayPal sell orders are filled by Peer Pay merchants, not by players in the bank.");
  });

  it("matches the platforms @zkp2p/cash puts behind Peer Pay's whitelist", () => {
    // 0.7.2 keeps CASH_RESTRICTED_PLATFORMS out of its public exports, so read it from the installed build.
    const dist = dirname(createRequire(import.meta.url).resolve("@zkp2p/cash"));
    const source = readdirSync(dist)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(dist, f), "utf8"))
      .join("\n");
    const match = /CASH_RESTRICTED_PLATFORMS = (?:\/\* @__PURE__ \*\/ )?new Set\(\[([^\]]*)\]\)/.exec(source);
    expect(match, "CASH_RESTRICTED_PLATFORMS not found in @zkp2p/cash").not.toBeNull();
    const library = [...match![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.toLowerCase()).sort();
    expect([...PEER_PAY_ONLY_PLATFORMS].sort()).toEqual(library);
  });
});

describe("seller spread", () => {
  it("states a spread order's pricing as the market rate plus or minus the spread", () => {
    expect(rateModeText({ marketRate: false, kind: "oracle_chainlink", spreadBps: 100 } as never)).toBe("Market rate +1.00%");
    expect(rateModeText({ marketRate: false, kind: "oracle_chainlink", spreadBps: -35 } as never)).toBe("Market rate -0.35%");
    expect(rateModeText({ marketRate: true, kind: "oracle_chainlink", spreadBps: 0, oracleRate: 0.9213 } as never, "EUR")).toBe("Market rate (0% spread), now 0.9213 EUR per USDC");
  });

  it("shows rates to about five significant figures, so a 0.1% step always shows", () => {
    expect(preciseRate(0.7554)).toBe("0.7554");
    expect(preciseRate(0.7554 * 1.001)).toBe("0.7562");
    expect(preciseRate(7.1234)).toBe("7.1234");
    expect(preciseRate(84.1234)).toBe("84.123");
    expect(preciseRate(84.1234 * 1.001)).toBe("84.208");
    expect(preciseRate(1234.5)).toBe("1,234.50");
    expect(preciseRate(0.012345)).toBe("0.01235");
    expect(preciseRate(0)).toBe("0");
  });
});

describe("review before depositing", () => {
  const valid = (offchainId: string, confirmed: boolean) =>
    ({ status: "done", key: "k", result: { kind: "valid", offchainId, payeeHash: null, confirmed } }) as const;

  it("lists every leg with its full handle, currencies and whether Peer confirmed it", () => {
    const rows = reviewLegs([
      { ...leg(), id: "a", currencies: ["GBP", "EUR"] },
      {
        ...leg({ platform: "zelle", payee: "zezima.the.great.banker@example-mail.com", offchainId: "zezima.the.great.banker@example-mail.com", platformInfo: null }),
        id: "b",
        currencies: ["USD"],
        check: valid("zezima.the.great.banker@example-mail.com", false),
      },
    ]);
    expect(rows).toEqual([
      {
        id: "a",
        platform: "revolut",
        name: "Revolut",
        currencies: "GBP or EUR",
        currencyCodes: ["GBP", "EUR"],
        handle: "@zezima",
        confirmed: true,
        warning: null,
      },
      {
        id: "b",
        platform: "zelle",
        name: "Zelle",
        currencies: "USD",
        currencyCodes: ["USD"],
        handle: "zezima.the.great.banker@example-mail.com",
        confirmed: false,
        warning: null,
      },
    ]);
  });

  it("carries Alipay's single-order warning", () => {
    const base = leg();
    const alipayInfo = { ...base.platformInfo!, platform: "alipay", name: "Alipay", singleOrder: { minAmount: 10_000_000n, warning: "Create no more than 3 a day." } };
    const [alipay] = reviewLegs([
      { ...leg({ platform: "alipay", payee: "z@example.com", offchainId: "z@example.com", platformInfo: alipayInfo }), id: "b", currencies: ["CNY"], check: valid("z@example.com", true) },
    ])!;
    expect(alipay!.warning).toBe("Create no more than 3 a day.");
  });

  it("refuses to review an order with a leg that isn't ready", () => {
    const ready = { ...leg(), id: "a", currencies: ["GBP" as const] };
    expect(reviewLegs([])).toBeNull();
    expect(reviewLegs([ready, { ...ready, id: "b", check: { status: "checking", key: "k" } }])).toBeNull();
    expect(reviewLegs([{ ...ready, offchainId: null }])).toBeNull();
    expect(reviewLegs([{ ...ready, check: { status: "done", key: "k", result: { kind: "error", message: "No.", retryable: true } } }])).toBeNull();
    // A result for a different handle than the one typed is never shown as this one.
    expect(reviewLegs([{ ...ready, offchainId: "zezlma", check: valid("zezima", true) }])).toBeNull();
  });

  it("says what a wrong handle costs, for one handle or several", () => {
    expect(reviewWarning(1)).toBe("Buyers pay exactly this handle. If it's wrong, they pay someone else and still receive your USDC.");
    expect(reviewWarning(2)).toBe("Buyers pay exactly these handles. If one is wrong, they pay someone else and still receive your USDC.");
  });
});

describe("submission steps and recovery", () => {
  it("draws steps in order without skipped ones", () => {
    expect(stepRows({ approve: "done", createDeposit: "active", accessPolicy: "skipped" })).toEqual([
      { id: "approve", label: "Approving your USDC", status: "done" },
      { id: "createDeposit", label: "Creating your offer", status: "active" },
    ]);
    expect(stepRows(null)).toEqual([]);
  });

  it("announces each step once as it becomes active", () => {
    const pending = { approve: "pending", createDeposit: "pending", accessPolicy: "pending" } as const;
    const sending = { approve: "active", createDeposit: "active", accessPolicy: "pending" } as const;
    const policy = { approve: "done", createDeposit: "done", accessPolicy: "active" } as const;
    expect(newlyActiveSteps(pending, sending)).toEqual(["Approving your USDC...", "Creating your offer..."]);
    expect(newlyActiveSteps(sending, sending)).toEqual([]);
    expect(newlyActiveSteps(sending, policy)).toEqual(["Setting buyer access..."]);
  });

  it("never offers a new deposit while one may be on-chain", () => {
    const reconcile = { recovery: { action: "reconcile" as const, label: "Check status", hint: "" } };
    expect(errorButtons(reconcile)).toEqual([{ kind: "reconcile", label: "Check status" }]);
    expect(errorButtons({ recovery: { ...reconcile.recovery, canDiscard: true } }).map((b) => b.kind)).toEqual(["reconcile", "discard"]);
    expect(errorButtons({ recovery: { action: "retryAccessPolicy", label: "Finish setup", hint: "" } })).toEqual([{ kind: "recover", label: "Finish setup" }]);
    expect(errorBlocksForm(reconcile)).toBe(true);
    expect(errorBlocksForm({ recovery: { action: "retryAccessPolicy", label: "", hint: "" } })).toBe(true);
  });

  it("lets nothing-sent errors go back to the form", () => {
    const retry = { recovery: { action: "retry" as const, label: "Try again", hint: "" } };
    expect(errorButtons(retry).map((b) => b.kind)).toEqual(["recover", "dismiss"]);
    expect(errorButtons({ recovery: { action: "addGas", label: "Add ETH", hint: "" } })).toEqual([{ kind: "dismiss", label: "OK" }]);
    expect(errorBlocksForm(retry)).toBe(false);
    expect(errorBlocksForm(null)).toBe(false);
  });
});

describe("collection box fills", () => {
  it("lists fills newest first with what each buyer paid, and never says an expired buyer owes money", () => {
    const fills: CashFill[] = [
      { intentHash: "0xa", status: "FULFILLED", amount: U(60), buyer: "0x1111111111111111111111111111111111111111", currency: "USD", fiatOwed: 60, fiatPaid: 60, paidCurrency: "USD", releasedAmount: U(60), signaledAt: 100, fulfilledAt: 200 },
      { intentHash: "0xb", status: "PRUNED", amount: U(30), buyer: "0x2222222222222222222222222222222222222222", currency: "GBP", fiatOwed: 23.58, signaledAt: 300 },
      { intentHash: "0xc", status: "SIGNALED", amount: U(5), buyer: "0x3333333333333333333333333333333333333333", currency: "EUR", fiatOwed: 4.61, signaledAt: 50, expiresAt: 2_000 },
      { intentHash: "0xd", status: "SIGNALED", amount: U(7), buyer: "0x4444444444444444444444444444444444444444", currency: "EUR", fiatOwed: 6.45, signaledAt: 40, expiresAt: 900 },
      { intentHash: "0xe", status: "MANUALLY_RELEASED", amount: U(9), buyer: "0x5555555555555555555555555555555555555555", currency: "GBP", fiatOwed: 7.07, signaledAt: 30 },
    ];
    expect(fillRows(fills, 1_000)).toEqual([
      { key: "0xb", amount: "30.00 USDC", buyer: fills[1]!.buyer, buyerShort: "0x2222...2222", outcome: "Expired, not paid", tone: "bad", at: 300 },
      { key: "0xa", amount: "60.00 USDC", buyer: fills[0]!.buyer, buyerShort: "0x1111...1111", outcome: "Paid $60.00", tone: "good", at: 200 },
      { key: "0xc", amount: "5.00 USDC", buyer: fills[2]!.buyer, buyerShort: "0x3333...3333", outcome: "Paying, owes €4.61", tone: "pending", at: 50 },
      { key: "0xd", amount: "7.00 USDC", buyer: fills[3]!.buyer, buyerShort: "0x4444...4444", outcome: "Expired, not paid", tone: "bad", at: 40 },
      { key: "0xe", amount: "9.00 USDC", buyer: fills[4]!.buyer, buyerShort: "0x5555...5555", outcome: "Released", tone: "good", at: 30 },
    ]);
    expect(fillRows(fills, 1_000).some((f) => f.outcome.includes("owes") && f.tone !== "pending")).toBe(false);
  });
});
