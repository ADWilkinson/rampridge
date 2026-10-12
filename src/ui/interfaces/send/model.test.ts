import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import {
  CallRevertedError,
  ChainSwitchError,
  InsufficientGasError,
  SponsorshipError,
  TransactionPendingError,
  TransactionRevertedError,
  UserRejectedError,
  WalletBusyError,
  WalletError,
} from "@/wallet/errors";
import { InsufficientUsdcError, SendUnconfirmedError, type PendingSend } from "@/wallet/send";
import {
  SPONSOR_FAILED,
  SPONSOR_FAILED_HINT,
  addToAmount,
  allAmount,
  checkAmount,
  cleanAmountText,
  ethText,
  feeLine,
  feeView,
  inFlightText,
  initialSendState,
  releaseHint,
  sendFailure,
  sendReducer,
  shortOfGasText,
  unconfirmedText,
  usdcHistoryUrl,
  type SendState,
} from "./model";

const TO = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as Address;
const FROM = "0x5555555555555555555555555555555555555555" as Address;
const TX = `0x${"12".repeat(32)}` as Hash;
const RECORD: PendingSend = { from: FROM, to: TO, amount: 25_000_000n, startedAt: 0, fromBlock: 1n, balanceBefore: 50_000_000n, hash: null, userOpHash: null };

describe("amount entry", () => {
  it("keeps digits and one decimal point, reading a comma as the point", () => {
    expect(cleanAmountText("25,50")).toBe("25.50");
    expect(cleanAmountText("1.2.3")).toBe("1.23");
    expect(cleanAmountText(" $12a.5 ")).toBe("12.5");
    expect(cleanAmountText("1,250")).toBe("1.250");
  });

  it("parses up to 6 decimals exactly and checks the balance", () => {
    expect(checkAmount("", 10n)).toEqual({ status: "empty" });
    expect(checkAmount("25.5", 100_000_000n)).toEqual({ status: "ok", units: 25_500_000n });
    expect(checkAmount("0.000001", 1n)).toEqual({ status: "ok", units: 1n });
    expect(checkAmount("0.0000001", 100n)).toEqual({ status: "invalid", message: "USDC has at most 6 decimal places." });
    expect(checkAmount("0", 100n)).toEqual({ status: "invalid", message: "Enter an amount above zero." });
    expect(checkAmount(".", 100n)).toEqual({ status: "invalid", message: "Enter an amount like 25 or 25.50." });
    expect(checkAmount("125.41", 125_400_000n)).toEqual({ status: "invalid", message: "You only have 125.40 USDC." });
    expect(checkAmount("1", 0n)).toEqual({ status: "invalid", message: "Your wallet has no USDC to send." });
    // Balance not known yet: the amount alone is checked.
    expect(checkAmount("9999", null)).toEqual({ status: "ok", units: 9_999_000_000n });
  });

  it("All is the exact balance, every decimal kept", () => {
    expect(allAmount(125_401_999n)).toBe("125.401999");
    expect(allAmount(125_400_000n)).toBe("125.4");
    expect(checkAmount(allAmount(125_401_999n), 125_401_999n)).toEqual({ status: "ok", units: 125_401_999n });
    expect(allAmount(1n)).toBe("0.000001");
  });

  it("+10 and +100 add whole USDC to what is typed", () => {
    expect(addToAmount("", 10)).toBe("10");
    expect(addToAmount("2.5", 100)).toBe("102.5");
    expect(addToAmount("oops", 10)).toBe("10");
    expect(addToAmount("0.000001", 10)).toBe("10.000001");
  });
});

describe("network fee", () => {
  it("is free for sponsored wallets and checked against ETH for the rest", () => {
    expect(feeView({ sponsored: true, fee: null, eth: null, loading: true })).toEqual({ kind: "free" });
    expect(feeView({ sponsored: false, fee: null, eth: null, loading: true })).toEqual({ kind: "checking" });
    expect(feeView({ sponsored: false, fee: 4_000_000_000_000n, eth: 10n ** 16n, loading: false }).kind).toBe("fee");
    expect(feeView({ sponsored: false, fee: 4_000_000_000_000n, eth: 1_000_000_000_000n, loading: false }).kind).toBe("short");
    expect(feeView({ sponsored: false, fee: null, eth: 0n, loading: false }).kind).toBe("short");
    expect(feeView({ sponsored: false, fee: null, eth: 10n ** 15n, loading: false }).kind).toBe("unknown");
  });

  it("reads plainly", () => {
    expect(ethText(4_000_000_000_000n)).toBe("0.000004 ETH");
    expect(ethText(10n)).toBe("less than 0.000001 ETH");
    expect(feeLine({ kind: "free" })).toEqual({ text: "Free (the bank pays it)", tone: "green" });
    expect(feeLine({ kind: "fee", fee: 4_000_000_000_000n, eth: 1n }).text).toBe("about 0.000004 ETH, paid by your wallet");
    // Yellow, never red on the stone: the red reason is on a dark well under it.
    expect(feeLine({ kind: "short", fee: 4_000_000_000_000n, eth: 0n })).toEqual({ text: "about 0.000004 ETH", tone: "yellow" });
    expect(shortOfGasText({ kind: "short", fee: 4_000_000_000_000n, eth: 0n })).toBe(
      "Your wallet has no ETH on Base for the network fee. Add a little ETH on Base to it, then try again.",
    );
    expect(shortOfGasText({ kind: "short", fee: 4_000_000_000_000n, eth: 1_000_000_000_000n })).toMatch(/has only 0.000001 ETH on Base/);
  });
});

describe("sendFailure", () => {
  it("returns silently to the review when the player rejects in the wallet", () => {
    expect(sendFailure(new UserRejectedError())).toEqual({ kind: "rejected" });
    expect(sendFailure({ code: 4001, message: "User rejected the request." })).toEqual({ kind: "rejected" });
  });

  it("settles from the chain whenever the send may have landed", () => {
    expect(sendFailure(new TransactionPendingError(TX))).toEqual({ kind: "unconfirmed" });
    expect(sendFailure(new TransactionPendingError(null))).toEqual({ kind: "unconfirmed" });
    expect(sendFailure(new WalletError("unknown", "socket hang up"))).toEqual({ kind: "unconfirmed" });
    expect(sendFailure(new SendUnconfirmedError(RECORD))).toEqual({ kind: "unconfirmed" });
  });

  it("explains each refusal with the next step", () => {
    expect(sendFailure(new InsufficientUsdcError(10_000_000n, 25_000_000n))).toEqual({
      kind: "error",
      message: "You only have 10.00 USDC now, less than this send.",
      hint: "Lower the amount, then try again.",
      back: "form",
      retry: false,
    });
    expect(sendFailure(new InsufficientGasError(FROM))).toMatchObject({
      message: "Your wallet needs a little ETH on Base to pay the network fee.",
      hint: "Add a little ETH on Base to this wallet, then try again.",
      back: "review",
    });
    expect(sendFailure(new SponsorshipError({ reason: "max per user" }))).toMatchObject({ message: SPONSOR_FAILED, hint: SPONSOR_FAILED_HINT, retry: true });
    expect(SPONSOR_FAILED_HINT).toMatch(/Try again later/);
    expect(SPONSOR_FAILED_HINT).toMatch(/your own wallet/);
    expect(sendFailure(new CallRevertedError("blacklisted"))).toMatchObject({ back: "form", hint: "Check the address and the amount." });
    expect(sendFailure(new TransactionRevertedError(TX, null))).toMatchObject({ message: "The send failed on Base. No USDC moved.", back: "review" });
    expect(sendFailure(new ChainSwitchError())).toMatchObject({ message: "Switch your wallet to the Base network and try again.", back: "review" });
    expect(sendFailure(new WalletBusyError())).toMatchObject({ kind: "error", back: "review" });
    expect(sendFailure(new WalletError("unknown", "Couldn't check your USDC balance on Base.", { mayHaveLanded: false }))).toMatchObject({
      kind: "error",
      hint: "Nothing was sent. You can try again.",
    });
  });
});

describe("send screens", () => {
  const review = (state: SendState) => sendReducer(state, { type: "review", amount: 25_000_000n, to: TO });

  it("goes form -> review -> back with the inputs kept", () => {
    let state = initialSendState();
    state = sendReducer(state, { type: "amount", text: "25" });
    state = sendReducer(state, { type: "to", text: TO });
    state = review(state);
    expect(state.screen).toEqual({ step: "review", amount: 25_000_000n, to: TO });
    // Typing is ignored on the review: what it shows is what Confirm sends.
    expect(sendReducer(state, { type: "amount", text: "99" })).toBe(state);
    state = sendReducer(state, { type: "back" });
    expect(state).toEqual({ amountText: "25", toText: TO, screen: { step: "form" } });
  });

  it("only sends from the review, and goes back there when the wallet is closed", () => {
    expect(sendReducer(initialSendState(), { type: "sending" }).screen.step).toBe("form");
    let state = sendReducer(review(initialSendState({ amount: "25", to: TO })), { type: "sending" });
    expect(state.screen).toEqual({ step: "sending", amount: 25_000_000n, to: TO });
    state = sendReducer(state, { type: "failed", failure: { kind: "rejected" }, record: null });
    expect(state.screen).toEqual({ step: "review", amount: 25_000_000n, to: TO });
  });

  it("shows success and forgets the draft", () => {
    const sending = sendReducer(review(initialSendState({ amount: "25", to: TO })), { type: "sending" });
    const state = sendReducer(sending, { type: "sent", sent: { hash: TX, amount: 25_000_000n, to: TO } });
    expect(state).toEqual({ amountText: "", toText: "", screen: { step: "success", sent: { hash: TX, amount: 25_000_000n, to: TO } } });
  });

  it("returns from an error to the screen that can fix it", () => {
    const sending = sendReducer(review(initialSendState({ amount: "25", to: TO })), { type: "sending" });
    const usdc = sendReducer(sending, { type: "failed", failure: sendFailure(new InsufficientUsdcError(1n, 25_000_000n)), record: null });
    expect(usdc.screen.step).toBe("error");
    expect(sendReducer(usdc, { type: "back" }).screen).toEqual({ step: "form" });
    const sponsor = sendReducer(sending, { type: "failed", failure: sendFailure(new SponsorshipError()), record: null });
    expect(sendReducer(sponsor, { type: "back" }).screen).toEqual({ step: "review", amount: 25_000_000n, to: TO });
  });

  it("never offers a resend while a send may have landed", () => {
    const sending = sendReducer(review(initialSendState({ amount: "25", to: TO })), { type: "sending" });
    const unconfirmed = sendReducer(sending, { type: "failed", failure: { kind: "unconfirmed" }, record: RECORD });
    expect(unconfirmed.screen).toEqual({ step: "unconfirmed", record: RECORD });
    expect(sendReducer(unconfirmed, { type: "back" })).toBe(unconfirmed);
    expect(sendReducer(unconfirmed, { type: "sending" })).toBe(unconfirmed);
    // Without a record to settle it by, the player is sent to check their wallet, not back to Confirm.
    const blind = sendReducer(sending, { type: "failed", failure: { kind: "unconfirmed" }, record: null });
    expect(blind.screen.step).toBe("error");
    expect(blind.screen.step === "error" && blind.screen.failure).toMatchObject({ back: "form", retry: false });
    // An earlier unconfirmed send is what the interface opens on.
    expect(initialSendState({}, RECORD).screen).toEqual({ step: "unconfirmed", record: RECORD });
  });

  it("settles an unconfirmed send as landed, failed or released", () => {
    const unconfirmed = initialSendState({ amount: "25", to: TO }, RECORD);
    expect(sendReducer(unconfirmed, { type: "sent", sent: { hash: TX, amount: RECORD.amount, to: TO } }).screen.step).toBe("success");
    const failed = sendReducer(unconfirmed, {
      type: "released",
      failure: { kind: "error", message: "That send failed on Base. No USDC moved.", hint: null, back: "form", retry: false },
    });
    expect(failed.screen.step).toBe("error");
    expect(sendReducer(unconfirmed, { type: "released" }).screen).toEqual({ step: "form" });
  });
});

describe("unconfirmed send copy", () => {
  const quiet = { scanned: true, balanceDropped: false, queued: false } as const;

  it("says what the latest check found, and never asks for a wallet app the player may not have", () => {
    expect(unconfirmedText(null)).toBe("Checking Base for it...");
    expect(unconfirmedText(quiet)).toBe("There's no sign of it on Base yet. Don't send it again while it may still go through.");
    expect(unconfirmedText({ ...quiet, queued: true })).toContain("still queued");
    expect(unconfirmedText({ ...quiet, balanceDropped: true })).toBe(
      "Your balance has dropped by at least that much since, so it may have gone through. Check your USDC history on Basescan.",
    );
    expect(unconfirmedText({ ...quiet, scanned: false })).toBe("Couldn't read Base just now. It will check again shortly.");
    expect(unconfirmedText({ ...quiet, balanceDropped: null })).toBe("Couldn't read Base just now. It will check again shortly.");
    expect(inFlightText(false)).not.toMatch(/wallet/i);
    expect(inFlightText(true)).toBe("Your wallet is still working on it. Check your wallet.");
    expect(releaseHint(false)).toContain("USDC history on Basescan");
    expect(releaseHint(false)).not.toMatch(/your wallet/i);
    expect(releaseHint(true)).toContain("If your wallet shows nothing pending");
    expect(usdcHistoryUrl(FROM)).toBe(`https://basescan.org/address/${FROM}#tokentxns`);
  });

  it("links the USDC history when a send's outcome is unknown and there is no record of it", () => {
    const sending: SendState = { amountText: "25", toText: TO, screen: { step: "sending", amount: 25_000_000n, to: TO } };
    const blind = sendReducer(sending, { type: "failed", failure: { kind: "unconfirmed" }, record: null });
    expect(blind.screen.step === "error" && blind.screen.failure).toMatchObject({ history: true, retry: false });
  });
});
