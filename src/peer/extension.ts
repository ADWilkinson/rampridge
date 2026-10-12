/**
 * Bridge to the Peer browser extension for buyer payment proofs.
 *
 * The extension opens the payment platform in a tab, captures the buyer's
 * recent payments inside its TEE session and posts back a metadata message:
 * display rows plus encrypted session material. The buyer then picks the row
 * that matches this order (never auto-picked: the wrong row proves the wrong
 * payment) and `buildBuyerTeeProof` turns it into the SDK's fulfil proof.
 */

import {
  createPeerExtensionSdk,
  type BuyerTeePaymentProofInput,
  type PeerAuthenticateParams,
  type PeerExtensionSdk,
  type PeerMetadataMessage,
  type PeerMetadataRow,
} from "@zkp2p/sdk";
import { formatUnits } from "viem";
import { PEER_ATTESTATION_URL, PEER_EXTENSION_INSTALL_URL } from "@/config";
import { BUY_PLATFORMS, minExtensionVersion, resolveVerifyMethod, type BuyPlatformId, type VerifyMethod } from "./platforms";

export type ExtensionStatus = "needs_install" | "needs_connection" | "needs_update" | "ready" | "unsupported_browser";

const VERSION_TIMEOUT_MS = 3_000;

/**
 * How often to look for the extension after the player opened its store page
 * (Peer web's EXTENSION_VERSION_FETCH_INTERVAL). A fresh install injects
 * itself into every open https tab, so `window.peer` appears without a reload.
 */
export const EXTENSION_POLL_MS = 5_000;

/**
 * Peer web's isVersionBelowMinimum: the first three numeric parts decide. A
 * version that is not numeric ("dev", "unknown") is never treated as older.
 */
export function isExtensionVersionBelow(version: string, minimum: string): boolean {
  const current = version.trim().replace(/^v/, "");
  if (!/^\d+(\.\d+)*$/.test(current)) return false;
  const a = current.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** The installed extension's version, or null when it cannot be read quickly. */
async function extensionVersion(sdk: PeerExtensionSdk): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const version = await Promise.race([
      sdk.getVersion(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), VERSION_TIMEOUT_MS);
      }),
    ]);
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let defaultSdk: PeerExtensionSdk | null = null;

/** The shared extension SDK (resolves `window.peer` on every call). */
export function peerExtension(): PeerExtensionSdk {
  defaultSdk ??= createPeerExtensionSdk();
  return defaultSdk;
}

/**
 * The extension ships on the Chrome Web Store only, which cannot install on
 * phones or non-Chromium browsers. Offering an install link there dead-ends.
 */
export function canInstallPeerExtension(userAgent?: string): boolean {
  const ua = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  if (!ua) return false;
  if (/Firefox|FxiOS/.test(ua)) return false;
  if (/Android|iPhone|iPad|iPod|Mobi/i.test(ua)) return false;
  return /Chrome|Chromium|Edg|OPR|Brave/.test(ua);
}

/**
 * Where the extension stands for this browser. `canInstall` overrides the
 * user-agent check (defaults to `canInstallPeerExtension()`). With `platform`,
 * an extension older than Peer's minimum build for that platform
 * (verifyConfig.minExtensionVersion: 0.6.3, Alipay 0.6.7, UPI 0.6.8, X Money
 * 0.7.1, Monobank 0.7.2) is `needs_update` whether or not it is connected yet,
 * as on Peer's web app (the extension answers its version to any page): an
 * old build captures rows no proof can use, which no retry fixes, so it is
 * updated before it is connected. A version that can't be read is let through.
 */
export async function getExtensionStatus(
  sdk: PeerExtensionSdk = peerExtension(),
  opts: { canInstall?: boolean; platform?: BuyPlatformId } = {},
): Promise<ExtensionStatus> {
  if (!sdk.isAvailable()) {
    return (opts.canInstall ?? canInstallPeerExtension()) ? "needs_install" : "unsupported_browser";
  }
  const state = await sdk.getState();
  if (!opts.platform) return state;
  const version = await extensionVersion(sdk);
  return version !== null && isExtensionVersionBelow(version, minExtensionVersion(opts.platform)) ? "needs_update" : state;
}

/** Opens the extension's approval prompt for this site. Resolves false when declined or unavailable. */
export async function requestExtensionConnection(sdk: PeerExtensionSdk = peerExtension()): Promise<boolean> {
  if (!sdk.isAvailable()) return false;
  try {
    return await sdk.requestConnection();
  } catch {
    return false;
  }
}

/**
 * Opens PeerAuth's Chrome Web Store page (`PEER_EXTENSION_INSTALL_URL`) in a
 * new tab. Chrome and Brave install from it; Edge and Opera can too. The
 * optional SDK argument is accepted for older callers and not needed.
 */
export function openExtensionInstallPage(_sdk?: PeerExtensionSdk): void {
  if (typeof window === "undefined") return;
  window.open(PEER_EXTENSION_INSTALL_URL, "_blank", "noopener,noreferrer");
}

/**
 * The browser the install button names, as Peer web's "Add to Chrome" /
 * "Add to Brave" / "Add to browser". Brave reports a Chrome user agent and is
 * told apart by `navigator.brave`.
 */
export function extensionBrowser(userAgent?: string, isBrave?: boolean): "chrome" | "brave" | "other" {
  const ua = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const brave = isBrave ?? (typeof navigator !== "undefined" && "brave" in navigator);
  if (brave || /Brave/.test(ua)) return "brave";
  if (/Edg\/|OPR\/|Opera/.test(ua)) return "other";
  return /Chrome|Chromium/.test(ua) ? "chrome" : "other";
}

/**
 * `authenticate` params for a buyer capture. Deliberately no
 * `providerConfig`: the extension resolves its provider template from
 * actionType + platform, and a partial providerConfig breaks capture.
 */
export function buyerCaptureParams(method: VerifyMethod): PeerAuthenticateParams {
  return {
    actionType: method.actionType,
    platform: method.actionPlatform,
    attestationActionType: method.actionType,
    attestationPlatform: method.actionPlatform,
    attestationServiceUrl: PEER_ATTESTATION_URL,
    captureMode: "buyerTee",
  };
}

export interface BuyerCaptureOptions {
  method: VerifyMethod;
  /**
   * Called with each metadata message for this method's platform until a
   * capture (encrypted session material) arrives. Error-only messages keep it
   * listening.
   */
  onMessage: (message: PeerMetadataMessage) => void;
  sdk?: PeerExtensionSdk;
}

/**
 * Subscribes for the capture result, then asks the extension to open the
 * platform. Returns an idempotent unsubscribe; call it on unmount, cancel or
 * before starting another capture so a stale listener can never fire.
 */
export function startBuyerCapture({ method, onMessage, sdk = peerExtension() }: BuyerCaptureOptions): () => void {
  let unsubscribe: (() => void) | null = null;
  const stop = () => {
    const fn = unsubscribe;
    unsubscribe = null;
    fn?.();
  };
  unsubscribe = sdk.onMetadataMessage((message) => {
    if (!unsubscribe || message.platform !== method.actionPlatform) return;
    // A seller-credential capture for the same platform (sell side) is not this buyer's payment list
    // (Peer web's useExtensionProxyProofsHydrator ignores it the same way).
    if (message.sarCredentialCapture != null) return;
    // Every authenticate() opens its own provider tab, and closing an abandoned one posts "Provider
    // authentication was cancelled." for the same platform with no correlation id (window.peer drops
    // captureAttemptId). Only a capture ends the subscription, so the live tab's result still lands.
    if (message.buyerTeeCapture?.encryptedSessionMaterial) stop();
    onMessage(message);
  });
  try {
    sdk.authenticate(buyerCaptureParams(method));
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}

const UNAUTHORIZED_CAPTURE_ERRORS = ["expected 200 got 401", "401 unauthorized", "expected status 2xx", "unauthorized"];

/**
 * What to tell the player when the extension's capture reports an error.
 * Mirrors Peer's web app (helpers/extensionErrors.ts and PaymentTable's
 * clock-skew mapping) and otherwise shows the extension's own reason, as
 * Peer does, so the player and support can see it.
 */
export function captureFailureText(errorMessage: string | undefined, name: string): string {
  const raw = (errorMessage ?? "").trim();
  const e = raw.toLowerCase();
  if (/attestation timestamp skew exceeds\s+\d+ms/.test(e)) {
    return "Your computer's clock is out of sync. Turn on automatic date and time in your system settings, then check again.";
  }
  if (e.includes("no transactions could be extracted")) {
    return `The extension found no payments on that ${name} page. Check again, then open your ${name} payment history in the tab it opens.`;
  }
  if (e.includes("authentication was cancelled")) {
    return `The ${name} tab closed before your payments were read. Check again and keep that tab open until your payments show here.`;
  }
  if (e.includes("connection required")) return "Approve RampRidge in the Peer extension, then check again.";
  // An extension update orphans this page's content script: it still reports "connected" but can no
  // longer open tabs. Only a page reload re-attaches it.
  if (e.includes("unable to open provider authentication tab")) {
    return "The Peer extension stopped responding, which happens after it updates. Reload this page (your order is saved), then check again.";
  }
  if (UNAUTHORIZED_CAPTURE_ERRORS.some((p) => e.includes(p))) {
    return `Your ${name} login expired. Log out of ${name}, close its tab, then check again. If that fails, restart your browser.`;
  }
  if (raw) return `The Peer extension couldn't read your ${name} payments: ${raw.slice(0, 200).replace(/[.\s]+$/, "")}. Check again.`;
  return `The extension couldn't read your ${name} payments. Log in to ${name} in the tab it opened, then try again.`;
}

/** One captured payment as the buyer sees it in the select-payment list. */
export interface PaymentRow {
  /** The extension's original row index (also the proof index where needed). */
  index: number;
  /** Amount in major units as a plain decimal ("101.50"), when readable. */
  amount: string | null;
  currency: string | null;
  recipient: string | null;
  /** Date as the platform reported it (raw; the UI formats it, see paymentRowDate). */
  date: string | null;
  /** Passes the platform's "this is a payment you sent" filter. */
  sent: boolean;
  row: PeerMetadataRow;
}

function text(value: unknown): string {
  if (Array.isArray(value)) return text(value[0]);
  return value === undefined || value === null ? "" : String(value);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

function finite(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function twoPlaces(n: number): string {
  return parseFloat(n.toFixed(2)).toString();
}

/**
 * Peer core parseLocalizedAmount: the later of "," and "." is the decimal mark
 * ("1.234,50 €" -> "1234.50", "-$1,234.50" -> "1234.50"); the sign is dropped.
 */
function localizedAmount(raw: string): string | null {
  const s = stripHtml(raw).replace(/[^0-9.,]/g, "");
  if (!/\d/.test(s)) return null;
  return s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
}

function minorToMajor(minor: number, currency: string): string {
  const digits = currency.toUpperCase() === "JPY" ? 0 : 2;
  const major = minor / 10 ** digits;
  return digits === 0 ? Math.round(major).toString() : twoPlaces(major);
}

/** Wise renders amounts like "1 950 EUR" or "54,02 USD". */
function wiseAmount(raw: string): { amount: string; currency: string } {
  const parts = stripHtml(raw).split(" ");
  const currency = parts.length > 1 ? (parts.pop() ?? "") : "";
  let amount = parts.join("").replace(/\s+/g, "");
  if (amount.includes(",") && amount.includes(".")) {
    amount =
      amount.lastIndexOf(",") > amount.lastIndexOf(".")
        ? amount.replace(/\./g, "").replace(",", ".")
        : amount.replace(/,/g, "");
  } else if (amount.includes(",")) {
    amount = amount.replace(",", ".");
  }
  return { amount, currency };
}

/** Peer core alipay.ts decodeUnicodeEscapes: "\\u5f20" (single or double escaped) -> "张". */
export function decodeUnicodeEscapes(value: string): string {
  return value.replace(/\\\\u([0-9a-fA-F]{4})|\\u([0-9a-fA-F]{4})/g, (_, double: string | undefined, single: string | undefined) =>
    String.fromCharCode(parseInt(double ?? single ?? "0", 16)),
  );
}

/** Peer core parseAlipayAmount: only outgoing payments ("- 12.34") have an amount; incoming ones are null. */
function alipayAmount(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("-")) return null;
  return trimmed.replace(/^-\s*/, "") || null;
}

/**
 * Peer core upi.ts amazonPayVerifyConfig.filterMetadata: a successful
 * outgoing person-to-person UPI payment on amazon.in, nothing else.
 */
export function isAmazonPayP2pDebit(row: PeerMetadataRow): boolean {
  if (text(row.status) !== "SUCCESS" || text(row.direction) !== "DEBIT") return false;
  const transactionUrl = (row.params as Record<string, unknown> | undefined)?.TRANSACTION_URL;
  if (typeof transactionUrl !== "string") return false;
  try {
    const url = new URL(transactionUrl, "https://www.amazon.in");
    const useCase = url.searchParams.get("useCase");
    return (
      url.origin === "https://www.amazon.in" &&
      url.pathname === "/pay/transaction-details" &&
      !url.username &&
      !url.password &&
      (useCase === "p2p_outgoing_pay" || useCase === "p2p_outgoing_scan_pay")
    );
  } catch {
    return false;
  }
}

function xMoneyAmount(raw: string): string | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const micros = BigInt(raw.trim());
  if (micros % 10_000n !== 0n) return null;
  return formatUnits(micros, 6);
}

type Described = Omit<PaymentRow, "index" | "row">;

function describe(platform: BuyPlatformId, row: PeerMetadataRow, method: VerifyMethod | null): Described {
  const amountRaw = text(row.amount);
  const currencyRaw = text(row.currency);
  const recipient = stripHtml(text(row.recipient)) || null;
  const date = text(row.date) || null;
  const base = { currency: currencyRaw || null, recipient, date };

  switch (platform) {
    case "venmo": {
      const amount = amountRaw.replace(/[^0-9.]/g, "");
      return { ...base, amount: amount || null, currency: "USD", sent: amountRaw.split(" ")[0] === "-" };
    }
    case "cashapp": {
      const cents = finite(amountRaw);
      return { ...base, amount: cents === null ? null : twoPlaces(cents / 100), currency: currencyRaw || "USD", sent: true };
    }
    case "revolut": {
      const minor = finite(amountRaw);
      return {
        ...base,
        amount: minor === null ? null : minorToMajor(-minor, currencyRaw),
        sent: minor !== null && minor < 0 && text(row.state) === "COMPLETED",
      };
    }
    case "wise": {
      const parsed = wiseAmount(amountRaw);
      return { ...base, amount: parsed.amount || null, currency: parsed.currency || base.currency, sent: true };
    }
    case "zelle": {
      const needsRecipient = method?.id !== "chase";
      return {
        ...base,
        amount: amountRaw || null,
        currency: "USD",
        sent: amountRaw !== "" && (!needsRecipient || recipient !== null),
      };
    }
    case "paypal": {
      const business = method?.id === "business";
      const name = stripHtml(text(row.recipientName)) || null;
      return {
        ...base,
        amount: localizedAmount(amountRaw),
        recipient: business ? (name ?? recipient) : recipient,
        sent: business ? amountRaw !== "" : text(row.type) === "SEND_MONEY_SENT",
      };
    }
    case "monzo": {
      const minor = finite(amountRaw);
      const name = stripHtml(text(row.recipientName)) || null;
      return {
        ...base,
        amount: minor === null ? null : twoPlaces(-minor / 100),
        recipient: name ?? recipient,
        sent: minor !== null && minor < 0 && name !== null,
      };
    }
    case "chime": {
      const n = finite(amountRaw);
      const status = text(row.status);
      const amount = n === null ? null : twoPlaces(n);
      return { ...base, amount, currency: "USD", sent: amount !== null && recipient !== null && (!status || status === "SUCCEEDED") };
    }
    case "luxon": {
      const n = finite(amountRaw.replace(/[^0-9.-]/g, ""));
      const amount = n === null ? null : twoPlaces(Math.abs(n));
      return { ...base, amount, sent: amount !== null && recipient !== null };
    }
    case "mercadopago":
      return { ...base, amount: amountRaw.replace("-", "").trim() || null, currency: "ARS", sent: amountRaw.includes("-") };
    case "monobank": {
      const valid = /^[1-9]\d{0,15}$/.test(amountRaw);
      return { ...base, amount: valid ? formatUnits(BigInt(amountRaw), 2) : null, currency: "UAH", sent: true };
    }
    case "xmoney": {
      const amount = xMoneyAmount(amountRaw);
      const dateOk = /^\d+$/.test(text(row.date).trim());
      return {
        ...base,
        amount,
        currency: currencyRaw ? currencyRaw.toUpperCase() : null,
        date: dateOk ? new Date(Number(text(row.date))).toISOString() : date,
        sent: text(row.direction) === "Debit" && amount !== null && dateOk && currencyRaw !== "",
      };
    }
    case "n26":
      return { ...base, amount: amountRaw || null, sent: true };
    case "alipay": {
      const amount = alipayAmount(amountRaw);
      const name = stripHtml(decodeUnicodeEscapes(text(row.recipient))) || null;
      // An unreadable date (replacement characters) is dropped rather than guessed.
      const dateOk = date !== null && !date.includes("\uFFFD");
      return { ...base, amount, currency: currencyRaw || "CNY", recipient: name, date: dateOk ? date : null, sent: amount !== null };
    }
    case "upi": {
      // Peer shows "₹{amount} · {description}" and only for a plain two-place amount and a description.
      const amount = /^\d+(?:\.\d{1,2})?$/.test(amountRaw) ? amountRaw : null;
      const description = stripHtml(text(row.description)) || null;
      return {
        ...base,
        amount,
        currency: "INR",
        // Amazon Pay describes a sent payment as "Paid to <name>"; the list shows just the name.
        recipient: description?.replace(/^paid to\s+/i, "") || null,
        sent: amount !== null && description !== null && isAmazonPayP2pDebit(row),
      };
    }
  }
}

/**
 * Platforms whose unfiltered history must never be offered: Revolut, and every
 * platform with a verifyConfig.filterMetadata (X Money, UPI), as Peer's web
 * client's PaymentTable does.
 */
const STRICT_FILTER: ReadonlySet<BuyPlatformId> = new Set(["revolut", "xmoney", "upi"]);
/** Platforms whose capture lists payments oldest first; Peer core reverses them (verifyConfig.reverseTransactionHistoryOrder). */
const NEWEST_LAST: ReadonlySet<BuyPlatformId> = new Set(["monzo"]);

export function toPaymentRow(platform: BuyPlatformId, row: PeerMetadataRow, method: VerifyMethod | null): PaymentRow {
  return { index: row.originalIndex, row, ...describe(platform, row, method) };
}

/**
 * Rows the buyer may pick from: every row with proof params (rows are marked
 * `hidden` by the extension as a redaction flag, so `hidden` is ignored),
 * narrowed to sent payments. When nothing passes the sent filter, the full
 * list is offered except on strict platforms, matching Peer's web client.
 */
export function selectableRows(
  message: PeerMetadataMessage,
  platform: BuyPlatformId,
  method: VerifyMethod | null = resolveVerifyMethod(platform),
): PaymentRow[] {
  const withParams = (message.metadata ?? [])
    .filter((row) => Boolean(row.params) && Number.isInteger(row.originalIndex))
    .map((row) => toPaymentRow(platform, row, method));
  const sent = withParams.filter((row) => row.sent);
  const shown = sent.length > 0 || STRICT_FILTER.has(platform) ? sent : withParams;
  return NEWEST_LAST.has(platform) ? [...shown].reverse() : shown;
}

export class ProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofError";
  }
}

/**
 * The fulfil proof for the row the buyer picked. Index-located platforms
 * (Venmo, Cash App, Revolut, Zelle) get `index: originalIndex` appended; the
 * rest identify the payment from the row params alone and must not get an
 * extra key. The verify method's route is always attached; for Zelle it is
 * required (actionPlatform "zelle" plus the bank's transfer_zelle_* type).
 */
export function buildBuyerTeeProof(
  message: PeerMetadataMessage,
  platform: BuyPlatformId,
  row: PeerMetadataRow,
  method: VerifyMethod | null = resolveVerifyMethod(platform),
): BuyerTeePaymentProofInput {
  if (!method) throw new ProofError("Choose your bank before verifying this Zelle payment.");
  if (!BUY_PLATFORMS[platform].verifyMethods.some((m) => m.id === method.id && m.actionType === method.actionType)) {
    throw new ProofError(`${method.label} is not a ${BUY_PLATFORMS[platform].name} verify method.`);
  }
  const encryptedSessionMaterial = message.buyerTeeCapture?.encryptedSessionMaterial;
  if (!encryptedSessionMaterial) throw new ProofError("The extension did not capture your payment session.");
  if (!row.params) throw new ProofError("That payment cannot be verified. Pick another one.");
  const includeIndex = BUY_PLATFORMS[platform].includeMetadataIndex;
  if (includeIndex && !Number.isInteger(row.originalIndex)) {
    throw new ProofError("That payment is missing its position in the list. Refresh and try again.");
  }
  return {
    proofType: "buyerTee",
    encryptedSessionMaterial,
    params: includeIndex ? { ...row.params, index: row.originalIndex } : { ...row.params },
    actionType: method.actionType,
    actionPlatform: method.actionPlatform,
  };
}
