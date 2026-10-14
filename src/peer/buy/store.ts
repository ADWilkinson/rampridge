/**
 * The buy flow state machine:
 *
 *   idle -> quoting -> quoted -> confirming -> signaling -> awaitingPayment
 *     -> verifying (checking | needsInstall | needsUpdate | needsConnection |
 *                   unsupportedBrowser | capturing)
 *     -> selectPayment -> fulfilling -> completed
 *
 * plus `cancelled` and `error` (with a return step). Once an intent is
 * signalled it is persisted per wallet and recovered from the chain on the
 * next bind, so nothing in-flight is ever only in memory. While an order is
 * open the chain is re-read in the background (on an interval and when the
 * window regains focus), so a release by the seller or an auto-release shows
 * without a reload. While a transaction is in flight (signal, fulfil,
 * cancel) no other action can start, and nothing it finishes is written into
 * a later wallet session.
 *
 * The Peer extension's status for the open order (`extension`) is read as
 * Peer web's app-wide version poll does: while a screen where it matters is
 * open (the Payment scroll, Verify: `watchExtension`) and the extension is
 * missing, too old or not read yet, at once, then every `extensionPollMs`
 * and whenever the page regains focus, stopping once it is usable or the
 * screens close. Only the status and version are read; nothing is prompted.
 * An install or connection prompt the extension has moved past goes on to
 * the next step by itself.
 */

import type { BuyerTeePaymentProofInput, PeerExtensionSdk, PeerMetadataMessage, Zkp2pClient } from "@zkp2p/sdk";
import type { Address, Hex } from "viem";
import { createStore, type StoreApi } from "zustand/vanilla";
import { track, type FunnelEvent } from "@/lib/telemetry";
import type { TxSender } from "@/wallet/types";
import { createPeerClient } from "../client";
import {
  EXTENSION_POLL_MS,
  buildBuyerTeeProof,
  canInstallPeerExtension,
  captureFailureText,
  getExtensionStatus,
  openExtensionInstallPage,
  peerExtension,
  requestExtensionConnection,
  selectableRows,
  startBuyerCapture,
  type ExtensionStatus,
} from "../extension";
import { reportFailure } from "../errorDetail";
import { FIAT_DECIMALS, formatDecimal, parseUsdc, tryParseAmount } from "../format";
import { getBuyQuotes, type BuyQuote, type BuyQuoteFees } from "../market";
import { BUY_PLATFORMS, needsRecipientId, recipientIdFor, resolveVerifyMethod } from "../platforms";
import { fiatToSend, fiatToSendText } from "./amounts";
import {
  SignalSentError,
  asPayeeRecord,
  cancelBuyIntent,
  fetchPayee,
  fulfillBuyIntent,
  reconcileSignal,
  signalBuyIntent,
  waitForIndexedFulfillment,
  type FulfillResult,
  type PayeeLookup,
  type SentSignal,
  type SignalReconciliation,
  type SignalResult,
} from "./chain";
import { blockingIntentFromError, technicalDetail, toBuyError, type ErrorContext } from "./errors";
import { pickMemo } from "./instructions";
import { recoverBuyOrder, type RecoveryResult } from "./recovery";
import { localOrderStorage, serializeOrder, type OrderStorage } from "./storage";
import type {
  BuyError,
  BuyErrorCode,
  BuyFlowState,
  BuyFlowStore,
  BuyOrder,
  BuyStep,
  PendingAction,
  QuoteInput,
  VerifyingState,
} from "./types";

export interface BuyDeps {
  getClient(sender: TxSender | null): Zkp2pClient;
  extension: PeerExtensionSdk;
  storage: OrderStorage;
  quotes: typeof getBuyQuotes;
  /** Curator payee lookup; a bare handle means "not a business profile". */
  fetchPayeeHandle: PayeeLookup;
  canInstallExtension(): boolean;
  /** Opens PeerAuth's Chrome Web Store page in a new tab. */
  openInstallPage(): void;
  /** How often to look for the extension once the player opened its store page. */
  extensionPollMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  /** How long to wait for the indexer to show FULFILLED after a successful receipt. */
  indexerTimeoutMs: number;
  /** How long to look for the intent of a signal whose outcome the wallet could not report. */
  signalReconcileMs: number;
  /** How often an open order is re-read from the chain in the background. */
  pollIntervalMs: number;
  /** Runs `run` every `ms` until the returned stop function is called. */
  every(ms: number, run: () => void): () => void;
  /** Runs `run` whenever the page regains focus until the returned stop function is called. */
  onFocus(run: () => void): () => void;
  /** Logs a failed transaction step with its redacted technical detail (`technicalDetail`). */
  warn(message: string, detail: string): void;
  /** Counts a funnel step in launch telemetry. */
  track(event: FunnelEvent): void;
  /** Sends a failed transaction step's redacted detail to launch telemetry. */
  reportFailure(error: unknown, context: string, detail: string): void;
}

function everyInterval(ms: number, run: () => void): () => void {
  const id = setInterval(run, ms);
  return () => clearInterval(id);
}

function onWindowFocus(run: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  window.addEventListener("focus", run);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("focus", run);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

const defaultDeps: BuyDeps = {
  getClient: (sender) => createPeerClient({ sender }),
  extension: peerExtension(),
  storage: localOrderStorage,
  quotes: getBuyQuotes,
  fetchPayeeHandle: fetchPayee,
  canInstallExtension: () => canInstallPeerExtension(),
  openInstallPage: () => openExtensionInstallPage(),
  extensionPollMs: EXTENSION_POLL_MS,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  indexerTimeoutMs: 30_000,
  signalReconcileMs: 90_000,
  pollIntervalMs: 15_000,
  every: everyInterval,
  onFocus: onWindowFocus,
  warn: (message, detail) => console.warn(message, detail),
  track,
  reportFailure,
};

type TxAction = "signal" | "fulfill" | "cancel";

/** A transaction-bearing action in flight, tied to the wallet session that started it. */
interface InFlight {
  action: TxAction;
  epoch: number;
}

/** A signal whose transaction may have landed but whose intent was never found. */
interface UnresolvedSignal {
  owner: Address;
  quote: BuyQuote;
  sender: TxSender;
  sent: SentSignal;
  epoch: number;
}

/** Selecting must finish before the captured session expires; proving takes a while. */
export const CAPTURE_SAFETY_MS = 30_000;

const EXPIRED_ORDER_NOTICE = "Your last order expired. If you already paid, verify it now. Otherwise dismiss it.";

const IDLE_STEPS: ReadonlySet<BuyStep> = new Set(["idle", "quoting", "quoted", "confirming", "completed", "cancelled"]);
const ORDER_STEPS: ReadonlySet<BuyStep> = new Set(["awaitingPayment", "verifying", "selectPayment", "fulfilling"]);

/** Errors that mean the quote itself is stale: the fix is fresh prices, not a resend. */
const REQUOTE_CODES: ReadonlySet<BuyErrorCode> = new Set([
  "quote_expired",
  "liquidity",
  "rate_changed",
  "signature_expired",
  "payment_method_unavailable",
  "amount_too_low",
  "amount_too_high",
]);

/** Fulfil errors where picking a different captured payment is the next step. */
const PICK_AGAIN_CODES: ReadonlySet<BuyErrorCode> = new Set([
  "payee_mismatch",
  "nullifier_used",
  "payment_verification_failed",
  "payment_not_settled",
]);

function initialState(): BuyFlowState {
  return {
    step: "idle",
    verifying: null,
    owner: null,
    request: null,
    quotes: [],
    nearby: { below: [], above: [] },
    quotesExpireAt: null,
    selectedQuote: null,
    order: null,
    payments: [],
    captureExpiresAt: null,
    completion: null,
    error: null,
    errorReturnStep: null,
    notice: null,
    pending: null,
    recovering: false,
    blockingIntent: null,
    extension: null,
    awaitingInstall: false,
  };
}

/** Verify prompts that wait on the extension, and the status each one waits out. */
const EXTENSION_PROMPTS: Partial<Record<VerifyingState, ExtensionStatus>> = {
  needsInstall: "needs_install",
  needsConnection: "needs_connection",
};

function lower(address: Address): Address {
  return address.toLowerCase() as Address;
}

function isExpired(order: BuyOrder, now: number): boolean {
  return now >= order.expiresAt;
}

function sameHash(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/** The quote's fees for the amount actually signalled (proportional when the chain reserved a different amount). */
function feesFor(fees: BuyQuoteFees, signalled: bigint, quoted: bigint): BuyQuoteFees {
  if (signalled === quoted || quoted <= 0n) return fees;
  const scale = (amount: bigint) => (amount * signalled) / quoted;
  return {
    ...fees,
    service: scale(fees.service),
    manager: scale(fees.manager),
    referrer: scale(fees.referrer),
    total: scale(fees.total),
  };
}

/** The quoted fees without RampRidge's leg, for an intent signalled with it waived. */
function withoutReferrerFee(fees: BuyQuoteFees): BuyQuoteFees {
  return { ...fees, referrer: 0n, referrerBps: null, total: fees.total - fees.referrer };
}

/** Pending actions that mean a transaction is being sent or settled. */
const TX_PENDING: ReadonlySet<PendingAction> = new Set(["signal", "fulfill", "cancel"]);

/**
 * A release was sent but its receipt never came: the notice stays on screen,
 * polled from the chain, so a release that lands completes by itself and is
 * never re-proved or sent again from here.
 */
function releasePending(state: Pick<BuyFlowState, "step" | "error" | "errorReturnStep" | "order">): boolean {
  return (
    state.step === "error" &&
    state.error?.code === "tx_pending" &&
    state.errorReturnStep === "awaitingPayment" &&
    state.order?.status === "active"
  );
}

export function createBuyStore(overrides: Partial<BuyDeps> = {}): StoreApi<BuyFlowStore> {
  const deps: BuyDeps = { ...defaultDeps, ...overrides };

  // Live handles that must never be serialised or rendered.
  let sender: TxSender | null = null;
  let runId = 0;
  let ownerEpoch = 0;
  let stopCapture: (() => void) | null = null;
  let capture: PeerMetadataMessage | null = null;
  let retryAction: (() => Promise<void>) | null = null;
  // Quotes shown before login are re-fetched for the logged-in wallet once its recovery is done.
  let requoteAfterRecovery: QuoteInput | null = null;
  // The double-submit guard. Unlike the `pending` field, no other action can overwrite it.
  let inFlight: InFlight | null = null;
  let unresolvedSignal: UnresolvedSignal | null = null;
  // The background chain re-read of an open order: its stop function, and whether a read is running.
  let stopPolling: (() => void) | null = null;
  let polling = false;
  // The Peer extension look-out: screens watching it, its timer and focus listener, and the read in progress.
  let extensionWatchers = 0;
  let stopExtensionPoll: (() => void) | null = null;
  let extensionRead: Promise<void> | null = null;
  // Orders dismissed in this session (lowercase intent hashes), so blocked storage can never make
  // recovery re-adopt an order the player just dismissed and trap them out of new orders.
  const dismissedHere = new Set<string>();
  // Orders whose verification was counted for launch telemetry (lowercase intent hashes).
  const verifyCounted = new Set<string>();

  return createStore<BuyFlowStore>()((set, get) => {
    const busy = () => inFlight !== null && inFlight.epoch === ownerEpoch;

    /** True while a signal, fulfil or cancel is being sent or settled. */
    const txBlocked = () => {
      const { step, pending } = get();
      return busy() || step === "signaling" || step === "fulfilling" || (pending !== null && TX_PENDING.has(pending));
    };

    /** Runs a transaction-bearing action; refuses to start while another is in flight. */
    const exclusive = async <T>(action: TxAction, run: () => Promise<T>): Promise<T | null> => {
      if (busy()) return null;
      const token: InFlight = { action, epoch: ownerEpoch };
      inFlight = token;
      try {
        return await run();
      } finally {
        if (inFlight === token) inFlight = null;
      }
    };

    const endCapture = () => {
      const stop = stopCapture;
      stopCapture = null;
      capture = null;
      stop?.();
    };

    /**
     * Runs the look-out (every `extensionPollMs`, and on focus) only while a
     * screen watches and the extension is missing, too old or not read yet,
     * as Peer web polls the version until the extension answers.
     */
    const syncExtensionPoll = () => {
      const status = get().extension;
      const want = extensionWatchers > 0 && (status === null || status === "needs_install" || status === "needs_update");
      if (want && !stopExtensionPoll) {
        const tick = () => void readExtension();
        const stopTimer = deps.every(deps.extensionPollMs, tick);
        const stopFocus = deps.onFocus(tick);
        stopExtensionPoll = () => {
          stopTimer();
          stopFocus();
        };
      } else if (!want && stopExtensionPoll) {
        const stop = stopExtensionPoll;
        stopExtensionPoll = null;
        stop();
      }
    };

    /** Records a fresh status: "waiting for the install" ends once PeerAuth is found, and the look-out follows. */
    const noteExtension = (status: ExtensionStatus) => {
      const { extension, awaitingInstall } = get();
      const found = awaitingInstall && status !== "needs_install";
      if (extension !== status || found) set({ extension: status, ...(found ? { awaitingInstall: false } : {}) });
      syncExtensionPoll();
    };

    /** The extension's status for the open order's platform, read without touching the visible step. */
    const readExtension = (): Promise<void> => {
      extensionRead ??= (async () => {
        const epoch = ownerEpoch;
        let status: ExtensionStatus;
        try {
          status = await getExtensionStatus(deps.extension, { canInstall: deps.canInstallExtension(), platform: get().order?.platform });
        } catch {
          return;
        }
        if (epoch !== ownerEpoch) return;
        noteExtension(status);
        // An install or connection prompt the extension has moved past goes on to the next step by
        // itself, as Peer web's InstallExtension does once its version poll finds the extension.
        const { step, verifying, pending } = get();
        const waitsOn = verifying === null ? undefined : EXTENSION_PROMPTS[verifying];
        if (step === "verifying" && pending === null && waitsOn !== undefined && waitsOn !== status) {
          await get().startVerification();
        }
      })().finally(() => {
        extensionRead = null;
      });
      return extensionRead;
    };

    const failWith = (error: BuyError, returnTo: BuyStep | null, retry: (() => Promise<void>) | null) => {
      retryAction = error.recoverable ? retry : null;
      set({ step: "error", error, errorReturnStep: returnTo, verifying: null, pending: null });
    };

    const fail = (
      cause: unknown,
      ctx: ErrorContext,
      returnTo: BuyStep | null,
      retry: (() => Promise<void>) | null,
    ): BuyError => {
      const error = toBuyError(cause, ctx);
      failWith(error, returnTo, retry);
      return error;
    };

    const own = (code: BuyErrorCode, message: string, recoverable = true): BuyError => ({ code, message, recoverable });

    /**
     * Logs why a signal, fulfil or cancel failed and keeps the same redacted
     * detail on the mapped error, so the next live failure is diagnosable from
     * the console without exposing anything secret. The same detail goes to
     * launch telemetry, except when the player said no in their wallet.
     */
    const report = (action: TxAction, error: unknown): string => {
      const detail = technicalDetail(error);
      deps.warn(`[buy] ${action} failed`, detail);
      if (toBuyError(error, { stage: action }).code !== "user_rejected") deps.reportFailure(error, `buy.${action}`, detail);
      return detail;
    };

    const client = () => deps.getClient(sender);

    const dismissedFor = (owner: Address): ReadonlySet<string> => new Set([...deps.storage.dismissed(owner), ...dismissedHere]);

    const saveOrder = (order: BuyOrder) => {
      deps.storage.save(order);
      set({ order });
    };

    /** Forgets a stored order, unless storage has since moved on to a different one. */
    const forgetStored = (owner: Address, intentHash: Hex) => {
      if (sameHash(deps.storage.load(owner)?.intentHash ?? null, intentHash)) deps.storage.clear(owner);
    };

    const payeeFor = (order: BuyOrder | null) =>
      order?.payeeHandle ? BUY_PLATFORMS[order.platform].formatPayee(order.payeeHandle) : null;

    /**
     * Applies a chain recovery result without disturbing a flow already in
     * progress. `evaluated` is the stored order the recovery started from; if
     * storage has moved on since (an order was signalled, fulfilled or
     * cancelled meanwhile) the result is stale and is dropped.
     */
    const applyRecovery = (result: RecoveryResult, owner: Address, evaluated: Hex | null) => {
      const state = get();
      if (state.step === "signaling" || (busy() && inFlight?.action === "signal")) return;
      if (!sameHash(deps.storage.load(owner)?.intentHash ?? null, evaluated)) return;
      const current = state.order;
      const sameOrder = (o: BuyOrder | null) => Boolean(o && current && sameHash(o.intentHash, current.intentHash));
      switch (result.kind) {
        case "active": {
          if (current && sameOrder(result.order)) {
            if (current.status !== "active") return;
            // Chain facts win, except what only this device knows: memo, verify method, payee, the
            // quoted fees and paid claim, and the confirmed net (the chain's referral legs alone omit
            // the rate manager's fee, so a figure rebuilt from them overstates what the buyer gets).
            const merged: BuyOrder = {
              ...result.order,
              // The same wallet; kept as shown (storage checksums it) so an unchanged order compares equal.
              owner: current.owner,
              usdcExpected: current.usdcExpected,
              verifyMethodId: current.verifyMethodId ?? result.order.verifyMethodId,
              memo: current.memo ?? result.order.memo,
              payeeHandle: current.payeeHandle ?? result.order.payeeHandle,
              payeeBusiness: current.payeeHandle ? current.payeeBusiness : result.order.payeeBusiness,
              recipientId: current.recipientId ?? result.order.recipientId,
              fees: current.fees ?? result.order.fees,
              paidClaimedAt: current.paidClaimedAt ?? result.order.paidClaimedAt,
            };
            if (merged.recipientId === undefined) delete merged.recipientId;
            // Background re-reads repeat the same facts; only a real change is saved and rendered.
            if (serializeOrder(merged) !== serializeOrder(current)) saveOrder(merged);
            return;
          }
          deps.storage.save(result.order);
          if (IDLE_STEPS.has(state.step) || (state.step === "error" && !current)) {
            if (state.step === "quoting") runId += 1;
            endCapture();
            set({
              pending: null,
              step: "awaitingPayment",
              order: result.order,
              error: null,
              errorReturnStep: null,
              notice: isExpired(result.order, deps.now())
                ? EXPIRED_ORDER_NOTICE
                : "You have an open order. Pay it or cancel it to start a new one.",
            });
          }
          return;
        }
        case "fulfilled": {
          deps.storage.clear(owner);
          if (sameOrder(result.order) && ((ORDER_STEPS.has(state.step) && state.step !== "fulfilling") || releasePending(state))) {
            endCapture();
            retryAction = null;
            set({
              step: "completed",
              error: null,
              errorReturnStep: null,
              order: result.order,
              payments: [],
              completion: {
                intentHash: result.order.intentHash,
                fulfillTxHash: result.txHash ?? result.order.intentHash,
                usdcReceived: result.usdcReceived ?? result.order.usdcExpected,
                fiatSent: result.order.fiatToSend,
                currency: result.order.currency,
                platform: result.order.platform,
                indexed: true,
              },
            });
          }
          return;
        }
        case "closed": {
          deps.storage.clear(owner);
          if (result.order && sameOrder(result.order) && ORDER_STEPS.has(state.step) && state.step !== "fulfilling") {
            endCapture();
            set({ step: "cancelled", order: result.order, payments: [], notice: "This order was cancelled or expired." });
          }
          return;
        }
        case "none":
          deps.storage.clear(owner);
          return;
      }
    };

    /**
     * Re-reads the owner's order from the chain and applies the result. The
     * visible variant (bind, "Try again") shows the stored order at once and
     * flags `recovering`; the background variant changes nothing on screen
     * unless the chain moved on (released, cancelled or new facts).
     */
    const refresh = async (visible: boolean) => {
      const owner = get().owner;
      if (!owner) return;
      const epoch = ownerEpoch;
      const stored = deps.storage.load(owner);
      // Another tab of this browser may have released or cancelled the order shown here and cleared it
      // from storage: the shown order is still settled from the chain rather than left open on screen.
      const shown = get().order;
      const evaluating =
        stored ??
        (shown?.status === "active" && sameHash(shown.owner, owner) && !dismissedFor(owner).has(shown.intentHash.toLowerCase())
          ? shown
          : null);
      if (visible && stored?.status === "active" && !get().order && IDLE_STEPS.has(get().step)) {
        if (get().step === "quoting") runId += 1;
        set({ step: "awaitingPayment", order: stored, pending: null });
      }
      if (visible) set({ recovering: true });
      try {
        const result = await recoverBuyOrder({
          client: client(),
          owner,
          stored: evaluating,
          now: deps.now(),
          lookupPayee: deps.fetchPayeeHandle,
          dismissed: dismissedFor(owner),
        });
        if (epoch !== ownerEpoch) return;
        applyRecovery(result, owner, stored?.intentHash ?? null);
      } catch {
        // Recovery is best effort; the stored order (if any) is already shown.
      } finally {
        if (visible && epoch === ownerEpoch) set({ recovering: false });
      }
    };

    /**
     * One background re-read, only while an order is open on screen and no
     * transaction or visible check is running. It does run during an
     * extension capture: a release meanwhile must end the capture rather
     * than lead to a fulfil that can only revert.
     */
    const pollOrder = async () => {
      const state = get();
      const { owner, step, recovering } = state;
      if (!owner || polling || recovering || txBlocked() || !(ORDER_STEPS.has(step) || releasePending(state))) return;
      polling = true;
      try {
        await refresh(false);
      } finally {
        polling = false;
      }
    };

    const stopPoll = () => {
      const stop = stopPolling;
      stopPolling = null;
      stop?.();
    };

    const startPoll = () => {
      stopPoll();
      const tick = () => void pollOrder();
      const stopTimer = deps.every(deps.pollIntervalMs, tick);
      const stopFocus = deps.onFocus(tick);
      stopPolling = () => {
        stopTimer();
        stopFocus();
      };
    };

    const switchOwner = (owner: Address | null) => {
      const { request, step } = get();
      endCapture();
      stopPoll();
      runId += 1;
      ownerEpoch += 1;
      retryAction = null;
      requoteAfterRecovery = owner && request && (step === "quoted" || step === "confirming") ? request : null;
      set({ ...initialState(), owner, request });
      if (owner) {
        startPoll();
        void get().recover();
      }
    };

    /**
     * Adopts the owner's open order instead of signalling a second one.
     * True when it did, or when the wallet session changed meanwhile (either
     * way, nothing more may be signalled).
     */
    const adoptExisting = async (owner: Address, epoch: number, reader: Zkp2pClient): Promise<boolean> => {
      const stored = deps.storage.load(owner);
      let result: RecoveryResult;
      try {
        result = await recoverBuyOrder({
          client: reader,
          owner,
          stored,
          now: deps.now(),
          lookupPayee: deps.fetchPayeeHandle,
          dismissed: dismissedFor(owner),
        });
      } catch {
        return epoch !== ownerEpoch;
      }
      if (result.kind === "active") {
        // An expired order still locked in escrow is shown too: the player may have paid it in
        // time, so only verifying it or dismissing it (dismissOrder) lets a new order through.
        deps.storage.save(result.order);
        if (epoch === ownerEpoch) {
          set({
            step: "awaitingPayment",
            order: result.order,
            pending: null,
            error: null,
            selectedQuote: null,
            notice: isExpired(result.order, deps.now()) ? EXPIRED_ORDER_NOTICE : "You already had an open order, so here it is.",
          });
        }
        return true;
      }
      // An order of ours already released or cancelled no longer stands in the way.
      if (result.kind !== "none" && stored) forgetStored(owner, stored.intentHash);
      return epoch !== ownerEpoch;
    };

    const orderFromSignal = (quote: BuyQuote, owner: Address, signal: SignalResult, recipientId: string | null): BuyOrder => {
      const platform = BUY_PLATFORMS[quote.platform];
      const toSend = fiatToSend(signal.amount, signal.rate, quote.currency);
      // A waived RampRidge fee (see signalBuyIntent) stays with the buyer.
      const quotedFees = signal.referrerFeeWaived ? withoutReferrerFee(quote.fees) : quote.fees;
      const quotedNet = signal.referrerFeeWaived ? quote.usdcAmount + quote.fees.referrer : quote.usdcAmount;
      const usdcExpected =
        signal.amount === quote.signalAmount ? quotedNet : (quotedNet * signal.amount) / quote.signalAmount;
      return {
        owner,
        intentHash: signal.intentHash,
        depositId: quote.depositId,
        escrow: quote.escrow,
        orchestrator: signal.orchestrator,
        platform: quote.platform,
        currency: quote.currency,
        usdcGross: signal.amount,
        usdcExpected,
        rate: signal.rate,
        fiatToSend: toSend,
        fiatToSendText: fiatToSendText(toSend, quote.currency),
        payeeHandle: quote.payeeHandle,
        ...(recipientId ? { recipientId } : {}),
        payeeDetailsHash: quote.payeeDetailsHash,
        signalTxHash: signal.txHash,
        signaledAt: signal.signaledAt,
        expiresAt: signal.expiresAt,
        verifyMethodId: platform.methodChoice === "beforeVerify" ? (platform.verifyMethods[0]?.id ?? null) : null,
        memo: pickMemo(quote.platform, deps.random),
        status: "active",
        fees: feesFor(quotedFees, signal.amount, quote.signalAmount),
        paidClaimedAt: null,
      };
    };

    /**
     * Persists a signalled intent and shows it. The intent exists on-chain,
     * so it is stored whatever happened to the session meanwhile.
     */
    const landSignal = (
      quote: BuyQuote,
      owner: Address,
      signal: SignalResult,
      epoch: number,
      notice: string | null = null,
      recipientId: string | null = null,
    ): BuyOrder | null => {
      const order = orderFromSignal(quote, owner, signal, recipientId);
      deps.storage.save(order);
      deps.track("signal_ok");
      if (epoch !== ownerEpoch) return null;
      set({
        step: "awaitingPayment",
        pending: null,
        order,
        quotes: [],
        nearby: { below: [], above: [] },
        selectedQuote: null,
        error: null,
        errorReturnStep: null,
        notice,
      });
      return order;
    };

    /**
     * Replaces the quoted payee handle with the one Curator registered for the
     * intent's payee, and fills in the payment-link account id (Alipay PID)
     * when the order has none yet. A lookup without one never erases it.
     */
    const refreshPayee = async (order: BuyOrder, epoch: number) => {
      const verified = asPayeeRecord(await deps.fetchPayeeHandle(order.platform, order.payeeDetailsHash));
      if (epoch !== ownerEpoch || !verified) return;
      const latest = get().order;
      if (latest?.status !== "active" || !sameHash(latest.intentHash, order.intentHash)) return;
      const recipientId = recipientIdFor(latest.platform, verified.recipientId) ?? latest.recipientId ?? null;
      if (
        latest.payeeHandle !== verified.handle ||
        Boolean(latest.payeeBusiness) !== verified.business ||
        (latest.recipientId ?? null) !== recipientId
      ) {
        const { payeeBusiness: _stale, recipientId: _staleId, ...rest } = latest;
        saveOrder({
          ...rest,
          payeeHandle: verified.handle,
          ...(verified.business ? { payeeBusiness: true } : {}),
          ...(recipientId ? { recipientId } : {}),
        });
      }
    };

    /**
     * The account id a platform's payment link needs (Alipay: the seller's
     * 16-digit PID in Curator's maker metadata), looked up before signalling.
     * Null means the buyer could not pay this seller, so nothing may be signalled.
     */
    const lookupRecipientId = async (quote: BuyQuote): Promise<string | null> => {
      try {
        return recipientIdFor(quote.platform, asPayeeRecord(await deps.fetchPayeeHandle(quote.platform, quote.payeeDetailsHash))?.recipientId);
      } catch {
        return null;
      }
    };

    const reconcile = async (unresolved: UnresolvedSignal, timeoutMs: number): Promise<SignalReconciliation> => {
      try {
        return await reconcileSignal(
          deps.getClient(unresolved.sender),
          unresolved.sender.address,
          unresolved.quote,
          unresolved.sent,
          { timeoutMs, sleep: deps.sleep, now: deps.now },
        );
      } catch {
        return { kind: "unknown" };
      }
    };

    /**
     * Settles a signal whose transaction may have landed, from the chain.
     * It never resends: only a reverted transaction lets the same quote be
     * confirmed again, a lapsed one (its signature expired with no intent on
     * the orchestrator) needs fresh prices, and an unresolved one is
     * re-checked before any later signal from this wallet.
     */
    const settleSentSignal = async (unresolved: UnresolvedSignal): Promise<BuyOrder | null> => {
      unresolvedSignal = unresolved;
      if (unresolved.epoch === ownerEpoch) {
        set({
          step: "signaling",
          pending: "signal",
          selectedQuote: null,
          error: null,
          errorReturnStep: null,
          notice: "Your wallet didn't confirm the order. Checking the chain for it.",
        });
      }
      const outcome = await reconcile(unresolved, deps.signalReconcileMs);
      if (outcome.kind !== "unknown" && unresolvedSignal === unresolved) unresolvedSignal = null;
      if (outcome.kind === "found") {
        return landSignal(unresolved.quote, unresolved.owner, outcome.signal, unresolved.epoch);
      }
      // A send the chain settled without an intent failed; one still unknown is counted once it settles.
      if (outcome.kind === "reverted" || outcome.kind === "lapsed") deps.track("signal_fail");
      if (unresolved.epoch !== ownerEpoch) return null;
      if (outcome.kind === "reverted") {
        set({ selectedQuote: unresolved.quote, notice: null });
        failWith(
          own("tx_failed", "The transaction failed on-chain, so no order was placed. Try again."),
          "confirming",
          () => get().confirm(),
        );
        return null;
      }
      if (outcome.kind === "lapsed") {
        const { request } = get();
        set({ quotes: [], nearby: { below: [], above: [] }, quotesExpireAt: null, notice: null });
        failWith(
          own("signature_expired", "Your order didn't go through, so nothing was reserved. Get a fresh quote."),
          "idle",
          request ? () => get().requestQuotes(request) : null,
        );
        return null;
      }
      // Still unknown: drop the quotes so the same offer cannot simply be confirmed again.
      set({ quotes: [], nearby: { below: [], above: [] }, quotesExpireAt: null, notice: null });
      failWith(
        own(
          "tx_pending",
          "We couldn't confirm whether your order went through. Check again in a minute before starting a new one.",
        ),
        "idle",
        () => recheckSignal(unresolved),
      );
      return null;
    };

    const recheckSignal = async (unresolved: UnresolvedSignal) => {
      if (unresolved.epoch !== ownerEpoch || unresolvedSignal !== unresolved) return;
      const landed = await exclusive("signal", () => settleSentSignal(unresolved));
      if (landed) await refreshPayee(landed, unresolved.epoch);
    };

    /** Signals a quote, or adopts the open order that makes signalling unnecessary. Returns the order now shown. */
    const signalQuote = async (
      quote: BuyQuote,
      current: TxSender,
      owner: Address,
      epoch: number,
      requote: () => Promise<void>,
    ): Promise<BuyOrder | null> => {
      runId += 1;
      set({ step: "signaling", pending: "signal", error: null, notice: null });
      const reader = deps.getClient(current);

      // An earlier send that never resolved may have landed since: settle it before signalling again.
      // Until the chain proves it found, reverted or lapsed it stays unresolved and blocks a second
      // intent, which could otherwise lock a seller's USDC in an order the player never sees.
      const earlier = unresolvedSignal;
      if (earlier && earlier.owner === owner) {
        const outcome = await reconcile(earlier, 0);
        if (outcome.kind !== "unknown" && unresolvedSignal === earlier) unresolvedSignal = null;
        if (outcome.kind === "found") {
          return landSignal(earlier.quote, owner, outcome.signal, epoch, "Your earlier order went through, so here it is.");
        }
        if (outcome.kind === "unknown") {
          if (epoch !== ownerEpoch) return null;
          failWith(
            own(
              "tx_pending",
              "We still can't tell whether your earlier order went through. Check again in a minute before placing a new one.",
            ),
            "confirming",
            () => get().confirm(),
          );
          return null;
        }
      }
      if (epoch !== ownerEpoch || (await adoptExisting(owner, epoch, reader))) return null;

      // Fail closed: an Alipay seller without a PID has no payable QR, so the order is never placed.
      let recipientId: string | null = null;
      if (needsRecipientId(quote.platform)) {
        recipientId = await lookupRecipientId(quote);
        if (epoch !== ownerEpoch) return null;
        if (!recipientId) {
          const name = BUY_PLATFORMS[quote.platform].name;
          const quotes = get().quotes.filter((q) => q.id !== quote.id);
          set({ quotes, selectedQuote: null });
          failWith(
            own("payment_method_unavailable", `This ${name} seller's payment QR isn't available, so no order was placed. Pick another seller.`),
            quotes.length > 0 ? "quoted" : "idle",
            requote,
          );
          return null;
        }
      }

      const sentAt = deps.now();
      let signal: SignalResult;
      try {
        signal = await signalBuyIntent(reader, current, quote);
      } catch (error) {
        const detail = report("signal", error);
        if (error instanceof SignalSentError) {
          return settleSentSignal({
            owner,
            quote,
            sender: current,
            sent: {
              txHash: error.txHash,
              orchestrator: error.orchestrator,
              sentAt,
              signatureExpiresAt: error.signatureExpiresAt,
              referrerFeeWaived: error.referrerFeeWaived,
            },
            epoch,
          });
        }
        // Nothing reached the chain, so the same quote can be retried at once, with no chain wait.
        const mapped = { ...toBuyError(error, { stage: "signal", platform: quote.platform }), detail };
        if (mapped.code !== "user_rejected") deps.track("signal_fail");
        if (mapped.code === "active_intent" && (await adoptExisting(owner, epoch, reader))) return null;
        if (epoch !== ownerEpoch) return null;
        if (mapped.code === "active_intent") {
          const blocker = blockingIntentFromError(error);
          if (blocker) set({ blockingIntent: blocker });
          failWith(
            blocker ? own("active_intent", "An older open order is blocking this one. Cancel it, then try again.") : mapped,
            "confirming",
            null,
          );
          return null;
        }
        if (REQUOTE_CODES.has(mapped.code)) {
          // Like Peer's failedQuoteKeys: never show the offer that just failed again.
          const quotes = get().quotes.filter((q) => q.id !== quote.id);
          set({ quotes, selectedQuote: null });
          failWith(mapped, quotes.length > 0 ? "quoted" : "idle", requote);
          return null;
        }
        failWith(mapped, "confirming", () => get().confirm());
        return null;
      }
      return landSignal(quote, owner, signal, epoch, null, recipientId);
    };

    const handleCapture = (run: number, order: BuyOrder, message: PeerMetadataMessage) => {
      if (run !== runId || get().order?.intentHash !== order.intentHash) return;
      const method = resolveVerifyMethod(order.platform, order.verifyMethodId);
      // UPI is read from the Amazon Pay account the buyer paid from, so name that, as Peer's web app does.
      const name = order.platform === "upi" ? (method?.label ?? BUY_PLATFORMS.upi.name) : BUY_PLATFORMS[order.platform].name;
      const retry = () => get().startVerification();
      if (message.errorMessage || !message.buyerTeeCapture?.encryptedSessionMaterial) {
        // The listener stays armed (retry, back, cancel and owner switches all end it), so a capture
        // from the live provider tab can still replace an error posted by an abandoned one.
        deps.warn("[buy] capture failed", message.errorMessage ?? "no buyerTeeCapture in the metadata message");
        failWith(
          {
            ...own("capture_failed", captureFailureText(message.errorMessage, name)),
            ...(message.errorMessage ? { detail: message.errorMessage } : {}),
          },
          "awaitingPayment",
          retry,
        );
        return;
      }
      stopCapture = null;
      retryAction = null;
      const rows = selectableRows(message, order.platform, method);
      if (rows.length === 0) {
        // The player has said they paid (paidClaimedAt), so never tell them to send money here: a payment
        // still pending (Revolut lists only completed ones), older than the captured slice, or made from
        // another account is still a real payment. Peer's web app shows "No send payments found" and a
        // recent-payments notice, never a prompt to pay.
        const listed = order.platform === "revolut" ? `completed ${name} payments` : `sent ${name} payments`;
        const text = isExpired(order, deps.now())
          ? "No payment for this offer was found yet. If you paid before it expired, wait a minute, then check again."
          : `No ${listed} found yet. Only recent payments from the ${name} account you logged in to are read. If you already paid, don't pay again: wait a few minutes, then check again.`;
        failWith(own("no_payments", text), "awaitingPayment", retry);
        return;
      }
      capture = message;
      set({
        step: "selectPayment",
        verifying: null,
        payments: rows,
        captureExpiresAt: Number.isFinite(message.expiresAt) ? message.expiresAt : null,
        pending: null,
        error: null,
        errorReturnStep: null,
      });
    };

    const complete = async (order: BuyOrder, txHash: Hex, released: bigint | null, epoch: number, paidFiat: bigint | null) => {
      deps.track("fulfil_ok");
      forgetStored(order.owner, order.intentHash);
      if (epoch !== ownerEpoch) return;
      set({ order: { ...order, status: "fulfilled" } });
      // The receipt's IntentFulfilled is the exact net released (as Peer's web app uses it); the indexer
      // only stands in when it is missing, so a lagging indexer never holds the success screen.
      const indexed =
        released !== null
          ? null
          : await waitForIndexedFulfillment(client(), order.intentHash, {
              timeoutMs: deps.indexerTimeoutMs,
              sleep: deps.sleep,
              now: deps.now,
            });
      if (epoch !== ownerEpoch) return;
      const net = indexed?.takerAmountNetFees;
      const indexedNet = net && /^\d+$/.test(net) ? BigInt(net) : null;
      set({
        step: "completed",
        pending: null,
        payments: [],
        captureExpiresAt: null,
        completion: {
          intentHash: order.intentHash,
          fulfillTxHash: txHash,
          usdcReceived: released ?? indexedNet ?? order.usdcExpected,
          fiatSent: paidFiat ?? order.fiatToSend,
          currency: order.currency,
          platform: order.platform,
          indexed: indexed !== null,
        },
      });
    };

    const fulfilOrder = async (
      order: BuyOrder,
      current: TxSender,
      proof: BuyerTeePaymentProofInput,
      index: number,
      epoch: number,
      paidFiat: bigint | null,
    ) => {
      runId += 1;
      set({ step: "fulfilling", pending: "fulfill", error: null });
      const toList = () => get().startVerification();
      let result: FulfillResult;
      try {
        result = await fulfillBuyIntent(deps.getClient(current), current, order.intentHash, order.orchestrator, proof);
      } catch (error) {
        const ctx: ErrorContext = { stage: "fulfill", platform: order.platform, payee: payeeFor(order) };
        const mapped = { ...toBuyError(error, ctx), detail: report("fulfill", error) };
        if (["tx_pending", "unknown", "network", "intent_closed", "tx_failed"].includes(mapped.code)) {
          // The release may have landed despite the error: settle from the chain before blaming the player.
          try {
            const settled = await recoverBuyOrder({
              client: deps.getClient(current),
              owner: order.owner,
              stored: order,
              now: deps.now(),
              lookupPayee: deps.fetchPayeeHandle,
            });
            if (settled.kind === "fulfilled") {
              deps.track("fulfil_ok");
              forgetStored(order.owner, order.intentHash);
              if (epoch !== ownerEpoch) return;
              endCapture();
              set({
                step: "completed",
                pending: null,
                payments: [],
                captureExpiresAt: null,
                order: settled.order,
                completion: {
                  intentHash: order.intentHash,
                  fulfillTxHash: settled.txHash ?? order.intentHash,
                  usdcReceived: settled.usdcReceived ?? order.usdcExpected,
                  fiatSent: paidFiat ?? order.fiatToSend,
                  currency: order.currency,
                  platform: order.platform,
                  indexed: true,
                },
              });
              return;
            }
          } catch {
            // Fall through to the mapped error.
          }
        }
        if (mapped.code !== "user_rejected") deps.track("fulfil_fail");
        if (epoch !== ownerEpoch) return;
        if (mapped.code === "tx_pending") {
          // The release was sent and may still land: never re-prove or resend it from here. "Check again"
          // and the background poll re-read the chain; Back still allows a fresh verify for a release
          // that was really dropped.
          endCapture();
          const notice: BuyError = {
            ...mapped,
            message:
              "Your USDC release was sent and is still confirming. This updates by itself once Base confirms it. If nothing changes in a few minutes, go back and verify your payment again.",
          };
          const recheck = async (): Promise<void> => {
            await get().recover();
            const now = get();
            if (epoch === ownerEpoch && now.step === "awaitingPayment" && now.order?.status === "active" && sameHash(now.order.intentHash, order.intentHash)) {
              failWith(notice, "awaitingPayment", recheck);
            }
          };
          failWith(notice, "awaitingPayment", recheck);
          return;
        }
        const captureLive =
          capture !== null && (get().captureExpiresAt === null || deps.now() < (get().captureExpiresAt ?? 0) - CAPTURE_SAFETY_MS);
        if (mapped.code === "payment_session_expired") {
          // The attestation service refused the captured session itself (the platform rejected it, or it was
          // sealed to an enclave key Peer has since rotated): replaying it fails the same way, so recapture.
          endCapture();
          failWith(mapped, "awaitingPayment", toList);
        } else if (PICK_AGAIN_CODES.has(mapped.code) && captureLive) {
          failWith(mapped, "selectPayment", null);
        } else if (mapped.code === "intent_expired" || mapped.code === "intent_closed") {
          failWith(mapped, "awaitingPayment", null);
        } else if (captureLive) {
          failWith(mapped, "selectPayment", () => get().choosePayment(index));
        } else {
          endCapture();
          failWith(mapped, "awaitingPayment", toList);
        }
        return;
      }
      await complete(order, result.txHash, result.released, epoch, paidFiat);
    };

    const cancelTarget = async (
      target: Hex,
      order: BuyOrder | null,
      current: TxSender,
      settledStep: BuyStep,
      epoch: number,
    ) => {
      endCapture();
      runId += 1;
      set({ step: settledStep, verifying: null, payments: [], pending: "cancel", error: null });
      try {
        await cancelBuyIntent(deps.getClient(current), current, target, order?.orchestrator ?? null);
      } catch (error) {
        const mapped = {
          ...toBuyError(error, { stage: "cancel", ...(order ? { platform: order.platform } : {}) }),
          detail: report("cancel", error),
        };
        if (epoch !== ownerEpoch) return;
        if (mapped.code === "intent_closed" && order) {
          // Already gone on-chain: find out whether it was released or expired.
          set({ pending: null });
          await get().recover();
          return;
        }
        failWith(mapped, settledStep, () => get().cancelOrder());
        return;
      }
      forgetStored(lower(current.address), target);
      if (epoch !== ownerEpoch) return;
      set({
        step: "cancelled",
        order: order ? { ...order, status: "cancelled" } : null,
        blockingIntent: null,
        pending: null,
        notice: null,
      });
    };

    return {
      ...initialState(),

      bindSender(next) {
        sender = next;
        const owner = next ? lower(next.address) : null;
        if (owner === get().owner) return;
        switchOwner(owner);
      },

      watchOwner(address) {
        if (sender) return;
        const owner = address ? lower(address) : null;
        if (owner === get().owner) return;
        switchOwner(owner);
      },

      async recover() {
        const owner = get().owner;
        if (!owner) return;
        const epoch = ownerEpoch;
        await refresh(true);
        // A later wallet session owns its own re-quote.
        if (epoch !== ownerEpoch) return;
        const requote = requoteAfterRecovery;
        requoteAfterRecovery = null;
        if (requote && get().step === "idle" && !get().order) {
          await get().requestQuotes(requote);
        }
      },

      async requestQuotes(input: QuoteInput) {
        if (txBlocked()) return;
        const { order } = get();
        if (order?.status === "active") {
          // An expired order can still be fulfilled, so it is never dropped silently: the player
          // verifies it (they may have paid in time) or dismisses it with dismissOrder().
          failWith(
            isExpired(order, deps.now())
              ? own("active_intent", "Verify or dismiss your expired order first.")
              : own("active_intent", "Finish or cancel your open order first."),
            "awaitingPayment",
            null,
          );
          return;
        }
        endCapture();
        const run = ++runId;
        retryAction = null;
        set({
          step: "quoting",
          pending: "quote",
          request: input,
          quotes: [],
          nearby: { below: [], above: [] },
          selectedQuote: null,
          error: null,
          errorReturnStep: null,
          notice: null,
          completion: null,
          order: null,
        });
        try {
          const result = await deps.quotes({
            fiatAmount: input.fiatAmount,
            currency: input.currency,
            ...(input.platforms ? { platforms: input.platforms } : {}),
            recipient: sender?.address ?? null,
            client: client(),
          });
          if (run !== runId) return;
          set({
            step: "quoted",
            pending: null,
            quotes: result.quotes,
            nearby: result.nearby,
            quotesExpireAt: result.expiresAt,
          });
          deps.track("quote");
        } catch (error) {
          if (run !== runId) return;
          fail(error, { stage: "quote" }, "idle", () => get().requestQuotes(input));
        }
      },

      selectQuote(quoteId) {
        const state = get();
        if (state.step !== "quoted" && state.step !== "confirming") return;
        const candidates = [
          ...state.quotes,
          ...state.nearby.below.map((n) => n.quote),
          ...state.nearby.above.map((n) => n.quote),
        ];
        const quote = candidates.find((q) => q.id === quoteId);
        if (!quote) return;
        set({ step: "confirming", selectedQuote: quote, error: null });
      },

      async requoteAt(fiatAmount) {
        const { request } = get();
        if (!request) return;
        await get().requestQuotes({
          ...request,
          fiatAmount: formatDecimal(fiatAmount, FIAT_DECIMALS, { group: false }),
        });
      },

      async confirm() {
        const state = get();
        const quote = state.selectedQuote;
        if (state.step !== "confirming" || !quote || busy()) return;
        const requote = () => (state.request ? get().requestQuotes(state.request) : Promise.resolve());
        const current = sender;
        if (!current) {
          failWith(own("not_connected", "Log in to buy."), "confirming", null);
          return;
        }
        if (deps.now() >= quote.expiresAt) {
          failWith(own("quote_expired", "This price has expired. Get fresh prices."), "quoted", requote);
          return;
        }
        const platform = BUY_PLATFORMS[quote.platform];
        if (!platform.live) {
          failWith(own("payment_method_unavailable", `${platform.name} isn't available right now.`), "quoted", requote);
          return;
        }
        const minFiat = tryParseAmount(platform.minFiat, FIAT_DECIMALS) ?? 0n;
        if (quote.fiatAmount < minFiat) {
          failWith(own("amount_too_low", `The smallest ${platform.name} order is ${platform.minFiat} ${quote.currency}.`), "quoted", null);
          return;
        }
        if (platform.maxUsdc !== null && quote.signalAmount > parseUsdc(platform.maxUsdc)) {
          failWith(own("amount_too_high", `${platform.name} orders are capped at ${platform.maxUsdc} USDC.`), "quoted", null);
          return;
        }
        const owner = lower(current.address);
        const epoch = ownerEpoch;
        const landed = await exclusive("signal", () => signalQuote(quote, current, owner, epoch, requote));
        if (landed) await refreshPayee(landed, epoch);
      },

      setVerifyMethod(methodId) {
        if (txBlocked()) return;
        const { order, step } = get();
        if (!order || order.status !== "active") return;
        if (!BUY_PLATFORMS[order.platform].verifyMethods.some((m) => m.id === methodId)) return;
        if (order.verifyMethodId === methodId) return;
        if (step === "verifying" || step === "selectPayment") {
          endCapture();
          runId += 1;
          set({ step: "awaitingPayment", verifying: null, payments: [], captureExpiresAt: null, pending: null });
        }
        saveOrder({ ...order, verifyMethodId: methodId });
      },

      async markPaid() {
        const { order, step } = get();
        if (!order || order.status !== "active" || step !== "awaitingPayment") return;
        await get().startVerification();
      },

      async startVerification() {
        const current = get().order;
        if (!current || current.status !== "active" || txBlocked()) return;
        // Counted once per order: "Check again" and retries start verification again.
        const key = current.intentHash.toLowerCase();
        if (!verifyCounted.has(key)) {
          verifyCounted.add(key);
          deps.track("verify_start");
        }
        // The player says they paid: remember it with the order, so a reload never shows
        // "send exactly" again for an order that may already be paid.
        let order = current;
        if (order.paidClaimedAt === null) {
          order = { ...order, paidClaimedAt: deps.now() };
          saveOrder(order);
        }
        // Expiry is not checked: an unpruned expired intent can still be fulfilled, and a player who
        // paid in time must be able to prove it. The UI warns against paying an expired order.
        const method = resolveVerifyMethod(order.platform, order.verifyMethodId);
        if (!method) {
          failWith(own("method_required", "Pick the bank you paid from first."), "awaitingPayment", null);
          return;
        }
        endCapture();
        const run = ++runId;
        set({
          step: "verifying",
          verifying: "checking",
          pending: "capture",
          error: null,
          errorReturnStep: null,
          payments: [],
          captureExpiresAt: null,
        });
        let status;
        try {
          status = await getExtensionStatus(deps.extension, { canInstall: deps.canInstallExtension(), platform: order.platform });
        } catch (error) {
          if (run !== runId) return;
          fail(error, { stage: "verify", platform: order.platform }, "awaitingPayment", () => get().startVerification());
          return;
        }
        if (run !== runId) return;
        noteExtension(status);
        if (status === "needs_install") {
          set({ verifying: "needsInstall", pending: null });
          return;
        }
        if (status === "unsupported_browser") {
          set({ verifying: "unsupportedBrowser", pending: null });
          return;
        }
        if (status === "needs_update") {
          set({ verifying: "needsUpdate", pending: null });
          return;
        }
        if (status === "needs_connection") {
          set({ verifying: "needsConnection", pending: null });
          return;
        }
        // Set before subscribing: the extension may answer synchronously.
        set({ verifying: "capturing", pending: "capture" });
        try {
          const stop = startBuyerCapture({
            method,
            sdk: deps.extension,
            onMessage: (message) => handleCapture(run, order, message),
          });
          if (run === runId && get().step === "verifying") stopCapture = stop;
          else if (get().step !== "selectPayment" || run !== runId) stop();
        } catch (error) {
          stopCapture = null;
          failWith(
            {
              ...own("extension_unavailable", "The Peer extension didn't respond. Update or reload it, then try again."),
              detail: error instanceof Error ? error.message : String(error),
            },
            "awaitingPayment",
            () => get().startVerification(),
          );
        }
      },

      async connectExtension() {
        if (get().step !== "verifying" || txBlocked()) return;
        const epoch = ownerEpoch;
        set({ pending: "connect" });
        const approved = await requestExtensionConnection(deps.extension);
        if (epoch !== ownerEpoch || get().step !== "verifying") return;
        if (approved) {
          await get().startVerification();
          return;
        }
        set({
          pending: null,
          verifying: "needsConnection",
          notice: "Approve RampRidge in the Peer extension to continue.",
        });
      },

      openExtensionInstall() {
        try {
          deps.openInstallPage();
        } catch {
          // No window (tests, SSR): nothing to open.
        }
        // As Peer web's InstallExtension after "Add to Chrome": look at once and keep looking (the open
        // screen's look-out) until it appears; a fresh install injects itself into this tab. An update is
        // not re-injected (the page needs a reload), so there is no install to wait for then.
        const { step, verifying, extension } = get();
        if ((step === "verifying" && verifying === "needsInstall") || extension === "needs_install") {
          if (!get().awaitingInstall) set({ awaitingInstall: true });
          void readExtension();
        }
      },

      checkExtension() {
        return readExtension();
      },

      watchExtension() {
        extensionWatchers += 1;
        syncExtensionPoll();
        void readExtension();
        let watching = true;
        return () => {
          if (!watching) return;
          watching = false;
          extensionWatchers -= 1;
          syncExtensionPoll();
        };
      },

      async choosePayment(index) {
        const state = get();
        const order = state.order;
        if (state.step !== "selectPayment" || !order || !capture || busy()) return;
        const row = state.payments.find((p) => p.index === index);
        const toList = () => get().startVerification();
        if (!row) {
          failWith(own("no_payments", "That payment is no longer listed. Check again."), "awaitingPayment", toList);
          return;
        }
        const now = deps.now();
        if (state.captureExpiresAt !== null && now >= state.captureExpiresAt - CAPTURE_SAFETY_MS) {
          endCapture();
          failWith(own("payment_session_expired", "Your payment list timed out. Check your payments again."), "awaitingPayment", toList);
          return;
        }
        const current = sender;
        if (!current) {
          failWith(own("not_connected", "Log in with the wallet that placed this order."), "selectPayment", null);
          return;
        }
        let proof: BuyerTeePaymentProofInput;
        try {
          proof = buildBuyerTeeProof(capture, order.platform, row.row, resolveVerifyMethod(order.platform, order.verifyMethodId));
        } catch (error) {
          fail(error, { stage: "verify", platform: order.platform }, "awaitingPayment", toList);
          return;
        }
        const epoch = ownerEpoch;
        // What the player actually sent, as the platform reported it (a short payment releases less USDC).
        const sameCurrency = row.currency === null || row.currency.toUpperCase() === order.currency;
        const paidFiat = sameCurrency && row.amount ? tryParseAmount(row.amount.replace(/,/g, ""), FIAT_DECIMALS) : null;
        await exclusive("fulfill", () => fulfilOrder(order, current, proof, index, epoch, paidFiat));
      },

      async cancelOrder() {
        const state = get();
        const order = state.order?.status === "active" ? state.order : null;
        const target = order?.intentHash ?? state.blockingIntent;
        if (!target || txBlocked()) return;
        const current = sender;
        const returnTo: BuyStep = state.step === "error" ? (state.errorReturnStep ?? "idle") : state.step;
        if (!current) {
          failWith(own("not_connected", "Log in with the wallet that placed this order."), returnTo, null);
          return;
        }
        const settledStep: BuyStep = order ? "awaitingPayment" : "idle";
        const epoch = ownerEpoch;
        await exclusive("cancel", () => cancelTarget(target, order, current, settledStep, epoch));
      },

      async retry() {
        const action = retryAction;
        retryAction = null;
        if (!action) return;
        const { step, errorReturnStep } = get();
        if (step === "error") set({ step: errorReturnStep ?? "idle", error: null, errorReturnStep: null });
        await action();
      },

      back() {
        const state = get();
        switch (state.step) {
          case "error": {
            let target = state.errorReturnStep ?? "idle";
            if (target === "selectPayment" && (!capture || state.payments.length === 0)) target = "awaitingPayment";
            if (target === "verifying") target = "awaitingPayment";
            if (ORDER_STEPS.has(target) && state.order?.status !== "active") target = "idle";
            if (target === "confirming" && !state.selectedQuote) target = state.quotes.length > 0 ? "quoted" : "idle";
            if (target === "awaitingPayment") endCapture();
            retryAction = null;
            set({ step: target, error: null, errorReturnStep: null, pending: null });
            return;
          }
          case "confirming":
            set({ step: "quoted", selectedQuote: null });
            return;
          case "quoted":
            set({ step: "idle", quotes: [], nearby: { below: [], above: [] }, quotesExpireAt: null });
            return;
          case "verifying":
          case "selectPayment":
            endCapture();
            runId += 1;
            set({ step: "awaitingPayment", verifying: null, payments: [], captureExpiresAt: null, pending: null });
            return;
          default:
            return;
        }
      },

      dismissNotice() {
        set({ notice: null });
      },

      dismissOrder() {
        const state = get();
        const order = state.order;
        if (!order || state.pending !== null || busy()) return;
        if (order.status === "active" && !isExpired(order, deps.now())) return;
        if (order.status === "active") {
          // Recovery would otherwise adopt it again from the chain while its USDC stays locked.
          dismissedHere.add(order.intentHash.toLowerCase());
          deps.storage.dismiss(order.owner, order.intentHash);
          forgetStored(order.owner, order.intentHash);
        }
        endCapture();
        runId += 1;
        retryAction = null;
        set({ ...initialState(), owner: state.owner, request: state.request, blockingIntent: state.blockingIntent });
      },

      reset() {
        const state = get();
        if (txBlocked()) return;
        endCapture();
        runId += 1;
        retryAction = null;
        const base = { ...initialState(), owner: state.owner, blockingIntent: state.blockingIntent, recovering: state.recovering };
        if (state.order?.status === "active") {
          // Same order, same browser: what is known about the extension, and any install watch, still hold.
          set({ ...base, step: "awaitingPayment", order: state.order, extension: state.extension, awaitingInstall: state.awaitingInstall });
        } else {
          set(base);
        }
      },
    };
  });
}
