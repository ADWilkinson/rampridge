/**
 * Alipay (CNY) and UPI via Amazon Pay (INR): the two beta platforms Peer's
 * web app lets buyers use, ported from zkp2p-clients packages/core
 * platforms/alipay.ts and upi.ts (fixtures from their tests), plus the
 * catalogue fields the UI explains them with, the Alipay PID the QR needs and
 * Curator's transient 503s.
 */

import {
  APIError,
  resolveFiatCurrencyBytes32,
  type GetQuoteResponse,
  type PeerMetadataMessage,
  type PeerMetadataRow,
  type Zkp2pClient,
} from "@zkp2p/sdk";
import { MAJOR_CURRENCIES, isMajorCurrency } from "@shared/currencies";
import type { TransactionReceipt } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletCall } from "@/wallet/types";
import { buildBuyerTeeProof, decodeUnicodeEscapes, isAmazonPayP2pDebit, selectableRows } from "../../extension";
import {
  CURATOR_RETRY_DELAYS_MS,
  getBestPricesByPlatform,
  getBuyQuotes,
  normalizeQuote,
  withCuratorRetry,
  type BuyQuoteResult,
} from "../../market";
import {
  BUY_PLATFORMS,
  BUY_PLATFORM_IDS,
  FIAT_CODES,
  alipayPid,
  buyableCurrencies,
  minExtensionVersion,
  platformsForCurrency,
  resolveVerifyMethod,
  type SendContext,
} from "../../platforms";
import { getPaymentInstructions } from "../instructions";
import { recoverBuyOrder } from "../recovery";
import { createBuyStore } from "../store";
import { deserializeOrder, memoryOrderStorage, serializeOrder } from "../storage";
import {
  BUYER,
  fakeClient,
  fakeExtension,
  fakeSender,
  flush,
  fundsLockedLog,
  intentSignaledLog,
  isSignalCall,
  pvIntentView,
  rawQuote,
  receipt,
  storedOrder,
} from "./helpers";

const apiGetPayeeDetails = vi.hoisted(() => vi.fn());
vi.mock("@zkp2p/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zkp2p/sdk")>()),
  apiGetPayeeDetails,
}));

const telemetry = vi.hoisted(() => ({ track: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telemetry")>()),
  track: telemetry.track,
  report: telemetry.report,
}));

const PID = "2088342832224055";
const ALIPAY_HASH = "0xcac9daea62d7b89d75ac73af4ee14dcf25721012ae82b568c2ea5c808eaa04ff";
const NOW = 1_791_711_200_000;

afterEach(() => {
  vi.useRealTimers();
  apiGetPayeeDetails.mockReset();
});

function ctx(overrides: Partial<SendContext> = {}): SendContext {
  return { payee: "maker@example.com", amount: "6.74", currency: "CNY", memo: null, recipientId: null, ...overrides };
}

describe("catalogue", () => {
  it("makes Alipay and UPI live, appended after X Money, and keeps N26, Luxon and Mercado Pago off", () => {
    expect(BUY_PLATFORM_IDS.slice(-3)).toEqual(["xmoney", "alipay", "upi"]);
    expect(BUY_PLATFORMS.alipay.live).toBe(true);
    expect(BUY_PLATFORMS.upi.live).toBe(true);
    for (const id of ["n26", "luxon", "mercadopago"] as const) expect(BUY_PLATFORMS[id].live, id).toBe(false);
  });

  it("buys exactly the major currencies, in catalogue order", () => {
    expect(buyableCurrencies()).toEqual(FIAT_CODES.filter((code) => isMajorCurrency(code)));
    expect(buyableCurrencies()).toHaveLength(MAJOR_CURRENCIES.length);
  });

  it("offers Alipay for CNY and UPI for INR", () => {
    expect(platformsForCurrency("CNY").map((p) => p.id)).toEqual(["revolut", "wise", "alipay"]);
    expect(platformsForCurrency("INR").map((p) => p.id)).toEqual(["wise", "upi"]);
  });

  it("ports Peer's Alipay and UPI configs", () => {
    expect(BUY_PLATFORMS.alipay).toMatchObject({
      name: "Alipay",
      color: "#1677FF",
      currencies: ["CNY"],
      minFiat: "0.1",
      payeeLabel: "Alipay account",
      verifyMethods: [{ id: "default", actionType: "transfer_alipay", actionPlatform: "alipay" }],
      methodChoice: "none",
      includeMetadataIndex: false,
      payOnWeb: false,
      amountLocale: "zh-CN",
    });
    expect(BUY_PLATFORMS.upi).toMatchObject({
      name: "UPI",
      currencies: ["INR"],
      minFiat: "1",
      payeeLabel: "UPI ID",
      verifyMethods: [{ id: "amazonpay", label: "Amazon Pay", actionType: "transfer_upi_amazonpay", actionPlatform: "upi" }],
      methodChoice: "none",
      includeMetadataIndex: false,
      payOnWeb: false,
    });
    expect(minExtensionVersion("alipay")).toBe("0.6.7");
    expect(minExtensionVersion("upi")).toBe("0.6.8");
    expect(resolveVerifyMethod("upi")?.actionType).toBe("transfer_upi_amazonpay");
  });

  it("flags Peer's beta platforms and explains them and the empty Peer Pay books", () => {
    const beta = BUY_PLATFORM_IDS.filter((id) => BUY_PLATFORMS[id].beta);
    expect(beta).toEqual(["xmoney", "alipay", "upi"]);
    expect(BUY_PLATFORMS.upi.buyNotice).toMatch(/standard UPI in the Amazon Pay app, not UPI Lite and not a merchant payment/);
    expect(BUY_PLATFORMS.upi.buyNotice).toMatch(/same amazon\.in account/);
    expect(BUY_PLATFORMS.alipay.buyNotice).toMatch(/Alipay app/);
    expect(BUY_PLATFORMS.venmo.noOffersNote).toBe("Every Venmo seller on Peer only sells to Peer Pay members right now.");
    expect(BUY_PLATFORMS.paypal.noOffersNote).toBe("Every PayPal seller on Peer only sells to Peer Pay members right now.");
    const noted = BUY_PLATFORM_IDS.filter((id) => BUY_PLATFORMS[id].noOffersNote);
    expect(noted).toEqual(["venmo", "paypal"]);
  });
});

describe("send links", () => {
  it("builds Peer's Alipay PID deep link as the QR, with no web option", () => {
    const link = `alipays://platformapi/startapp?appId=20000116&actionType=toAccount&userId=${PID}&amount=0.01`;
    expect(BUY_PLATFORMS.alipay.sendLinks(ctx({ amount: "0.01", recipientId: PID }), null)).toEqual({
      deepLink: link,
      webLink: null,
      qrValue: link,
    });
    // zh-CN grouping never reaches the link.
    expect(BUY_PLATFORMS.alipay.sendLinks(ctx({ amount: "1,234.50", recipientId: PID }), null).qrValue).toBe(
      `alipays://platformapi/startapp?appId=20000116&actionType=toAccount&userId=${PID}&amount=1234.50`,
    );
  });

  it("gives no Alipay link without a valid PID: the email handle is not payable by link", () => {
    for (const recipientId of [null, "208834283222405", "20883428322240555", "not-a-pid"]) {
      expect(BUY_PLATFORMS.alipay.sendLinks(ctx({ recipientId }), null)).toEqual({ deepLink: null, webLink: null, qrValue: null });
    }
  });

  it("writes Peer's Alipay QR guidance", () => {
    const texts = BUY_PLATFORMS.alipay.rules(ctx(), null).map((r) => r.text);
    expect(texts).toContain("Scan the QR code with the Alipay app.");
    expect(texts).toContain('Make sure the "Your Send" amount is at least 6.74 CNY.');
    expect(texts.some((t) => t.includes("exact amount"))).toBe(true);
  });

  it("builds an exact-amount INR UPI link to the normalised VPA", () => {
    const links = BUY_PLATFORMS.upi.sendLinks(ctx({ payee: "Seller@okaxis", amount: "1250.50", currency: "INR" }), null);
    expect(links.deepLink).toBe("upi://pay?pa=seller%40okaxis&cu=INR&am=1250.50");
    expect(links.qrValue).toBe(links.deepLink);
    expect(links.webLink).toBeNull();
    const url = new URL(links.deepLink ?? "");
    expect(url.protocol).toBe("upi:");
    expect(url.searchParams.get("pa")).toBe("seller@okaxis");
    expect(url.searchParams.get("am")).toBe("1250.50");
    expect(url.searchParams.get("cu")).toBe("INR");
    expect(BUY_PLATFORMS.upi.formatPayee("  Sachin.Kumar@OKHDFC  ")).toBe("sachin.kumar@okhdfc");
  });

  it("tells UPI buyers to pay in Amazon Pay and verify on the same amazon.in account", () => {
    const texts = BUY_PLATFORMS.upi.rules(ctx({ amount: "12.34", currency: "INR" }), null).map((r) => r.text).join(" ");
    expect(texts).toContain("12.34 INR");
    expect(texts).toContain("Amazon Pay");
    expect(texts).toContain("UPI Lite");
    expect(texts).not.toMatch(/HDFC|Gmail/);
  });
});

describe("payment instructions", () => {
  const alipayOrder = (extra: Partial<Parameters<typeof storedOrder>[0]> = {}) =>
    storedOrder({ platform: "alipay", currency: "CNY", payeeHandle: "maker@example.com", fiatToSend: 1_234_500_000n, fiatToSendText: "1234.50", ...extra });

  it("renders the Alipay QR from the order's stored PID", () => {
    const steps = getPaymentInstructions(alipayOrder({ recipientId: PID }));
    expect(steps.qrValue).toBe(`alipays://platformapi/startapp?appId=20000116&actionType=toAccount&userId=${PID}&amount=1234.50`);
    expect(steps.amount).toBe("1234.50");
    expect(steps.amountText).toBe("¥1,234.50");
    expect(steps.payeeDisplay).toBe("maker@example.com");
  });

  it("shows no Alipay QR until the PID is known", () => {
    expect(getPaymentInstructions(alipayOrder()).qrValue).toBeNull();
  });

  it("gives every other platform a null recipient id, even with a stray stored one", () => {
    const steps = getPaymentInstructions(storedOrder({ platform: "upi", currency: "INR", payeeHandle: "seller@okaxis", recipientId: PID, fiatToSendText: "500.00" }));
    expect(steps.qrValue).toBe("upi://pay?pa=seller%40okaxis&cu=INR&am=500.00");
  });

  it("keeps the Alipay PID through storage and drops one that is malformed or on another platform", () => {
    const order = alipayOrder({ recipientId: PID });
    expect(deserializeOrder(serializeOrder(order))?.recipientId).toBe(PID);
    expect(deserializeOrder(serializeOrder(alipayOrder({ recipientId: "123" })))).not.toHaveProperty("recipientId");
    expect(deserializeOrder(serializeOrder(storedOrder({ recipientId: PID })))).not.toHaveProperty("recipientId");
  });
});

describe("captured payments", () => {
  function message(platform: string, rows: PeerMetadataRow[]): PeerMetadataMessage {
    return { metadata: rows, platform, requestId: "req", expiresAt: Date.now() + 300_000, buyerTeeCapture: { encryptedSessionMaterial: "enc" } };
  }

  it("parses outgoing Alipay payments as Peer core does", () => {
    const rows = selectableRows(
      message("alipay", [
        { amount: "- 12.34", currency: "CNY", date: "2026-08-13 14:05", hidden: false, originalIndex: 0, recipient: "\\u5f20\\u4e09", params: { id: "a" } },
      ]),
      "alipay",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ index: 0, amount: "12.34", currency: "CNY", date: "2026-08-13 14:05", recipient: "张三", sent: true });
  });

  it("never offers an incoming Alipay payment as sent, and drops an unreadable date", () => {
    const rows = selectableRows(
      message("alipay", [
        { amount: "+ 12.34", currency: "CNY", date: "�� 14:05", hidden: false, originalIndex: 0, recipient: "张三", params: { id: "a" } },
        { amount: "- 5.00", currency: "CNY", date: "�� 14:06", hidden: false, originalIndex: 1, recipient: "李四", params: { id: "b" } },
      ]),
      "alipay",
    );
    expect(rows.map((r) => r.index)).toEqual([1]);
    expect(rows[0]).toMatchObject({ amount: "5.00", date: null });
  });

  it("decodes single and double escaped unicode", () => {
    expect(decodeUnicodeEscapes("\\u004a")).toBe("J");
    expect(decodeUnicodeEscapes("\\\\u004a")).toBe("J");
    expect(decodeUnicodeEscapes("plain")).toBe("plain");
  });

  const amazon = (url: string, status = "SUCCESS", direction = "DEBIT", extra: Partial<PeerMetadataRow> = {}): PeerMetadataRow => ({
    originalIndex: 7,
    hidden: false,
    status,
    direction,
    amount: "5.00",
    description: "Paid to Test",
    date: "2026-10-11",
    params: { TRANSACTION_URL: url },
    ...extra,
  });

  it("accepts only successful outgoing P2P Amazon Pay UPI receipts", () => {
    for (const useCase of ["p2p_outgoing_pay", "p2p_outgoing_scan_pay"]) {
      for (const prefix of ["", "https://www.amazon.in"]) {
        expect(isAmazonPayP2pDebit(amazon(`${prefix}/pay/transaction-details?useCase=${useCase}`))).toBe(true);
      }
    }
    for (const url of [
      "https://example.com/pay/transaction-details?useCase=p2p_outgoing_pay",
      "http://www.amazon.in/pay/transaction-details?useCase=p2p_outgoing_pay",
      "/wrong-path?useCase=p2p_outgoing_pay",
      "/pay/transaction-details?useCase=p2m_outgoing_pay",
      "/pay/transaction-details?useCase=p2p_incoming_pay",
      "https://user@www.amazon.in/pay/transaction-details?useCase=p2p_outgoing_pay",
    ]) {
      expect(isAmazonPayP2pDebit(amazon(url)), url).toBe(false);
    }
    const url = "/pay/transaction-details?useCase=p2p_outgoing_pay";
    expect(isAmazonPayP2pDebit(amazon(url, "PENDING"))).toBe(false);
    expect(isAmazonPayP2pDebit(amazon(url, "SUCCESS", "CREDIT"))).toBe(false);
  });

  it("shows UPI rows with Peer's rupee subject and never falls back to unfiltered history", () => {
    const ok = "/pay/transaction-details?useCase=p2p_outgoing_pay";
    const rows = selectableRows(
      message("upi", [
        amazon(ok, "SUCCESS", "DEBIT", { originalIndex: 0, amount: "100.25" }),
        amazon(ok, "SUCCESS", "DEBIT", { originalIndex: 1, amount: "1,000" }),
        amazon(ok, "SUCCESS", "DEBIT", { originalIndex: 2, description: "" }),
        amazon("/pay/transaction-details?useCase=p2m_outgoing_pay", "SUCCESS", "DEBIT", { originalIndex: 3 }),
      ]),
      "upi",
    );
    expect(rows.map((r) => r.index)).toEqual([0]);
    expect(rows[0]).toMatchObject({ amount: "100.25", currency: "INR", recipient: "Test", sent: true });
    // Strict like Revolut and X Money: nothing valid means nothing offered.
    const none = selectableRows(message("upi", [amazon(ok, "PENDING", "DEBIT", { originalIndex: 0 })]), "upi");
    expect(none).toEqual([]);
  });

  it("proves Alipay and UPI rows on their own routes without a row index", () => {
    const alipayRow: PeerMetadataRow = { hidden: false, originalIndex: 3, amount: "- 1.00", params: { id: "x" } };
    expect(buildBuyerTeeProof(message("alipay", [alipayRow]), "alipay", alipayRow)).toEqual({
      proofType: "buyerTee",
      encryptedSessionMaterial: "enc",
      params: { id: "x" },
      actionType: "transfer_alipay",
      actionPlatform: "alipay",
    });
    const upiRow = amazon("/pay/transaction-details?useCase=p2p_outgoing_pay");
    expect(buildBuyerTeeProof(message("upi", [upiRow]), "upi", upiRow)).toEqual({
      proofType: "buyerTee",
      encryptedSessionMaterial: "enc",
      params: { TRANSACTION_URL: "/pay/transaction-details?useCase=p2p_outgoing_pay" },
      actionType: "transfer_upi_amazonpay",
      actionPlatform: "upi",
    });
  });
});

describe("Curator maker metadata", () => {
  const curator = (responseObject: unknown) =>
    apiGetPayeeDetails.mockResolvedValueOnce({ success: true, message: "", statusCode: 200, responseObject });

  it.each([null, {}, { alipayPid: "208834283222405" }, { alipayPid: "20883428322240555" }, { alipayPid: "not-a-pid" }, { alipayPid: 2088342832224055 }])(
    "rejects missing or malformed PID metadata %#",
    (metadata) => {
      expect(alipayPid(metadata)).toBeNull();
    },
  );

  it("reads the signed Curator PID for Alipay payees only", async () => {
    const { fetchPayee } = await import("../chain");
    curator({ offchainId: "maker@example.com", isBusiness: false, metadata: { alipayPid: PID } });
    expect(await fetchPayee("alipay", "0x01")).toEqual({ handle: "maker@example.com", business: false, recipientId: PID });
    curator({ offchainId: "maker@example.com", isBusiness: false, metadata: { alipayPid: "123" } });
    expect(await fetchPayee("alipay", "0x01")).toEqual({ handle: "maker@example.com", business: false });
    curator({ offchainId: "revtag", isBusiness: false, metadata: { alipayPid: PID } });
    expect(await fetchPayee("revolut", "0x01")).toEqual({ handle: "revtag", business: false });
  });

  it("recovers an Alipay order's PID from Curator when storage lost it", async () => {
    const fc = fakeClient();
    const view = pvIntentView({ paymentMethod: ALIPAY_HASH });
    view.intent.fiatCurrency = resolveFiatCurrencyBytes32("CNY");
    fc.accountIntents.mockResolvedValue([view]);
    const lookupPayee = vi.fn(async () => ({ handle: "maker@example.com", business: false, recipientId: PID }));
    const stored = storedOrder({ platform: "alipay", currency: "CNY", payeeHandle: "maker@example.com" });
    const result = await recoverBuyOrder({ client: fc.client, owner: BUYER, stored, now: NOW, lookupPayee, dismissed: new Set() });
    expect(result).toMatchObject({ kind: "active", order: { platform: "alipay", payeeHandle: "maker@example.com", recipientId: PID } });
    expect(lookupPayee).toHaveBeenCalledWith("alipay", stored.payeeDetailsHash);

    // Once known, it is kept without asking Curator again.
    lookupPayee.mockClear();
    const again = await recoverBuyOrder({ client: fc.client, owner: BUYER, stored: { ...stored, recipientId: PID }, now: NOW, lookupPayee, dismissed: new Set() });
    expect(again).toMatchObject({ kind: "active", order: { recipientId: PID } });
    expect(lookupPayee).not.toHaveBeenCalled();
  });
});

describe("signalling an Alipay order", () => {
  const CNY_HASH = resolveFiatCurrencyBytes32("CNY");
  const alipayQuote = () =>
    normalizeQuote(
      rawQuote({
        paymentMethod: "alipay",
        fiatAmount: "13376401",
        intent: { ...rawQuote().intent, processorName: "alipay", fiatCurrencyCode: CNY_HASH },
        maker: { offchainId: "maker@example.com" },
      }),
      "CNY",
      NOW + 600_000,
    )!;

  function setup(lookup: (platform: string, hash: string) => Promise<unknown>) {
    const fc = fakeClient();
    const storage = memoryOrderStorage();
    const quote = alipayQuote();
    const result = (): BuyQuoteResult => ({ fiatAmount: quote.fiatAmount, currency: "CNY", quotes: [quote], nearby: { below: [], above: [] }, expiresAt: NOW + 600_000 });
    const fetchPayeeHandle = vi.fn(lookup) as never;
    const store = createBuyStore({
      warn: vi.fn(),
      getClient: () => fc.client,
      extension: fakeExtension().sdk,
      storage,
      quotes: vi.fn(async () => result()),
      fetchPayeeHandle,
      canInstallExtension: () => true,
      now: () => NOW,
      sleep: async () => {},
      random: () => 0,
      indexerTimeoutMs: 1_000,
      signalReconcileMs: 1_000,
      pollIntervalMs: 15_000,
      every: () => () => {},
      onFocus: () => () => {},
    });
    const sender = fakeSender(async (calls: WalletCall[]): Promise<TransactionReceipt> =>
      isSignalCall(calls[0]?.data) ? receipt([intentSignaledLog(), fundsLockedLog()]) : receipt([]),
    );
    return { store, fc, storage, sender, quote, fetchPayeeHandle };
  }

  async function confirm(s: ReturnType<typeof setup>) {
    s.store.getState().bindSender(s.sender);
    await flush();
    await s.store.getState().requestQuotes({ fiatAmount: "13.376401", currency: "CNY" });
    s.store.getState().selectQuote(s.quote.id);
    await s.store.getState().confirm();
    await flush();
  }

  it("looks up the seller's PID before signalling and keeps it on the order", async () => {
    const s = setup(async () => ({ handle: "maker@example.com", business: false, recipientId: PID }));
    await confirm(s);
    expect(s.sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(s.store.getState()).toMatchObject({ step: "awaitingPayment", order: { platform: "alipay", recipientId: PID } });
    expect(s.storage.load(BUYER)?.recipientId).toBe(PID);
    const steps = getPaymentInstructions(s.store.getState().order!);
    expect(steps.qrValue).toContain(`userId=${PID}`);
  });

  it.each([
    ["no maker record", async () => null],
    ["a bare handle", async () => "maker@example.com"],
    ["a malformed PID", async () => ({ handle: "maker@example.com", business: false, recipientId: "2088" })],
    ["a failed lookup", async () => {
      throw new Error("Curator down");
    }],
  ])("never signals when Curator has %s", async (_label, lookup) => {
    const s = setup(lookup);
    await confirm(s);
    expect(s.sender.sendCalls).not.toHaveBeenCalled();
    expect(s.fc.signalPrepare).not.toHaveBeenCalled();
    expect(s.store.getState()).toMatchObject({
      step: "error",
      error: { code: "payment_method_unavailable" },
      errorReturnStep: "idle",
      quotes: [],
      order: null,
    });
    expect(s.store.getState().error?.message).toMatch(/Pick another seller/);
    expect(s.storage.load(BUYER)).toBeNull();
  });
});

describe("verifying a UPI order", () => {
  it("names the Amazon Pay account when no payment is found", async () => {
    const fc = fakeClient();
    const ext = fakeExtension();
    const storage = memoryOrderStorage();
    storage.save(storedOrder({ platform: "upi", currency: "INR", payeeHandle: "seller@okaxis", fiatToSendText: "500.00", fiatToSend: 500_000_000n }));
    const store = createBuyStore({
      warn: vi.fn(),
      getClient: () => fc.client,
      extension: ext.sdk,
      storage,
      fetchPayeeHandle: vi.fn(async () => "seller@okaxis"),
      canInstallExtension: () => true,
      now: () => NOW,
      sleep: async () => {},
      every: () => () => {},
      onFocus: () => () => {},
    });
    store.getState().bindSender(fakeSender(async () => receipt([])));
    await flush(40);
    expect(store.getState()).toMatchObject({ step: "awaitingPayment", order: { platform: "upi" } });
    await store.getState().markPaid();
    await flush(20);
    expect(ext.sdk.authenticate).toHaveBeenCalledWith(expect.objectContaining({ actionType: "transfer_upi_amazonpay", platform: "upi" }));
    ext.emit({ platform: "upi", requestId: "r", expiresAt: NOW + 300_000, metadata: [], buyerTeeCapture: { encryptedSessionMaterial: "enc" } });
    expect(store.getState().error).toMatchObject({ code: "no_payments" });
    expect(store.getState().error?.message).toContain("sent Amazon Pay payments");
  });
});

describe("Curator 503s", () => {
  const unavailable = (message = "V3 admission state unavailable") => new APIError(message, 503);

  it("retries a 503 at most twice, with under 2 s of backoff", async () => {
    expect(CURATOR_RETRY_DELAYS_MS).toHaveLength(2);
    expect(CURATOR_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(2_000);
    const waits: number[] = [];
    const run = vi.fn().mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable("Indexer unavailable")).mockResolvedValue("ok");
    await expect(withCuratorRetry(run, async (ms) => void waits.push(ms))).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([...CURATOR_RETRY_DELAYS_MS]);

    const always = vi.fn().mockRejectedValue(unavailable());
    await expect(withCuratorRetry(always, async () => {})).rejects.toMatchObject({ status: 503 });
    expect(always).toHaveBeenCalledTimes(3);
  });

  it("never retries other failures", async () => {
    for (const error of [new APIError("No quotes found", 404), new APIError("Bad", 400), new Error("boom")]) {
      const run = vi.fn().mockRejectedValue(error);
      await expect(withCuratorRetry(run, async () => {})).rejects.toBe(error);
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  function quoteResponse(): GetQuoteResponse {
    return {
      success: true,
      message: "ok",
      statusCode: 200,
      responseObject: {
        fiat: { currencyCode: "USD", currencyName: "USD", currencySymbol: "$", countryCode: "us" },
        token: { token: "0x", decimals: 6, name: "USD Coin", symbol: "USDC", chainId: 8453 },
        quotes: [rawQuote()] as GetQuoteResponse["responseObject"]["quotes"],
        fees: { zkp2pFee: "0", zkp2pFeeFormatted: "0", swapFee: "0", swapFeeFormatted: "0" },
        quoteExpiresAt: new Date(NOW + 600_000).toISOString(),
        orchestratorAddress: "0x014025fde093f8701d86e9f38e2c3a9b779cb5c7",
        mode: "eligible",
      },
    };
  }

  it("rides out a 503 in getBuyQuotes and getBestPricesByPlatform", async () => {
    vi.useFakeTimers();
    const getQuote = vi.fn().mockRejectedValueOnce(unavailable()).mockResolvedValue(quoteResponse());
    const getQuotesBestByPlatform = vi
      .fn()
      .mockRejectedValueOnce(unavailable("Indexer unavailable"))
      .mockResolvedValue({ responseObject: { platformQuotes: [{ platform: "revolut", available: true, bestQuote: rawQuote() }] } });
    const client = { getQuote, getQuotesBestByPlatform } as unknown as Zkp2pClient;

    const quotes = getBuyQuotes({ fiatAmount: "50", currency: "USD", client });
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await quotes).quotes).toHaveLength(1);
    expect(getQuote).toHaveBeenCalledTimes(2);

    const prices = getBestPricesByPlatform({ fiatAmount: "50", currency: "USD", client });
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await prices).find((p) => p.platform === "revolut")?.available).toBe(true);
    expect(getQuotesBestByPlatform).toHaveBeenCalledTimes(2);
  });
});
