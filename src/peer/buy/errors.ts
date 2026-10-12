/**
 * Maps SDK, Curator, attestation, wallet and contract failures to short
 * plain-English messages a player can act on. Contract reverts are decoded
 * against the real OrchestratorV3 and EscrowV2 ABIs, not string-matched,
 * whenever revert data is present.
 */

import { APIError, NetworkError, ValidationError } from "@zkp2p/sdk";
import { decodeErrorResult, type Hex } from "viem";
import { PEER_ABIS } from "../client";
import { MarketError } from "../market";
import { ProofError } from "../extension";
import { BUY_PLATFORMS, type BuyPlatformId } from "../platforms";
import type { BuyError, BuyErrorCode } from "./types";

export { technicalDetail } from "../errorDetail";

/** An error raised by the buy flow itself with a known code. */
export class BuyFlowError extends Error {
  readonly code: BuyErrorCode;
  readonly recoverable: boolean;
  constructor(code: BuyErrorCode, message: string, recoverable = true, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BuyFlowError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export type ErrorStage = "quote" | "signal" | "verify" | "fulfill" | "cancel" | "recover";

export interface ErrorContext {
  stage: ErrorStage;
  platform?: BuyPlatformId;
  /** Payee handle as displayed, for payee-mismatch guidance. */
  payee?: string | null;
}

function make(code: BuyErrorCode, message: string, recoverable: boolean, detail?: string): BuyError {
  return detail ? { code, message, recoverable, detail } : { code, message, recoverable };
}

/** Walks an error and its causes, collecting text and hex revert payloads. */
function collect(error: unknown): { texts: string[]; hexes: Hex[]; statuses: number[]; names: string[] } {
  const texts: string[] = [];
  const hexes: Hex[] = [];
  const statuses: number[] = [];
  const names: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < 64) {
    const value = queue.shift();
    if (value === null || value === undefined || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === "string") {
      texts.push(value);
      for (const match of value.matchAll(/0x[0-9a-fA-F]{8,}/g)) hexes.push(match[0] as Hex);
      continue;
    }
    if (typeof value !== "object") continue;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.status === "number") statuses.push(record.status);
    if (typeof record.errorName === "string") names.push(record.errorName);
    if (typeof record.name === "string") names.push(record.name);
    if (typeof record.code === "number" && record.code === 4001) names.push("UserRejectedRequestError");
    const data = record.data;
    if (data && typeof data === "object" && typeof (data as Record<string, unknown>).errorName === "string") {
      names.push((data as Record<string, string>).errorName as string);
    }
    queue.push(
      record.shortMessage,
      record.message,
      record.details,
      record.reason,
      record.data,
      record.errorData,
      record.revertData,
      record.metaMessages,
      record.error,
      record.cause,
      record.responseBody,
    );
  }
  return { texts, hexes, statuses, names };
}

const ABIS = [PEER_ABIS.orchestrator, PEER_ABIS.escrow];

/**
 * The require() reasons (Solidity `Error(string)`) in an error's revert data.
 * Bundlers and some RPCs only return the reason hex-encoded, never as text.
 */
function revertReasons(hexes: readonly Hex[]): string[] {
  const reasons: string[] = [];
  for (const data of hexes) {
    try {
      // viem decodes Error(string) whatever ABI it is given.
      const decoded = decodeErrorResult({ abi: PEER_ABIS.orchestrator, data });
      const reason = decoded.errorName === "Error" ? decoded.args?.[0] : undefined;
      if (typeof reason === "string") reasons.push(reason);
    } catch {
      // Not revert data.
    }
  }
  return reasons;
}

/**
 * The payment verifier refused the proof: one of UnifiedPaymentVerifier's
 * checks ("UPV: Invalid payment amount", "UPV: Snapshot payee mismatch") or the
 * attestation's witness signatures ("ThresholdSigVerifierUtils: Not enough
 * valid witness signatures"). Seen at the fulfil preflight, so nothing is sent.
 */
const PROOF_REJECTED_TEXT = /\bupv:|witness signature/i;

const PROOF_REJECTED: Mapped = [
  "proof_rejected",
  "Peer couldn't verify this payment on-chain, so no USDC was released. Check you picked the matching payment, then try again.",
  true,
];

/** The contract error name in a revert, decoded with the protocol ABIs. */
export function decodeRevertName(error: unknown): string | null {
  const { hexes, names } = collect(error);
  for (const data of hexes) {
    for (const abi of ABIS) {
      try {
        return decodeErrorResult({ abi, data }).errorName;
      } catch {
        // Not this ABI's error or not revert data at all.
      }
    }
  }
  return names.find((n) => CONTRACT_ERRORS[n] !== undefined) ?? null;
}

/**
 * The intent an AccountHasActiveIntent revert names as the blocker, so the
 * player can be offered a cancel for exactly that intent.
 */
export function blockingIntentFromError(error: unknown): Hex | null {
  const { hexes } = collect(error);
  for (const data of hexes) {
    try {
      const decoded = decodeErrorResult({ abi: PEER_ABIS.orchestrator, data });
      if (decoded.errorName !== "AccountHasActiveIntent") continue;
      const existing = decoded.args?.[1];
      if (typeof existing === "string" && existing.startsWith("0x")) return existing as Hex;
    } catch {
      // Not orchestrator revert data.
    }
  }
  return null;
}

type Mapped = [BuyErrorCode, string, boolean];

const CONTRACT_ERRORS: Record<string, Mapped> = {
  AccountHasActiveIntent: ["active_intent", "You already have an open order. Finish or cancel it first.", true],
  AmountBelowMin: ["amount_too_low", "That amount is below this seller's minimum. Try a bigger amount.", true],
  AmountAboveMax: ["amount_too_high", "That amount is above this seller's maximum. Try a smaller amount.", true],
  AmountExceedsLimit: ["amount_too_high", "That amount is over the limit for one order. Try a smaller amount.", true],
  AmountExceedsAvailable: ["liquidity", "This seller doesn't have that much USDC left. Pick another offer.", true],
  InsufficientDepositLiquidity: ["liquidity", "This seller doesn't have that much USDC left. Pick another offer.", true],
  DepositNotAcceptingIntents: ["liquidity", "This seller has paused their offer. Pick another one.", true],
  DepositNotFound: ["liquidity", "This offer is gone. Get a fresh quote.", true],
  MaxIntentsExceeded: ["liquidity", "This seller is busy with other orders. Pick another offer.", true],
  RateBelowMinimum: ["rate_changed", "The seller changed their price. Get a fresh quote.", true],
  // Fee legs Peer signed that the orchestrator will not take (e.g. one wallet paid twice): this offer cannot be filled.
  DuplicateReferralFeeRecipient: ["liquidity", "Peer can't fill this offer right now. Pick another offer.", true],
  InvalidReferralFeeConfiguration: ["liquidity", "Peer can't fill this offer right now. Pick another offer.", true],
  ReferralFeeCountExceedsMaximum: ["liquidity", "Peer can't fill this offer right now. Pick another offer.", true],
  ReferralFeeExceedsMaximum: ["liquidity", "Peer can't fill this offer right now. Pick another offer.", true],
  SignatureExpired: ["signature_expired", "The offer timed out. Get a fresh quote.", true],
  InvalidSignature: ["signature_expired", "The offer approval didn't match. Get a fresh quote.", true],
  CurrencyNotSupported: ["payment_method_unavailable", "This seller no longer takes that currency. Pick another offer.", true],
  CurrencyNotFound: ["payment_method_unavailable", "This seller no longer takes that currency. Pick another offer.", true],
  PaymentMethodNotSupported: ["payment_method_unavailable", "That payment method isn't available on this offer.", true],
  PaymentMethodDoesNotExist: ["payment_method_unavailable", "That payment method isn't available on this offer.", true],
  PaymentMethodNotWhitelisted: ["payment_method_unavailable", "That payment method isn't available right now.", true],
  PaymentMethodNotActive: ["payment_method_unavailable", "This seller turned that payment method off. Pick another offer.", true],
  PaymentMethodNotListed: ["payment_method_unavailable", "That payment method isn't on this offer.", true],
  EscrowNotWhitelisted: ["liquidity", "This offer is no longer available. Get a fresh quote.", true],
  EscrowLockFailed: ["liquidity", "Couldn't reserve the seller's USDC. Try again.", true],
  IntentAlreadyExists: ["active_intent", "That order already exists. Reload to see it.", true],
  IntentNotFound: ["intent_closed", "This order is no longer open on-chain.", false],
  PaymentVerificationFailed: [
    "payment_verification_failed",
    "Peer couldn't verify that payment. Check the amount and recipient, then pick the right one.",
    true,
  ],
  HashMismatch: ["payment_verification_failed", "That proof doesn't match this order. Verify again.", true],
  UnauthorizedCaller: ["tx_failed", "This wallet can't do that for this order. Use the wallet that placed it.", false],
  UnauthorizedCallerOrDelegate: ["tx_failed", "This wallet can't do that for this order. Use the wallet that placed it.", false],
  TransferFailed: ["tx_failed", "The USDC transfer failed. Try again.", true],
  ZeroValue: ["invalid_amount", "The amount must be above zero.", true],
};

function lower(texts: string[]): string {
  return texts.join(" \n ").toLowerCase();
}

function platformName(platform?: BuyPlatformId): string {
  return platform ? BUY_PLATFORMS[platform].name : "The platform";
}

/**
 * The platform refused the captured login when the attestation service
 * replayed it (connector 401, "<Platform> session is unauthorized"). The same
 * capture fails the same way: the player logs out and back in so the
 * extension captures a fresh session (Peer's web app says the same).
 */
function sessionRefused(name: string): Mapped {
  return [
    "payment_session_expired",
    `${name} ended your session before Peer could check the payment. Press Check again, log out of ${name} in the tab that opens, then log back in.`,
    true,
  ];
}

/** Attestation-service rejections seen when proving a buyer payment. */
function mapAttestation(all: string, ctx: ErrorContext): Mapped | null {
  const name = platformName(ctx.platform);
  if (all.includes("payee mismatch") || all.includes("recipient mismatch")) {
    const to = ctx.payee ? ` to ${ctx.payee}` : "";
    return ["payee_mismatch", `That payment went to someone else. Pick the payment you sent${to}.`, true];
  }
  if (all.includes("nullifier has already been used") || all.includes("nullifier already used")) {
    return ["nullifier_used", "That payment was already used for another order. Pick a different one.", true];
  }
  // The capture was sealed to an attestation-enclave key a Peer deploy has since replaced: only a
  // fresh capture can be proven (Peer's web app recaptures on exactly this message).
  if (all.includes("session material failed authentication") || all.includes("session material is bound to a different public key")) {
    return ["payment_session_expired", "Peer's payment checker was updated while you were verifying. Check again, then pick the same payment.", true];
  }
  if (all.includes("session is unauthorized") || all.includes("session is invalid or expired")) return sessionRefused(name);
  // UnifiedPaymentVerifier checks: the picked payment is the wrong one, so picking again is the fix.
  if (all.includes("payment timestamp before intent window")) {
    return ["payment_verification_failed", "That payment was sent before this order was placed. Pick the payment you sent for this order.", true];
  }
  // Wise accepts a converted payment when either side is the order's currency; this one had neither.
  if (all.includes("neither source nor target currency matches intent currency")) {
    return [
      "payment_verification_failed",
      `That ${name} payment was in another currency on both sides, so it can't be matched to this order. Pay the exact amount again so the seller receives this order's currency, then pick that payment. Get help to recover the first payment.`,
      true,
    ];
  }
  if (all.includes("currency mismatch") || all.includes("currency matches intent currency")) {
    return ["payment_verification_failed", "That payment was in a different currency from this order. Pick the payment you sent for this order.", true];
  }
  if (all.includes("payment method mismatch")) {
    return ["payment_verification_failed", `That payment wasn't made on ${name}. Pick the ${name} payment you sent for this order.`, true];
  }
  // "No matching Revolut buyer payment found for index: selected transaction is missing recipient username".
  if (all.includes("missing recipient")) {
    return ["payment_verification_failed", `${name} didn't show who that payment went to. Press Check again and log in to ${name} again.`, true];
  }
  // A pending X Money payment usually means the seller can't receive X Money, so it won't settle on its own.
  if (all.includes("x money transaction status is not settled")) {
    return [
      "payment_not_settled",
      "X Money still shows that payment as pending. If it doesn't settle, cancel it on X, then cancel this offer. Don't pay again.",
      true,
    ];
  }
  if (
    all.includes("status is not complete") ||
    all.includes("status is not succeeded") ||
    all.includes("not completed or delivered") ||
    all.includes("is not outgoing_payment_sent") ||
    all.includes("status is not settled") ||
    all.includes("has not marked")
  ) {
    return ["payment_not_settled", `${name} hasn't finished that payment yet. Wait a minute, then verify again.`, true];
  }
  if (/returned status (?:400|429)\b/.test(all) || all.includes("session expired") || all.includes("session is no longer valid")) {
    return ["payment_session_expired", `${name} rejected the saved session. Verify again and log in to ${name}.`, true];
  }
  if (all.includes("no matching") || all.includes("does not match") || /invalid [^\n]* at index \d+/.test(all)) {
    return ["payment_verification_failed", `${name} couldn't match that payment. Pick a different one or verify again.`, true];
  }
  return null;
}

function mapApi(error: APIError, all: string, ctx: ErrorContext): Mapped | null {
  const status = error.status;
  if (
    all.includes("wallet is blocked") ||
    all.includes("sanction") ||
    (status === 403 && ctx.stage === "signal")
  ) {
    return ["wallet_blocked", "This wallet can't trade on Peer.", false];
  }
  if (status === 503 && (all.includes("screening") || ctx.stage === "signal")) {
    return ["screening_unavailable", "Wallet checks are down for a moment. Try again in a minute.", true];
  }
  if (status === 429) return ["rate_limited", "Too many requests. Wait a few seconds and try again.", true];
  if (ctx.stage === "fulfill" || ctx.stage === "verify") {
    // /buyer/verify answers 401 only for a connector "unauthorized", whatever the platform's wording.
    if (status === 401) return sessionRefused(platformName(ctx.platform));
    const attestation = mapAttestation(all, ctx);
    if (attestation) return attestation;
    // Any other 4xx is the attestation service refusing this exact proof: resubmitting it cannot pass.
    // Its rate limits are 400s too, but those clear by themselves.
    if (status !== undefined && status >= 400 && status < 500 && !/limit reached|budget exhausted|capacity is exhausted/.test(all)) {
      return ["payment_verification_failed", "Peer couldn't verify that payment. Pick another payment, or check your payments again.", true];
    }
  }
  if (ctx.stage === "signal") {
    if (all.includes("payee") || all.includes("payment method") || all.includes("inactive")) {
      return ["payment_method_unavailable", "This seller's payment details changed. Get a fresh quote.", true];
    }
    if (status === 409 || status === 400 || status === 404) {
      return ["liquidity", "Peer turned down this offer. Get a fresh quote and try another.", true];
    }
  }
  if (status !== undefined && status >= 500) {
    return ["network", "Peer's servers are having trouble. Try again in a minute.", true];
  }
  return null;
}

/**
 * TxSender failures (src/wallet WalletError) carry a string `code` and a
 * player-ready message. Matched structurally so this module does not depend
 * on the wallet implementation.
 */
const WALLET_CODES = new Set([
  "user_rejected",
  "insufficient_gas",
  "sponsorship_failed",
  "chain_switch_failed",
  "wallet_not_ready",
  "busy",
  "popup_blocked",
  "call_reverted",
  "reverted",
  "receipt_timeout",
  "request_timeout",
  "invalid_request",
  "unknown",
]);

function walletError(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof Error)) return null;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== "string" || !WALLET_CODES.has(code)) return null;
  if (!error.name.endsWith("Error") || error.name === "Error") return null;
  return { code, message: error.message };
}

/** Converts anything thrown in the buy flow into a BuyError. */
export function toBuyError(error: unknown, ctx: ErrorContext): BuyError {
  if (error instanceof BuyFlowError) return make(error.code, error.message, error.recoverable);
  if (error instanceof MarketError) return make(error.code, error.message, true);
  if (error instanceof ProofError) return make("capture_failed", error.message, true);

  const wallet = walletError(error);
  if (wallet) {
    switch (wallet.code) {
      case "user_rejected":
        return make("user_rejected", "You cancelled in your wallet.", true);
      case "insufficient_gas":
        return make("insufficient_gas", "Your wallet needs a little ETH on Base to pay gas.", true);
      case "receipt_timeout":
        return make("tx_pending", "Your transaction is still confirming. Check back in a minute.", true);
      case "call_reverted":
      case "reverted": {
        const name = decodeRevertName(error);
        const mapped = name ? CONTRACT_ERRORS[name] : undefined;
        if (mapped) return make(mapped[0], mapped[1], mapped[2], error instanceof Error ? error.message : undefined);
        break;
      }
      case "unknown":
        break;
      default:
        return make("wallet", wallet.message, true);
    }
  }

  const { texts, hexes, names } = collect(error);
  const all = lower(texts);
  const detail = texts[0]?.slice(0, 500);

  if (
    names.includes("UserRejectedRequestError") ||
    all.includes("user rejected") ||
    all.includes("user denied") ||
    all.includes("rejected the request") ||
    all.includes("user cancelled") ||
    all.includes("user canceled")
  ) {
    return make("user_rejected", "You cancelled in your wallet.", true);
  }

  const revert = decodeRevertName(error);
  const mappedRevert = revert ? CONTRACT_ERRORS[revert] : undefined;
  if (mappedRevert) return make(mappedRevert[0], mappedRevert[1], mappedRevert[2], detail);

  // Before the attestation wording below: "UPV: Snapshot payee mismatch" is a stale proof, not a payment to someone else.
  if (
    (ctx.stage === "fulfill" || ctx.stage === "verify") &&
    (PROOF_REJECTED_TEXT.test(all) || revertReasons(hexes).some((reason) => PROOF_REJECTED_TEXT.test(reason)))
  ) {
    return make(PROOF_REJECTED[0], PROOF_REJECTED[1], PROOF_REJECTED[2], detail);
  }

  if (
    names.includes("InsufficientFundsError") ||
    all.includes("insufficient funds") ||
    all.includes("exceeds the balance of the account")
  ) {
    return make("insufficient_gas", "Your wallet needs a little ETH on Base to pay gas.", true, detail);
  }

  if (error instanceof ValidationError || names.includes("ValidationError")) {
    if (all.includes("expired")) {
      // The SDK says this only from its indexer fallback after a failed ProtocolViewer read.
      // OrchestratorV3.fulfillIntent has no expiry check, so an expired intent still locked in
      // escrow can be released and a retry re-reads it from the chain. A pruned intent comes
      // back as "no longer fulfillable" (intent_closed) instead.
      if (ctx.stage === "fulfill") {
        return make("network", "Peer couldn't read your order just now. Try again in a moment.", true, detail);
      }
      return make("intent_expired", "This order has expired and can't be completed.", false, detail);
    }
    if (all.includes("no longer fulfillable") || all.includes("not found")) {
      return make("intent_closed", "This order is no longer open.", false, detail);
    }
  }

  if (error instanceof APIError) {
    const mapped = mapApi(error, all, ctx);
    if (mapped) return make(mapped[0], mapped[1], mapped[2], detail);
  }

  if (ctx.stage === "fulfill" || ctx.stage === "verify") {
    const mapped = mapAttestation(all, ctx);
    if (mapped) return make(mapped[0], mapped[1], mapped[2], detail);
  }

  for (const [name, mapped] of Object.entries(CONTRACT_ERRORS)) {
    if (all.includes(name.toLowerCase())) return make(mapped[0], mapped[1], mapped[2], detail);
  }

  if (all.includes("not found on indexer")) {
    return make("network", "Peer can't see your order yet. Try again in a moment.", true, detail);
  }

  if (all.includes("intent expired") || all.includes("has expired")) {
    return make("intent_expired", "This order has expired and can't be completed.", false, detail);
  }

  if (
    error instanceof NetworkError ||
    names.includes("NetworkError") ||
    names.includes("HttpRequestError") ||
    names.includes("TimeoutError") ||
    all.includes("failed to fetch") ||
    all.includes("network") ||
    all.includes("timed out") ||
    all.includes("timeout")
  ) {
    return make("network", "Connection problem. Check your internet and try again.", true, detail);
  }

  if (all.includes("reverted")) {
    if (ctx.stage === "signal" && wallet?.code !== "reverted") {
      // A signal failure that reaches here sent nothing (the preflight or the wallet's own
      // simulation refused it), and the same offer would be refused again.
      return make("liquidity", "Peer refused this offer before anything was sent. Get fresh prices and pick another.", true, detail);
    }
    return make("tx_failed", "The transaction failed on-chain. Try again.", true, detail);
  }

  return make("unknown", "Something went wrong. Try again.", true, detail);
}
