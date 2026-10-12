import { describe, expect, it } from "vitest";
import type { BuyOrder } from "@/peer/buy/types";
import type { BuyQuote, PlatformPrice } from "@/peer/market";
import { BUY_PLATFORMS, platformsForCurrency } from "@/peer/platforms";
import {
  addExtensionLabel,
  extensionHeadsUp,
  extensionsPage,
  afterFeesText,
  amountRules,
  amountSteps,
  assembleSlots,
  bestMarketRate,
  buySlotTarget,
  buySlotView,
  compareRate,
  effectiveRate,
  errorActions,
  errorText,
  feeWaived,
  fiatAmountText,
  fiatOfferLabel,
  fiatUnits,
  isDepositQuote,
  isVerificationError,
  missingPayLink,
  noOffersText,
  onchainDepositId,
  openingTradeAmount,
  orderByLiquidity,
  paymentChecklist,
  overCheapest,
  paymentRowAmount,
  payButtonLabel,
  paymentRowDate,
  peerAuthVersionText,
  peerOrder,
  qrCaption,
  rankPlatforms,
  rateText,
  rowMatchesOrder,
  sellSlotView,
  stallPeerPayOnly,
  txInFlight,
  usdcStack,
  verifyNeedsComputer,
  verifySite,
} from "./model";

const RATE = (text: string) => BigInt(Math.round(Number(text) * 1e6)) * 10n ** 12n;

function order(overrides: Partial<BuyOrder> = {}): BuyOrder {
  return {
    owner: "0x0000000000000000000000000000000000000001",
    intentHash: `0x${"11".repeat(32)}`,
    depositId: "1",
    escrow: "0x0000000000000000000000000000000000000002",
    orchestrator: null,
    platform: "revolut",
    currency: "GBP",
    usdcGross: 128_000_000n,
    usdcExpected: 127_000_000n,
    rate: RATE("0.79"),
    fiatToSend: 101_500_000n,
    fiatToSendText: "101.50",
    payeeHandle: "revtag",
    payeeDetailsHash: `0x${"22".repeat(32)}`,
    signalTxHash: null,
    signaledAt: 1_000,
    expiresAt: 10_000,
    verifyMethodId: null,
    memo: null,
    status: "active",
    fees: null,
    paidClaimedAt: null,
    ...overrides,
  };
}

const sell = (id: string) => ({ depositId: id });

describe("buySlotView", () => {
  it("is null without an order", () => {
    expect(buySlotView("idle", null, 0)).toBeNull();
  });

  it("shows a live order waiting for payment in orange", () => {
    expect(buySlotView("awaitingPayment", order(), 5_000)).toMatchObject({ status: "awaitingPayment", bar: "progress", label: "Pay the seller" });
  });

  it("marks an expired live order red even while verifying", () => {
    expect(buySlotView("awaitingPayment", order(), 10_000)).toMatchObject({ status: "expired", bar: "aborted" });
    expect(buySlotView("verifying", order(), 20_000)).toMatchObject({ status: "expired" });
  });

  it("follows verification and release", () => {
    expect(buySlotView("selectPayment", order(), 5_000)?.status).toBe("verifying");
    expect(buySlotView("fulfilling", order(), 20_000)?.status).toBe("releasing");
  });

  it("is green once fulfilled and red once cancelled", () => {
    expect(buySlotView("completed", order({ status: "fulfilled" }), 0)).toMatchObject({ status: "completed", bar: "complete", progress: 1 });
    expect(buySlotView("cancelled", order({ status: "cancelled" }), 0)).toMatchObject({ status: "cancelled", bar: "aborted" });
    expect(buySlotView("idle", order({ status: "cancelled" }), 0)?.status).toBe("cancelled");
  });

  it("sends an error raised while verifying to Verify, any other error to Payment", () => {
    expect(buySlotView("error", order(), 5_000, true)).toMatchObject({ status: "verifying", label: "Verification failed", alert: true });
    expect(buySlotView("error", order(), 5_000, false)).toMatchObject({ status: "awaitingPayment", label: "Pay the seller" });
    expect(buySlotView("error", order(), 20_000, true)?.status).toBe("expired");
    expect(buySlotView("awaitingPayment", order(), 5_000, true)?.status).toBe("awaitingPayment");
  });

  it("sends a player who already said they paid to Verify, even after a reload", () => {
    const claimed = order({ paidClaimedAt: 2_000 });
    expect(buySlotView("awaitingPayment", claimed, 5_000)).toMatchObject({ status: "verifying", label: "Verify payment", bar: "progress" });
    expect(buySlotTarget(buySlotView("awaitingPayment", claimed, 5_000)!.status)).toBe("verify");
    expect(buySlotView("error", claimed, 5_000)).toMatchObject({ label: "Verify payment" });
    expect(buySlotView("verifying", claimed, 5_000)?.label).toBe("Verifying payment");
    expect(buySlotView("error", claimed, 5_000, true)?.label).toBe("Verification failed");
    expect(buySlotView("awaitingPayment", claimed, 10_000)?.status).toBe("expired");
  });

  it("treats an order stored before paid claims were recorded as unpaid", () => {
    const legacy = { ...order(), paidClaimedAt: undefined } as unknown as BuyOrder;
    expect(buySlotView("awaitingPayment", legacy, 5_000)?.label).toBe("Pay the seller");
  });

  it("routes slot clicks", () => {
    expect(buySlotTarget("awaitingPayment")).toBe("payment");
    expect(buySlotTarget("expired")).toBe("payment");
    expect(buySlotTarget("verifying")).toBe("verify");
    expect(buySlotTarget("releasing")).toBe("verify");
    expect(buySlotTarget("completed")).toBe("collect");
    expect(buySlotTarget("cancelled")).toBe("collect");
  });
});

describe("sellSlotView", () => {
  it("maps sell states to bar colours and labels", () => {
    expect(sellSlotView("awaiting-buyer", 0)).toEqual({ progress: 0, bar: "progress", label: "Waiting for a buyer" });
    expect(sellSlotView("delivering", 0.4)).toEqual({ progress: 0.4, bar: "progress", label: "Partly sold" });
    expect(sellSlotView("delivered", 0.4)).toMatchObject({ progress: 1, bar: "complete" });
    expect(sellSlotView("returned", 0)).toMatchObject({ bar: "aborted", label: "Returned" });
  });
});

describe("assembleSlots", () => {
  it("fills eight empty slots with nothing to show", () => {
    const slots = assembleSlots(null, []);
    expect(slots).toHaveLength(8);
    expect(slots.every((s) => s.kind === "empty")).toBe(true);
  });

  it("puts the buy order first, then sells, then empties", () => {
    const slots = assembleSlots("buy", [sell("a"), sell("b")]);
    expect(slots.map((s) => s.kind)).toEqual(["buy", "sell", "sell", "empty", "empty", "empty", "empty", "empty"]);
  });

  it("always keeps one empty slot free", () => {
    const seven = Array.from({ length: 7 }, (_, i) => sell(String(i)));
    const slots = assembleSlots(null, seven);
    expect(slots.filter((s) => s.kind === "sell")).toHaveLength(7);
    expect(slots[7]?.kind).toBe("empty");
  });

  it("collapses overflowing sells into a 'more' slot", () => {
    const many = Array.from({ length: 10 }, (_, i) => sell(String(i)));
    const slots = assembleSlots("buy", many);
    expect(slots.map((s) => s.kind)).toEqual(["buy", "sell", "sell", "sell", "sell", "sell", "more", "empty"]);
    const more = slots[6];
    expect(more?.kind === "more" && more.count).toBe(5);
  });

  it("uses stable keys", () => {
    const slots = assembleSlots(null, [sell("x")]);
    expect(slots[0]?.key).toBe("sell:x");
  });
});

describe("rates", () => {
  const quote = (rate: string) => ({ rate: RATE(rate) }) as BuyQuote;
  it("finds the cheapest available rate", () => {
    const prices: PlatformPrice[] = [
      { platform: "revolut", available: true, quote: quote("0.80") },
      { platform: "wise", available: true, quote: quote("0.79") },
      { platform: "monzo", available: false, quote: quote("0.70") },
      { platform: "paypal", available: true, quote: null },
    ];
    expect(bestMarketRate(prices)).toMatchObject({ platform: "wise", rate: RATE("0.79") });
    expect(bestMarketRate([])).toBeNull();
    expect(bestMarketRate(undefined)).toBeNull();
  });

  it("warns only when strictly more than 1% worse", () => {
    expect(compareRate(RATE("1.01"), RATE("1.00"))).toEqual({ warn: false, percentText: "1.0%" });
    expect(compareRate(RATE("1.0101"), RATE("1.00"))).toEqual({ warn: true, percentText: "1.0%" });
    expect(compareRate(RATE("0.8184"), RATE("0.80"))).toEqual({ warn: true, percentText: "2.3%" });
    expect(compareRate(RATE("0.79"), RATE("0.80"))).toEqual({ warn: false, percentText: "0.0%" });
    expect(compareRate(RATE("1"), 0n).warn).toBe(false);
  });

  it("formats rates to four places", () => {
    expect(rateText(1_019_019_019_019_019_035n, "USD")).toBe("1.0190 USD per USDC");
  });
});

describe("amounts", () => {
  it("sizes steps to the currency", () => {
    expect(amountSteps("GBP")).toEqual([10, 100, 1000]);
    expect(amountSteps("JPY")).toEqual([1000, 10000, 100000]);
    expect(amountSteps("VND")).toEqual([10000, 100000, 1000000]);
  });

  it("uses the platform minimum and the Venmo cap", () => {
    expect(amountRules(BUY_PLATFORMS.revolut, "GBP", null)).toEqual({ min: 0.1, decimals: 2 });
    expect(amountRules(BUY_PLATFORMS.venmo, "USD", null)).toEqual({ min: 0.1, decimals: 2, max: 5000 });
    expect(amountRules(BUY_PLATFORMS.venmo, "USD", RATE("1.025"))).toEqual({ min: 0.1, decimals: 2, max: 5125 });
    expect(amountRules(null, "ARS", null).decimals).toBe(2);
    expect(amountRules(null, "JPY", null).decimals).toBe(0);
  });

  it("opens a merchant trade at the amount its shout quoted", () => {
    expect(openingTradeAmount(250, "GBP", BUY_PLATFORMS.revolut)).toBe(250);
    expect(openingTradeAmount(102.456, "GBP", BUY_PLATFORMS.revolut)).toBe(102.46);
    expect(openingTradeAmount(15_000.4, "JPY", BUY_PLATFORMS.wise)).toBe(15_000);
  });

  it("clamps the quoted amount to the platform's limits", () => {
    expect(openingTradeAmount(0.04, "GBP", BUY_PLATFORMS.revolut)).toBe(0.1);
    expect(openingTradeAmount(0.04, "JPY", BUY_PLATFORMS.wise)).toBe(1);
    expect(openingTradeAmount(9_000, "USD", BUY_PLATFORMS.venmo)).toBe(5_000);
  });

  it("falls back to the currency's default amount without a usable quote", () => {
    expect(openingTradeAmount(undefined, "GBP", BUY_PLATFORMS.revolut)).toBe(100);
    expect(openingTradeAmount(Number.NaN, "GBP", BUY_PLATFORMS.revolut)).toBe(100);
    expect(openingTradeAmount(0, "JPY", BUY_PLATFORMS.wise)).toBe(10_000);
    expect(openingTradeAmount(-5, "GBP", BUY_PLATFORMS.revolut)).toBe(100);
  });

  it("converts the pad value exactly", () => {
    expect(fiatAmountText(100, "GBP")).toBe("100.00");
    expect(fiatAmountText(99.5, "GBP")).toBe("99.50");
    expect(fiatAmountText(1500, "JPY")).toBe("1500");
    expect(fiatAmountText(Number.NaN, "GBP")).toBe("0.00");
    expect(fiatUnits(101.5, "GBP")).toBe(101_500_000n);
  });

  it("labels the fiat offer as an item", () => {
    expect(fiatOfferLabel(100_000_000n, "GBP", "revolut")).toBe("£100.00 (Revolut)");
  });

  it("stacks whole USDC", () => {
    expect(usdcStack(125_400_000n)).toBe(125);
    expect(usdcStack(999_999n)).toBe(0);
  });
});

describe("stalls", () => {
  const ESCROW = "0x777777779d229cdF3110e9de47943791c26300Ef";
  it("takes the on-chain id from a composite deposit id", () => {
    expect(onchainDepositId(`${ESCROW}_6528`)).toBe("6528");
    expect(onchainDepositId("6528")).toBe("6528");
  });

  it("matches a quote to the stall's deposit and escrow", () => {
    const quote = { depositId: "6528", escrow: ESCROW } as const;
    expect(isDepositQuote(quote, `${ESCROW.toLowerCase()}_6528`, ESCROW.toLowerCase())).toBe(true);
    expect(isDepositQuote(quote, `${ESCROW}_6529`, ESCROW)).toBe(false);
    expect(isDepositQuote(quote, `${ESCROW}_6528`, "0x0000000000000000000000000000000000000001")).toBe(false);
  });
});

describe("payment rows", () => {
  const o = order();
  it("hints rows with the exact amount and currency", () => {
    expect(rowMatchesOrder({ amount: "101.5", currency: "GBP" }, o)).toBe(true);
    expect(rowMatchesOrder({ amount: "101.50", currency: null }, o)).toBe(true);
    expect(rowMatchesOrder({ amount: "101.49", currency: "GBP" }, o)).toBe(false);
    expect(rowMatchesOrder({ amount: "101.50", currency: "EUR" }, o)).toBe(false);
    expect(rowMatchesOrder({ amount: null, currency: "GBP" }, o)).toBe(false);
  });

  it("formats row amounts", () => {
    expect(paymentRowAmount({ amount: "101.5", currency: "GBP" }, "GBP")).toBe("£101.50");
    expect(paymentRowAmount({ amount: "20", currency: "EUR" }, "GBP")).toBe("20.00 EUR");
    expect(paymentRowAmount({ amount: "abc", currency: null }, "GBP")).toBe("abc GBP");
    expect(paymentRowAmount({ amount: null, currency: null }, "GBP")).toBe("Unknown amount");
  });
});

describe("errorActions", () => {
  it("offers another pick for wrong-payment errors with a live list", () => {
    expect(errorActions({ code: "payee_mismatch", recoverable: true }, "selectPayment")).toEqual({
      primary: { label: "Pick another payment", action: "back" },
      back: false,
    });
    expect(errorActions({ code: "payee_mismatch", recoverable: true }, "awaitingPayment").primary).toEqual({ label: "Try again", action: "retry" });
  });

  it("re-checks captures and pending transactions, never resends", () => {
    expect(errorActions({ code: "no_payments", recoverable: true }, "awaitingPayment").primary?.label).toBe("Check again");
    expect(errorActions({ code: "tx_pending", recoverable: true }, "idle").primary?.label).toBe("Check again");
  });

  it("asks for fresh prices on stale quotes", () => {
    expect(errorActions({ code: "quote_expired", recoverable: true }, "quoted").primary?.label).toBe("Get fresh prices");
  });

  it("has no retry for closed orders or unrecoverable errors", () => {
    expect(errorActions({ code: "intent_expired", recoverable: true }, "awaitingPayment")).toEqual({ primary: null, back: true });
    expect(errorActions({ code: "wallet_blocked", recoverable: false }, "confirming")).toEqual({ primary: null, back: true });
  });
});

describe("isVerificationError", () => {
  const state = (code: Parameters<typeof errorActions>[0]["code"], errorReturnStep: Parameters<typeof errorActions>[1]) => ({
    step: "error" as const,
    error: { code },
    errorReturnStep,
  });

  it("follows the step the error came from", () => {
    expect(isVerificationError(state("network", "awaitingPayment"), "fulfilling")).toBe(true);
    expect(isVerificationError(state("network", "awaitingPayment"), "verifying")).toBe(true);
    expect(isVerificationError(state("network", "awaitingPayment"), "awaitingPayment")).toBe(false);
  });

  it("falls back to the return step and verify-only codes", () => {
    expect(isVerificationError(state("tx_failed", "selectPayment"), null)).toBe(true);
    for (const code of ["capture_failed", "no_payments", "payment_session_expired", "extension_unavailable", "payee_mismatch", "nullifier_used", "payment_verification_failed", "payment_not_settled"] as const) {
      expect(isVerificationError(state(code, "awaitingPayment"), null)).toBe(true);
    }
    expect(isVerificationError(state("active_intent", "awaitingPayment"), null)).toBe(false);
    expect(isVerificationError(state("user_rejected", "awaitingPayment"), null)).toBe(false);
    expect(isVerificationError(state("method_required", "awaitingPayment"), null)).toBe(false);
  });

  it("is false outside an error", () => {
    expect(isVerificationError({ step: "verifying", error: null, errorReturnStep: null }, "verifying")).toBe(false);
  });
});

describe("errorText", () => {
  const noPayments = {
    code: "no_payments" as const,
    message: "No completed Revolut payments found yet. Only recent payments from the Revolut account you logged in to are read. If you already paid, don't pay again: wait a few minutes, then check again.",
  };
  it("never tells the player to send money for an expired order", () => {
    expect(errorText(noPayments, false)).toBe(noPayments.message);
    expect(errorText(noPayments, true)).not.toMatch(/Send the payment/);
    expect(errorText(noPayments, true)).toMatch(/Do not send money now\./);
    expect(errorText({ code: "network", message: "Connection problem." }, true)).toBe("Connection problem.");
  });
});

describe("paymentRowDate", () => {
  it("formats raw platform dates and leaves free text alone", () => {
    const ms = new Date(2026, 9, 11, 14, 5).getTime();
    expect(paymentRowDate(String(ms), "revolut")).toBe(
      new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    );
    expect(paymentRowDate(String(ms), "revolut")).not.toMatch(/^\d{10,}$/);
    expect(paymentRowDate("2026-10-11T10:00:00", "venmo")).toBe(paymentRowDate("2026-10-11T10:00:00Z", "venmo"));
    expect(paymentRowDate("20261011", "zelle")).toBe(new Date(2026, 9, 11).toLocaleString(undefined, { month: "short", day: "numeric" }));
    expect(paymentRowDate("Bob 12", "n26")).toBe("Bob 12");
    expect(paymentRowDate(null, "wise")).toBe("");
  });
});

describe("txInFlight", () => {
  it("blocks while a transaction is being sent", () => {
    expect(txInFlight("signaling", "signal")).toBe(true);
    expect(txInFlight("awaitingPayment", "cancel")).toBe(true);
    expect(txInFlight("fulfilling", null)).toBe(true);
    expect(txInFlight("verifying", "capture")).toBe(false);
    expect(txInFlight("quoted", null)).toBe(false);
  });
});

describe("orderByLiquidity", () => {
  it("keeps every currency in order, all liquid, while the market is unknown", () => {
    expect(orderByLiquidity(["USD", "HKD", "GBP"], null)).toEqual([
      { code: "USD", liquid: true },
      { code: "HKD", liquid: true },
      { code: "GBP", liquid: true },
    ]);
  });

  it("puts currencies with offers first and marks the rest, keeping each group's order", () => {
    expect(orderByLiquidity(["USD", "HKD", "JPY", "GBP", "AED"], new Set(["GBP", "USD"]))).toEqual([
      { code: "USD", liquid: true },
      { code: "GBP", liquid: true },
      { code: "HKD", liquid: false },
      { code: "JPY", liquid: false },
      { code: "AED", liquid: false },
    ]);
  });

  it("marks every currency when none has offers", () => {
    expect(orderByLiquidity(["USD", "GBP"], new Set()).every((r) => !r.liquid)).toBe(true);
  });
});

describe("verifyNeedsComputer", () => {
  const UA = {
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1",
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
    ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0",
    safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  };
  const missing = { isAvailable: () => false };
  const present = { isAvailable: () => true };

  it("stops phones, tablets, Firefox and Safari that can't get the extension", () => {
    for (const ua of [UA.iphone, UA.iphoneChrome, UA.android, UA.ipad, UA.firefox, UA.safari]) {
      expect(verifyNeedsComputer(ua, missing)).toBe(true);
    }
  });

  it("never stops desktop Chrome or Edge, with or without the extension (they can install it)", () => {
    for (const ua of [UA.chrome, UA.edge]) {
      expect(verifyNeedsComputer(ua, missing)).toBe(false);
      expect(verifyNeedsComputer(ua, present)).toBe(false);
    }
  });

  it("lets any browser where the extension is already present verify", () => {
    expect(verifyNeedsComputer(UA.android, present)).toBe(false);
    expect(verifyNeedsComputer(UA.firefox, present)).toBe(false);
  });

  it("treats an extension check that throws as missing", () => {
    expect(verifyNeedsComputer(UA.iphone, { isAvailable: () => { throw new Error("no window"); } })).toBe(true);
  });

  it("treats an unknown browser as unable to install", () => {
    expect(verifyNeedsComputer("", missing)).toBe(true);
  });
});

describe("after-fees rate", () => {
  it("divides the fiat sent by the USDC that lands", () => {
    // $103.00 for 100.50 USDC after fees: 1.0249 per USDC, against a listed 1.0100.
    expect(effectiveRate(103_000_000n, 100_500_000n)).toBe(1_024_875_621_890_547_263n);
    expect(afterFeesText(103_000_000n, 100_500_000n, "USD")).toBe("After fees: 1.0249 USD per USDC");
  });

  it("is null with nothing to divide", () => {
    expect(effectiveRate(0n, 100n)).toBeNull();
    expect(effectiveRate(100n, 0n)).toBeNull();
    expect(afterFeesText(100n, 0n, "USD")).toBeNull();
  });
});

describe("Peer's method order", () => {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it("lists Alipay first for yuan and UPI first for rupees", () => {
    expect(ids(peerOrder(platformsForCurrency("CNY"), "CNY"))[0]).toBe("alipay");
    expect(ids(peerOrder(platformsForCurrency("INR"), "INR"))[0]).toBe("upi");
    expect(ids(peerOrder(platformsForCurrency("CNY"), "CNY")).sort()).toEqual(ids(platformsForCurrency("CNY")).sort());
  });

  it("keeps the catalogue order for currencies without a home method", () => {
    expect(ids(peerOrder(platformsForCurrency("USD"), "USD"))).toEqual(ids(platformsForCurrency("USD")));
  });

  it("keeps the home method first among methods without offers", () => {
    const quote = (rate: string) => ({ rate: RATE(rate) }) as BuyQuote;
    const cny = peerOrder(platformsForCurrency("CNY"), "CNY");
    const none = rankPlatforms(cny, cny.map((p) => ({ platform: p.id, available: false, quote: null })));
    expect(none[0]?.platform.id).toBe("alipay");
    const wiseOnly = rankPlatforms(cny, [{ platform: "wise", available: true, quote: quote("7.2") }]);
    expect(wiseOnly.map((r) => r.platform.id).slice(0, 2)).toEqual(["wise", "alipay"]);
  });
});

describe("Alipay and UPI payment copy", () => {
  it("names the app to scan with and where the payment is read from", () => {
    expect(qrCaption(BUY_PLATFORMS.alipay)).toBe("Scan with the Alipay app on your phone.");
    expect(qrCaption(BUY_PLATFORMS.upi)).toMatch(/^Scan with the Amazon Pay app on your phone/);
    expect(qrCaption(BUY_PLATFORMS.revolut)).toBe("Scan the QR code with your phone and pay in the Revolut app.");
    expect(verifySite(BUY_PLATFORMS.upi)).toBe("Amazon Pay on amazon.in");
    expect(verifySite(BUY_PLATFORMS.alipay)).toBe("alipay.com");
    expect(verifySite(BUY_PLATFORMS.wise)).toBe("Wise");
    expect(payButtonLabel(BUY_PLATFORMS.upi)).toBe("Pay with UPI");
    expect(payButtonLabel(BUY_PLATFORMS.alipay)).toBe("Open Alipay");
  });

  it("states the PeerAuth version a platform needs", () => {
    expect(peerAuthVersionText(BUY_PLATFORMS.alipay)).toBe("Verifying needs PeerAuth 0.6.7 or newer, on a computer.");
    expect(peerAuthVersionText(BUY_PLATFORMS.upi)).toBe("Verifying needs PeerAuth 0.6.8 or newer, on a computer.");
    expect(peerAuthVersionText(BUY_PLATFORMS.revolut)).toBeNull();
  });

  it("flags an Alipay order with no payment code as unpayable, and nothing else", () => {
    const none = { payee: "seller@example.com", deepLink: null, webLink: null, qrValue: null };
    expect(missingPayLink(BUY_PLATFORMS.alipay, none)).toBe(true);
    expect(missingPayLink(BUY_PLATFORMS.alipay, { ...none, qrValue: "alipays://x", deepLink: "alipays://x" })).toBe(false);
    expect(missingPayLink(BUY_PLATFORMS.alipay, { ...none, payee: null })).toBe(false);
    // Revolut Business payees have no link on purpose: the rules say how to pay them.
    expect(missingPayLink(BUY_PLATFORMS.revolut, none)).toBe(false);
  });
});

describe("no-offer text", () => {
  it("says why Venmo and PayPal books are empty, and 'No sellers yet' elsewhere", () => {
    expect(noOffersText(BUY_PLATFORMS.venmo)).toBe(BUY_PLATFORMS.venmo.noOffersNote);
    expect(noOffersText(BUY_PLATFORMS.paypal)).toBe(BUY_PLATFORMS.paypal.noOffersNote);
    expect(noOffersText(BUY_PLATFORMS.venmo)).not.toBe("No sellers yet");
    expect(noOffersText(BUY_PLATFORMS.revolut)).toBe("No sellers yet");
  });
});

describe("payment method ranking", () => {
  const quote = (rate: string) => ({ rate: RATE(rate) }) as BuyQuote;
  const usd = platformsForCurrency("USD");
  const ids = (rows: { platform: { id: string } }[]) => rows.map((r) => r.platform.id);

  it("keeps the given order while prices load", () => {
    expect(ids(rankPlatforms(usd, undefined))).toEqual(usd.map((p) => p.id));
    expect(rankPlatforms(usd, undefined).every((r) => !r.available && r.price === null && r.overCheapest === null)).toBe(true);
  });

  it("puts methods with offers first, cheapest first, and methods without offers last in their given order", () => {
    const prices: PlatformPrice[] = [
      { platform: "venmo", available: false, quote: null },
      { platform: "cashapp", available: true, quote: quote("1.16") },
      { platform: "zelle", available: true, quote: quote("1.01") },
      { platform: "paypal", available: false, quote: null },
      { platform: "revolut", available: true, quote: quote("1.02") },
    ];
    const rows = rankPlatforms(usd, prices);
    const withOffers = rows.filter((r) => r.available);
    expect(ids(withOffers)).toEqual(["zelle", "revolut", "cashapp"]);
    expect(ids(rows.slice(0, 3))).toEqual(["zelle", "revolut", "cashapp"]);
    const without = ids(rows.slice(3));
    expect(without).toEqual(usd.map((p) => p.id).filter((id) => !["zelle", "revolut", "cashapp"].includes(id)));
    expect(without.indexOf("venmo")).toBeLessThan(without.indexOf("paypal"));
  });

  it("flags only methods more than 3% over the cheapest", () => {
    const prices: PlatformPrice[] = [
      { platform: "cashapp", available: true, quote: quote("1.1615") },
      { platform: "zelle", available: true, quote: quote("1.01") },
      { platform: "revolut", available: true, quote: quote("1.0403") },
    ];
    const rows = rankPlatforms(usd, prices);
    const flag = (id: string) => rows.find((r) => r.platform.id === id)?.overCheapest;
    expect(flag("zelle")).toBeNull();
    expect(flag("revolut")).toBeNull();
    expect(flag("cashapp")).toBe("+15.0%");
  });

  it("compares a quote with the cheapest method", () => {
    const prices: PlatformPrice[] = [
      { platform: "zelle", available: true, quote: quote("1.00") },
      { platform: "monzo", available: false, quote: quote("0.50") },
    ];
    expect(overCheapest(RATE("1.03"), prices)).toBeNull();
    expect(overCheapest(RATE("1.0301"), prices)).toMatchObject({ percentText: "+3.0%", best: { platform: "zelle" } });
    expect(overCheapest(RATE("1.15"), prices)?.percentText).toBe("+15.0%");
    expect(overCheapest(RATE("0.99"), prices)).toBeNull();
    expect(overCheapest(RATE("1.5"), [])).toBeNull();
    expect(overCheapest(RATE("1.5"), undefined)).toBeNull();
  });
});

describe("stallPeerPayOnly", () => {
  it("marks Venmo and PayPal stalls, which only Peer Pay merchants can fill", () => {
    expect(stallPeerPayOnly("venmo")).toBe(true);
    expect(stallPeerPayOnly("PayPal")).toBe(true);
    expect(stallPeerPayOnly("cashapp")).toBe(false);
    expect(stallPeerPayOnly("revolut")).toBe(false);
  });
});

describe("feeWaived", () => {
  const fees = { serviceBps: 95, service: 1_202_531n, manager: 0n, referrer: 632_911n, referrerBps: 50, total: 1_835_442n };
  it("is true only when the order's fees on record carry no RampRidge leg", () => {
    expect(feeWaived(order({ fees }))).toBe(false);
    expect(feeWaived(order({ fees: { ...fees, referrer: 0n, referrerBps: null, total: 1_202_531n } }))).toBe(true);
    expect(feeWaived(order({ fees: null }))).toBe(false);
  });
});

describe("Peer extension prompts", () => {
  it("flags a missing or outdated extension while paying, and nothing else", () => {
    expect(extensionHeadsUp("needs_install")).toBe("install");
    expect(extensionHeadsUp("needs_update")).toBe("update");
    // A phone or Safari gets the "verify on a computer" note instead; connecting happens at Verify.
    expect(extensionHeadsUp("unsupported_browser")).toBeNull();
    expect(extensionHeadsUp("needs_connection")).toBeNull();
    expect(extensionHeadsUp("ready")).toBeNull();
    expect(extensionHeadsUp(null)).toBeNull();
  });

  it("words the install button and the update page as Peer web does", () => {
    expect(addExtensionLabel("chrome")).toBe("Add to Chrome");
    expect(addExtensionLabel("brave")).toBe("Add to Brave");
    expect(addExtensionLabel("other")).toBe("Add to browser");
    expect(extensionsPage("chrome")).toBe("chrome://extensions");
    expect(extensionsPage("brave")).toBe("brave://extensions");
  });
});

describe("Payment scroll checklist", () => {
  const ctx = (amount: string, currency: "GBP" | "USD" | "EUR" | "CNY" | "INR", payee = "seller") => ({ payee, amount, currency, memo: null, recipientId: null });
  const checklist = (id: keyof typeof BUY_PLATFORMS, c: ReturnType<typeof ctx>, methodId?: string) => {
    const p = BUY_PLATFORMS[id];
    const method = methodId ? (p.verifyMethods.find((m) => m.id === methodId) ?? null) : p.methodChoice === "beforePayment" ? null : (p.verifyMethods[0] ?? null);
    return paymentChecklist({
      platformName: p.name,
      warning: p.warning(c, method),
      rules: p.rules(c, method),
      needsMethodChoice: p.methodChoice === "beforePayment" && method === null,
    });
  };
  const texts = (items: ReturnType<typeof paymentChecklist>) => items.map((i) => i.text);

  it("says Revolut's 5% currency warning once, first, and keeps every other rule", () => {
    const items = checklist("revolut", ctx("100.00", "GBP"));
    expect(items[0]).toEqual({ kind: "warn", text: "Send in the same currency. A wrong-currency payment loses 5%.", important: true });
    expect(texts(items).filter((t) => t.includes("loses 5%"))).toHaveLength(1);
    expect(items).toHaveLength(BUY_PLATFORMS.revolut.rules(ctx("100.00", "GBP"), null).length);
    expect(items.slice(1).every((i) => !i.important)).toBe(true);
  });

  it("leads with the rules that already say the warning instead of repeating it", () => {
    const venmo = checklist("venmo", ctx("250.00", "USD"));
    const venmoRules = BUY_PLATFORMS.venmo.rules(ctx("250.00", "USD"), null).map((r) => r.text);
    expect(venmo.slice(0, 2).map((i) => i.text)).toEqual([venmoRules.find((t) => t.includes("friends")), venmoRules.find((t) => t.includes("purchases"))]);
    expect(venmo.slice(0, 2).every((i) => i.important)).toBe(true);
    expect(venmo.some((i) => i.kind === "warn")).toBe(false);
    const cashapp = checklist("cashapp", ctx("100.00", "USD"));
    expect(cashapp.some((i) => i.kind === "warn")).toBe(false);
    expect(texts(cashapp).filter((t) => t.startsWith("Send exactly"))).toHaveLength(1);
    const monzo = checklist("monzo", ctx("100.00", "GBP"));
    expect(monzo[0]).toEqual({ kind: "do", text: "Pay in the Monzo app.", important: true });
    expect(monzo.some((i) => i.kind === "warn")).toBe(false);
  });

  it("keeps a warning that says something new, first, beside every rule", () => {
    const paypal = checklist("paypal", ctx("60.00", "EUR"));
    expect(paypal[0]?.kind).toBe("warn");
    expect(paypal).toHaveLength(BUY_PLATFORMS.paypal.rules(ctx("60.00", "EUR"), null).length + 1);
    const upi = checklist("upi", ctx("8850.00", "INR"));
    expect(upi[0]).toMatchObject({ kind: "warn", text: "Use standard UPI in the Amazon Pay app, not UPI Lite or a merchant payment." });
    expect(texts(upi)).not.toContain("Don't use UPI Lite or pay a merchant.");
    expect(checklist("alipay", ctx("712.00", "CNY"))[0]?.kind).toBe("warn");
  });

  it("leaves the bank question out of a Zelle checklist until a bank is chosen", () => {
    const before = checklist("zelle", ctx("80.00", "USD"));
    expect(before.some((i) => i.kind === "warn" || i.important)).toBe(false);
    const chase = checklist("zelle", ctx("80.00", "USD"), "chase");
    expect(texts(chase).filter((t) => t.startsWith("Send exactly 80.00 USD"))).toHaveLength(1);
  });

  it("never lists the same text twice, says the warning at most once and puts what matters most first, on any platform", () => {
    for (const p of Object.values(BUY_PLATFORMS)) {
      const c = ctx("100.00", p.currencies[0] as "USD");
      const items = checklist(p.id, c, p.verifyMethods[0]?.id);
      expect(new Set(texts(items)).size).toBe(items.length);
      expect(items.length).toBeGreaterThan(0);
      const warns = items.flatMap((i, n) => (i.kind === "warn" ? [n] : []));
      expect(warns.length === 0 || (warns.length === 1 && warns[0] === 0)).toBe(true);
      const firstPlain = items.findIndex((i) => !i.important);
      expect(firstPlain === -1 || items.slice(firstPlain).every((i) => !i.important)).toBe(true);
    }
  });
});
