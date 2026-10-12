/**
 * Harness scenarios: each one is a fixture wallet, a fake chain and an
 * opening interface, plus optional draft input and clicks, so every state of
 * the bank, sell and collection interfaces can be reached from a URL
 * (`/dev/bank.html?state=<id>`). Dev only.
 */

import type { CurrencyType } from "@zkp2p/cash";
import type { Address } from "viem";
import type { PendingSellRecord } from "@/peer/sell";
import type { WalletKind } from "@/wallet/types";
import type { OpenInterface } from "../../context";
import { USDC, depositIdOf, fakeFill, methodHash, type FakeOrderSpec, type OrdersMode, type SendFailure } from "./fakes";

export interface ScenarioWallet {
  kind: WalletKind;
  sponsored: boolean;
  usdc: bigint;
  eth: bigint;
}

export interface DraftLeg {
  platform: string;
  currencies: CurrencyType[];
  payee: string;
  /** The normalised handle the seller confirmed is enrolled (Zelle). */
  enrolledFor?: string;
}

export interface Scenario {
  id: string;
  group: "Bank" | "Sell" | "Collection";
  label: string;
  open: OpenInterface;
  /** Null starts logged out (Log in switches to a smart wallet). */
  wallet: ScenarioWallet | null;
  orders?: FakeOrderSpec[];
  ordersMode?: OrdersMode;
  sendDelayMs?: number;
  sendFailure?: SendFailure;
  /** Sell draft typed into the real sell store before the interface opens. */
  draft?: { amount: string; legs: DraftLeg[]; spreadBps?: number };
  /** A pending deposit record from an earlier (interrupted) session. */
  pending?: (owner: Address) => PendingSellRecord;
  /** Orders that exist on the chain for a recovery but were not in the list before. */
  stall?: number | null;
  /** CSS selectors (or `selector|text`) clicked in order once each is enabled. */
  autoClick?: string[];
  verified?: boolean;
  /** PeerAuth in this browser (default: the real `window.peer`, which headless Chrome lacks). */
  extension?: "missing" | "installs" | "unsupported" | "ready";
  /** How long after the last click the page counts as settled for screenshots (default 2.5 s). */
  settleMs?: number;
  /** A selector scrolled into view once settled (e.g. a leg's status line below the fold). */
  reveal?: string;
}

const SMART: ScenarioWallet = { kind: "smart", sponsored: true, usdc: USDC(1250.4), eth: 0n };
const EXTERNAL_NO_GAS: ScenarioWallet = { kind: "external", sponsored: false, usdc: USDC(830.25), eth: 0n };
const EXTERNAL_GAS: ScenarioWallet = { kind: "external", sponsored: false, usdc: USDC(830.25), eth: 2_000_000_000_000_000n };

export const MIXED_ORDERS: FakeOrderSpec[] = [
  { id: 1201, total: USDC(500), state: "awaiting-buyer", legs: [{ platform: "revolut", currencies: ["GBP", "EUR"] }], ageSeconds: 1_800 },
  {
    id: 1188,
    total: USDC(250),
    filled: USDC(120),
    pending: USDC(50),
    state: "delivering",
    legs: [{ platform: "venmo", currencies: ["USD"] }],
    fills: [
      fakeFill({ n: 1, amount: 120, status: "FULFILLED", currency: "USD", ageSeconds: 7_200 }),
      fakeFill({ n: 2, amount: 50, status: "SIGNALED", currency: "USD", ageSeconds: 300 }),
    ],
    ageSeconds: 300,
  },
  {
    id: 1175,
    total: USDC(1250),
    pending: USDC(100),
    state: "matched",
    legs: [{ platform: "wise", currencies: ["EUR", "GBP", "USD"] }],
    fills: [fakeFill({ n: 10, amount: 100, status: "SIGNALED", currency: "EUR", ageSeconds: 120, expiresInSeconds: 1_680 })],
    ageSeconds: 120,
  },
  { id: 1160, total: USDC(12_500), state: "awaiting-buyer", legs: [{ platform: "zelle", currencies: ["USD"] }], ageSeconds: 86_400 },
  { id: 1150, total: USDC(3.5), state: "awaiting-buyer", legs: [{ platform: "monzo", currencies: ["GBP"] }], ageSeconds: 4_000 },
  {
    id: 1102,
    total: USDC(100),
    filled: USDC(100),
    state: "delivered",
    legs: [{ platform: "cashapp", currencies: ["USD"] }],
    fills: [
      fakeFill({ n: 3, amount: 60, status: "FULFILLED", currency: "USD", ageSeconds: 200_000 }),
      fakeFill({ n: 4, amount: 40, status: "FULFILLED", currency: "USD", ageSeconds: 180_000 }),
    ],
    ageSeconds: 180_000,
  },
  {
    id: 1090,
    total: USDC(75.5),
    filled: USDC(25),
    returned: USDC(50.5),
    state: "returned",
    withdrawn: true,
    legs: [{ platform: "monzo", currencies: ["GBP"] }],
    fills: [
      fakeFill({ n: 5, amount: 25, status: "FULFILLED", currency: "GBP", ageSeconds: 400_000 }),
      fakeFill({ n: 6, amount: 30, status: "PRUNED", currency: "GBP", ageSeconds: 390_000 }),
    ],
    ageSeconds: 380_000,
  },
  {
    id: 1085,
    total: USDC(40),
    filled: USDC(10),
    returned: USDC(30),
    state: "returned",
    withdrawn: true,
    legs: [{ platform: "revolut", currencies: ["EUR"] }],
    fills: [
      fakeFill({ n: 7, amount: 10, status: "FULFILLED", currency: "EUR", ageSeconds: 600_000 }),
      fakeFill({ n: 8, amount: 30, status: "PRUNED", currency: "EUR", ageSeconds: 590_000 }),
    ],
    ageSeconds: 580_000,
  },
];

const LIVE_ONLY = MIXED_ORDERS.filter((o) => o.state === "awaiting-buyer" || o.state === "matched" || o.state === "delivering");

/** A spread order: Revolut GBP and EUR at the market rate +1.00%. */
const SPREAD_ORDER: FakeOrderSpec = {
  id: 1225,
  total: USDC(300),
  state: "awaiting-buyer",
  legs: [{ platform: "revolut", currencies: ["GBP", "EUR"], spreadBps: 100 }],
  ageSeconds: 900,
};
const WISE_NEW = { amount: "400", legs: [{ platform: "wise", currencies: ["EUR"] as CurrencyType[], payee: "newseller" }] };
const ZELLE_EMAIL = "zezima.banker@example.com";

/** A buyer signalled for 80 of 300 USDC and let their time run out; nobody has pruned the intent yet. */
const EXPIRED_HOLD: FakeOrderSpec = {
  id: 1180,
  total: USDC(300),
  pending: USDC(80),
  state: "matched",
  legs: [{ platform: "revolut", currencies: ["GBP"] }],
  fills: [fakeFill({ n: 11, amount: 80, status: "SIGNALED", currency: "GBP", ageSeconds: 3_000, expiresInSeconds: -1_200 })],
  ageSeconds: 3_000,
};

const READY_DRAFT = { amount: "250", legs: [{ platform: "revolut", currencies: ["GBP"] as CurrencyType[], payee: "zezima" }] };
/** A Venmo payout: only Peer Pay merchants can buy from it, so it is never advertised as a stall. */
const VENMO_DRAFT = { amount: "150", legs: [{ platform: "venmo", currencies: ["USD"] as CurrencyType[], payee: "zezima" }] };
/** A Zelle handle: the curator accepts any well-formed one without confirming the account exists. */
const UNCONFIRMED_DRAFT = { amount: "250", legs: [{ platform: "zelle", currencies: ["USD"] as CurrencyType[], payee: "zezima.the.great.banker@example-mail.com" }] };
/** Deposit opens the review; Confirm sends. */
const REVIEW = ["[data-bank-deposit]"];
const DEPOSIT = ["[data-bank-deposit]", "[data-bank-confirm]"];

function pendingRecord(owner: Address, extra: Partial<PendingSellRecord> & Pick<PendingSellRecord, "stage" | "startedAt">): PendingSellRecord {
  return {
    v: 1,
    owner: owner.toLowerCase(),
    amount: USDC(250).toString(),
    legs: [{ platform: "revolut", currencies: ["GBP"] }],
    knownDepositIds: MIXED_ORDERS.map((o) => depositIdOf(o.id)),
    baseline: { nonce: 41, isContract: true, usdcBalance: USDC(1250.4).toString() },
    accessPolicyPaymentMethods: [],
    policyTxHashes: {},
    ...extra,
  };
}

export const SCENARIOS: Scenario[] = [
  // Bank
  { id: "bank-logged-out", group: "Bank", label: "Bank: logged out", open: { id: "bank" }, wallet: null },
  { id: "bank-loading", group: "Bank", label: "Bank: loading", open: { id: "bank" }, wallet: SMART, ordersMode: "loading" },
  { id: "bank-error", group: "Bank", label: "Bank: orders failed to load", open: { id: "bank" }, wallet: SMART, ordersMode: "error" },
  { id: "bank-empty", group: "Bank", label: "Bank: no offers", open: { id: "bank" }, wallet: SMART, orders: [] },
  { id: "bank-items", group: "Bank", label: "Bank: offers (one advertised)", open: { id: "bank" }, wallet: SMART, orders: MIXED_ORDERS, stall: 1201, verified: true },
  { id: "bank-slow-wallet", group: "Bank", label: "Bank: slow wallet (actions wait)", open: { id: "bank" }, wallet: SMART, orders: MIXED_ORDERS, sendDelayMs: 6_000, stall: null },
  { id: "bank-reject", group: "Bank", label: "Bank: wallet rejects", open: { id: "bank" }, wallet: SMART, orders: MIXED_ORDERS, sendFailure: "reject" },
  { id: "bank-unknown", group: "Bank", label: "Bank: withdraw outcome unknown", open: { id: "bank" }, wallet: SMART, orders: MIXED_ORDERS, sendFailure: "unknown" },
  {
    id: "bank-unknown-lands",
    group: "Bank",
    label: "Bank: outcome unknown, then it lands",
    open: { id: "bank" },
    wallet: SMART,
    orders: MIXED_ORDERS,
    sendFailure: "unknown-lands",
  },
  {
    id: "bank-unknown-reverts",
    group: "Bank",
    label: "Bank: outcome unknown, then it reverted",
    open: { id: "bank" },
    wallet: SMART,
    orders: MIXED_ORDERS,
    sendFailure: "unknown-reverts",
  },
  { id: "bank-spread", group: "Bank", label: "Bank: an offer at the market rate +1%", open: { id: "bank" }, wallet: SMART, orders: [SPREAD_ORDER, ...LIVE_ONLY] },
  {
    id: "bank-spread-examine",
    group: "Bank",
    label: "Bank: examine an offer at +1%",
    open: { id: "bank" },
    wallet: SMART,
    orders: [SPREAD_ORDER, ...LIVE_ONLY],
    autoClick: [".bk-bank button.rs-slot|300", ".rs-menu__row|Examine"],
  },
  { id: "bank-expired-hold", group: "Bank", label: "Bank: a buyer's time ran out", open: { id: "bank" }, wallet: SMART, orders: [EXPIRED_HOLD, ...LIVE_ONLY] },

  // Sell
  { id: "sell-logged-out", group: "Sell", label: "Sell: logged out", open: { id: "sell" }, wallet: null },
  { id: "sell-empty", group: "Sell", label: "Sell: new offer", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY },
  { id: "sell-prefill", group: "Sell", label: "Sell: opened for Wise EUR", open: { id: "sell", platform: "wise", currency: "EUR" }, wallet: SMART, orders: LIVE_ONLY },
  { id: "sell-ready", group: "Sell", label: "Sell: ready (handle found)", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: READY_DRAFT },
  {
    id: "sell-unconfirmed",
    group: "Sell",
    label: "Sell: ready, handle Peer can't confirm",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: UNCONFIRMED_DRAFT,
  },
  { id: "sell-review", group: "Sell", label: "Sell: review before depositing", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: READY_DRAFT, autoClick: REVIEW },
  { id: "sell-venmo", group: "Sell", label: "Sell: Venmo (Peer Pay merchants only)", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: VENMO_DRAFT },
  { id: "sell-review-venmo", group: "Sell", label: "Sell: review a Venmo offer", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: VENMO_DRAFT, autoClick: REVIEW },
  {
    id: "sell-listed-venmo",
    group: "Sell",
    label: "Sell: Venmo offer live (no Advertise)",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: VENMO_DRAFT,
    sendDelayMs: 1_200,
    autoClick: DEPOSIT,
  },
  {
    id: "sell-review-multi",
    group: "Sell",
    label: "Sell: review, two handles (one unconfirmed)",
    open: { id: "sell" },
    wallet: EXTERNAL_GAS,
    orders: LIVE_ONLY,
    draft: {
      amount: "600",
      legs: [
        { platform: "revolut", currencies: ["GBP", "EUR", "USD"], payee: "zezima" },
        // Enrolment confirmed, or Deposit stays off and the review never opens.
        { platform: "zelle", currencies: ["USD"], payee: "zezima.the.great.banker@example-mail.com", enrolledFor: "zezima.the.great.banker@example-mail.com" },
      ],
    },
    autoClick: REVIEW,
  },
  { id: "sell-spread", group: "Sell", label: "Sell: price 0.30% above the market", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: { ...READY_DRAFT, spreadBps: 30 } },
  { id: "sell-spread-below", group: "Sell", label: "Sell: price 1.20% below the market", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: { ...READY_DRAFT, spreadBps: -120 } },
  {
    id: "sell-review-spread",
    group: "Sell",
    label: "Sell: review an offer at +0.30%",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { ...READY_DRAFT, spreadBps: 30 },
    autoClick: REVIEW,
  },
  { id: "sell-verify-install", group: "Sell", label: "Sell: verification needs PeerAuth (not installed)", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: WISE_NEW, extension: "missing", reveal: ".bk-leg__status" },
  {
    id: "sell-verify-installing",
    group: "Sell",
    label: "Sell: PeerAuth install page opened",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: WISE_NEW,
    extension: "missing",
    reveal: ".bk-leg__status",
    autoClick: [".bk-leg__status button|Install"],
  },
  {
    id: "sell-verify-installed",
    group: "Sell",
    label: "Sell: PeerAuth installed (found on return)",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: WISE_NEW,
    extension: "installs",
    reveal: ".bk-leg__status",
    autoClick: [".bk-leg__status button|Install"],
    settleMs: 7_000,
  },
  { id: "sell-verify-phone", group: "Sell", label: "Sell: verification on a phone (no PeerAuth)", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: WISE_NEW, extension: "unsupported", reveal: ".bk-leg__status" },
  {
    id: "sell-zelle-unticked",
    group: "Sell",
    label: "Sell: Zelle, enrolment not confirmed",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "250", legs: [{ platform: "zelle", currencies: ["USD"], payee: ZELLE_EMAIL }] },
  },
  {
    id: "sell-zelle-ticked",
    group: "Sell",
    label: "Sell: Zelle, enrolment confirmed",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "250", legs: [{ platform: "zelle", currencies: ["USD"], payee: ZELLE_EMAIL, enrolledFor: ZELLE_EMAIL }] },
  },
  {
    id: "sell-alipay-min",
    group: "Sell",
    label: "Sell: Alipay below its 10 USDC minimum",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "8", legs: [{ platform: "alipay", currencies: ["CNY"], payee: "zezima.trader@example.com" }] },
  },
  {
    id: "sell-alipay",
    group: "Sell",
    label: "Sell: Alipay ready (single order, risk warning)",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "120", legs: [{ platform: "alipay", currencies: ["CNY"], payee: "zezima.trader@example.com" }] },
  },
  {
    id: "sell-checking",
    group: "Sell",
    label: "Sell: checking handle",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "250", legs: [{ platform: "revolut", currencies: ["GBP"], payee: "slowpoke" }] },
  },
  {
    id: "sell-not-found",
    group: "Sell",
    label: "Sell: handle not found",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "250", legs: [{ platform: "revolut", currencies: ["GBP"], payee: "unknownuser" }] },
  },
  {
    id: "sell-verify",
    group: "Sell",
    label: "Sell: handle needs Peer verification",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "400", legs: [{ platform: "wise", currencies: ["EUR"], payee: "newseller" }] },
  },
  {
    id: "sell-check-error",
    group: "Sell",
    label: "Sell: handle check failed",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "250", legs: [{ platform: "venmo", currencies: ["USD"], payee: "error-test" }] },
  },
  {
    id: "sell-multi",
    group: "Sell",
    label: "Sell: two payout methods, multi-currency",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: {
      amount: "600",
      legs: [
        { platform: "revolut", currencies: ["GBP", "EUR", "USD"], payee: "zezima" },
        { platform: "venmo", currencies: ["USD"], payee: "zezima-rs" },
      ],
    },
  },
  {
    id: "sell-too-much",
    group: "Sell",
    label: "Sell: more than the wallet holds",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "5000", legs: [{ platform: "revolut", currencies: ["GBP"], payee: "zezima" }] },
  },
  { id: "sell-no-gas", group: "Sell", label: "Sell: external wallet without ETH", open: { id: "sell" }, wallet: EXTERNAL_NO_GAS, orders: LIVE_ONLY, draft: READY_DRAFT },
  { id: "sell-external", group: "Sell", label: "Sell: external wallet with ETH", open: { id: "sell" }, wallet: EXTERNAL_GAS, orders: LIVE_ONLY, draft: READY_DRAFT },
  { id: "sell-submitting", group: "Sell", label: "Sell: depositing (steps)", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: READY_DRAFT, sendDelayMs: 600_000, autoClick: DEPOSIT },
  {
    id: "sell-policy",
    group: "Sell",
    label: "Sell: Venmo (buyer access step)",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    draft: { amount: "150", legs: [{ platform: "venmo", currencies: ["USD"], payee: "zezima-rs" }] },
    sendDelayMs: 2_500,
    autoClick: DEPOSIT,
  },
  { id: "sell-listed", group: "Sell", label: "Sell: offer live", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: READY_DRAFT, sendDelayMs: 1_200, autoClick: DEPOSIT },
  { id: "sell-rejected", group: "Sell", label: "Sell: cancelled in wallet", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: READY_DRAFT, sendDelayMs: 800, sendFailure: "reject", autoClick: DEPOSIT },
  { id: "sell-unknown", group: "Sell", label: "Sell: outcome unknown (reconcile)", open: { id: "sell" }, wallet: SMART, orders: LIVE_ONLY, draft: READY_DRAFT, sendDelayMs: 800, sendFailure: "unknown", autoClick: DEPOSIT },
  {
    id: "sell-recover-pending",
    group: "Sell",
    label: "Sell: after refresh, deposit not found yet",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    pending: (owner) => pendingRecord(owner, { stage: "sending", startedAt: Date.now() - 2 * 60_000 }),
  },
  {
    id: "sell-recover-discard",
    group: "Sell",
    label: "Sell: after refresh, safe to start again",
    open: { id: "sell" },
    wallet: SMART,
    orders: LIVE_ONLY,
    pending: (owner) => pendingRecord(owner, { stage: "sending", startedAt: Date.now() - 15 * 60_000 }),
  },
  {
    id: "sell-recover-policy",
    group: "Sell",
    label: "Sell: after refresh, buyer access missing",
    open: { id: "sell" },
    wallet: SMART,
    orders: [...LIVE_ONLY, { id: 1210, total: USDC(150), state: "awaiting-buyer", legs: [{ platform: "venmo", currencies: ["USD"] }], ageSeconds: 90 }],
    sendDelayMs: 1_500,
    pending: (owner) =>
      pendingRecord(owner, {
        stage: "deposited",
        startedAt: Date.now() - 3 * 60_000,
        amount: USDC(150).toString(),
        legs: [{ platform: "venmo", currencies: ["USD"] }],
        depositId: depositIdOf(1210),
        accessPolicyPaymentMethods: [methodHash("venmo")],
      }),
  },
  {
    id: "sell-recover-listed",
    group: "Sell",
    label: "Sell: after refresh, deposit found",
    open: { id: "sell" },
    wallet: SMART,
    orders: [...LIVE_ONLY, { id: 1211, total: USDC(250), state: "awaiting-buyer", legs: [{ platform: "revolut", currencies: ["GBP"] }], ageSeconds: 30 }],
    pending: (owner) => pendingRecord(owner, { stage: "sending", startedAt: Date.now() - 60_000 }),
  },

  // Collection box
  { id: "collection-logged-out", group: "Collection", label: "Collection: logged out", open: { id: "collection" }, wallet: null },
  { id: "collection-loading", group: "Collection", label: "Collection: loading", open: { id: "collection" }, wallet: SMART, ordersMode: "loading" },
  { id: "collection-empty", group: "Collection", label: "Collection: nothing to collect", open: { id: "collection" }, wallet: SMART, orders: LIVE_ONLY },
  { id: "collection-items", group: "Collection", label: "Collection: completed offers", open: { id: "collection" }, wallet: SMART, orders: MIXED_ORDERS, sendDelayMs: 2_000 },
  {
    id: "collection-collect",
    group: "Collection",
    label: "Collection: closed offer with USDC left",
    open: { id: "collection" },
    wallet: SMART,
    sendDelayMs: 2_000,
    orders: [
      ...MIXED_ORDERS.filter((o) => o.state === "delivered"),
      { id: 1070, total: USDC(60), filled: USDC(20), state: "returned", legs: [{ platform: "venmo", currencies: ["USD"] }], fills: [fakeFill({ n: 9, amount: 20, status: "FULFILLED", currency: "USD", ageSeconds: 90_000 })], ageSeconds: 80_000 },
    ],
  },
];

export function findScenario(id: string | null): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS.find((s) => s.id === "bank-items")!;
}

/** A distinct fixture address per scenario, so pending records and in-flight guards never collide. */
export function scenarioAddress(id: string): Address {
  let h = 0x811c9dc5;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return `0x${h.toString(16).padStart(8, "0")}${"5eed".repeat(8)}` as Address;
}
