import { isMajorCurrency } from "@shared/currencies";
import { getCurrencyCodeFromHash, getPaymentMethodsCatalog } from "@zkp2p/sdk";
import { describe, expect, it } from "vitest";
import {
  BUY_PLATFORM_IDS,
  BUY_PLATFORMS,
  BUYER_TEE_VERIFIERS,
  FIAT_CURRENCIES,
  buyableCurrencies,
  currenciesForPlatform,
  defaultCurrencyForLocale,
  platformsForCurrency,
  resolveVerifyMethod,
  zelleQrLink,
  type SendContext,
} from "../../platforms";

const catalog = getPaymentMethodsCatalog(8453, "production");

describe("catalog", () => {
  it("only marks platforms the SDK can signal and the attestation service can verify as live", () => {
    for (const id of BUY_PLATFORM_IDS) {
      const verifiable = BUY_PLATFORMS[id].verifyMethods.every((m) => BUYER_TEE_VERIFIERS.has(`${m.actionPlatform}/${m.actionType}`));
      const offered = BUY_PLATFORMS[id].currencies.length > 0;
      expect(BUY_PLATFORMS[id].live, id).toBe(Boolean(catalog[id]) && verifiable && offered);
    }
    expect(BUY_PLATFORMS.venmo.live).toBe(true);
    expect(BUY_PLATFORMS.n26.live).toBe(false);
    expect(BUY_PLATFORMS.luxon.live).toBe(false);
    // In the SDK catalog, but the attestation service has no buyer TEE verifier for it.
    expect(BUY_PLATFORMS.mercadopago.live).toBe(false);
    expect(buyableCurrencies()).not.toContain("ARS");
  });

  it("offers exactly the major currencies the on-chain payment method accepts", () => {
    for (const id of BUY_PLATFORM_IDS) {
      const entry = catalog[id];
      if (!entry?.currencies) continue;
      const onchain = entry.currencies
        .map((hash) => getCurrencyCodeFromHash(hash))
        .filter((code): code is string => typeof code === "string" && isMajorCurrency(code))
        .sort();
      expect([...BUY_PLATFORMS[id].currencies].sort(), id).toEqual(onchain);
    }
  });

  it("offers only major currencies, so niche ones and the platforms that only take them are gone", () => {
    for (const code of buyableCurrencies()) expect(isMajorCurrency(code), code).toBe(true);
    expect(buyableCurrencies()).toEqual(expect.arrayContaining(["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SGD", "MXN"]));
    for (const code of ["UAH", "JPY", "TRY", "ZAR", "PLN", "SEK", "AED"]) expect(buyableCurrencies()).not.toContain(code);
    expect(BUY_PLATFORMS.monobank.live).toBe(false);
  });

  it("has metadata for every currency it uses", () => {
    for (const id of BUY_PLATFORM_IDS) {
      for (const code of BUY_PLATFORMS[id].currencies) expect(FIAT_CURRENCIES[code], code).toBeDefined();
    }
  });

  it("filters platforms by currency and liveness", () => {
    expect(platformsForCurrency("GBP").map((p) => p.id)).toEqual(["revolut", "wise", "paypal", "monzo"]);
    expect(platformsForCurrency("EUR").map((p) => p.id)).not.toContain("n26");
    expect(platformsForCurrency("EUR", { includeUnavailable: true }).map((p) => p.id)).toContain("n26");
    expect(currenciesForPlatform("monzo")).toEqual(["GBP"]);
    expect(currenciesForPlatform("revolut")).not.toContain("JPY");
  });

  it("picks a currency from the locale", () => {
    expect(defaultCurrencyForLocale("en-GB")).toBe("GBP");
    expect(defaultCurrencyForLocale("de-DE")).toBe("EUR");
    expect(defaultCurrencyForLocale("fr")).toBe("EUR");
    // ARS is only on Mercado Pago, which cannot be verified, so Argentina falls back to USD.
    expect(defaultCurrencyForLocale("es-AR")).toBe("USD");
    expect(defaultCurrencyForLocale("ko-KR")).toBe("USD");
    expect(defaultCurrencyForLocale("not a locale")).toBe("USD");
  });

  it("needs a bank choice for Zelle and defaults PayPal to personal", () => {
    expect(resolveVerifyMethod("zelle")).toBeNull();
    expect(resolveVerifyMethod("zelle", "citi")?.actionType).toBe("transfer_zelle_citi");
    expect(resolveVerifyMethod("paypal")?.actionType).toBe("transfer_paypal");
    expect(resolveVerifyMethod("paypal", "business")?.actionType).toBe("transfer_business_paypal");
    expect(resolveVerifyMethod("venmo")?.actionType).toBe("transfer_venmo");
  });
});

describe("send links", () => {
  const ctx = (payee: string, amount = "101.50", currency: SendContext["currency"] = "USD"): SendContext => ({
    payee,
    amount,
    currency,
    memo: null,
    recipientId: null,
  });

  it("builds Venmo app and web links with the note", () => {
    const links = BUY_PLATFORMS.venmo.sendLinks({ ...ctx("alice"), memo: "🍕" }, null);
    expect(links.deepLink).toBe(`venmo://paycharge?txn=pay&recipients=alice&note=${encodeURIComponent("🍕")}&amount=101.50`);
    expect(links.webLink).toBe(`https://account.venmo.com/pay?recipients=alice&note=${encodeURIComponent("🍕")}&amount=101.50`);
    expect(links.qrValue).toBe(links.deepLink);
  });

  it("builds handle links for Cash App, Revolut, Wise, Chime and X Money", () => {
    expect(BUY_PLATFORMS.cashapp.sendLinks(ctx("bob"), null).deepLink).toBe("https://cash.app/$bob");
    expect(BUY_PLATFORMS.cashapp.sendLinks(ctx("$bob"), null).deepLink).toBe("https://cash.app/$bob");
    expect(BUY_PLATFORMS.revolut.sendLinks(ctx("revtag"), null).deepLink).toBe("https://revolut.me/revtag");
    expect(BUY_PLATFORMS.wise.sendLinks(ctx("@wisetag"), null).deepLink).toBe("https://wise.com/pay/me/wisetag");
    expect(BUY_PLATFORMS.chime.sendLinks(ctx("$zezima-rs"), null).deepLink).toBe(
      "https://app.chime.com/link/qr?u=zezima-rs",
    );
    expect(BUY_PLATFORMS.xmoney.sendLinks(ctx("zezima"), null).deepLink).toBe(
      "https://x.com/i/money/pay/zezima",
    );
  });

  it("puts the amount and currency in PayPal.me links", () => {
    const links = BUY_PLATFORMS.paypal.sendLinks(ctx("https://paypal.me/Carol/5", "12.00", "EUR"), null);
    expect(links.deepLink).toBe("https://paypal.me/carol/12.00EUR");
  });

  it("routes Zelle by bank", () => {
    const chase = resolveVerifyMethod("zelle", "chase");
    const bofa = resolveVerifyMethod("zelle", "bofa");
    const email = "seller@example.com";
    expect(BUY_PLATFORMS.zelle.sendLinks(ctx(email), null).deepLink).toBeNull();
    const chaseLinks = BUY_PLATFORMS.zelle.sendLinks(ctx(email), chase);
    expect(chaseLinks.qrValue).toBe(zelleQrLink(email));
    // The button opens the bank's own Zelle page, as Peer's "Pay on Desktop" does; the QR link only finds a bank.
    expect(chaseLinks.webLink).toMatch(/^https:\/\/secure\.chase\.com\//);
    expect(chaseLinks.deepLink).toBe(chaseLinks.webLink);
    expect(BUY_PLATFORMS.zelle.sendLinks(ctx(email), resolveVerifyMethod("zelle", "citi")).webLink).toBe(
      "https://online.citi.com/US/nga/zelle/transfer",
    );
    const decoded = JSON.parse(atob(zelleQrLink(email).split("data=")[1] ?? ""));
    expect(decoded).toEqual({ name: "", action: "payment", token: email });
    const bofaLinks = BUY_PLATFORMS.zelle.sendLinks(ctx(email), bofa);
    expect(bofaLinks.deepLink).toBe("https://www.bankofamerica.com/movemoney");
    expect(bofaLinks.qrValue).toBeNull();
  });

  it("writes rules with the exact amount", () => {
    const rules = BUY_PLATFORMS.revolut.rules(ctx("revtag", "101.50", "GBP"), null);
    expect(rules[0]).toEqual({ kind: "do", text: "Send exactly 101.50 GBP in one payment." });
    expect(rules.some((r) => r.kind === "dont" && r.text.includes("card"))).toBe(true);
  });
});
