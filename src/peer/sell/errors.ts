/**
 * One error type for every sell-side failure, with a plain-English message and
 * the single recovery the player should take. The recovery is what keeps
 * money safe: anything that may already be on-chain recovers by reconciling or
 * finishing the existing deposit, never by creating another one.
 */

import { isCashError, isUserRejectedError, type CashErrorCode } from "@zkp2p/cash";
import type { Hex } from "viem";

export type SellLocalErrorCode =
  | "USER_REJECTED"
  | "SUBMISSION_UNKNOWN"
  | "PENDING_SUBMISSION_EXISTS"
  | "INSUFFICIENT_BALANCE"
  | "NO_GAS"
  | "WALLET_REQUIRED"
  | "INVALID_PLAN"
  | "INVALID_AMOUNT"
  | "WALLET_NOT_SENT"
  | "UNKNOWN";

export type SellErrorCode = CashErrorCode | SellLocalErrorCode;

export type SellRecoveryAction =
  /** Nothing reached the chain; the same action can run again. */
  | "retry"
  /** Fix the form (amount, payout method, handle) and resubmit. */
  | "editForm"
  /** A deposit may exist: check the chain before anything else. Never resubmit. */
  | "reconcile"
  /** The deposit exists; attach its remaining buyer restriction. */
  | "retryAccessPolicy"
  | "fundWallet"
  | "addGas"
  | "reconnectWallet"
  /** Wait for a buyer or the network, then try again. */
  | "wait"
  | "none";

export interface SellRecovery {
  action: SellRecoveryAction;
  /** Short button text, e.g. "Check status". */
  label: string;
  /** One sentence on what to do next. */
  hint: string;
  /**
   * Reconcile only: true once the chain shows no deposit and enough time has
   * passed that abandoning the attempt cannot race a late transaction.
   */
  canDiscard?: boolean;
}

export type SellErrorStage = "prepare" | "send" | "finalize" | "policy" | "withdraw" | "topUp" | "read";

export class SellFlowError extends Error {
  readonly code: SellErrorCode;
  readonly retryable: boolean;
  readonly recovery: SellRecovery;
  readonly depositId: string | undefined;
  readonly paymentMethod: Hex | undefined;
  readonly transactionHash: Hex | undefined;

  constructor(init: {
    code: SellErrorCode;
    message: string;
    recovery: SellRecovery;
    retryable?: boolean;
    depositId?: string | undefined;
    paymentMethod?: Hex | undefined;
    transactionHash?: Hex | undefined;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "SellFlowError";
    this.code = init.code;
    this.recovery = init.recovery;
    this.retryable = init.retryable ?? (init.recovery.action === "retry" || init.recovery.action === "wait");
    this.depositId = init.depositId;
    this.paymentMethod = init.paymentMethod;
    this.transactionHash = init.transactionHash;
  }
}

export function isSellFlowError(value: unknown): value is SellFlowError {
  return value instanceof SellFlowError;
}

const RECOVERY: Record<SellRecoveryAction, Omit<SellRecovery, "hint" | "action">> = {
  retry: { label: "Try again" },
  editForm: { label: "Edit order" },
  reconcile: { label: "Check status" },
  retryAccessPolicy: { label: "Finish setup" },
  fundWallet: { label: "Add USDC" },
  addGas: { label: "Add ETH" },
  reconnectWallet: { label: "Reconnect wallet" },
  wait: { label: "Try later" },
  none: { label: "Close" },
};

function recovery(action: SellRecoveryAction, hint: string, extra: Partial<SellRecovery> = {}): SellRecovery {
  return { action, ...RECOVERY[action], hint, ...extra };
}

interface Copy {
  message: string;
  recovery: SellRecovery;
}

const NOTHING_SENT = "Nothing was sent, so you can try again.";
const DONT_RESEND = "Don't deposit again until we've checked whether it went through.";

/** Copy for each SDK code on the Base-USDC path. Source-route codes never occur here. */
function cashCopy(code: CashErrorCode, stage: SellErrorStage | undefined): Copy {
  switch (code) {
    case "AMOUNT_BELOW_MINIMUM":
      return { message: "That amount is below the minimum.", recovery: recovery("editForm", "Raise the amount.") };
    case "INVALID_INTENT_AMOUNT_RANGE":
      return { message: "That order size isn't allowed.", recovery: recovery("editForm", "Change the amount.") };
    case "UNSUPPORTED_PLATFORM":
    case "UNSUPPORTED_PLATFORM_CURRENCY":
    case "ORACLE_UNSUPPORTED_CURRENCY":
    case "INVALID_PAYOUT_CURRENCIES":
    case "INVALID_PAYOUT_PLATFORMS":
      return {
        message: "That payout method and currency can't be offered together.",
        recovery: recovery("editForm", "Pick a different payout method or currency."),
      };
    case "ORACLE_READ_FAILED":
      return { message: "The market rate couldn't be read just now.", recovery: recovery("retry", NOTHING_SENT) };
    case "PAYEE_VERIFICATION_REQUIRED":
      return {
        message: "This payout account must be registered once before you can sell to it.",
        recovery: recovery("editForm", "Register the handle with the PeerAuth extension or at peer.xyz."),
      };
    case "PAYEE_REGISTRATION_FAILED":
      return {
        message: "Your payout handle couldn't be confirmed.",
        recovery: recovery("editForm", "Check the handle, then try again."),
      };
    case "INSUFFICIENT_TOKEN_BALANCE":
      return { message: "You don't have enough USDC for that.", recovery: recovery("fundWallet", "Lower the amount or add USDC.") };
    case "ESCROW_PAUSED":
      return {
        message: "New sell orders are paused on Peer right now.",
        recovery: recovery("wait", "Existing orders are safe and can still be withdrawn."),
      };
    case "INDEXER_LAG":
    case "INDEXER_UNAVAILABLE":
    case "ORDER_NOT_FOUND":
      return {
        message: "Order data is catching up with the chain.",
        recovery: recovery("retry", "Check again in a few seconds."),
      };
    case "ACTIVE_INTENT_BLOCKS_WITHDRAWAL":
      return {
        message: "A buyer is paying for part of this order right now.",
        recovery: recovery("wait", "Wait for them to finish or for their time to run out, or withdraw only the unlocked amount."),
      };
    case "NOTHING_TO_WITHDRAW":
      return { message: "There's nothing left to withdraw from this order.", recovery: recovery("none", "It has already filled or been withdrawn.") };
    case "INSUFFICIENT_AVAILABLE_FUNDS":
      return {
        message: "That's more than the unlocked balance of this order.",
        recovery: recovery("editForm", "Withdraw a smaller amount."),
      };
    case "ORDER_NOT_ACTIVE":
      return { message: "This order is closed.", recovery: recovery("none", "Start a new sell order instead.") };
    case "INVALID_DEPOSIT_ID":
      return { message: "That order id isn't valid.", recovery: recovery("none", "Open the order from your bank instead.") };
    case "TRANSACTION_REJECTED":
      return { message: "You cancelled in your wallet.", recovery: recovery("retry", NOTHING_SENT) };
    case "TRANSACTION_FAILED":
      return stage === "policy"
        ? policyCopy()
        : { message: "The transaction failed on-chain, so nothing changed.", recovery: recovery("retry", "You can try again.") };
    case "TRANSACTION_SUBMISSION_UNKNOWN":
    case "TRANSACTION_STATUS_UNKNOWN":
    case "DEPOSIT_RESOLUTION_FAILED":
      return {
        message: "We couldn't confirm whether your transaction went through.",
        recovery: recovery("reconcile", DONT_RESEND),
      };
    case "ACCESS_POLICY_CONFIGURATION_FAILED":
      return policyCopy();
    case "ALLOWANCE_NOT_VISIBLE":
      return { message: "The network hasn't caught up with your approval yet.", recovery: recovery("retry", "Try again in a few seconds.") };
    case "SIGNER_CHAIN_MISMATCH":
      return { message: "Your wallet is on the wrong network.", recovery: recovery("reconnectWallet", "Switch your wallet to Base.") };
    case "SIGNER_REQUIRED":
    case "SIGNER_CHAIN_UNAVAILABLE":
      return { message: "Your wallet isn't responding.", recovery: recovery("reconnectWallet", "Reconnect your wallet and try again.") };
    case "WATCH_TIMEOUT":
      return { message: "Live updates paused.", recovery: recovery("retry", "Your order is safe on-chain. Refresh to resume.") };
    default:
      return { message: "Something went wrong with Peer.", recovery: recovery("none", "Close this and try again later.") };
  }
}

function policyCopy(): Copy {
  return {
    message: "Your order is live, but its buyer restriction wasn't attached.",
    recovery: recovery(
      "retryAccessPolicy",
      "Finish setup so only Peer Pay merchants can take it. Don't create another order.",
    ),
  };
}

function localCopy(code: SellLocalErrorCode): Copy {
  switch (code) {
    case "USER_REJECTED":
      return { message: "You cancelled in your wallet.", recovery: recovery("retry", NOTHING_SENT) };
    case "SUBMISSION_UNKNOWN":
      return { message: "We couldn't confirm whether your deposit went through.", recovery: recovery("reconcile", DONT_RESEND) };
    case "PENDING_SUBMISSION_EXISTS":
      return {
        message: "Your last deposit from this wallet hasn't been confirmed yet.",
        recovery: recovery("reconcile", "Check its status before starting another one."),
      };
    case "INSUFFICIENT_BALANCE":
      return { message: "You don't have enough USDC for that.", recovery: recovery("fundWallet", "Lower the amount or add USDC.") };
    case "NO_GAS":
      return {
        message: "Your wallet needs a little ETH on Base to pay network fees.",
        recovery: recovery("addGas", "Add a small amount of ETH on Base, then try again."),
      };
    case "WALLET_REQUIRED":
      return { message: "Log in to trade.", recovery: recovery("reconnectWallet", "Connect a wallet to sell USDC.") };
    case "INVALID_AMOUNT":
      return { message: "That amount isn't valid.", recovery: recovery("editForm", "Enter an amount above zero.") };
    case "WALLET_NOT_SENT":
      return { message: "Your wallet couldn't send that, so nothing was sent.", recovery: recovery("retry", "You can try again.") };
    case "INVALID_PLAN":
      return {
        message: "Peer returned an unexpected transaction plan, so nothing was sent.",
        recovery: recovery("retry", "Try again in a moment."),
      };
    case "UNKNOWN":
      return { message: "Something went wrong.", recovery: recovery("retry", NOTHING_SENT) };
  }
}

const LOCAL_CODES = new Set<string>([
  "USER_REJECTED",
  "SUBMISSION_UNKNOWN",
  "PENDING_SUBMISSION_EXISTS",
  "INSUFFICIENT_BALANCE",
  "NO_GAS",
  "WALLET_REQUIRED",
  "INVALID_PLAN",
  "INVALID_AMOUNT",
  "WALLET_NOT_SENT",
  "UNKNOWN",
]);

export interface SellErrorContext {
  stage?: SellErrorStage;
  depositId?: string;
  paymentMethod?: Hex;
  transactionHash?: Hex;
}

/** Builds a SellFlowError for a code with its standard copy. */
export function sellError(code: SellErrorCode, ctx: SellErrorContext & { cause?: unknown; message?: string } = {}): SellFlowError {
  const copy = LOCAL_CODES.has(code) ? localCopy(code as SellLocalErrorCode) : cashCopy(code as CashErrorCode, ctx.stage);
  return new SellFlowError({
    code,
    message: ctx.message ?? copy.message,
    recovery: copy.recovery,
    depositId: ctx.depositId,
    paymentMethod: ctx.paymentMethod,
    transactionHash: ctx.transactionHash,
    cause: ctx.cause,
  });
}

/** viem errors raised before a wallet hands anything to the network. */
const PRE_BROADCAST_ERRORS = new Set([
  "EstimateGasExecutionError",
  "InsufficientFundsError",
  "ChainMismatchError",
  "ChainDisconnectedError",
  "ProviderDisconnectedError",
  "SwitchChainError",
  "AccountNotFoundError",
]);

/**
 * True only when a wallet error proves nothing was broadcast (gas estimation
 * failed, wrong chain, no funds for gas). Anything else from a send is treated
 * as possibly broadcast.
 */
export function provenNotBroadcast(err: unknown): "insufficientFunds" | "notSent" | null {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const name = (current as { name?: unknown }).name;
    if (typeof name === "string" && PRE_BROADCAST_ERRORS.has(name)) {
      return name === "InsufficientFundsError" ? "insufficientFunds" : "notSent";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function hexOrUndefined(value: unknown): Hex | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? (value as Hex) : undefined;
}

/**
 * `TxSender` failure codes (src/wallet `WalletError.code`) that mean the
 * request never reached the chain. Matched structurally so this module does
 * not depend on the wallet implementation; unknown codes stay "unknown".
 */
const WALLET_NOT_SENT_CODES = new Set([
  "insufficient_gas",
  "sponsorship_failed",
  "chain_switch_failed",
  "wallet_not_ready",
  "busy",
  "popup_blocked",
  "call_reverted",
  "invalid_request",
]);

function walletCode(err: unknown): string | null {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 3; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z_]+$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export type SendFailure =
  /** The player cancelled before signing. */
  | { kind: "rejected" }
  /** Provably never reached the chain (estimation failed, wrong chain, no gas, popup blocked...). */
  | { kind: "notSent"; insufficientGas: boolean; switchChain: boolean; message: string | null }
  /** Mined and reverted: no state changed in the reverted call. */
  | { kind: "reverted"; hash: Hex | null }
  /** May have been broadcast; the chain must be checked before anything else. */
  | { kind: "unknown"; hash: Hex | null };

/** Classifies a failed `sendCalls`. Anything not provably safe is "unknown". */
export function classifySendFailure(err: unknown): SendFailure {
  const code = walletCode(err);
  if (code === "user_rejected" || isUserRejectedError(err)) return { kind: "rejected" };
  const hash = err && typeof err === "object" ? (hexOrUndefined((err as { hash?: unknown }).hash) ?? null) : null;
  if (code === "reverted") return { kind: "reverted", hash };
  if (code && WALLET_NOT_SENT_CODES.has(code)) {
    return {
      kind: "notSent",
      insufficientGas: code === "insufficient_gas",
      switchChain: code === "chain_switch_failed",
      message: err instanceof Error && err.message ? err.message : null,
    };
  }
  // A wallet error that knows how far its send got (src/wallet `mayHaveLanded`) is believed either way.
  const landed = err && typeof err === "object" ? (err as { mayHaveLanded?: unknown }).mayHaveLanded : undefined;
  if (landed === false) {
    return { kind: "notSent", insufficientGas: false, switchChain: false, message: err instanceof Error && err.message ? err.message : null };
  }
  if (landed === true) return { kind: "unknown", hash };
  const viem = provenNotBroadcast(err);
  if (viem) return { kind: "notSent", insufficientGas: viem === "insufficientFunds", switchChain: false, message: null };
  return { kind: "unknown", hash };
}

function sendFailureError(err: unknown, ctx: SellErrorContext): SellFlowError {
  const failure = classifySendFailure(err);
  switch (failure.kind) {
    case "rejected":
      return sellError("USER_REJECTED", { ...ctx, cause: err });
    case "notSent": {
      if (failure.insufficientGas) return sellError("NO_GAS", { ...ctx, cause: err });
      const base = sellError("WALLET_NOT_SENT", { ...ctx, cause: err, ...(failure.message ? { message: failure.message } : {}) });
      if (!failure.switchChain) return base;
      return new SellFlowError({
        code: base.code,
        message: base.message,
        recovery: recovery("reconnectWallet", "Switch your wallet to Base, then try again."),
        cause: err,
      });
    }
    case "reverted":
      return sellError("TRANSACTION_FAILED", { ...ctx, cause: err, ...(failure.hash ? { transactionHash: failure.hash } : {}) });
    case "unknown":
      return sellError("SUBMISSION_UNKNOWN", {
        ...ctx,
        cause: err,
        ...(failure.hash ? { transactionHash: failure.hash } : {}),
        ...(ctx.stage === "send"
          ? {}
          : { message: "We couldn't confirm whether your transaction went through. Refresh the order before trying again." }),
      });
  }
}

/**
 * Maps any thrown value to a SellFlowError. Wallet errors are stage-sensitive:
 * a failed send of the deposit batch is "unknown" (it may have broadcast)
 * unless the wallet clearly reports the user cancelled before signing.
 */
export function toSellFlowError(err: unknown, ctx: SellErrorContext = {}): SellFlowError {
  if (isSellFlowError(err)) return err;
  if (isCashError(err)) {
    const recoveryInfo = err.recovery;
    let depositId = ctx.depositId;
    let transactionHash = ctx.transactionHash;
    let paymentMethod = ctx.paymentMethod;
    if (recoveryInfo?.kind === "configure-cashout-access-policy") {
      depositId = recoveryInfo.depositId;
      transactionHash = hexOrUndefined(recoveryInfo.transactionHash) ?? transactionHash;
      paymentMethod = hexOrUndefined(recoveryInfo.paymentMethod) ?? paymentMethod;
    } else if (recoveryInfo?.kind === "inspect-base-transaction") {
      transactionHash = hexOrUndefined(recoveryInfo.transactionHash) ?? transactionHash;
    }
    return sellError(err.code, { ...ctx, depositId, transactionHash, paymentMethod, cause: err });
  }
  switch (ctx.stage) {
    case "send":
    case "withdraw":
    case "topUp":
      return sendFailureError(err, ctx);
    case "policy":
      return sellError("ACCESS_POLICY_CONFIGURATION_FAILED", { ...ctx, cause: err });
    case "finalize":
      return sellError("DEPOSIT_RESOLUTION_FAILED", { ...ctx, cause: err });
    default:
      if (isUserRejectedError(err)) return sellError("USER_REJECTED", { ...ctx, cause: err });
      return sellError("UNKNOWN", { ...ctx, cause: err });
  }
}
