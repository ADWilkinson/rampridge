/**
 * Pure presentation helpers for the bank, sell and collection interfaces:
 * stack sizing, examine text, leg validation summaries, step rows and money
 * formatting. No React, no network: everything here is unit-tested.
 *
 * Money is always shown exactly: USDC truncated (never rounded up) to two
 * decimals, fiat with its symbol ($, £, €) or its ISO code. Nothing here
 * invents a fee, rate or promise; every number comes from the SDK.
 */

import { isFillLive, type CashFill, type CashOrderState, type CashPayoutInfo, type CashPayoutPricing } from "@zkp2p/cash";
import type { SellFlowError, SellIssue, SellLegView, SellOrderRow, SubmitStepId, SubmitStepStatus, SubmitSteps } from "@/peer/sell";
import { formatUsdcAmount } from "@/peer/sell/amount";
import { displayPayee, platformName } from "@/peer/sell/payees";
import type { ExtensionStatus } from "@/peer/extension";

export const USDC_UNIT = 1_000_000n;

/** "1,250.40": exact USDC truncated to cents, grouped. */
export function usdcText(units: bigint): string {
  return formatUsdcAmount(units, { minDecimals: 2, maxDecimals: 2, group: true });
}

/** Whole USDC as a stack size (floored), capped to a safe integer. */
export function wholeUsdc(units: bigint): number {
  if (units <= 0n) return 0;
  const whole = units / USDC_UNIT;
  return whole > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(whole);
}

/** USDC text with up to two decimals and no grouping, for the amount field ("250", "99.5"). */
export function usdcInputText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const cents = Math.round(value * 100);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}

/** A prompt amount (number, at most two decimals) as USDC base units. */
export function usdcUnitsFromNumber(value: number): bigint | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return BigInt(Math.round(value * 100)) * 10_000n;
}

/** USDC base units as a number of whole USDC, truncated to cents (for AmountPad bounds). */
export function usdcNumber(units: bigint | null | undefined): number {
  if (!units || units <= 0n) return 0;
  return Number(units / 10_000n) / 100;
}

/** "0x12ab...cdef" with ASCII dots: the RuneScape fonts have no ellipsis glyph. */
export function shortAddr(address: string | null | undefined, head = 4, tail = 4): string {
  if (!address) return "";
  const body = address.startsWith("0x") ? address.slice(2) : address;
  if (body.length <= head + tail + 3) return address;
  return `${address.startsWith("0x") ? "0x" : ""}${body.slice(0, head)}...${body.slice(-tail)}`;
}

/** A deposit id ("escrow_onchainId") as the player reads it: "#1234 (0xca38...2d70)". */
export function depositLabel(depositId: string): string {
  const [escrow, onchain] = depositId.split("_");
  if (!escrow || !onchain) return depositId;
  return `#${onchain} (${shortAddr(escrow)})`;
}

export const BASESCAN = "https://basescan.org";

export function txUrl(hash: string): string {
  return `${BASESCAN}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${BASESCAN}/address/${address}`;
}

const SYMBOL_CURRENCIES: Readonly<Record<string, string>> = { USD: "$", GBP: "£", EUR: "€" };

/**
 * Fiat with its symbol for $, £ and € (the RuneScape fonts draw those), and
 * with its ISO code otherwise: "£196.50", "1,234.50 AUD".
 */
export function fiatText(amount: number, currency: string): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const digits = safe.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = SYMBOL_CURRENCIES[currency.toUpperCase()];
  if (symbol) return safe < 0 ? `-${symbol}${digits.slice(1)}` : `${symbol}${digits}`;
  return `${digits} ${currency.toUpperCase()}`;
}

/** Fiat per USDC as the oracle reports it: four decimals under 100, two above. */
export function rateNumber(rate: number): string {
  if (!Number.isFinite(rate)) return "0";
  const decimals = Math.abs(rate) >= 100 ? 2 : 4;
  return rate.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * A rate to about five significant figures, so every 0.1% spread step moves
 * it visibly: 0.7554 GBP, 7.1234 CNY, 84.123 INR, 0.012345 below 0.1.
 */
export function preciseRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "0";
  const magnitude = Math.floor(Math.log10(rate));
  const decimals = Math.min(8, Math.max(2, magnitude >= 0 ? 4 - magnitude : 4 + (-magnitude - 1)));
  return rate.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** "1 USDC = 0.7860 GBP" */
export function rateText(rate: number, currency: string): string {
  return `1 USDC = ${rateNumber(rate)} ${currency.toUpperCase()}`;
}

/** "GBP", "GBP or EUR", "GBP, EUR or USD" */
export function currencyList(currencies: readonly string[]): string {
  if (currencies.length <= 1) return currencies[0] ?? "";
  return `${currencies.slice(0, -1).join(", ")} or ${currencies[currencies.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Payout methods only Peer Pay merchants can buy from

/**
 * Payout platforms whose sell orders only Peer Pay merchants can fill.
 * @zkp2p/cash puts Peer Pay's buyer whitelist on every Venmo and PayPal
 * deposit (its CASH_RESTRICTED_PLATFORMS, which 0.7.2 does not export), so
 * no player in the bank can take them from a stall. A test keeps this equal
 * to the library's set.
 */
export const PEER_PAY_ONLY_PLATFORMS: ReadonlySet<string> = new Set(["venmo", "paypal"]);

/** Said under a Venmo or PayPal payout, on the review and on the listed offer. */
export const PEER_PAY_ONLY_TEXT = "Venmo and PayPal sell orders are filled by Peer Pay merchants, not by players in the bank.";

export function isPeerPayOnly(platform: string | null | undefined): boolean {
  return Boolean(platform) && PEER_PAY_ONLY_PLATFORMS.has(platform!.toLowerCase());
}

/**
 * True when every payout of an order goes through Peer Pay only, so no player
 * could take it from a stall. False while the payouts are unknown (list rows
 * may not carry them) or empty.
 */
export function onlyPeerPay(payouts: readonly Pick<CashPayoutInfo, "platform">[] | null | undefined): boolean {
  return Boolean(payouts && payouts.length > 0 && payouts.every((p) => isPeerPayOnly(p.platform)));
}

// ---------------------------------------------------------------------------
// Sell orders as bank items

export type BankTab = "all" | "open" | "completed";

export const BANK_TABS: readonly { id: BankTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "completed", label: "Completed" },
];

type Amounts = Pick<SellOrderRow, "totalAmount" | "filledAmount" | "returnedAmount">;

/** What is still in the order: everything not delivered to buyers or returned to the seller. */
export function remainingAmount(row: Amounts): bigint {
  const used = row.filledAmount + row.returnedAmount;
  return row.totalAmount > used ? row.totalAmount - used : 0n;
}

export interface OrderStack {
  /** Whole USDC drawn as the stack count. */
  quantity: number;
  /** Nothing left: drawn faded with "0", like the bank's placeholders. */
  placeholder: boolean;
  /** Whole USDC that picks the coin-pile sprite (the original amount for placeholders). */
  spriteQuantity: number;
}

/** The coin stack for an order, sized to what is left in it. */
export function orderStack(row: Amounts): OrderStack {
  const remaining = remainingAmount(row);
  const quantity = wholeUsdc(remaining);
  const placeholder = remaining === 0n;
  return { quantity, placeholder, spriteQuantity: Math.max(1, placeholder ? wholeUsdc(row.totalAmount) : quantity) };
}

export function filterOrders<T extends Pick<SellOrderRow, "isInFlight">>(rows: readonly T[], tab: BankTab): T[] {
  if (tab === "open") return rows.filter((r) => r.isInFlight);
  if (tab === "completed") return rows.filter((r) => !r.isInFlight);
  return [...rows];
}

export function emptyBankText(tab: BankTab): string {
  if (tab === "open") return "You have no open sell offers.";
  if (tab === "completed") return "You have no completed sell offers.";
  return "You have no sell offers. Deposit USDC to start selling.";
}

const STATE_LABELS: Readonly<Record<CashOrderState, string>> = {
  "awaiting-buyer": "Waiting for a buyer",
  matched: "A buyer is paying",
  delivering: "Part filled, a buyer is paying",
  delivered: "Completed",
  returned: "Closed",
};

export function stateLabel(state: CashOrderState): string {
  return STATE_LABELS[state] ?? "Unknown";
}

export interface PayoutGroup {
  platform: string;
  name: string;
  currencies: string[];
  /** Every payout of this platform has stopped accepting buyers. */
  paused: boolean;
  pricing: CashPayoutPricing | null;
  /** The currency `pricing` was read for (the platform's first payout). */
  pricingCurrency: string | null;
}

/** Payout legs grouped by platform, currencies in the order the chain lists them. */
export function payoutGroups(payouts: readonly CashPayoutInfo[] | null | undefined): PayoutGroup[] {
  const groups = new Map<string, PayoutGroup & { activeCount: number }>();
  for (const p of payouts ?? []) {
    let g = groups.get(p.platform);
    if (!g) {
      g = {
        platform: p.platform,
        name: platformName(p.platform),
        currencies: [],
        paused: false,
        pricing: p.pricing ?? null,
        pricingCurrency: p.currency ?? null,
        activeCount: 0,
      };
      groups.set(p.platform, g);
    }
    if (p.currency && !g.currencies.includes(p.currency)) g.currencies.push(p.currency);
    if (p.active) g.activeCount += 1;
  }
  return [...groups.values()].map(({ activeCount, ...g }) => ({ ...g, paused: activeCount === 0 }));
}

/** How the order is priced, only from what the chain reports. Null when nothing is known. */
export function rateModeText(pricing: CashPayoutPricing | null | undefined, currency?: string): string | null {
  if (!pricing) return null;
  const cur = currency ? ` ${currency}` : "";
  if (pricing.fixedAtCreation && typeof pricing.fixedRate === "number") return `Fixed at ${rateNumber(pricing.fixedRate)}${cur} per USDC`;
  if (pricing.marketRate) {
    const now = typeof pricing.oracleRate === "number" ? `, now ${rateNumber(pricing.oracleRate)}${cur} per USDC` : "";
    return `Market rate (0% spread)${now}`;
  }
  if (typeof pricing.spreadBps === "number") {
    // A seller spread on the live oracle: buyers pay the market rate plus (or minus) this much.
    const pct = pricing.spreadBps / 100;
    return `Market rate ${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(2)}%`;
  }
  return null;
}

/** "Revolut (GBP, EUR)" for the item name and menus. */
export function payoutTitle(groups: readonly PayoutGroup[]): string {
  if (groups.length === 0) return "";
  const first = groups[0]!;
  const extra = groups.length > 1 ? ` +${groups.length - 1}` : "";
  return first.currencies.length ? `${first.name} (${first.currencies.join(", ")})${extra}` : `${first.name}${extra}`;
}

export type BuyerHold =
  /** Nothing is held for a buyer. */
  | "none"
  /** A buyer is inside their time limit. */
  | "live"
  /** Every buyer holding part of the order ran out of time; Withdraw-All releases it. */
  | "expired"
  /** Something is held but the fills are not loaded (list rows carry none). */
  | "unknown";

/** Whether the USDC held for buyers is still theirs, from the order's fills (the SDK's `isFillLive` rule). */
export function buyerHold(row: Pick<SellOrderRow, "pendingAmount" | "fills">, nowSeconds: number): BuyerHold {
  if (row.pendingAmount <= 0n) return "none";
  const signalled = row.fills.filter((f) => f.status === "SIGNALED");
  if (signalled.length === 0) return "unknown";
  return signalled.some((f) => isFillLive(f, nowSeconds)) ? "live" : "expired";
}

/** The newest buyer still inside their time limit, for "who is paying me?". */
export function liveBuyer(fills: readonly CashFill[], nowSeconds: number): string | null {
  const live = fills.filter((f) => isFillLive(f, nowSeconds));
  live.sort((a, b) => (b.signaledAt ?? 0) - (a.signaledAt ?? 0));
  return live[0]?.buyer ?? null;
}

export interface ExamineInput {
  row: Pick<
    SellOrderRow,
    "state" | "totalAmount" | "filledAmount" | "pendingAmount" | "returnedAmount" | "availableAmount" | "isInFlight"
  >;
  /** Payout legs, when known (list rows may not carry them). */
  payouts: readonly CashPayoutInfo[] | null;
  payoutsLoading?: boolean;
  advertised?: boolean;
  /** From `buyerHold` once the order's fills are known. */
  hold?: BuyerHold;
}

/**
 * The examine text for a bank item, one fact per line: what is left, the
 * state, filled vs remaining, payout legs, rate mode, then one sentence about
 * the order (`orderSentence`). When the buyer's time ran out, that sentence
 * is replaced by what Withdraw-All does.
 */
export function examineLines({ row, payouts, payoutsLoading = false, advertised = false, hold = "unknown" }: ExamineInput): string[] {
  const remaining = remainingAmount(row);
  const expired = hold === "expired";
  const state = expired ? (row.filledAmount > 0n ? "Part filled, a buyer's time ran out" : "A buyer's time ran out") : stateLabel(row.state);
  const lines = [`${usdcText(remaining)} USDC left of ${usdcText(row.totalAmount)} USDC.`, `${state}.`];
  const filled = [`Filled: ${usdcText(row.filledAmount)} USDC.`];
  if (row.pendingAmount > 0n) filled.push(`${expired ? "Held by an expired buyer" : "Held for a buyer"}: ${usdcText(row.pendingAmount)} USDC.`);
  if (row.returnedAmount > 0n) filled.push(`Returned: ${usdcText(row.returnedAmount)} USDC.`);
  lines.push(filled.join(" "));
  const groups = payoutGroups(payouts);
  if (groups.length) {
    for (const g of groups) {
      lines.push(`Paid by ${g.name}${g.currencies.length ? ` in ${currencyList(g.currencies)}` : ""}${g.paused ? " (paused)" : ""}.`);
    }
    for (const g of groups) {
      const mode = rateModeText(g.pricing, g.pricingCurrency ?? undefined);
      if (mode) lines.push(`Rate${groups.length > 1 ? ` (${g.name})` : ""}: ${mode}.`);
    }
  } else if (payoutsLoading) {
    lines.push("Loading payout details...");
  }
  if (groups.some((g) => isPeerPayOnly(g.platform))) lines.push(PEER_PAY_ONLY_TEXT);
  const sentence = examineSentence(row, hold);
  // A waiting offer's sentence would repeat the first two lines; only its last clause is new.
  if (row.state === "awaiting-buyer" && !expired) lines.push("You can withdraw it at any time.");
  else if (sentence) lines.push(sentence);
  if (advertised) lines.push("Advertised as your stall.");
  return lines;
}

type SentenceRow = Pick<SellOrderRow, "state" | "totalAmount" | "filledAmount" | "pendingAmount" | "returnedAmount" | "availableAmount">;

/**
 * One plain sentence about a sell order, from its state and amounts (USDC
 * with two decimals). The bank's own words replace @zkp2p/cash's `explain()`,
 * which says "cash-out" and "fill(s)" and formats numbers its own way.
 */
export function orderSentence(row: SentenceRow): string {
  const usdc = (units: bigint) => `${usdcText(units)} USDC`;
  const forSale = row.availableAmount > 0n ? ` ${usdc(row.availableAmount)} is still for sale.` : "";
  const paying = row.pendingAmount > 0n ? ` A buyer is paying for ${usdc(row.pendingAmount)}.` : "";
  switch (row.state) {
    case "awaiting-buyer":
      return `${usdc(row.availableAmount)} is for sale, waiting for a buyer. You can withdraw it at any time.`;
    case "matched":
      return `A buyer is paying for ${usdc(row.pendingAmount)}. It goes to them once Peer proves their payment.${forSale}`;
    case "delivering":
      return `${usdc(row.filledAmount)} of ${usdc(row.totalAmount)} sold.${paying}${forSale}`;
    case "delivered":
      return `Sold out: buyers paid for all ${usdc(row.filledAmount)}.`;
    case "returned":
      if (row.filledAmount > 0n) return `${usdc(row.filledAmount)} sold and ${usdc(row.returnedAmount)} returned to your wallet.`;
      return row.returnedAmount > 0n ? `No buyer paid. ${usdc(row.returnedAmount)} returned to your wallet.` : "No buyer paid. This offer is closed.";
    default:
      return `${usdc(row.filledAmount)} of ${usdc(row.totalAmount)} sold.`;
  }
}

/**
 * The one sentence Examine prints in the chatbox: `orderSentence`, except
 * when the buyer's time ran out (the order still counts them as paying).
 */
export function examineSentence(row: SentenceRow, hold: BuyerHold): string {
  if (hold === "expired") {
    return `The buyer's time ran out. Withdraw-All returns everything left, including the ${usdcText(row.pendingAmount)} USDC they held.`;
  }
  return orderSentence(row);
}

/** The buyer holding part of an order, with their Peer record once it loads. */
export function buyerLine(address: string, profile: { fulfilled: number; pruned: number } | null, loading = false): string {
  const short = shortAddr(address);
  if (!profile) return loading ? `Checking the record of the buyer paying now (${short})...` : `A buyer (${short}) is paying now.`;
  const finished = profile.fulfilled + profile.pruned;
  const who = `The buyer paying now (${short})`;
  if (finished === 0) return `${who} has no finished trades on Peer yet.`;
  return `${who} has paid for ${profile.fulfilled} of ${finished} trades on Peer.`;
}

// ---------------------------------------------------------------------------
// Item menu

export type ItemAction = "withdraw-all" | "withdraw-x" | "top-up" | "advertise" | "stop-advertising" | "examine" | "hold";

export interface ItemMenuOption {
  action: ItemAction;
  verb: string;
  targetName?: string;
  kind: "item";
  suffix?: string;
}

/**
 * Why money actions on an order are held back:
 * - "checking": a buyer holds part of it and its fills are still loading, so
 *   it is not yet known whether their time ran out;
 * - "updating": a withdrawal or top-up confirmed and the bank has not shown it yet;
 * - "unconfirmed": an earlier withdrawal or top-up may still land.
 */
export type ItemHold = "checking" | "updating" | "unconfirmed";

export interface ItemMenuContext {
  /** This order is the player's advertised stall. */
  advertised: boolean;
  /** Another bank action or wallet request is in flight. */
  busy: boolean;
  hold: ItemHold | null;
}

const HOLD_VERBS: Readonly<Record<ItemHold, string>> = {
  checking: "Checking...",
  updating: "Updating...",
  unconfirmed: "Unconfirmed",
};

/** The game message for choosing a held entry. */
export function holdMessage(hold: ItemHold): string {
  switch (hold) {
    case "checking":
      return "Still checking this offer. Try again in a moment.";
    case "updating":
      return "Your bank is still updating with your last transaction.";
    case "unconfirmed":
      return "An earlier withdrawal or top-up on this offer hasn't been confirmed.";
  }
}

/**
 * The Choose Option entries for an order, in the original bank's order:
 * Withdraw-All, Withdraw-X, Top-up, Advertise, Examine (Cancel is added by
 * the menu). Money actions are left out while anything is in flight, so a
 * second click can never send a second transaction, and replaced by one
 * explanatory entry while the order is held. Advertise is left out for an
 * order only Peer Pay merchants can buy from (`onlyPeerPay`): no player could
 * take it from a stall.
 */
export function itemMenuOptions(
  row: Pick<SellOrderRow, "canWithdraw" | "canTopUp" | "availableAmount" | "isInFlight" | "totalAmount" | "filledAmount" | "returnedAmount"> & {
    order?: { withdrawn?: boolean };
    /** The order's payout legs when known (list rows may not carry them). */
    payouts?: readonly Pick<CashPayoutInfo, "platform">[] | null;
  },
  ctx: ItemMenuContext,
): ItemMenuOption[] {
  const item = (action: ItemAction, verb: string): ItemMenuOption => ({ action, verb, targetName: "USDC", kind: "item" });
  const options: ItemMenuOption[] = [];
  const withdrawn = row.order?.withdrawn === true;
  const hasMoneyAction = (row.canWithdraw && remainingAmount(row) > 0n) || (!withdrawn && row.availableAmount > 0n) || row.canTopUp;
  if (ctx.hold) {
    if (hasMoneyAction || ctx.hold !== "checking") options.push({ action: "hold", verb: HOLD_VERBS[ctx.hold], kind: "item" });
  } else if (!ctx.busy) {
    if (row.canWithdraw && remainingAmount(row) > 0n) options.push(item("withdraw-all", "Withdraw-All"));
    if (!withdrawn && row.availableAmount > 0n) options.push(item("withdraw-x", "Withdraw-X"));
    if (row.canTopUp) options.push(item("top-up", "Top-up"));
  }
  if (!ctx.busy) {
    if (ctx.advertised) options.push(item("stop-advertising", "Stop advertising"));
    else if (row.isInFlight && row.availableAmount > 0n && !onlyPeerPay(row.payouts)) options.push(item("advertise", "Advertise"));
  }
  options.push(item("examine", "Examine"));
  return options;
}

// ---------------------------------------------------------------------------
// Sell form: payout legs

export type LegTone = "good" | "bad" | "warn" | "pending" | "none";

export type LegAction =
  /** Run PeerAuth registration through the extension. */
  | "register"
  /** Register once at peer.xyz (no extension in this browser). */
  | "registerWeb"
  /** Install the PeerAuth extension (opens the Chrome Web Store). */
  | "install"
  /** "I've installed it": look for the extension again. */
  | "installed"
  /** Run the handle check again. */
  | "recheck"
  /** Stop a registration in progress. */
  | "cancelRegistration";

export interface LegStatus {
  tone: LegTone;
  text: string;
  actions: LegAction[];
}

const REGISTERING = new Set(["checkingExtension", "connecting", "awaitingCapture", "attesting", "registering"]);

function registrationText(phase: string, name: string): string {
  switch (phase) {
    case "checkingExtension":
      return "Looking for the Peer extension...";
    case "connecting":
      return "Allow RampRidge in the Peer extension.";
    case "awaitingCapture":
      return `Log in to ${name} in the tab Peer opened.`;
    case "attesting":
      return "Peer is verifying your account...";
    default:
      return "Registering your handle with Peer...";
  }
}

/**
 * Said of a handle the curator accepted without confirming the account
 * exists (some rails, like Zelle, take any well-formed handle): a typo that
 * belongs to someone else would send buyers' payments to them.
 */
export const UNCONFIRMED_HANDLE = "Peer can't confirm this account exists.";

type LegInput = Pick<SellLegView, "platform" | "payee" | "offchainId" | "check" | "issues" | "registration" | "canRegister" | "platformInfo">;

export interface LegStatusOptions {
  /** PeerAuth can be installed in this browser (desktop Chromium). */
  extensionSupported: boolean;
  /** PeerAuth's state while a handle needs registration (`SellFlow.extension`); null when unknown. */
  extension?: ExtensionStatus | null;
  /** The install page was opened and PeerAuth isn't found yet. */
  installPending?: boolean;
}

/** Said while PeerAuth is being installed: the extension may only reach this tab after a reload. */
export const EXTENSION_INSTALL_HINT = "Come back to this tab once it's installed. If it isn't found, reload the page and enter your handle again.";

/** Said on phones and browsers that can't install PeerAuth. */
export const EXTENSION_DESKTOP_ONLY =
  "Verifying needs the Peer extension, which runs on Chrome or Brave on a computer. Register this handle once on Peer's site there, then check again.";

/**
 * One line under a payout handle: green "Handle found" (only when Peer
 * confirmed the account exists), a yellow warning with the exact handle when
 * Peer accepted it without being able to confirm it, red "not found", a
 * one-time verification prompt, a check in flight, or a registration step.
 * `actions` are the buttons the line offers, in order.
 */
export function legStatus(leg: LegInput, opts: LegStatusOptions): LegStatus {
  const name = leg.platformInfo?.name ?? platformName(leg.platform);
  if (!leg.platform) return { tone: "none", text: "", actions: [] };

  const registration = leg.registration;
  if (registration && REGISTERING.has(registration.phase)) {
    return { tone: "pending", text: registrationText(registration.phase, name), actions: ["cancelRegistration"] };
  }
  // PeerAuth missing at the moment it is needed: offer the install there, as Peer's web app does.
  const needsInstall = opts.extensionSupported && opts.extension === "needs_install";
  const installActions: LegAction[] = opts.installPending ? ["install", "installed"] : ["install"];
  const registerAction: LegAction[] =
    leg.canRegister && opts.extensionSupported
      ? needsInstall
        ? installActions
        : ["register"]
      : leg.platformInfo?.registration
        ? ["registerWeb", "recheck"]
        : [];
  if (registration?.phase === "failed" && registration.error) {
    const code = registration.error.code;
    const actions: LegAction[] =
      code === "EXTENSION_MISSING"
        ? opts.extension && opts.extension !== "needs_install"
          ? ["register"]
          : installActions
        : leg.canRegister
          ? ["register"]
          : [];
    return { tone: "bad", text: registration.error.message, actions };
  }

  if (!leg.payee.trim()) return { tone: "none", text: "", actions: [] };
  if (!leg.offchainId) {
    const issue = leg.issues.find((i) => i.code === "PAYEE_INVALID" || i.code === "PAYEE_REQUIRED");
    return { tone: "bad", text: issue?.message ?? "That handle doesn't look right.", actions: [] };
  }
  const check = leg.check;
  if (check.status !== "done") {
    const registered = registration?.phase === "registered";
    return { tone: "pending", text: registered ? "Handle registered. Checking it..." : "Checking your handle...", actions: [] };
  }
  const result = check.result;
  switch (result.kind) {
    case "valid":
      return result.confirmed
        ? { tone: "good", text: "Handle found", actions: [] }
        : { tone: "warn", text: `${UNCONFIRMED_HANDLE} Buyers will pay exactly: ${displayPayee(leg.platform, result.offchainId)}`, actions: [] };
    case "notFound":
      return {
        tone: "bad",
        text: `That handle was not found on ${name}.${result.registration ? registrationHint(opts, needsInstall) : ""}`,
        actions: result.registration ? registerAction : ["recheck"],
      };
    case "needsIdentityAttestation":
      return {
        tone: "warn",
        text: `This handle needs a one-time Peer verification.${registrationHint(opts, needsInstall)}`,
        actions: registerAction.length ? registerAction : ["registerWeb", "recheck"],
      };
    case "invalidFormat":
      return { tone: "bad", text: result.message, actions: [] };
    case "error":
      return { tone: "bad", text: result.message, actions: result.retryable ? ["recheck"] : [] };
  }
}

/** What the player needs before registering: install PeerAuth, or a computer. */
function registrationHint(opts: LegStatusOptions, needsInstall: boolean): string {
  if (!opts.extensionSupported) return ` ${EXTENSION_DESKTOP_ONLY}`;
  if (needsInstall) return opts.installPending ? ` ${EXTENSION_INSTALL_HINT}` : " It runs through the Peer extension (PeerAuth): install it in Chrome first.";
  return "";
}

const LEG_ISSUES_SHOWN_BY_STATUS = new Set([
  "PAYEE_INVALID",
  "PAYEE_REQUIRED",
  "PAYEE_CHECKING",
  "PAYEE_NOT_FOUND",
  "PAYEE_NEEDS_REGISTRATION",
  "PAYEE_CHECK_FAILED",
  // The Zelle enrolment checkbox under the handle is its own explanation.
  "PAYEE_ENROLLMENT_REQUIRED",
]);

/** The leg's own blocking issue not already explained by its handle line or enrolment checkbox (platform, currency). */
export function legSetupIssue(issues: readonly SellIssue[]): SellIssue | null {
  return issues.find((i) => i.severity === "error" && !LEG_ISSUES_SHOWN_BY_STATUS.has(i.code)) ?? null;
}

const FORM_ISSUE_HIDDEN = new Set(["WALLET_REQUIRED", "NO_GAS"]);

/**
 * The single order-level line above the Deposit button: the first blocking
 * issue that is not about one leg (amount, balance), or a pending check.
 * Gas is shown on its own line, and logged-out players see the login view.
 */
export function formIssue(issues: readonly SellIssue[]): SellIssue | null {
  const general = issues.filter((i) => !i.legId && !FORM_ISSUE_HIDDEN.has(i.code));
  return general.find((i) => i.severity === "error") ?? general.find((i) => i.severity === "pending") ?? null;
}

// ---------------------------------------------------------------------------
// Sell form: review before depositing

export interface ReviewLeg {
  id: string;
  platform: string;
  /** "Revolut" */
  name: string;
  /** "GBP", "GBP or EUR" */
  currencies: string;
  /** The currency codes in order; the first is the one the estimate is for. */
  currencyCodes: SellLegView["currencies"];
  /** The handle buyers will pay, in full, as the player reads it ("@zezima", "you@example.com"). */
  handle: string;
  /** Peer confirmed the account exists; false means only its format was checked. */
  confirmed: boolean;
  /** The platform's own warning for sellers (Alipay's single-order risk control), when it has one. */
  warning: string | null;
}

type ReviewInput = Pick<SellLegView, "id" | "platform" | "currencies" | "offchainId" | "check" | "platformInfo">;

/**
 * What the review screen lists for each payout leg: exactly the handle and
 * currencies the deposit will carry. Null unless every leg has a handle that
 * passed its check, so the review can never show an order that isn't ready.
 */
export function reviewLegs(legs: readonly ReviewInput[]): ReviewLeg[] | null {
  if (legs.length === 0) return null;
  const rows: ReviewLeg[] = [];
  for (const leg of legs) {
    const check = leg.check;
    if (!leg.platform || !leg.offchainId || check.status !== "done" || check.result.kind !== "valid") return null;
    if (check.result.offchainId !== leg.offchainId) return null;
    rows.push({
      id: leg.id,
      platform: leg.platform,
      name: leg.platformInfo?.name ?? platformName(leg.platform),
      currencies: currencyList(leg.currencies),
      currencyCodes: [...leg.currencies],
      handle: displayPayee(leg.platform, leg.offchainId),
      confirmed: check.result.confirmed,
      warning: leg.platformInfo?.singleOrder?.warning ?? null,
    });
  }
  return rows;
}

/** The warning under the review list: what a wrong handle costs the seller. */
export function reviewWarning(legCount: number): string {
  return legCount > 1
    ? "Buyers pay exactly these handles. If one is wrong, they pay someone else and still receive your USDC."
    : "Buyers pay exactly this handle. If it's wrong, they pay someone else and still receive your USDC.";
}

// ---------------------------------------------------------------------------
// Submission steps and recovery

export const STEP_LABELS: Readonly<Record<SubmitStepId, string>> = {
  approve: "Approving your USDC",
  createDeposit: "Creating your offer",
  accessPolicy: "Setting buyer access",
};

export interface StepRow {
  id: SubmitStepId;
  label: string;
  status: SubmitStepStatus;
}

/** The steps to draw, in order; skipped steps are left out. */
export function stepRows(steps: SubmitSteps | null): StepRow[] {
  if (!steps) return [];
  return (["approve", "createDeposit", "accessPolicy"] as const)
    .filter((id) => steps[id] !== "skipped")
    .map((id) => ({ id, label: STEP_LABELS[id], status: steps[id] }));
}

/** Game messages for steps that just became active ("Creating your offer..."). */
export function newlyActiveSteps(prev: SubmitSteps | null, next: SubmitSteps | null): string[] {
  if (!next) return [];
  return (["approve", "createDeposit", "accessPolicy"] as const)
    .filter((id) => next[id] === "active" && prev?.[id] !== "active")
    .map((id) => `${STEP_LABELS[id]}...`);
}

export type ErrorButton = { kind: "recover" | "reconcile" | "discard" | "dismiss"; label: string };

/**
 * The buttons a sell error offers. Anything that may already be on-chain
 * (reconcile, retryAccessPolicy) only ever offers its recovery, never a new
 * deposit; "Start a new order" appears only once the sell module says the
 * attempt can be safely abandoned.
 */
export function errorButtons(error: Pick<SellFlowError, "recovery">): ErrorButton[] {
  const { action, canDiscard } = error.recovery;
  switch (action) {
    case "retry":
      return [{ kind: "recover", label: error.recovery.label || "Try again" }, { kind: "dismiss", label: "Edit order" }];
    case "reconcile":
      return canDiscard
        ? [{ kind: "reconcile", label: "Check status" }, { kind: "discard", label: "Start a new order" }]
        : [{ kind: "reconcile", label: "Check status" }];
    case "retryAccessPolicy":
      return [{ kind: "recover", label: "Finish setup" }];
    case "editForm":
    case "fundWallet":
      return [{ kind: "dismiss", label: "Edit order" }];
    default:
      return [{ kind: "dismiss", label: "OK" }];
  }
}

/** True when the error may describe something on-chain, so the form must stay hidden. */
export function errorBlocksForm(error: Pick<SellFlowError, "recovery"> | null): boolean {
  return error?.recovery.action === "reconcile" || error?.recovery.action === "retryAccessPolicy";
}

// ---------------------------------------------------------------------------
// Collection box

export type FillTone = "good" | "pending" | "bad";

export interface FillRow {
  key: string;
  amount: string;
  buyer: string;
  buyerShort: string;
  /** "Paid $40.00", "Paying, owes £23.58", "Expired, not paid", "Released". */
  outcome: string;
  tone: FillTone;
  /** Unix seconds of the most relevant event. */
  at: number | null;
}

function fillOutcome(f: CashFill, nowSeconds: number): { outcome: string; tone: FillTone } {
  const paidCurrency = f.paidCurrency ?? f.currency;
  const paid = typeof f.fiatPaid === "number" && paidCurrency ? fiatText(f.fiatPaid, paidCurrency) : null;
  switch (f.status) {
    case "FULFILLED":
      return { outcome: paid ? `Paid ${paid}` : "Paid", tone: "good" };
    case "MANUALLY_RELEASED":
      return { outcome: paid ? `Released, paid ${paid}` : "Released", tone: "good" };
    case "SIGNALED":
      if (!isFillLive(f, nowSeconds)) return { outcome: "Expired, not paid", tone: "bad" };
      return { outcome: typeof f.fiatOwed === "number" && f.currency ? `Paying, owes ${fiatText(f.fiatOwed, f.currency)}` : "Paying", tone: "pending" };
    case "PRUNED":
      return { outcome: "Expired, not paid", tone: "bad" };
    default:
      return { outcome: String(f.status), tone: "pending" };
  }
}

/**
 * A completed or closed order's fills, newest first. Only a buyer who is
 * still paying "owes" anything; an expired buyer never paid and owes nothing.
 */
export function fillRows(fills: readonly CashFill[], nowSeconds: number = Math.floor(Date.now() / 1000)): FillRow[] {
  return [...fills]
    .sort((a, b) => (b.fulfilledAt ?? b.signaledAt ?? 0) - (a.fulfilledAt ?? a.signaledAt ?? 0))
    .map((f) => ({
      key: f.intentHash,
      amount: `${usdcText(f.releasedAmount ?? f.amount)} USDC`,
      buyer: f.buyer,
      buyerShort: shortAddr(f.buyer),
      ...fillOutcome(f, nowSeconds),
      at: f.fulfilledAt ?? f.prunedAt ?? f.signaledAt ?? null,
    }));
}

/** "11 Oct 2026" from unix seconds, or "" when unknown. */
export function dateText(seconds: number | null | undefined): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
