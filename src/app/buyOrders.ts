import type { Address } from "viem";
import type { BuyFlowState, BuyStep, PendingAction } from "@/peer/buy";

/**
 * Pure rules for the shell's view of buy orders: the Payment scroll's
 * examine text, chatbox reminders, and when the buy flow moves onto (and back
 * off) the player's earlier wallet, the embedded EOA that holds an order
 * placed while the smart wallet was still being set up.
 */

/** Steps after the player said they paid: the order is with Peer, not waiting for money. */
const VERIFYING_STEPS: ReadonlySet<BuyStep> = new Set(["verifying", "selectPayment", "fulfilling"]);

const TX_PENDING: ReadonlySet<PendingAction> = new Set(["signal", "fulfill", "cancel"]);

/** What the Payment scroll's examine text needs from the payment instructions. */
export interface ScrollFacts {
  /** Exact amount with its symbol, e.g. "£101.50". */
  amountText: string;
  /** Payee as the platform shows it, or null when it couldn't be looked up. */
  payeeDisplay: string | null;
  platformName: string;
}

export function paymentScrollExamine(pay: ScrollFacts, step: BuyStep | null, expired: boolean): string {
  if (step !== null && VERIFYING_STEPS.has(step)) return "Your payment is being verified.";
  if (expired) return "This offer has expired. If you already paid, read this scroll and verify it now. Otherwise don't pay it.";
  const to = pay.payeeDisplay ? ` to ${pay.payeeDisplay}` : "";
  return `Pay ${pay.amountText}${to} on ${pay.platformName} once, then verify it with Peer. If you have already paid, don't pay again.`;
}

/** Chatbox reminder for an open order the player didn't just place (found on entry, recovered or adopted). */
export function buyOrderReminder(expired: boolean, earlierWallet: boolean): string {
  if (expired) return "Your buy offer has expired. If you already paid, read the Payment scroll and verify it now. Otherwise don't pay it.";
  return earlierWallet
    ? "You have an open buy offer from your earlier wallet. Read the Payment scroll in your inventory to pay it or to verify your payment."
    : "You have an open buy offer. Read the Payment scroll in your inventory to pay it or to verify your payment.";
}

export const EARLIER_ORDER_WAITING =
  "You also have an open buy offer from your earlier wallet. Finish or cancel your current offer to see it.";

/**
 * A signal sent in this session just landed (or a reconciled one, or an open
 * order adopted instead of signalling). The interface that placed it already
 * says so and opens the Payment scroll, so the shell must not remind about it.
 */
export function signalLanded(state: Pick<BuyFlowState, "step" | "order">, prev: Pick<BuyFlowState, "step">): boolean {
  return prev.step === "signaling" && state.step === "awaitingPayment" && state.order?.status === "active";
}

export type FlowView = Pick<BuyFlowState, "owner" | "step" | "order" | "pending" | "recovering">;

/**
 * Steps in which the buy flow can move to another wallet without losing
 * anything on-chain or interrupting an offer the player is putting together.
 */
const ADOPT_STEPS: ReadonlySet<BuyStep> = new Set(["idle", "completed", "cancelled", "error"]);

function txPending(flow: FlowView): boolean {
  return flow.pending !== null && TX_PENDING.has(flow.pending);
}

/**
 * True when the buy flow, bound to the player's wallet (`main`), holds no open
 * order and nothing in flight, so an earlier-wallet order can take its place.
 */
export function canAdoptEarlierOrder(flow: FlowView, main: Address): boolean {
  return (
    flow.owner === main.toLowerCase() &&
    !flow.recovering &&
    !txPending(flow) &&
    flow.order?.status !== "active" &&
    ADOPT_STEPS.has(flow.step)
  );
}

/**
 * True when the buy flow, bound to the earlier wallet, has finished with its
 * order and should go back to the player's wallet. A new offer (quotes on
 * screen) goes back at once so it is never placed from the earlier wallet;
 * otherwise it waits until no buy interface is open, so a completion or
 * cancellation screen stays up until the player closes it.
 */
export function canReleaseEarlierOrder(flow: FlowView, buyInterfaceOpen: boolean): boolean {
  if (flow.recovering || txPending(flow) || flow.order?.status === "active") return false;
  if (flow.step === "quoted" || flow.step === "confirming") return true;
  if (buyInterfaceOpen) return false;
  return flow.step === "idle" || flow.step === "completed" || flow.step === "cancelled" || flow.step === "error";
}

/** The buy flow is on the earlier wallet for this order. */
export interface EarlierLatch {
  eoa: string;
  intentHash: string;
  /** The flow has shown an order or looked for one since switching. */
  seen: boolean;
  /** The flow has shown this very order. */
  shown: boolean;
}

export interface LatchInput {
  flow: FlowView;
  /** The player's wallet (smart wallet) when it can transact. */
  main: Address | null;
  /** The earlier wallet when the smart wallet is selected and ready. */
  eoa: Address | null;
  /** A sender for the earlier wallet exists (its wallet is connected). */
  earlierReady: boolean;
  /** The open order found on the earlier wallet, if any, and when that lookup finished (ms). */
  found: { intentHash: string; at: number } | null;
  /** Lookups that finished before this time (ms) are stale and never adopted. */
  staleBefore: number;
  /** Orders the flow already showed and finished; never adopted again this session. */
  released: ReadonlySet<string>;
  buyInterfaceOpen: boolean;
}

export interface LatchStep {
  latch: EarlierLatch | null;
  /** The flow showed this order and is done with it: never adopt it again. */
  forget: string | null;
  /** The flow let go without ever showing the order: look it up again before adopting. */
  recheck: boolean;
}

const same = (latch: EarlierLatch | null): LatchStep => ({ latch, forget: null, recheck: false });

/** Next state of the earlier-wallet binding. `latch` is `current` itself when nothing changes. */
export function nextEarlierLatch(current: EarlierLatch | null, input: LatchInput): LatchStep {
  const eoa = input.eoa ? input.eoa.toLowerCase() : null;
  if (current) {
    // Logged out or the wallet changed: drop the binding without forgetting the order.
    if (current.eoa !== eoa) return same(null);
    // Still switching over (or the earlier wallet disconnected for a moment): it must be looked for again.
    if (input.flow.owner !== current.eoa) return same(current.seen ? { ...current, seen: false } : current);
    const showing = input.flow.order !== null && input.flow.order.intentHash.toLowerCase() === current.intentHash;
    const seen = current.seen || input.flow.recovering || input.flow.order !== null;
    const shown = current.shown || showing;
    const next = seen !== current.seen || shown !== current.shown ? { ...current, seen, shown } : current;
    if (!seen || !canReleaseEarlierOrder(input.flow, input.buyInterfaceOpen)) return same(next);
    return shown ? { latch: null, forget: current.intentHash, recheck: false } : { latch: null, forget: null, recheck: true };
  }
  if (!eoa || !input.main || !input.earlierReady || !input.found || input.found.at <= input.staleBefore) return same(null);
  const intentHash = input.found.intentHash.toLowerCase();
  if (input.released.has(intentHash) || !canAdoptEarlierOrder(input.flow, input.main)) return same(null);
  return same({ eoa, intentHash, seen: false, shown: false });
}

/**
 * The earlier wallet has an open order the flow can't show yet because the
 * player's wallet has its own open order. Null when there is nothing to say.
 */
export function blockedEarlierOrder(input: LatchInput, latched: boolean): string | null {
  if (latched || !input.found || !input.main || input.found.at <= input.staleBefore) return null;
  const intentHash = input.found.intentHash.toLowerCase();
  if (input.released.has(intentHash)) return null;
  return input.flow.owner === input.main.toLowerCase() && input.flow.order?.status === "active" ? intentHash : null;
}
