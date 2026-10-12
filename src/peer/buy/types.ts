import type { Address, Hex } from "viem";
import type { TxSender } from "@/wallet/types";
import type { ExtensionStatus, PaymentRow } from "../extension";
import type { BuyQuote, BuyQuoteFees, NearbyBuyQuote } from "../market";
import type { BuyPlatformId, FiatCode } from "../platforms";

export type BuyStep =
  | "idle"
  | "quoting"
  | "quoted"
  | "confirming"
  | "signaling"
  | "awaitingPayment"
  | "verifying"
  | "selectPayment"
  | "fulfilling"
  | "completed"
  | "cancelled"
  | "error";

/** Where verification is while `step === "verifying"`. */
export type VerifyingState =
  | "checking"
  | "needsInstall"
  | "needsConnection"
  | "needsUpdate"
  | "unsupportedBrowser"
  | "capturing";

export type OrderStatus = "active" | "fulfilled" | "cancelled";

/**
 * A signalled buy order. Persisted per wallet so a refresh never loses it.
 * Amounts are base units: USDC 6 decimals, fiat 6 decimals, rate 18.
 */
export interface BuyOrder {
  owner: Address;
  intentHash: Hex;
  depositId: string;
  escrow: Address;
  /** Orchestrator the intent lives on, from the signal receipt when known. */
  orchestrator: Address | null;
  platform: BuyPlatformId;
  currency: FiatCode;
  /** Gross USDC reserved by the intent. */
  usdcGross: bigint;
  /** USDC the buyer receives after fees. */
  usdcExpected: bigint;
  /** Fiat per USDC the intent was signalled at. */
  rate: bigint;
  /** Exact fiat to send: intent amount x rate, rounded up to the currency's cents. */
  fiatToSend: bigint;
  /** fiatToSend as the plain decimal a player types, e.g. "101.50". */
  fiatToSendText: string;
  payeeHandle: string | null;
  /** Curator marks the payee a business profile (Revolut Business: no revolut.me link or QR). */
  payeeBusiness?: boolean;
  /**
   * The seller's account id the payment link needs where it differs from the
   * handle (Alipay: the 16-digit PID from Curator's maker metadata). Kept with
   * the order so a reload or another device still shows the QR.
   */
  recipientId?: string;
  payeeDetailsHash: Hex;
  signalTxHash: Hex | null;
  /** ms since epoch. */
  signaledAt: number;
  /** ms since epoch. */
  expiresAt: number;
  /** Chosen verify method (Zelle bank, PayPal account type); null until chosen where required. */
  verifyMethodId: string | null;
  /** Payment note for platforms that need one (Venmo). */
  memo: string | null;
  status: OrderStatus;
  /**
   * The fees the confirmed quote priced in (USDC base units, scaled to the
   * signalled amount). Null when the order was rebuilt from the chain with no
   * stored copy, since the chain does not record them.
   */
  fees: BuyQuoteFees | null;
  /**
   * When the player first said they paid (ms since epoch): set as soon as
   * verification starts and kept across reloads and chain recovery, so a
   * resumed order never asks for the payment a second time.
   */
  paidClaimedAt: number | null;
}

export type BuyErrorCode =
  | "not_connected"
  | "invalid_amount"
  | "amount_too_low"
  | "amount_too_high"
  | "no_platforms"
  | "quote_expired"
  | "user_rejected"
  | "insufficient_gas"
  | "active_intent"
  | "liquidity"
  | "rate_changed"
  | "signature_expired"
  | "wallet_blocked"
  | "screening_unavailable"
  | "payment_method_unavailable"
  | "intent_expired"
  | "intent_closed"
  | "payee_mismatch"
  | "nullifier_used"
  | "payment_verification_failed"
  /** The on-chain payment verifier refused the proof at the fulfil preflight; nothing was sent. */
  | "proof_rejected"
  | "payment_not_settled"
  | "payment_session_expired"
  | "capture_failed"
  | "no_payments"
  | "extension_unavailable"
  | "method_required"
  | "rate_limited"
  | "network"
  | "wallet"
  | "tx_pending"
  | "tx_failed"
  | "unknown";

export interface BuyError {
  code: BuyErrorCode;
  /** Short plain-English cause and next action, safe to show as-is. */
  message: string;
  /** True when retrying or going back can succeed. */
  recoverable: boolean;
  /** Raw technical detail for logs; never shown to players. */
  detail?: string;
}

export interface NearbyQuotes {
  below: NearbyBuyQuote[];
  above: NearbyBuyQuote[];
}

export interface QuoteInput {
  /** Fiat to pay, decimal string as typed ("250", "99.50"). */
  fiatAmount: string;
  currency: FiatCode;
  /** Restrict to these platforms; omit for all live platforms. */
  platforms?: BuyPlatformId[];
}

export interface BuyCompletion {
  intentHash: Hex;
  fulfillTxHash: Hex;
  /** USDC credited to the buyer, base units (from the IntentFulfilled event when available). */
  usdcReceived: bigint;
  fiatSent: bigint;
  currency: FiatCode;
  platform: BuyPlatformId;
  /** The indexer had confirmed FULFILLED (false when only the receipt confirmed it). */
  indexed: boolean;
}

export type PendingAction = "quote" | "signal" | "connect" | "capture" | "fulfill" | "cancel" | "recover";

export interface BuyFlowState {
  step: BuyStep;
  /** Sub-state while `step === "verifying"`, otherwise null. */
  verifying: VerifyingState | null;
  /** Bound wallet address (lowercase), or null when logged out. */
  owner: Address | null;
  request: QuoteInput | null;
  quotes: BuyQuote[];
  nearby: NearbyQuotes;
  quotesExpireAt: number | null;
  selectedQuote: BuyQuote | null;
  order: BuyOrder | null;
  /** Captured payments to pick from while `step === "selectPayment"`. */
  payments: PaymentRow[];
  /** When the captured payment session expires (ms), while selecting. */
  captureExpiresAt: number | null;
  completion: BuyCompletion | null;
  error: BuyError | null;
  /** Step to return to from `error` via back(). */
  errorReturnStep: BuyStep | null;
  /** Non-error info for the player, e.g. that an open order was resumed. */
  notice: string | null;
  pending: PendingAction | null;
  /** A chain read for the owner's open order is running. */
  recovering: boolean;
  /**
   * An open intent the contract named (AccountHasActiveIntent) as blocking a
   * new order that this app cannot show, e.g. an old order from elsewhere.
   * cancelOrder() cancels it when there is no active order in view.
   */
  blockingIntent: Hex | null;
  /**
   * The Peer extension's status for the open order's platform as last read
   * (null until read): missing, outdated, unconnected, ready, or a browser
   * that can't run it. Kept fresh while a screen watches it
   * (`watchExtension`) and at every verification, so a missing or outdated
   * PeerAuth is flagged while paying.
   */
  extension: ExtensionStatus | null;
  /** The player opened PeerAuth's store page and it hasn't appeared yet ("Waiting for PeerAuth"). */
  awaitingInstall: boolean;
}

export interface BuyFlowActions {
  /** Binds the logged-in wallet (null on logout); recovers any open order for it. */
  bindSender(sender: TxSender | null): void;
  /**
   * Watches an address read-only (no sender yet), recovering its open order.
   * Ignored while a sender for a different address is bound.
   */
  watchOwner(address: Address | null): void;
  requestQuotes(input: QuoteInput): Promise<void>;
  selectQuote(quoteId: string): void;
  /** Re-quote at a nearby fillable amount (6-decimal fiat base units). */
  requoteAt(fiatAmount: bigint): Promise<void>;
  confirm(): Promise<void>;
  setVerifyMethod(methodId: string): void;
  markPaid(): Promise<void>;
  startVerification(): Promise<void>;
  connectExtension(): Promise<void>;
  /**
   * Opens PeerAuth's Chrome Web Store page. While the extension is missing,
   * marks the install as awaited and looks at once; the open screen keeps
   * looking until it appears, and an install prompt on Verify then moves on
   * to connect or capture by itself.
   */
  openExtensionInstall(): void;
  /** Reads the extension's status for the open order once, without changing the visible step. */
  checkExtension(): Promise<void>;
  /**
   * For a screen where the extension matters (Payment scroll, Verify), while
   * it is open: reads the status at once, then, while the extension is
   * missing, too old or unread, every few seconds and on focus until it is
   * usable (Peer web's version poll). Returns the stop for when it closes.
   */
  watchExtension(): () => void;
  choosePayment(index: number): Promise<void>;
  cancelOrder(): Promise<void>;
  recover(): Promise<void>;
  retry(): Promise<void>;
  back(): void;
  dismissNotice(): void;
  /** Forgets an expired (or finished) order locally without an on-chain cancel. No-op for a live order. */
  dismissOrder(): void;
  reset(): void;
}

export type BuyFlowStore = BuyFlowState & BuyFlowActions;
