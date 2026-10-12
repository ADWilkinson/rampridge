/**
 * The sell flow as pure data. The pre-submission phases (idle, editing,
 * validating, ready) are derived from the draft every render, so they can
 * never drift from what the player sees; the submission phases (submitting,
 * listed, error) are stored, because they describe on-chain facts.
 */

import type { CashReceiveLeg, CashoutInput, CurrencyType } from "@zkp2p/cash";
import type { Hex } from "viem";
import { formatUsdcAmount, parseUsdcAmount } from "./amount";
import { findPlatform, type SellCapabilities, type SellPlatform } from "./cash";
import type { SellFlowError } from "./errors";
import { isValidSpreadBps, SELL_SPREAD_ENABLED } from "./spreadRate";
import { normalizePayee } from "./payees";
import { payeeCheckKey, type PayeeCheck } from "./validatePayee";

export type SellPhase = "idle" | "editing" | "validating" | "ready" | "submitting" | "listed" | "error";

export interface SellLegDraft {
  id: string;
  /** Platform id from capabilities, or "" until chosen. */
  platform: string;
  /** One or more currencies the buyer may pay in. */
  currencies: CurrencyType[];
  /** Raw handle as typed. */
  payee: string;
  /**
   * The normalised handle (curator offchainId) the seller confirmed is
   * enrolled with the platform (Zelle), or null. Never sent to Curator;
   * editing the handle invalidates it because it no longer matches.
   */
  enrolledFor?: string | null;
}

export type LegCheckState =
  | { status: "unchecked" }
  | { status: "checking"; key: string }
  | { status: "done"; key: string; result: PayeeCheck };

export type SubmitStepId = "approve" | "createDeposit" | "accessPolicy";
export type SubmitStepStatus = "pending" | "active" | "done" | "skipped" | "failed";
export type SubmitSteps = Record<SubmitStepId, SubmitStepStatus>;

/** A payout leg ready for submission. */
export interface ResolvedLeg {
  platform: string;
  currencies: CurrencyType[];
  offchainId: string;
}

export interface ListedSell {
  depositId: string;
  /** USDC base units deposited. */
  amount: bigint;
  legs: { platform: string; currencies: CurrencyType[] }[];
  /** The seller's spread on the oracle rate, basis points (0 = the market rate). */
  spreadBps?: number;
  txHashes: { createDeposit: Hex | null; accessPolicy: Hex[] };
}

export type SubmissionState =
  | { status: "submitting"; steps: SubmitSteps }
  | { status: "listed"; steps: SubmitSteps; listed: ListedSell }
  | { status: "error"; steps: SubmitSteps; error: SellFlowError };

export interface SellDraftState {
  /** Raw amount text. */
  amount: string;
  legs: SellLegDraft[];
  checks: Record<string, LegCheckState>;
  submission: SubmissionState | null;
  /** The seller's spread on the oracle rate, basis points; 0 (the default) is the market rate. */
  spreadBps?: number;
}

export type SellIssueCode =
  | "WALLET_REQUIRED"
  | "NO_GAS"
  | "BALANCE_UNKNOWN"
  | "AMOUNT_REQUIRED"
  | "AMOUNT_INVALID"
  | "AMOUNT_PRECISION"
  | "AMOUNT_BELOW_MIN"
  | "AMOUNT_ABOVE_BALANCE"
  | "AMOUNT_ABOVE_MAX"
  | "LEG_REQUIRED"
  | "PLATFORM_REQUIRED"
  | "PLATFORM_UNSUPPORTED"
  | "PLATFORM_DUPLICATE"
  | "CURRENCY_REQUIRED"
  | "CURRENCY_UNSUPPORTED"
  | "CURRENCY_DUPLICATE"
  | "PAYEE_REQUIRED"
  | "PAYEE_INVALID"
  | "PAYEE_CHECKING"
  | "PAYEE_NOT_FOUND"
  | "PAYEE_NEEDS_REGISTRATION"
  | "PAYEE_CHECK_FAILED"
  /** Zelle: the seller hasn't confirmed this exact handle is enrolled and can receive payments. */
  | "PAYEE_ENROLLMENT_REQUIRED"
  /** An order with a single-order platform (Alipay) is below that platform's minimum deposit. */
  | "AMOUNT_BELOW_SINGLE_ORDER_MIN"
  /** The spread is not a whole number of basis points within Peer's -5% to +5%. */
  | "SPREAD_INVALID";

export interface SellIssue {
  code: SellIssueCode;
  /** "error" blocks submission until fixed; "pending" resolves on its own (a check in flight). */
  severity: "error" | "pending";
  /** The leg the issue belongs to, when it is about one leg. */
  legId?: string;
  message: string;
}

export type GasState = "ok" | "empty" | "unknown" | "sponsored";

export interface SellContext {
  caps: SellCapabilities;
  walletConnected: boolean;
  /** USDC base units; null while unknown. */
  balance: bigint | null;
  gas: GasState;
}

export interface SellEvaluation {
  phase: SellPhase;
  issues: SellIssue[];
  /** Parsed amount when it is a valid number, even if out of bounds. */
  amount: bigint | null;
  /** Every leg, resolved, only when the whole order is ready to submit. */
  legs: ResolvedLeg[] | null;
  /** The spread the order lists at (0 while spreads are switched off). */
  spreadBps: number;
  canSubmit: boolean;
}

let legCounter = 0;

export function createLeg(platform = "", currencies: CurrencyType[] = []): SellLegDraft {
  legCounter += 1;
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `leg-${Date.now()}-${legCounter}`;
  return { id, platform, currencies, payee: "", enrolledFor: null };
}

export function initialSteps(): SubmitSteps {
  return { approve: "pending", createDeposit: "pending", accessPolicy: "pending" };
}

export function isPristine(state: Pick<SellDraftState, "amount" | "legs">): boolean {
  return state.amount.trim() === "" && state.legs.every((leg) => leg.payee.trim() === "");
}

/** The payee-check key for a leg, or null when the leg cannot be checked yet. */
export function legCheckKey(leg: SellLegDraft, caps: SellCapabilities): string | null {
  if (!leg.platform || !findPlatform(caps, leg.platform)) return null;
  const format = normalizePayee(leg.platform, leg.payee);
  return format.ok ? payeeCheckKey(leg.platform, format.offchainId) : null;
}

/** Currencies to run a payee check with: the leg's supported ones, else the platform default. */
export function checkCurrencies(leg: SellLegDraft, platform: SellPlatform): CurrencyType[] {
  const supported = leg.currencies.filter((c) => platform.currencies.includes(c));
  if (supported.length) return supported;
  const first = platform.currencies[0];
  return first ? [first] : [];
}

function payeeIssue(leg: SellLegDraft, check: LegCheckState | undefined, key: string): SellIssue | null {
  if (!check || check.status === "unchecked" || check.key !== key || check.status === "checking") {
    return { code: "PAYEE_CHECKING", severity: "pending", legId: leg.id, message: "Checking your handle..." };
  }
  const result = check.result;
  switch (result.kind) {
    case "valid":
      return null;
    case "notFound":
      return { code: "PAYEE_NOT_FOUND", severity: "error", legId: leg.id, message: result.message };
    case "needsIdentityAttestation":
      return { code: "PAYEE_NEEDS_REGISTRATION", severity: "error", legId: leg.id, message: result.message };
    case "invalidFormat":
      return { code: "PAYEE_INVALID", severity: "error", legId: leg.id, message: result.message };
    case "error":
      return { code: "PAYEE_CHECK_FAILED", severity: "error", legId: leg.id, message: result.message };
  }
}

/** True once the seller confirmed enrolment for exactly this handle, or when the platform needs none. */
export function enrollmentConfirmed(leg: Pick<SellLegDraft, "platform" | "payee" | "enrolledFor">, platform: SellPlatform | null): boolean {
  if (!platform?.payeeEnrollment) return true;
  const format = normalizePayee(leg.platform, leg.payee);
  return format.ok && leg.enrolledFor === format.offchainId;
}

function evaluateLegs(state: SellDraftState, caps: SellCapabilities, issues: SellIssue[]): ResolvedLeg[] {
  const resolved: ResolvedLeg[] = [];
  const seenPlatforms = new Set<string>();
  if (state.legs.length === 0) {
    issues.push({ code: "LEG_REQUIRED", severity: "error", message: "Add a payout method." });
  }
  for (const leg of state.legs) {
    if (!leg.platform) {
      issues.push({ code: "PLATFORM_REQUIRED", severity: "error", legId: leg.id, message: "Choose how you want to be paid." });
      continue;
    }
    const platform = findPlatform(caps, leg.platform);
    if (!platform) {
      issues.push({ code: "PLATFORM_UNSUPPORTED", severity: "error", legId: leg.id, message: "That payout method isn't available." });
      continue;
    }
    if (seenPlatforms.has(leg.platform)) {
      issues.push({
        code: "PLATFORM_DUPLICATE",
        severity: "error",
        legId: leg.id,
        message: `${platform.name} is already in this order. Each payout method can appear once.`,
      });
      continue;
    }
    seenPlatforms.add(leg.platform);

    let legOk = true;
    if (leg.currencies.length === 0) {
      issues.push({ code: "CURRENCY_REQUIRED", severity: "error", legId: leg.id, message: "Choose a currency." });
      legOk = false;
    } else if (new Set(leg.currencies).size !== leg.currencies.length) {
      issues.push({ code: "CURRENCY_DUPLICATE", severity: "error", legId: leg.id, message: "Each currency can be picked once." });
      legOk = false;
    } else {
      const unsupported = leg.currencies.find((c) => !platform.currencies.includes(c));
      if (unsupported) {
        issues.push({
          code: "CURRENCY_UNSUPPORTED",
          severity: "error",
          legId: leg.id,
          message: `${platform.name} can't pay out in ${unsupported}.`,
        });
        legOk = false;
      }
    }

    if (!leg.payee.trim()) {
      issues.push({ code: "PAYEE_REQUIRED", severity: "error", legId: leg.id, message: `Enter your ${platform.payeeLabel}.` });
      continue;
    }
    const format = normalizePayee(leg.platform, leg.payee);
    if (!format.ok) {
      issues.push({ code: "PAYEE_INVALID", severity: "error", legId: leg.id, message: format.message });
      continue;
    }
    if (platform.payeeEnrollment && leg.enrolledFor !== format.offchainId) {
      issues.push({
        code: "PAYEE_ENROLLMENT_REQUIRED",
        severity: "error",
        legId: leg.id,
        message: `Confirm this ${platform.payeeLabel} is enrolled with ${platform.name} and can receive payments.`,
      });
      legOk = false;
    }
    const issue = payeeIssue(leg, state.checks[leg.id], payeeCheckKey(leg.platform, format.offchainId));
    if (issue) {
      issues.push(issue);
      continue;
    }
    if (legOk) resolved.push({ platform: leg.platform, currencies: [...leg.currencies], offchainId: format.offchainId });
  }
  return resolved;
}

function evaluateAmount(state: SellDraftState, ctx: SellContext, issues: SellIssue[]): bigint | null {
  const parsed = parseUsdcAmount(state.amount);
  if (!parsed.ok) {
    if (parsed.reason === "empty") {
      issues.push({ code: "AMOUNT_REQUIRED", severity: "error", message: "Enter how much USDC to sell." });
    } else if (parsed.reason === "precision") {
      issues.push({ code: "AMOUNT_PRECISION", severity: "error", message: "USDC has at most 6 decimal places." });
    } else {
      issues.push({ code: "AMOUNT_INVALID", severity: "error", message: "Enter a number, like 125 or 99.50." });
    }
    return null;
  }
  const amount = parsed.units;
  if (amount < ctx.caps.minAmount) {
    issues.push({
      code: "AMOUNT_BELOW_MIN",
      severity: "error",
      message: `The minimum is ${formatUsdcAmount(ctx.caps.minAmount, { minDecimals: 0 })} USDC.`,
    });
  } else if (ctx.caps.maxAmount !== null && amount > ctx.caps.maxAmount) {
    issues.push({
      code: "AMOUNT_ABOVE_MAX",
      severity: "error",
      message: `The maximum is ${formatUsdcAmount(ctx.caps.maxAmount, { group: true })} USDC.`,
    });
  } else if (ctx.balance !== null && amount > ctx.balance) {
    issues.push({
      code: "AMOUNT_ABOVE_BALANCE",
      severity: "error",
      message: `You only have ${formatUsdcAmount(ctx.balance, { group: true })} USDC.`,
    });
  }
  return amount;
}

/** Alipay-style platforms fill in one order and need a minimum deposit (Peer's single-order rule). */
function singleOrderIssue(state: SellDraftState, caps: SellCapabilities, amount: bigint): SellIssue | null {
  let binding: { platform: SellPlatform; minAmount: bigint } | null = null;
  for (const leg of state.legs) {
    const platform = findPlatform(caps, leg.platform);
    const policy = platform?.singleOrder;
    if (platform && policy && (!binding || policy.minAmount > binding.minAmount)) binding = { platform, minAmount: policy.minAmount };
  }
  if (!binding || amount >= binding.minAmount) return null;
  return {
    code: "AMOUNT_BELOW_SINGLE_ORDER_MIN",
    severity: "error",
    message: `${binding.platform.name} orders must be at least ${formatUsdcAmount(binding.minAmount, { minDecimals: 0 })} USDC: each one fills in a single trade.`,
  };
}

/** Derives the phase, blocking issues and the submittable order from the draft. */
export function evaluateSell(state: SellDraftState, ctx: SellContext): SellEvaluation {
  const issues: SellIssue[] = [];
  if (!ctx.walletConnected) {
    issues.push({ code: "WALLET_REQUIRED", severity: "error", message: "Log in to trade." });
  } else {
    if (ctx.balance === null) {
      issues.push({ code: "BALANCE_UNKNOWN", severity: "pending", message: "Checking your USDC balance..." });
    }
    if (ctx.gas === "empty") {
      issues.push({ code: "NO_GAS", severity: "error", message: "Your wallet needs a little ETH on Base to pay network fees." });
    }
  }
  const amount = evaluateAmount(state, ctx, issues);
  if (amount !== null && !issues.some((i) => i.code.startsWith("AMOUNT_"))) {
    const single = singleOrderIssue(state, ctx.caps, amount);
    if (single) issues.push(single);
  }
  const resolved = evaluateLegs(state, ctx.caps, issues);
  const spreadBps = SELL_SPREAD_ENABLED ? (state.spreadBps ?? 0) : 0;
  if (!isValidSpreadBps(spreadBps)) {
    issues.push({ code: "SPREAD_INVALID", severity: "error", message: "Choose a spread between -5% and +5%." });
  }

  let phase: SellPhase;
  if (state.submission) {
    phase = state.submission.status === "submitting" ? "submitting" : state.submission.status;
  } else if (isPristine(state)) {
    phase = "idle";
  } else if (issues.some((i) => i.severity === "error")) {
    phase = "editing";
  } else if (issues.length > 0) {
    phase = "validating";
  } else {
    phase = "ready";
  }
  const ready = phase === "ready" && amount !== null && resolved.length === state.legs.length;
  return { phase, issues, amount, legs: ready ? resolved : null, spreadBps, canSubmit: ready };
}

/** The SDK `receive` value for resolved legs: one leg, or a non-empty array of legs. */
export function toReceive(legs: readonly Pick<ResolvedLeg, "platform" | "currencies" | "offchainId">[]): CashoutInput["receive"] {
  const mapped = legs.map((leg): CashReceiveLeg => {
    const [first, ...rest] = leg.currencies;
    if (!first) throw new Error(`Leg ${leg.platform} has no currency`);
    return rest.length === 0
      ? { platform: leg.platform, currency: first, payee: leg.offchainId }
      : { platform: leg.platform, currencies: [first, ...rest], payee: leg.offchainId };
  });
  const [head, ...tail] = mapped;
  if (!head) throw new Error("A sell order needs at least one payout leg");
  return tail.length === 0 ? head : [head, ...tail];
}
