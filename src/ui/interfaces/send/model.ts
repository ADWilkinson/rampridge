import type { Address, Hash } from "viem";
import { formatUsdcInput, parseUsdcAmount } from "@/peer/sell/amount";
import { toWalletError, type WalletError } from "@/wallet/errors";
import { formatEth } from "@/wallet/format";
import { InsufficientUsdcError, SendUnconfirmedError, formatSendAmount, type PendingCheck, type PendingSend } from "@/wallet/send";

/**
 * The Send interface's state and copy, without React: amount entry, the
 * screen machine (form -> review -> sending -> success, or an error, or an
 * unconfirmed send) and how each wallet failure is shown.
 */

export const USDC_UNIT = 1_000_000n;
/** Quick amount buttons beside "All", as the Grand Exchange's +10 / +100. */
export const AMOUNT_STEPS = [10, 100] as const;
/** Confirm stays off this long after the review opens, so a double click on Continue can't pass straight through. */
export const REVIEW_ARM_MS = 1_500;
export const BASESCAN = "https://basescan.org";

export function txUrl(hash: string): string {
  return `${BASESCAN}/tx/${hash}`;
}

/** The wallet's USDC (token) transfers on Basescan: where a player with no wallet app checks a send. */
export function usdcHistoryUrl(address: string): string {
  return `${BASESCAN}/address/${address}#tokentxns`;
}

// ---------------------------------------------------------------------------
// Amount

/**
 * Cleans what the player types into the amount box: digits and one decimal
 * point. A comma is read as the decimal point (keyboards in many countries
 * type one), never as thousands grouping, so "25,50" is 25.50 and a stray
 * "1,250" can only ever come out smaller than meant, and the review shows it.
 */
export function cleanAmountText(text: string): string {
  const unified = text.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const dot = unified.indexOf(".");
  return dot === -1 ? unified : unified.slice(0, dot + 1) + unified.slice(dot + 1).replace(/\./g, "");
}

export type AmountCheck =
  | { status: "empty" }
  | { status: "invalid"; message: string }
  | { status: "ok"; units: bigint };

/** The typed amount in USDC base units, checked against the balance when it is known. */
export function checkAmount(text: string, balance: bigint | null): AmountCheck {
  const parsed = parseUsdcAmount(cleanAmountText(text));
  if (!parsed.ok) {
    if (parsed.reason === "empty") return { status: "empty" };
    if (parsed.reason === "precision") return { status: "invalid", message: "USDC has at most 6 decimal places." };
    return { status: "invalid", message: "Enter an amount like 25 or 25.50." };
  }
  if (parsed.units === 0n) return { status: "invalid", message: "Enter an amount above zero." };
  if (balance !== null && parsed.units > balance) {
    return { status: "invalid", message: balance === 0n ? "Your wallet has no USDC to send." : `You only have ${formatSendAmount(balance)} USDC.` };
  }
  return { status: "ok", units: parsed.units };
}

/** The +10 / +100 buttons: adds whole USDC to what is typed (nothing typed, or a typo, counts as 0). */
export function addToAmount(text: string, step: number): string {
  const parsed = parseUsdcAmount(cleanAmountText(text));
  const current = parsed.ok ? parsed.units : 0n;
  return formatUsdcInput(current + BigInt(step) * USDC_UNIT);
}

/** "All": the exact balance, every one of its 6 decimals, so nothing is lost to rounding. */
export function allAmount(balance: bigint): string {
  return formatUsdcInput(balance);
}

// ---------------------------------------------------------------------------
// Network fee shown on the review

export type FeeView =
  /** The bank's paymaster pays (smart wallets, sponsored embedded wallets). */
  | { kind: "free" }
  | { kind: "checking" }
  /** The wallet pays about `fee` wei and holds `eth`. */
  | { kind: "fee"; fee: bigint; eth: bigint }
  /** The wallet holds less ETH than the fee: the send can't go through. */
  | { kind: "short"; fee: bigint; eth: bigint }
  /** The fee couldn't be estimated; the wallet will say. */
  | { kind: "unknown"; eth: bigint | null };

export function feeView(input: { sponsored: boolean; fee: bigint | null; eth: bigint | null; loading: boolean }): FeeView {
  if (input.sponsored) return { kind: "free" };
  if (input.loading) return { kind: "checking" };
  if (input.eth !== null && input.eth === 0n) return { kind: "short", fee: input.fee ?? 0n, eth: 0n };
  if (input.fee === null || input.eth === null) return { kind: "unknown", eth: input.eth };
  return input.eth < input.fee ? { kind: "short", fee: input.fee, eth: input.eth } : { kind: "fee", fee: input.fee, eth: input.eth };
}

/** "about 0.000004 ETH", or "less than 0.000001 ETH" for a dust fee. */
export function ethText(wei: bigint): string {
  const text = formatEth(wei, 6);
  if (wei > 0n && /^0(\.0*)?$/.test(text)) return "less than 0.000001 ETH";
  return `${text} ETH`;
}

/**
 * The review's "Network fee:" value. A fee the wallet can't pay is yellow, not
 * red: the red reason sits right under it on a dark well, and red on the
 * stone itself is too faint to read.
 */
export function feeLine(view: FeeView): { text: string; tone: "green" | "white" | "yellow" } {
  switch (view.kind) {
    case "free":
      return { text: "Free (the bank pays it)", tone: "green" };
    case "checking":
      return { text: "checking", tone: "yellow" };
    case "fee":
      return { text: `about ${ethText(view.fee)}, paid by your wallet`, tone: "white" };
    case "unknown":
      return { text: "paid in ETH by your wallet", tone: "white" };
    case "short":
      return { text: view.fee > 0n ? `about ${ethText(view.fee)}` : "paid in ETH by your wallet", tone: "yellow" };
  }
}

/** Why Confirm is off for an external wallet without enough ETH. */
export function shortOfGasText(view: Extract<FeeView, { kind: "short" }>): string {
  const has = view.eth === 0n ? "has no ETH on Base" : `has only ${ethText(view.eth)} on Base`;
  return `Your wallet ${has} for the network fee. Add a little ETH on Base to it, then try again.`;
}

// ---------------------------------------------------------------------------
// Failures

export type SendFailure =
  /** The player closed or refused the wallet prompt: back to the review, no message. */
  | { kind: "rejected" }
  /** The send may have gone through: settle it from the chain before anything else. */
  | { kind: "unconfirmed" }
  /**
   * Nothing was sent (unless `history`). `back` is the screen the player
   * returns to. `history`: whether it went through is unknown, so the screen
   * links the wallet's USDC history on Basescan.
   */
  | { kind: "error"; message: string; hint: string | null; back: "form" | "review"; retry: boolean; history?: true };

const NO_RECORD_FAILURE: Extract<SendFailure, { kind: "error" }> = {
  kind: "error",
  message: "Your wallet didn't say whether the send went through.",
  hint: "Check your balance and your USDC history on Basescan before sending again.",
  back: "form",
  retry: false,
  history: true,
};

export const SPONSOR_FAILED = "The bank couldn't pay the network fee for this send right now, so nothing was sent.";
export const SPONSOR_FAILED_HINT = "Try again later, or log in with your own wallet and pay the fee in ETH on Base.";

/** Maps anything `sendUsdc` throws to what the Send interface shows. */
export function sendFailure(error: unknown): SendFailure {
  if (error instanceof SendUnconfirmedError) return { kind: "unconfirmed" };
  const walletError: WalletError = toWalletError(error);
  if (walletError.code === "user_rejected") return { kind: "rejected" };
  if (walletError instanceof InsufficientUsdcError) {
    return { kind: "error", message: walletError.message, hint: "Lower the amount, then try again.", back: "form", retry: false };
  }
  if (walletError.mayHaveLanded) return { kind: "unconfirmed" };
  switch (walletError.code) {
    case "insufficient_gas":
      return {
        kind: "error",
        message: "Your wallet needs a little ETH on Base to pay the network fee.",
        hint: "Add a little ETH on Base to this wallet, then try again.",
        back: "review",
        retry: true,
      };
    case "sponsorship_failed":
      return { kind: "error", message: SPONSOR_FAILED, hint: SPONSOR_FAILED_HINT, back: "review", retry: true };
    case "call_reverted":
      return { kind: "error", message: walletError.message, hint: "Check the address and the amount.", back: "form", retry: false };
    case "reverted":
      return { kind: "error", message: "The send failed on Base. No USDC moved.", hint: "You can try again.", back: "review", retry: true };
    case "invalid_request":
      return { kind: "error", message: walletError.message, hint: null, back: "form", retry: false };
    default:
      return { kind: "error", message: walletError.message, hint: "Nothing was sent. You can try again.", back: "review", retry: true };
  }
}

// ---------------------------------------------------------------------------
// Screens

export interface SentView {
  hash: Hash;
  amount: bigint;
  to: Address;
}

export type SendScreen =
  | { step: "form" }
  | { step: "review"; amount: bigint; to: Address }
  | { step: "sending"; amount: bigint; to: Address }
  | { step: "success"; sent: SentView }
  | { step: "error"; failure: Extract<SendFailure, { kind: "error" }>; amount: bigint; to: Address }
  | { step: "unconfirmed"; record: PendingSend };

export interface SendState {
  /** What is typed; kept through review and back. */
  amountText: string;
  toText: string;
  screen: SendScreen;
}

export type SendAction =
  | { type: "amount"; text: string }
  | { type: "to"; text: string }
  | { type: "review"; amount: bigint; to: Address }
  | { type: "back" }
  | { type: "sending" }
  | { type: "sent"; sent: SentView }
  | { type: "failed"; failure: SendFailure; record: PendingSend | null }
  | { type: "unconfirmed"; record: PendingSend }
  /** The pending send is settled as not having happened (failed on-chain, or released by the player). */
  | { type: "released"; failure?: Extract<SendFailure, { kind: "error" }> }
  | { type: "reset" };

export function initialSendState(draft: { amount?: string; to?: string } = {}, pending: PendingSend | null = null): SendState {
  return {
    amountText: draft.amount ?? "",
    toText: draft.to ?? "",
    screen: pending ? { step: "unconfirmed", record: pending } : { step: "form" },
  };
}

export function sendReducer(state: SendState, action: SendAction): SendState {
  const { screen } = state;
  switch (action.type) {
    case "amount":
      return screen.step === "form" ? { ...state, amountText: cleanAmountText(action.text) } : state;
    case "to":
      return screen.step === "form" ? { ...state, toText: action.text } : state;
    case "review":
      return screen.step === "form" ? { ...state, screen: { step: "review", amount: action.amount, to: action.to } } : state;
    case "back":
      if (screen.step === "review") return { ...state, screen: { step: "form" } };
      if (screen.step === "error") {
        return {
          ...state,
          screen: screen.failure.back === "review" ? { step: "review", amount: screen.amount, to: screen.to } : { step: "form" },
        };
      }
      return state;
    case "sending":
      return screen.step === "review" ? { ...state, screen: { step: "sending", amount: screen.amount, to: screen.to } } : state;
    case "sent":
      // A send settled from the unconfirmed screen also lands here; the typed draft is done with.
      return { amountText: "", toText: "", screen: { step: "success", sent: action.sent } };
    case "failed": {
      if (screen.step !== "sending") return state;
      const { failure } = action;
      if (failure.kind === "rejected") return { ...state, screen: { step: "review", amount: screen.amount, to: screen.to } };
      if (failure.kind === "unconfirmed") {
        if (action.record) return { ...state, screen: { step: "unconfirmed", record: action.record } };
        // No record to settle it by: never offer a resend from here.
        return { ...state, screen: { step: "error", failure: NO_RECORD_FAILURE, amount: screen.amount, to: screen.to } };
      }
      return { ...state, screen: { step: "error", failure, amount: screen.amount, to: screen.to } };
    }
    case "unconfirmed":
      return { ...state, screen: { step: "unconfirmed", record: action.record } };
    case "released":
      if (screen.step !== "unconfirmed") return state;
      if (action.failure) return { ...state, screen: { step: "error", failure: action.failure, amount: screen.record.amount, to: screen.record.to } };
      return { ...state, screen: { step: "form" } };
    case "reset":
      return initialSendState();
  }
}

/** Copy for a send that may or may not have gone through, from the latest check. */
export function unconfirmedText(check: Pick<PendingCheck, "scanned" | "balanceDropped" | "queued"> | null): string {
  if (!check) return "Checking Base for it...";
  if (check.queued) return "It's still queued to go onto Base, so it can still go through. Don't send it again.";
  if (check.balanceDropped) {
    return "Your balance has dropped by at least that much since, so it may have gone through. Check your USDC history on Basescan.";
  }
  if (!check.scanned || check.balanceDropped === null) return "Couldn't read Base just now. It will check again shortly.";
  return "There's no sign of it on Base yet. Don't send it again while it may still go through.";
}

/** While the send is still running in this page. A player with their own wallet app can look there. */
export function inFlightText(walletApp: boolean): string {
  return walletApp ? "Your wallet is still working on it. Check your wallet." : "It's still going through. This updates when it's done.";
}

/**
 * Shown with the release button. A wallet app can still hold a stuck
 * transaction that Base has not seen, so its player looks there too.
 */
export function releaseHint(walletApp: boolean): string {
  return walletApp
    ? "It's been over 10 minutes and Base shows no sign of it. If your wallet shows nothing pending either, it didn't go through and you can send again."
    : "It's been over 10 minutes and Base shows no sign of it, so it didn't go through. To be sure, check your USDC history on Basescan.";
}

/** The button that gives up on the pending send: what it does, not a status. */
export const RELEASE_LABEL = "Let me send again";
