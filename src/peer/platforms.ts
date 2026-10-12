/**
 * Buy-side payment platform catalog: what each platform accepts, how the
 * buyer pays a seller on it, and how the Peer extension proves that payment.
 * Values mirror Peer's own platform configs (zkp2p-clients packages/core
 * platforms/*.ts); the rules text is condensed to short plain English.
 *
 * `live` needs both an on-chain payment method the installed SDK can resolve
 * and a production buyer TEE verifier for every verify method (attestation
 * service GET /buyer/supported, the set Peer's web app offers for buying).
 * Mercado Pago, Luxon and N26 have no buyer verifier: a buyer could signal and
 * pay but never prove the payment, so they are listed but never quoted.
 * Alipay (CNY) and UPI via Amazon Pay (INR) are beta on Peer, as is X Money.
 */

import { getPaymentMethodsCatalog, resolvePaymentMethodHashFromCatalog } from "@zkp2p/sdk";
import { isMajorCurrency } from "@shared/currencies";
import { CHAIN_ID } from "@/config";

export interface FiatCurrency {
  code: string;
  name: string;
  symbol: string;
  /** ISO 4217 minor units. */
  decimals: number;
  /** ISO 3166 alpha-2, lowercase (for flag sprites). */
  country: string;
}

export const FIAT_CURRENCIES = {
  USD: { code: "USD", name: "US Dollar", symbol: "$", decimals: 2, country: "us" },
  EUR: { code: "EUR", name: "Euro", symbol: "€", decimals: 2, country: "eu" },
  GBP: { code: "GBP", name: "British Pound", symbol: "£", decimals: 2, country: "gb" },
  AUD: { code: "AUD", name: "Australian Dollar", symbol: "A$", decimals: 2, country: "au" },
  CAD: { code: "CAD", name: "Canadian Dollar", symbol: "C$", decimals: 2, country: "ca" },
  NZD: { code: "NZD", name: "New Zealand Dollar", symbol: "NZ$", decimals: 2, country: "nz" },
  SGD: { code: "SGD", name: "Singapore Dollar", symbol: "S$", decimals: 2, country: "sg" },
  HKD: { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$", decimals: 2, country: "hk" },
  CHF: { code: "CHF", name: "Swiss Franc", symbol: "Fr", decimals: 2, country: "ch" },
  JPY: { code: "JPY", name: "Japanese Yen", symbol: "¥", decimals: 0, country: "jp" },
  CNY: { code: "CNY", name: "Chinese Yuan", symbol: "¥", decimals: 2, country: "cn" },
  MXN: { code: "MXN", name: "Mexican Peso", symbol: "MX$", decimals: 2, country: "mx" },
  ARS: { code: "ARS", name: "Argentine Peso", symbol: "AR$", decimals: 2, country: "ar" },
  AED: { code: "AED", name: "UAE Dirham", symbol: "AED ", decimals: 2, country: "ae" },
  SAR: { code: "SAR", name: "Saudi Riyal", symbol: "SAR ", decimals: 2, country: "sa" },
  ILS: { code: "ILS", name: "Israeli Shekel", symbol: "₪", decimals: 2, country: "il" },
  TRY: { code: "TRY", name: "Turkish Lira", symbol: "₺", decimals: 2, country: "tr" },
  ZAR: { code: "ZAR", name: "South African Rand", symbol: "R", decimals: 2, country: "za" },
  KES: { code: "KES", name: "Kenyan Shilling", symbol: "KSh", decimals: 2, country: "ke" },
  UGX: { code: "UGX", name: "Ugandan Shilling", symbol: "USh", decimals: 0, country: "ug" },
  INR: { code: "INR", name: "Indian Rupee", symbol: "₹", decimals: 2, country: "in" },
  IDR: { code: "IDR", name: "Indonesian Rupiah", symbol: "Rp", decimals: 2, country: "id" },
  MYR: { code: "MYR", name: "Malaysian Ringgit", symbol: "RM", decimals: 2, country: "my" },
  PHP: { code: "PHP", name: "Philippine Peso", symbol: "₱", decimals: 2, country: "ph" },
  THB: { code: "THB", name: "Thai Baht", symbol: "฿", decimals: 2, country: "th" },
  VND: { code: "VND", name: "Vietnamese Dong", symbol: "₫", decimals: 0, country: "vn" },
  PLN: { code: "PLN", name: "Polish Zloty", symbol: "zł", decimals: 2, country: "pl" },
  CZK: { code: "CZK", name: "Czech Koruna", symbol: "Kč", decimals: 2, country: "cz" },
  HUF: { code: "HUF", name: "Hungarian Forint", symbol: "Ft", decimals: 2, country: "hu" },
  RON: { code: "RON", name: "Romanian Leu", symbol: "lei ", decimals: 2, country: "ro" },
  DKK: { code: "DKK", name: "Danish Krone", symbol: "kr ", decimals: 2, country: "dk" },
  NOK: { code: "NOK", name: "Norwegian Krone", symbol: "kr ", decimals: 2, country: "no" },
  SEK: { code: "SEK", name: "Swedish Krona", symbol: "kr ", decimals: 2, country: "se" },
  UAH: { code: "UAH", name: "Ukrainian Hryvnia", symbol: "₴", decimals: 2, country: "ua" },
} as const satisfies Record<string, FiatCurrency>;

export type FiatCode = keyof typeof FIAT_CURRENCIES;

export const FIAT_CODES = Object.keys(FIAT_CURRENCIES) as FiatCode[];

export function isFiatCode(value: string): value is FiatCode {
  return Object.prototype.hasOwnProperty.call(FIAT_CURRENCIES, value);
}

export const BUY_PLATFORM_IDS = [
  "venmo",
  "cashapp",
  "revolut",
  "wise",
  "zelle",
  "paypal",
  "monzo",
  "chime",
  "n26",
  "luxon",
  "mercadopago",
  "monobank",
  "xmoney",
  "alipay",
  "upi",
] as const;

export type BuyPlatformId = (typeof BUY_PLATFORM_IDS)[number];

export function isBuyPlatformId(value: string): value is BuyPlatformId {
  return (BUY_PLATFORM_IDS as readonly string[]).includes(value);
}

export interface PaymentRule {
  kind: "do" | "dont";
  text: string;
}

/**
 * How the Peer extension captures and proves a payment. Zelle has one per
 * bank and PayPal one per account type; every other platform has "default".
 */
export interface VerifyMethod {
  id: string;
  label: string;
  /** Extension provider template and attestation route. */
  actionType: string;
  /** Platform key the extension and attestation service expect. */
  actionPlatform: string;
}

export interface SendContext {
  /** Raw payee handle from Curator (maker offchainId). */
  payee: string;
  /** Exact amount to send as a plain decimal, e.g. "101.50". */
  amount: string;
  currency: FiatCode;
  /** Note to put on the payment, where the platform needs one. */
  memo: string | null;
  /**
   * The seller's account id for the payment link where it differs from the
   * payee handle: Alipay's 16-digit PID from Curator's maker metadata (the
   * handle is the seller's email). Null for every other platform.
   */
  recipientId: string | null;
}

export interface SendLinks {
  /** Opens the platform app or payment page. */
  deepLink: string | null;
  /** Browser fallback when the deep link is an app scheme. */
  webLink: string | null;
  /** Value to encode in a QR code, only when it carries the recipient. */
  qrValue: string | null;
}

export interface BuyPlatform {
  id: BuyPlatformId;
  name: string;
  color: string;
  currencies: readonly FiatCode[];
  /** Smallest fiat amount the platform supports, decimal string. */
  minFiat: string;
  /** Client-side cap per order in USDC, decimal string, when the platform has one. */
  maxUsdc: string | null;
  /** What the payee handle is, e.g. "Venmo username". */
  payeeLabel: string;
  verifyMethods: readonly VerifyMethod[];
  /**
   * "beforePayment": the buyer must pick a method before paying (Zelle bank
   * decides where to send). "beforeVerify": pick at verification, defaults
   * to the first (PayPal personal or business). "none": single method.
   */
  methodChoice: "none" | "beforePayment" | "beforeVerify";
  /** The attestation locates the payment by its row index in the capture. */
  includeMetadataIndex: boolean;
  /** The send link carries a payment note (Venmo requires one). */
  usesMemo: boolean;
  /**
   * False where the platform's web pay page is not the in-app balance transfer
   * Peer can verify (revolut.me and monzo.me take cards). A computer then gets
   * only the QR to scan with the phone app, as Peer's web app does
   * (sendConfig.supportsSendingPaymentOnWeb: false).
   */
  payOnWeb?: false;
  /** Locale the platform shows money in (Peer core localeTimeString). Unset means plain en-US decimals. */
  amountLocale?: string;
  /**
   * Oldest Peer extension build that can capture this platform's buyer
   * payment, when above Peer's 0.6.3 floor (verifyConfig.minExtensionVersion).
   */
  minExtensionVersion?: string;
  /** Peer marks the platform beta (isBeta): available, but newer and less proven. */
  beta?: true;
  /** A non-blocking notice to show before the buyer places an order on this platform. */
  buyNotice?: string;
  /** Shown instead of "No offers right now" when the platform's book is empty for a known reason. */
  noOffersNote?: string;
  /** True when the platform can be signalled with the installed SDK and verified by Peer's attestation service. */
  live: boolean;
  formatPayee(handle: string): string;
  sendLinks(ctx: SendContext, method: VerifyMethod | null): SendLinks;
  warning(ctx: SendContext, method: VerifyMethod | null): string | null;
  rules(ctx: SendContext, method: VerifyMethod | null): PaymentRule[];
}

const NO_CRYPTO_NOTE: PaymentRule = {
  kind: "dont",
  text: "Don't mention Peer, PeerAuth or crypto in the note.",
};

function exactly(ctx: SendContext): PaymentRule {
  return { kind: "do", text: `Send exactly ${ctx.amount} ${ctx.currency} in one payment.` };
}

function single(id: string, label: string, actionType: string, actionPlatform: string): VerifyMethod {
  return { id, label, actionType, actionPlatform };
}

function noLinks(): SendLinks {
  return { deepLink: null, webLink: null, qrValue: null };
}

function webOnly(url: string, qr = false): SendLinks {
  return { deepLink: url, webLink: url, qrValue: qr ? url : null };
}

function stripPrefix(handle: string, prefix: string): string {
  return handle.trim().startsWith(prefix) ? handle.trim().slice(prefix.length) : handle.trim();
}

function withPrefix(handle: string, prefix: string): string {
  return `${prefix}${stripPrefix(handle, prefix)}`;
}

const PAYPAL_ME = /^(?:https?:\/\/)?(?:www\.)?paypal\.me\//i;

function paypalUsername(handle: string): string {
  const withoutDomain = handle.trim().replace(PAYPAL_ME, "");
  const [path = ""] = withoutDomain.split(/[?#]/, 1);
  const [username = ""] = path.replace(/^\/+/, "").split("/", 1);
  return username.replace(/^@+/, "").trim().toLowerCase();
}

/** Zelle's QR enrollment link carries the recipient token as base64 JSON. */
export function zelleQrLink(email: string): string {
  const payload = JSON.stringify({ name: "", action: "payment", token: email.trim() });
  return `https://enroll.zellepay.com/qr-codes?data=${btoa(payload)}`;
}

export type ZelleBank = "chase" | "bofa" | "citi";

const ZELLE_BANK_NAMES: Record<ZelleBank, string> = {
  chase: "Chase",
  bofa: "Bank of America",
  citi: "Citi",
};

const venmo: BuyPlatform = {
  id: "venmo",
  name: "Venmo",
  color: "#3D95CE",
  currencies: ["USD"],
  minFiat: "0.1",
  maxUsdc: "5000",
  payeeLabel: "Venmo username",
  verifyMethods: [single("default", "Venmo", "transfer_venmo", "venmo")],
  methodChoice: "none",
  includeMetadataIndex: true,
  usesMemo: true,
  noOffersNote: "Every Venmo seller on Peer only sells to Peer Pay members right now.",
  live: false,
  formatPayee: (h) => withPrefix(h, "@"),
  sendLinks: (ctx) => {
    const query = `txn=pay&recipients=${encodeURIComponent(stripPrefix(ctx.payee, "@"))}&note=${encodeURIComponent(
      ctx.memo ?? "",
    )}&amount=${ctx.amount}`;
    const deepLink = `venmo://paycharge?${query}`;
    return {
      deepLink,
      webLink: `https://account.venmo.com/pay?${query.replace("txn=pay&", "")}`,
      qrValue: deepLink,
    };
  },
  warning: () => 'Pay as friends & family. Do not turn on "Turn on for purchases".',
  rules: (ctx) => [
    exactly(ctx),
    { kind: "do", text: "Pay as friends & family." },
    { kind: "do", text: "Double-check the username before you confirm." },
    { kind: "dont", text: "Don't pay from a business account." },
    { kind: "dont", text: 'Don\'t turn on "Turn on for purchases".' },
    NO_CRYPTO_NOTE,
  ],
};

const cashapp: BuyPlatform = {
  id: "cashapp",
  name: "Cash App",
  color: "#00D632",
  currencies: ["USD"],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "$Cashtag",
  verifyMethods: [single("default", "Cash App", "transfer_cashapp", "cashapp")],
  methodChoice: "none",
  includeMetadataIndex: true,
  usesMemo: false,
  payOnWeb: false,
  live: false,
  formatPayee: (h) => withPrefix(h, "$"),
  sendLinks: (ctx) => webOnly(`https://cash.app/${withPrefix(ctx.payee, "$")}`, true),
  warning: (ctx) => `Send exactly ${ctx.amount} ${ctx.currency} in a single payment.`,
  rules: (ctx) => [
    exactly(ctx),
    { kind: "do", text: "Pay to the $Cashtag shown here." },
    { kind: "do", text: "Double-check the recipient before you confirm." },
    NO_CRYPTO_NOTE,
    { kind: "dont", text: "Don't pay with an expired or expiring linked card." },
  ],
};

const revolut: BuyPlatform = {
  id: "revolut",
  name: "Revolut",
  color: "#000000",
  currencies: [
    "USD", "EUR", "GBP", "SGD", "NZD", "AUD", "CAD", "HKD", "MXN", "SAR", "AED", "THB",
    "TRY", "PLN", "CHF", "ZAR", "JPY", "CZK", "CNY", "DKK", "HUF", "NOK", "RON", "SEK",
  ],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "Revtag",
  verifyMethods: [single("default", "Revolut", "transfer_revolut", "revolut")],
  methodChoice: "none",
  includeMetadataIndex: true,
  usesMemo: false,
  payOnWeb: false,
  live: false,
  formatPayee: (h) => withPrefix(h, "@"),
  sendLinks: (ctx) => webOnly(`https://revolut.me/${encodeURIComponent(stripPrefix(ctx.payee, "@"))}`, true),
  warning: () => "Send in the same currency. A wrong-currency payment loses 5%.",
  rules: (ctx) => [
    exactly(ctx),
    { kind: "do", text: "Pay from your Revolut balance in the Revolut app before the order expires." },
    { kind: "do", text: "Use a personal Revolut account that you control." },
    { kind: "dont", text: "Don't pay by card on the Revolut link. Card payments can't be verified." },
    { kind: "dont", text: "Don't convert currency. A wrong-currency payment loses 5%." },
    { kind: "dont", text: "Don't pay from a Business, Kids & Teens, joint or shared account." },
  ],
};

const wise: BuyPlatform = {
  id: "wise",
  name: "Wise",
  color: "#163300",
  currencies: [
    "USD", "CNY", "EUR", "GBP", "AUD", "NZD", "CAD", "AED", "CHF", "ZAR", "SGD", "ILS",
    "HKD", "JPY", "PLN", "TRY", "IDR", "KES", "MYR", "MXN", "THB", "VND", "UGX", "CZK",
    "DKK", "HUF", "INR", "NOK", "PHP", "RON", "SEK",
  ],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "Wisetag",
  verifyMethods: [single("default", "Wise", "transfer_wise", "wise")],
  methodChoice: "none",
  includeMetadataIndex: false,
  usesMemo: false,
  live: false,
  formatPayee: (h) => withPrefix(h, "@"),
  sendLinks: (ctx) => webOnly(`https://wise.com/pay/me/${encodeURIComponent(stripPrefix(ctx.payee, "@"))}`, true),
  warning: (ctx) => `The seller must receive ${ctx.currency}. Paying from another currency loses 5%, and a payment that arrives in another currency can't be verified.`,
  rules: (ctx) => [
    { kind: "do", text: `Send it as one payment, with ${ctx.currency} as the currency the seller gets and exactly ${ctx.amount} ${ctx.currency} arriving.` },
    { kind: "dont", text: "Don't convert currency. A cross-currency payment loses 5%." },
    NO_CRYPTO_NOTE,
  ],
};

const zelle: BuyPlatform = {
  id: "zelle",
  name: "Zelle",
  color: "#6D1ED4",
  currencies: ["USD"],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "Zelle email",
  verifyMethods: [
    single("chase", ZELLE_BANK_NAMES.chase, "transfer_zelle_chase", "zelle"),
    single("bofa", ZELLE_BANK_NAMES.bofa, "transfer_zelle_bofa", "zelle"),
    single("citi", ZELLE_BANK_NAMES.citi, "transfer_zelle_citi", "zelle"),
  ],
  methodChoice: "beforePayment",
  includeMetadataIndex: true,
  usesMemo: false,
  live: false,
  formatPayee: (h) => h.trim(),
  sendLinks: (ctx, method) => {
    if (!method) return noLinks();
    if (method.id === "bofa") return webOnly("https://www.bankofamerica.com/movemoney");
    // The QR is for the bank's app to scan. The button opens the bank's own Zelle page, as Peer's
    // "Pay on Desktop" and mobile "Send Payment" do (core platforms/zelle.ts troubleScanningQRCodeLink):
    // opening the QR link itself only lands on Zelle's "Find Your Bank" enrolment page.
    const bankLink =
      method.id === "chase"
        ? "https://secure.chase.com/web/auth/dashboard#/dashboard/singleDoor/singleDoorController/index"
        : "https://online.citi.com/US/nga/zelle/transfer";
    return { deepLink: bankLink, webLink: bankLink, qrValue: zelleQrLink(ctx.payee) };
  },
  warning: (ctx, method) =>
    method
      ? `Send exactly ${ctx.amount} ${ctx.currency} through ${method.label}'s Zelle.`
      : "Choose the bank you will pay from before you send.",
  rules: (ctx, method) => {
    const bank = method?.label ?? "your bank";
    const rules: PaymentRule[] = [exactly(ctx), { kind: "do", text: `Use ${bank} for this payment.` }];
    if (method?.id === "bofa") {
      rules.push({ kind: "do", text: "Type the recipient email in by hand and double-check it." });
    }
    rules.push(
      { kind: "dont", text: `Don't send unless you can log in to ${bank}'s website. It's needed to verify.` },
      { kind: "dont", text: "Don't use any other bank." },
    );
    return rules;
  },
};

const paypal: BuyPlatform = {
  id: "paypal",
  name: "PayPal",
  color: "#0070BA",
  currencies: ["USD", "EUR", "GBP", "SGD", "NZD", "AUD", "CAD"],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "PayPal.me username",
  verifyMethods: [
    single("personal", "Personal account", "transfer_paypal", "paypal"),
    single("business", "Business account", "transfer_business_paypal", "paypal"),
  ],
  methodChoice: "beforeVerify",
  includeMetadataIndex: false,
  usesMemo: false,
  noOffersNote: "Every PayPal seller on Peer only sells to Peer Pay members right now.",
  live: false,
  formatPayee: (h) => `paypal.me/${paypalUsername(h)}`,
  sendLinks: (ctx) => {
    const username = paypalUsername(ctx.payee);
    if (!username) return noLinks();
    const link = `https://paypal.me/${encodeURIComponent(username)}/${ctx.amount}${ctx.currency}`;
    return { deepLink: link, webLink: link, qrValue: link };
  },
  warning: () => "Remember whether you paid from a personal or business account. You pick the same one to verify.",
  rules: (ctx) => [
    { kind: "do", text: "Choose Friends and Family." },
    { kind: "do", text: "Pay from your PayPal balance so it lands before the order expires." },
    { kind: "do", text: `Make sure the seller gets at least ${ctx.amount} ${ctx.currency} after fees.` },
    { kind: "dont", text: "Never send as Goods and Services. You will lose the money." },
    { kind: "dont", text: "Don't pay by bank account or eCheck. Those clear too late." },
    { kind: "dont", text: "Don't convert currency. A wrong-currency payment loses 5%." },
    NO_CRYPTO_NOTE,
  ],
};

const monzo: BuyPlatform = {
  id: "monzo",
  name: "Monzo",
  color: "#112231",
  currencies: ["GBP"],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "Monzo.me username",
  verifyMethods: [single("default", "Monzo", "transfer_monzo", "monzo")],
  methodChoice: "none",
  includeMetadataIndex: false,
  usesMemo: false,
  payOnWeb: false,
  live: false,
  formatPayee: (h) => `monzo.me/${h.trim()}`,
  sendLinks: (ctx) => webOnly(`https://monzo.me/${encodeURIComponent(ctx.payee.trim())}`, true),
  warning: (ctx) => `Send ${ctx.amount} ${ctx.currency} in a single payment from the Monzo app.`,
  rules: (ctx) => [
    { kind: "do", text: "Pay in the Monzo app." },
    exactly(ctx),
    { kind: "dont", text: "Don't pay by card." },
  ],
};

const chime: BuyPlatform = {
  id: "chime",
  name: "Chime",
  color: "#1EC677",
  currencies: ["USD"],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "$ChimeSign",
  verifyMethods: [single("default", "Chime", "transfer_chime", "chime")],
  methodChoice: "none",
  includeMetadataIndex: false,
  usesMemo: false,
  payOnWeb: false,
  live: false,
  formatPayee: (h) => withPrefix(h, "$"),
  sendLinks: (ctx) =>
    webOnly(`https://app.chime.com/link/qr?u=${encodeURIComponent(stripPrefix(ctx.payee, "$"))}`, true),
  warning: (ctx) => `Send exactly ${ctx.amount} ${ctx.currency} in a single payment.`,
  rules: (ctx) => [
    exactly(ctx),
    { kind: "do", text: "Pay with the Chime QR or $ChimeSign." },
    { kind: "do", text: "Double-check the recipient before you confirm." },
    NO_CRYPTO_NOTE,
  ],
};

const n26: BuyPlatform = {
  id: "n26",
  name: "N26",
  color: "#121212",
  currencies: ["EUR"],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "IBAN",
  verifyMethods: [single("default", "N26", "transfer_n26", "n26")],
  methodChoice: "none",
  includeMetadataIndex: false,
  usesMemo: false,
  live: false,
  formatPayee: (h) => h.trim(),
  sendLinks: () => ({ deepLink: "number26://", webLink: "https://app.n26.com/", qrValue: null }),
  warning: () => "Only SEPA Instant is accepted. A standard SEPA transfer will be rejected.",
  rules: (ctx) => [
    { kind: "do", text: "Choose SEPA Instant when you send." },
    exactly(ctx),
    { kind: "do", text: "Enter the IBAN exactly as shown." },
    { kind: "dont", text: "Don't use a standard SEPA transfer." },
    { kind: "dont", text: "Don't mention Peer or crypto in the reference." },
  ],
};

const luxon: BuyPlatform = {
  id: "luxon",
  name: "Luxon",
  color: "#1B6FF2",
  currencies: ["USD", "EUR", "GBP"],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "Luxon recipient",
  verifyMethods: [single("default", "Luxon", "transfer_luxon", "luxon")],
  methodChoice: "none",
  includeMetadataIndex: false,
  usesMemo: false,
  live: false,
  formatPayee: (h) => h.trim(),
  sendLinks: () => webOnly("https://web.luxon.com/dashboard"),
  warning: (ctx) => `Send exactly ${ctx.amount} ${ctx.currency} in a single payment.`,
  rules: (ctx) => [
    exactly(ctx),
    { kind: "do", text: "Double-check the recipient before you confirm." },
    NO_CRYPTO_NOTE,
  ],
};

const mercadopago: BuyPlatform = {
  id: "mercadopago",
  name: "Mercado Pago",
  color: "#00B1EA",
  currencies: ["ARS"],
  minFiat: "1",
  maxUsdc: null,
  payeeLabel: "CVU",
  verifyMethods: [single("default", "Mercado Pago", "transfer_mercadopago", "mercadopago")],
  methodChoice: "none",
  includeMetadataIndex: false,
  usesMemo: false,
  amountLocale: "es-AR",
  live: false,
  formatPayee: (h) => h.trim(),
  sendLinks: () => webOnly("https://www.mercadopago.com.ar/money-out/transfer/"),
  warning: () => "Pay on the Mercado Pago website only. Do not use the mobile app.",
  rules: (ctx) => [
    { kind: "do", text: "Pay on the Mercado Pago website." },
    { kind: "do", text: "Check the CVU matches exactly." },
    exactly(ctx),
    { kind: "dont", text: "Don't use the mobile app for this payment." },
  ],
};

const monobank: BuyPlatform = {
  id: "monobank",
  name: "Monobank Business",
  color: "#111111",
  currencies: ["UAH"],
  minFiat: "0.01",
  maxUsdc: null,
  payeeLabel: "IBAN",
  verifyMethods: [single("default", "Monobank", "transfer_monobank", "monobank")],
  methodChoice: "none",
  includeMetadataIndex: false,
  usesMemo: false,
  amountLocale: "uk-UA",
  minExtensionVersion: "0.7.2",
  live: false,
  formatPayee: (h) => h.trim(),
  sendLinks: () => webOnly("https://web.monobank.ua/"),
  warning: () => "Verifying needs a Monobank business account with web access.",
  rules: (ctx) => [
    { kind: "do", text: `Send exactly ${ctx.amount} UAH in one bank transfer from your Monobank business account.` },
    { kind: "do", text: "Copy the IBAN exactly." },
    { kind: "do", text: "Wait for the transfer to be approved, then verify." },
    { kind: "dont", text: "Don't pay from a personal account or to a card number." },
  ],
};

const xmoney: BuyPlatform = {
  id: "xmoney",
  name: "X Money",
  color: "#000000",
  currencies: ["USD"],
  minFiat: "0.01",
  maxUsdc: null,
  payeeLabel: "X username",
  verifyMethods: [single("default", "X Money", "transfer_xmoney", "xmoney")],
  methodChoice: "none",
  includeMetadataIndex: false,
  usesMemo: false,
  minExtensionVersion: "0.7.1",
  beta: true,
  live: false,
  formatPayee: (h) => withPrefix(h, "@"),
  sendLinks: (ctx) =>
    webOnly(`https://x.com/i/money/pay/${encodeURIComponent(stripPrefix(ctx.payee, "@"))}`, true),
  warning: (ctx) => `Send exactly ${ctx.amount} ${ctx.currency} in a single payment.`,
  rules: (ctx) => [
    exactly(ctx),
    { kind: "do", text: "Double-check the username before you confirm." },
    { kind: "dont", text: "Don't pay someone who hasn't set up X Money. The payment stays pending." },
  ],
};

/** Curator's maker metadata.alipayPid when it is the 16-digit Alipay PID payment links need, else null. */
export function alipayPid(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  return recipientIdFor("alipay", (metadata as { alipayPid?: unknown }).alipayPid);
}

/** `value` when it is a valid payment-link account id for the platform (Alipay: 16 digits), else null. */
export function recipientIdFor(id: BuyPlatformId, value: unknown): string | null {
  if (id !== "alipay") return null;
  return typeof value === "string" && /^\d{16}$/.test(value) ? value : null;
}

/**
 * Platforms whose payment link needs the seller's account id from Curator's
 * maker metadata before an order may be signalled (Peer core
 * getPaymentLinkRecipientId): without it the buyer has no way to pay.
 */
export function needsRecipientId(id: BuyPlatformId): boolean {
  return id === "alipay";
}

/** Peer core alipay.ts getAlipaySendLink: Alipay's transfer-to-account deep link. */
export function alipayPayLink(pid: string, amount: string): string {
  const params = new URLSearchParams({ appId: "20000116", actionType: "toAccount", userId: pid });
  if (amount) params.set("amount", amount);
  return `alipays://platformapi/startapp?${params.toString()}`;
}

/** Peer core upi.ts normalizeUpiVpa: Curator stores UPI IDs trimmed and lowercased. */
export function normalizeUpiVpa(value: string): string {
  return value.trim().toLowerCase();
}

/** Peer core upi.ts getUpiPaymentLink: a standard UPI intent with the exact INR amount. */
export function upiPayLink(vpa: string, amount: string): string {
  const params = new URLSearchParams({ pa: normalizeUpiVpa(vpa), cu: "INR" });
  if (amount.trim()) params.set("am", amount.trim());
  return `upi://pay?${params.toString()}`;
}

const alipay: BuyPlatform = {
  id: "alipay",
  name: "Alipay",
  color: "#1677FF",
  currencies: ["CNY"],
  minFiat: "0.1",
  maxUsdc: null,
  payeeLabel: "Alipay account",
  verifyMethods: [single("default", "Alipay", "transfer_alipay", "alipay")],
  methodChoice: "none",
  // Peer sets no buyerTeeParams for Alipay: the attestation locates the payment from its params alone.
  includeMetadataIndex: false,
  usesMemo: false,
  payOnWeb: false,
  amountLocale: "zh-CN",
  minExtensionVersion: "0.6.7",
  beta: true,
  buyNotice:
    "Alipay is new on Peer. Pay by scanning the seller's QR code with the Alipay app, then verify in the Peer extension on a computer signed in to alipay.com with the same account.",
  live: false,
  formatPayee: (h) => h.trim(),
  sendLinks: (ctx) => {
    if (!ctx.recipientId || !/^\d{16}$/.test(ctx.recipientId)) return noLinks();
    // The link takes a plain decimal: drop zh-CN grouping ("1,234.50" -> "1234.50").
    const link = alipayPayLink(ctx.recipientId, ctx.amount.replace(/,/g, ""));
    return { deepLink: link, webLink: null, qrValue: link };
  },
  // Peer's Alipay capture reads one payment (verifyConfig.numPaymentsFetched: 1).
  warning: () => "The extension reads only your latest Alipay payment, so verify before you pay anyone else.",
  rules: (ctx) => [
    { kind: "do", text: "Scan the QR code with the Alipay app." },
    { kind: "do", text: "Send the exact amount to the Alipay recipient shown." },
    { kind: "do", text: `Make sure the "Your Send" amount is at least ${ctx.amount} ${ctx.currency}.` },
  ],
};

const UPI_NOTICE =
  "Pay with standard UPI in the Amazon Pay app, not UPI Lite and not a merchant payment. To verify, sign in on a computer to the same amazon.in account you paid from.";

const upi: BuyPlatform = {
  id: "upi",
  name: "UPI",
  color: "#6B4EFF",
  currencies: ["INR"],
  minFiat: "1",
  maxUsdc: null,
  payeeLabel: "UPI ID",
  verifyMethods: [single("amazonpay", "Amazon Pay", "transfer_upi_amazonpay", "upi")],
  methodChoice: "none",
  includeMetadataIndex: false,
  usesMemo: false,
  payOnWeb: false,
  minExtensionVersion: "0.6.8",
  beta: true,
  buyNotice: UPI_NOTICE,
  live: false,
  formatPayee: (h) => normalizeUpiVpa(h),
  sendLinks: (ctx) => {
    const link = upiPayLink(ctx.payee, ctx.amount);
    return { deepLink: link, webLink: null, qrValue: link };
  },
  warning: () => "Use standard UPI in the Amazon Pay app, not UPI Lite or a merchant payment.",
  rules: (ctx) => [
    { kind: "do", text: "Pay with standard UPI through Amazon Pay to the seller's UPI ID." },
    { kind: "do", text: `Send exactly ${ctx.amount} INR in a single payment.` },
    { kind: "do", text: "Verify by signing in to the same amazon.in account you used to pay." },
    { kind: "dont", text: "Don't use UPI Lite or pay a merchant." },
    { kind: "dont", text: "Don't send another payment while verification is pending." },
  ],
};

function isSignalable(id: BuyPlatformId): boolean {
  try {
    resolvePaymentMethodHashFromCatalog(id, getPaymentMethodsCatalog(CHAIN_ID, "production"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Buyer TEE verifiers Peer's attestation service serves, as
 * `actionPlatform/actionType` (GET https://attestation-service.zkp2p.xyz/buyer/supported,
 * 2026-10-11). A platform the SDK can signal but this service cannot verify
 * (Mercado Pago: its buyer flow was removed from the attestation service)
 * would take the buyer's fiat and then fail every fulfil with a 400, so it is
 * never live.
 */
export const BUYER_TEE_VERIFIERS: ReadonlySet<string> = new Set([
  "venmo/transfer_venmo",
  "cashapp/transfer_cashapp",
  "revolut/transfer_revolut",
  "wise/transfer_wise",
  "zelle/transfer_zelle_chase",
  "zelle/transfer_zelle_bofa",
  "zelle/transfer_zelle_citi",
  "zelle/transfer_zelle_capitalone",
  "paypal/transfer_paypal",
  "paypal/transfer_business_paypal",
  "monzo/transfer_monzo",
  "chime/transfer_chime",
  "monobank/transfer_monobank",
  "xmoney/transfer_xmoney",
  "alipay/transfer_alipay",
  "upi/transfer_upi_amazonpay",
]);

function isVerifiable(platform: BuyPlatform): boolean {
  return platform.verifyMethods.every((m) => BUYER_TEE_VERIFIERS.has(`${m.actionPlatform}/${m.actionType}`));
}

/**
 * The catalog as offered: each platform keeps only the major currencies
 * (shared/currencies.ts), and a platform left with none (Monobank's UAH,
 * Mercado Pago's ARS) is never live. Every other Peer currency is left out on
 * purpose, however the platform lists it.
 */
export const BUY_PLATFORMS: Readonly<Record<BuyPlatformId, BuyPlatform>> = Object.fromEntries(
  [venmo, cashapp, revolut, wise, zelle, paypal, monzo, chime, n26, luxon, mercadopago, monobank, xmoney, alipay, upi].map(
    (platform): [BuyPlatformId, BuyPlatform] => {
      const currencies = platform.currencies.filter(isMajorCurrency);
      const live = currencies.length > 0 && isSignalable(platform.id) && isVerifiable(platform);
      return [platform.id, { ...platform, currencies, live }];
    },
  ),
) as Record<BuyPlatformId, BuyPlatform>;

export function getBuyPlatform(id: BuyPlatformId): BuyPlatform {
  return BUY_PLATFORMS[id];
}

export function isPlatformLive(id: BuyPlatformId): boolean {
  return BUY_PLATFORMS[id].live;
}

/** The verify method by id, or the default one (null when the platform needs an explicit choice). */
export function resolveVerifyMethod(id: BuyPlatformId, methodId?: string | null): VerifyMethod | null {
  const platform = BUY_PLATFORMS[id];
  if (methodId) return platform.verifyMethods.find((m) => m.id === methodId) ?? null;
  if (platform.methodChoice === "beforePayment") return null;
  return platform.verifyMethods[0] ?? null;
}

/** Oldest Peer extension that can capture `id` (Peer's per-method minExtensionVersion; 0.6.3 floor). */
export function minExtensionVersion(id: BuyPlatformId): string {
  return BUY_PLATFORMS[id].minExtensionVersion ?? "0.6.3";
}

/** Live platforms (in catalog order) that accept the currency. */
export function platformsForCurrency(
  currency: FiatCode,
  opts: { includeUnavailable?: boolean } = {},
): BuyPlatform[] {
  return BUY_PLATFORM_IDS.map((id) => BUY_PLATFORMS[id]).filter(
    (p) => (opts.includeUnavailable || p.live) && p.currencies.includes(currency),
  );
}

export function currenciesForPlatform(id: BuyPlatformId): readonly FiatCode[] {
  return BUY_PLATFORMS[id].currencies;
}

/** Every currency at least one live platform accepts, in FIAT_CURRENCIES order. */
export function buyableCurrencies(): FiatCode[] {
  return FIAT_CODES.filter((code) => platformsForCurrency(code).length > 0);
}

const EURO_REGIONS = new Set([
  "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV",
  "MT", "NL", "PT", "SI", "SK",
]);

const REGION_CURRENCY: Record<string, FiatCode> = {
  US: "USD", GB: "GBP", CA: "CAD", AU: "AUD", NZ: "NZD", SG: "SGD", HK: "HKD", CH: "CHF",
  JP: "JPY", CN: "CNY", MX: "MXN", AR: "ARS", AE: "AED", SA: "SAR", IL: "ILS", TR: "TRY",
  ZA: "ZAR", KE: "KES", UG: "UGX", IN: "INR", ID: "IDR", MY: "MYR", PH: "PHP", TH: "THB",
  VN: "VND", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", DK: "DKK", NO: "NOK", SE: "SEK",
  UA: "UAH",
};

function localeRegion(locale: string): string | null {
  try {
    const parsed = new Intl.Locale(locale);
    return (parsed.region ?? parsed.maximize().region ?? null)?.toUpperCase() ?? null;
  } catch {
    const match = /[-_]([A-Za-z]{2})\b/.exec(locale);
    return match?.[1]?.toUpperCase() ?? null;
  }
}

/**
 * Best currency guess for a locale (defaults to the browser's), falling back
 * to USD when the region's currency has no live platform.
 */
export function defaultCurrencyForLocale(locale?: string): FiatCode {
  const resolved =
    locale ?? (typeof navigator !== "undefined" ? navigator.languages?.[0] ?? navigator.language : undefined);
  if (!resolved) return "USD";
  const region = localeRegion(resolved);
  if (!region) return "USD";
  const code = EURO_REGIONS.has(region) ? "EUR" : REGION_CURRENCY[region];
  if (!code) return "USD";
  return platformsForCurrency(code).length > 0 ? code : "USD";
}
