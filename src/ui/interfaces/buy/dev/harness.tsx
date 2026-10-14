/**
 * Dev harness for the buy interfaces (Exchange, Trade, Payment, Verify).
 * Open http://localhost:<port>/dev/buy.html. Each scenario builds the REAL
 * buy store (createBuyStore) over fake Peer, wallet, extension and Cash
 * clients and drives it with real actions into the state named, then renders
 * the interface inside the real GameFrame. `?state=<id>` picks a scenario,
 * `?bare=1` hides the switcher (screenshots), `?scene=0` skips the 3D bank.
 */
import "@/lib/polyfills";
import "@/styles/index.css";
import "./harness.css";

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBuyStore, memoryOrderStorage, type BuyFlowStore, type BuyOrder } from "@/peer/buy";
import { BUY_PLATFORMS, resolveVerifyMethod, type BuyPlatformId, type FiatCode } from "@/peer/platforms";
import { publicClient } from "@/wallet/publicClient";
import type { TxSender } from "@/wallet/types";
import { GameFrame, InventoryPanel, MINIMAP_SIZE, appendLines, chatLine, gameMessage, type ChatLine } from "@/ui/frame";
import { Sprite, StoneButton, Window, coinsSpriteFor, ensureSprites, useIsMobile } from "@/ui/kit";
import { mountBankBackdrop } from "@/ui/dev/sceneBackdrop";
import { GameContext, type GameContextValue, type OpenInterface } from "../../context";
import { BuyUiDepsProvider, type BuyUiDeps } from "../deps";
import { interfaces } from "../index";
import {
  ALIPAY_PID,
  BUYER,
  ESCROW,
  PAYEES,
  STALL_DEPOSIT,
  capturedRows,
  fakeCash,
  fakeChain,
  fakeExtension,
  fakeInstallPage,
  fakeMarket,
  type ChainOptions,
  type ExtensionOptions,
  type MarketOptions,
  type SellMode,
  type Timing,
} from "../simulated";

void ensureSprites();

const params = new URLSearchParams(window.location.search);
const BARE = params.get("bare") === "1";
const SCENE = params.get("scene") !== "0";
/** `?computer=1` shows the "verify on a computer" notices on any browser, `?computer=0` hides them; default: this browser's own answer. */
const COMPUTER = params.get("computer");

try {
  window.localStorage.removeItem("rampridge:buy-ui:celebrated");
} catch {
  // Storage blocked: nothing to clear.
}

// ---------------------------------------------------------------------------
// Scenarios

interface Env {
  store: ReturnType<typeof createBuyStore>;
  sender: TxSender;
  timing: Timing;
  clock: { offset: number; now: () => number };
  storage: ReturnType<typeof memoryOrderStorage>;
  /** The fake extension's live options: flip `installed` to have PeerAuth appear. */
  extension: ExtensionOptions;
}

interface Scenario {
  id: string;
  group: "Exchange" | "Trade" | "Payment" | "Verify";
  label: string;
  open: OpenInterface;
  loggedIn?: boolean;
  market?: Partial<MarketOptions>;
  chain?: Partial<ChainOptions>;
  ext?: Partial<ExtensionOptions>;
  canInstall?: boolean;
  sells?: SellMode;
  /** Timing used once the scenario is set up (setup always runs fast). */
  timing?: Partial<Timing>;
  announceFails?: boolean;
  /** false: an external wallet that pays its own gas (the confirm screens say so). */
  sponsored?: boolean;
  /** Currencies the shell reports as liquid; null while the market is unknown. Defaults to the fixture market's. */
  liquid?: readonly string[] | null;
  setup?: (env: Env) => Promise<void>;
  /** Clicks to make after the interface renders, by accessible name or text. */
  clicks?: string[];
  /** Curator's Alipay maker has no 16-digit PID, so there is no QR to pay with. */
  pidMissing?: boolean;
}

const GBP_REVOLUT = { fiat: "100", currency: "GBP" as FiatCode, platform: "revolut" as BuyPlatformId };
const MERCHANT: OpenInterface = { id: "trade", target: { kind: "merchant", merchantId: "m-revolut-gbp", name: "Revolut GBP merchant", platform: "revolut", currency: "GBP" } };
const STALL: OpenInterface = { id: "trade", target: { kind: "stall", pid: "p-woox", name: "Woox", stall: STALL_DEPOSIT } };
/** A merchant whose shout quoted its offer at £250. */
const MERCHANT_QUOTED: OpenInterface = {
  id: "trade",
  target: { kind: "merchant", merchantId: "m-revolut-gbp", name: "Revolut GBP merchant", platform: "revolut", currency: "GBP", fiatAmount: 250 },
};
/**
 * The US market as fork tests found it before launch: nobody sells on Venmo or
 * PayPal (their Peer Cash orders are Peer Pay only) and Cash App sits about
 * 15% above Zelle.
 */
const US_LAUNCH: Partial<MarketOptions> = { rateFactors: { venmo: null, paypal: null, zelle: 1, cashapp: 1.15, chime: 1.01 } };
/** A player's Venmo stall: a Peer Pay only sell order no player can take. */
const VENMO_STALL: OpenInterface = {
  id: "trade",
  target: { kind: "stall", pid: "p-woox", name: "Woox", stall: { ...STALL_DEPOSIT, platform: "venmo", currency: "USD", rate: "1.0200" } },
};
/** Currencies the fixture market fills (fakes.ts BASE_RATES), as the shell's market book would report them. */
const FIXTURE_LIQUID = ["USD", "EUR", "GBP", "AUD", "CAD", "JPY", "MXN", "ARS", "INR", "CNY"];
/** Yuan and rupees as Peer lists them: Alipay and UPI sellers, nobody selling yuan on Wise or rupees on Wise. */
const CNY_INR: Partial<MarketOptions> = { rateFactors: { alipay: 0.99, revolut: 1.004, wise: null, upi: 1 } };
const ALIPAY_ORDER = { fiat: "712", currency: "CNY" as FiatCode, platform: "alipay" as BuyPlatformId };
const UPI_ORDER = { fiat: "8850", currency: "INR" as FiatCode, platform: "upi" as BuyPlatformId };
const UPI_MERCHANT: OpenInterface = {
  id: "trade",
  target: { kind: "merchant", merchantId: "upi:INR", name: "UPI trader", platform: "upi", currency: "INR", fiatAmount: 8_843 },
};
const ACK = '[class~="rb-pay__ack"] input';
/** An Alipay order saved before its seller's PID was known, recovered after a reload. */
async function reloadAlipayNoPid(env: Env) {
  env.storage.save(
    storedOrder({
      platform: "alipay",
      currency: "CNY",
      rate: 7_124_000_000_000_000_000n,
      fiatToSend: 712_000_000n,
      fiatToSendText: "712.00",
      payeeHandle: PAYEES.alipay ?? "seller@example.com",
      usdcGross: 99_943_851n,
      usdcExpected: 98_495_665n,
      fees: null,
    }),
  );
  env.store.getState().bindSender(env.sender);
  await waitFor(env.store, (s) => !s.recovering && s.order !== null);
}

async function waitFor(store: Env["store"], predicate: (s: BuyFlowStore) => boolean, ms = 8000): Promise<void> {
  if (predicate(store.getState())) return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsub();
      reject(new Error(`Scenario did not reach its state (step ${store.getState().step})`));
    }, ms);
    const unsub = store.subscribe((s) => {
      if (predicate(s)) {
        window.clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}

async function bind(env: Env) {
  env.store.getState().bindSender(env.sender);
  await waitFor(env.store, (s) => !s.recovering);
}

async function place(env: Env, o: { fiat: string; currency: FiatCode; platform: BuyPlatformId } = GBP_REVOLUT) {
  await bind(env);
  await env.store.getState().requestQuotes({ fiatAmount: o.fiat, currency: o.currency, platforms: [o.platform] });
  const quote = env.store.getState().quotes[0];
  if (!quote) throw new Error("no fixture quote");
  env.store.getState().selectQuote(quote.id);
  void env.store.getState().confirm();
  await waitFor(env.store, (s) => s.step === "awaitingPayment" && s.order?.status === "active");
}

async function toSelect(env: Env) {
  await place(env);
  void env.store.getState().markPaid();
  await waitFor(env.store, (s) => s.step === "selectPayment");
}

/** The release fails (fulfil "network") after the player picked their payment. */
async function releaseFails(env: Env) {
  await toSelect(env);
  await env.store.getState().choosePayment(env.store.getState().payments[0]!.index);
  await waitFor(env.store, (s) => s.step === "error");
}

/** The order expires; the player says they paid before it did, but the extension finds no payment yet. */
async function expiredNothingFound(env: Env & { emptyCapture?: boolean }) {
  await place(env);
  env.clock.offset = 7 * 3_600_000;
  env.emptyCapture = true;
  void env.store.getState().markPaid();
  await waitFor(env.store, (s) => s.step === "error");
}

/** Placing an offer is refused: an older open order from elsewhere blocks it. */
async function blockedByOlder(env: Env) {
  await bind(env);
  await env.store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
  env.store.getState().selectQuote(env.store.getState().quotes[0]!.id);
  await env.store.getState().confirm();
  await waitFor(env.store, (s) => s.step === "error" && s.blockingIntent !== null);
}

async function placeExpired(env: Env) {
  await place(env);
  env.clock.offset = 7 * 3_600_000;
}

function storedOrder(overrides: Partial<BuyOrder> = {}): BuyOrder {
  const now = Date.now();
  return {
    owner: BUYER.toLowerCase() as BuyOrder["owner"],
    intentHash: `0x${"7e".repeat(32)}`,
    depositId: "6528",
    escrow: ESCROW,
    orchestrator: null,
    platform: "revolut",
    currency: "GBP",
    usdcGross: 126_582_278n,
    usdcExpected: 124_746_836n,
    rate: 790_000_000_000_000_000n,
    fiatToSend: 100_000_000n,
    fiatToSendText: "100.00",
    payeeHandle: "revtag",
    payeeDetailsHash: `0x${"9a".repeat(32)}`,
    signalTxHash: null,
    signaledAt: now - 20 * 60_000,
    expiresAt: now + 5 * 3_600_000,
    verifyMethodId: null,
    memo: null,
    status: "active",
    // Peer 0.95% and RampRidge 0.5% of the gross, as the quote priced them.
    fees: { serviceBps: 95, service: 1_202_531n, manager: 0n, referrer: 632_911n, referrerBps: 50, total: 1_835_442n },
    paidClaimedAt: null,
    ...overrides,
  };
}

/** A reload after the player said they paid: the stored order carries the claim and is recovered from the chain. */
async function reloadPaidClaimed(env: Env) {
  env.storage.save(storedOrder({ paidClaimedAt: Date.now() - 4 * 60_000 }));
  env.store.getState().bindSender(env.sender);
  await waitFor(env.store, (s) => !s.recovering && s.order !== null);
}

const SCENARIOS: Scenario[] = [
  // Exchange
  { id: "ex-empty", group: "Exchange", label: "Slots: empty", open: { id: "exchange" }, sells: "none", setup: bind },
  { id: "ex-slots", group: "Exchange", label: "Slots: buy order + sell orders", open: { id: "exchange" }, sells: "some", setup: (e) => place(e) },
  { id: "ex-full", group: "Exchange", label: "Slots: overflowing sell orders", open: { id: "exchange" }, sells: "many", setup: (e) => place(e) },
  {
    id: "ex-verifying",
    group: "Exchange",
    label: "Slots: buy order verifying",
    open: { id: "exchange" },
    sells: "some",
    timing: { captureMs: null },
    setup: async (e) => {
      await place(e);
      e.timing.captureMs = null;
      void e.store.getState().markPaid();
      await waitFor(e.store, (s) => s.verifying === "capturing");
    },
  },
  {
    id: "ex-expired",
    group: "Exchange",
    label: "Slots: expired buy order",
    open: { id: "exchange" },
    sells: "none",
    setup: async (e) => {
      await place(e);
      e.clock.offset = 7 * 3_600_000;
    },
  },
  {
    id: "ex-completed",
    group: "Exchange",
    label: "Slots: completed buy",
    open: { id: "exchange" },
    sells: "some",
    setup: async (e) => {
      await toSelect(e);
      void e.store.getState().choosePayment(e.store.getState().payments[0]!.index);
      await waitFor(e.store, (s) => s.step === "completed");
    },
  },
  {
    id: "ex-cancelled",
    group: "Exchange",
    label: "Slots: cancelled buy",
    open: { id: "exchange" },
    sells: "none",
    setup: async (e) => {
      await place(e);
      await e.store.getState().cancelOrder();
    },
  },
  {
    id: "ex-loading",
    group: "Exchange",
    label: "Slots: loading (order resumed after refresh)",
    open: { id: "exchange" },
    sells: "loading",
    chain: { readMs: 120_000 },
    setup: async (e) => {
      e.storage.save(storedOrder());
      e.store.getState().bindSender(e.sender);
      await waitFor(e.store, (s) => s.recovering);
    },
  },
  { id: "ex-paid-claimed", group: "Exchange", label: "Slots: reloaded after saying they paid", open: { id: "exchange" }, sells: "none", setup: reloadPaidClaimed },
  { id: "ex-sell-error", group: "Exchange", label: "Slots: sell orders failed to load", open: { id: "exchange" }, sells: "error", setup: bind },
  { id: "ex-loggedout", group: "Exchange", label: "Slots: logged out", open: { id: "exchange" }, loggedIn: false },
  { id: "ex-setup", group: "Exchange", label: "Buy offer: setup with guide price", open: { id: "exchange", side: "buy", currency: "GBP", platform: "revolut" }, setup: bind },
  { id: "ex-setup-pick", group: "Exchange", label: "Buy offer: choose a method", open: { id: "exchange", side: "buy", currency: "USD" }, setup: bind },
  { id: "ex-setup-loggedout", group: "Exchange", label: "Buy offer: logged out", open: { id: "exchange", side: "buy", currency: "GBP", platform: "revolut" }, loggedIn: false },
  { id: "ex-currency", group: "Exchange", label: "Buy offer: currency picker", open: { id: "exchange", side: "buy", currency: "GBP", platform: "revolut" }, setup: bind, clicks: ["Currency: British Pound. Change currency"] },
  {
    id: "ex-currency-unknown",
    group: "Exchange",
    label: "Buy offer: currency picker, market not loaded",
    open: { id: "exchange", side: "buy", currency: "GBP", platform: "revolut" },
    liquid: null,
    setup: bind,
    clicks: ["Currency: British Pound. Change currency"],
  },
  { id: "ex-platform", group: "Exchange", label: "Buy offer: payment method picker", open: { id: "exchange", side: "buy", currency: "USD" }, setup: bind, clicks: ["Choose a payment method"] },
  {
    id: "ex-platform-us",
    group: "Exchange",
    label: "Buy offer: US methods as at launch (Venmo, PayPal empty; Cash App +15%)",
    open: { id: "exchange", side: "buy", currency: "USD" },
    market: US_LAUNCH,
    setup: bind,
    clicks: ["Choose a payment method"],
  },
  {
    id: "ex-platform-cny",
    group: "Exchange",
    label: "Buy offer: CNY methods (Alipay first, beta)",
    open: { id: "exchange", side: "buy", currency: "CNY" },
    market: CNY_INR,
    setup: bind,
    clicks: ["Choose a payment method"],
  },
  {
    id: "ex-platform-inr",
    group: "Exchange",
    label: "Buy offer: INR methods (UPI first, beta)",
    open: { id: "exchange", side: "buy", currency: "INR" },
    market: CNY_INR,
    setup: bind,
    clicks: ["Choose a payment method"],
  },
  { id: "ex-setup-alipay", group: "Exchange", label: "Buy offer: Alipay chosen (beta)", open: { id: "exchange", side: "buy", currency: "CNY", platform: "alipay" }, market: CNY_INR, setup: bind },
  { id: "ex-setup-venmo-empty", group: "Exchange", label: "Buy offer: Venmo with no offers (Peer Pay note)", open: { id: "exchange", side: "buy", currency: "USD", platform: "venmo" }, market: US_LAUNCH, setup: bind },
  {
    id: "ex-quoted-upi",
    group: "Exchange",
    label: "Buy offer: UPI quote with the Amazon Pay notice",
    open: { id: "exchange" },
    market: CNY_INR,
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: UPI_ORDER.fiat, currency: "INR", platforms: ["upi"] });
    },
  },
  {
    id: "ex-quoted-alipay",
    group: "Exchange",
    label: "Buy offer: Alipay quote with its notice",
    open: { id: "exchange" },
    market: CNY_INR,
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: ALIPAY_ORDER.fiat, currency: "CNY", platforms: ["alipay"] });
    },
  },
  {
    id: "ex-alipay-nopid",
    group: "Exchange",
    label: "Buy offer: Alipay seller without a payment QR (not placed)",
    open: { id: "exchange" },
    market: CNY_INR,
    pidMissing: true,
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: ALIPAY_ORDER.fiat, currency: "CNY", platforms: ["alipay"] });
      e.store.getState().selectQuote(e.store.getState().quotes[0]!.id);
      await e.store.getState().confirm();
    },
  },
  {
    id: "ex-quoted-cashapp",
    group: "Exchange",
    label: "Buy offer: Cash App quote 15% over the cheapest method",
    open: { id: "exchange" },
    market: US_LAUNCH,
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "100.00", currency: "USD", platforms: ["cashapp"] });
    },
  },
  {
    id: "ex-venmo-cap",
    group: "Exchange",
    label: "Buy offer: Venmo at its cap",
    open: { id: "exchange", side: "buy", currency: "USD", platform: "venmo" },
    setup: bind,
    clicks: ["Add 1,000", "Add 1,000", "Add 1,000", "Add 1,000", "Add 1,000"],
  },
  {
    id: "ex-quoting",
    group: "Exchange",
    label: "Buy offer: finding offers",
    open: { id: "exchange" },
    market: { quotes: "hang" },
    setup: async (e) => {
      await bind(e);
      void e.store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
    },
  },
  {
    id: "ex-quoted",
    group: "Exchange",
    label: "Buy offer: best quote",
    open: { id: "exchange" },
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
    },
  },
  {
    id: "ex-quoted-manager",
    group: "Exchange",
    label: "Buy offer: best quote with a rate-manager fee",
    open: { id: "exchange" },
    market: { managerFeeBps: 10 },
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "100", currency: "EUR", platforms: ["revolut"] });
    },
  },
  {
    id: "ex-quoted-noref",
    group: "Exchange",
    label: "Buy offer: best quote without RampRidge's fee (fallback)",
    open: { id: "exchange" },
    market: { referrerFee: false },
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
    },
  },
  {
    id: "ex-quoted-external",
    group: "Exchange",
    label: "Buy offer: best quote, external wallet pays gas",
    open: { id: "exchange" },
    sponsored: false,
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
    },
  },
  {
    id: "ex-noquotes",
    group: "Exchange",
    label: "Buy offer: no sellers (nearby amounts)",
    open: { id: "exchange" },
    market: { quotes: "none" },
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "2500", currency: "GBP", platforms: ["monzo"] });
    },
  },
  {
    id: "ex-quote-error",
    group: "Exchange",
    label: "Buy offer: quote error",
    open: { id: "exchange" },
    market: { quotes: "error" },
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
    },
  },
  {
    id: "ex-signaling",
    group: "Exchange",
    label: "Buy offer: wallet didn't confirm (checking chain)",
    open: { id: "exchange" },
    chain: { signal: "pending" },
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
      e.store.getState().selectQuote(e.store.getState().quotes[0]!.id);
      void e.store.getState().confirm();
      await waitFor(e.store, (s) => s.notice !== null && s.step === "signaling");
    },
  },
  {
    id: "ex-rejected",
    group: "Exchange",
    label: "Buy offer: rejected in wallet",
    open: { id: "exchange" },
    chain: { signal: "rejected" },
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
      e.store.getState().selectQuote(e.store.getState().quotes[0]!.id);
      await e.store.getState().confirm();
    },
  },
  {
    id: "ex-place",
    group: "Exchange",
    label: "Buy offer: Confirm offer (places it, opens Payment)",
    open: { id: "exchange" },
    setup: async (e) => {
      await bind(e);
      await e.store.getState().requestQuotes({ fiatAmount: "100", currency: "GBP", platforms: ["revolut"] });
    },
    clicks: ["Confirm offer"],
  },
  { id: "ex-gate", group: "Exchange", label: "Buy offer: blocked by open order", open: { id: "exchange", side: "buy" }, setup: (e) => place(e) },
  { id: "ex-gate-expired", group: "Exchange", label: "Buy offer: blocked by expired order", open: { id: "exchange", side: "buy" }, setup: placeExpired },
  { id: "ex-dismiss-confirm", group: "Exchange", label: "Buy offer: dismiss expired order (confirm)", open: { id: "exchange", side: "buy" }, setup: placeExpired, clicks: ["Dismiss it"] },
  { id: "ex-gate-error", group: "Exchange", label: "Buy offer: expired order, nothing found", open: { id: "exchange", side: "buy" }, setup: expiredNothingFound },
  { id: "ex-blocked", group: "Exchange", label: "Buy offer: blocked by an older order", open: { id: "exchange" }, chain: { signal: "blocked" }, setup: blockedByOlder },
  {
    id: "ex-blocked-confirm",
    group: "Exchange",
    label: "Buy offer: cancel older order (confirm)",
    open: { id: "exchange" },
    chain: { signal: "blocked" },
    setup: blockedByOlder,
    clicks: ["Cancel old order"],
  },
  { id: "ex-verify-failed", group: "Exchange", label: "Slots: release failed", open: { id: "exchange" }, sells: "some", chain: { fulfil: "network" }, setup: releaseFails },

  // Trade
  { id: "tr-merchant", group: "Trade", label: "Merchant: offer ready", open: MERCHANT, setup: bind },
  { id: "tr-merchant-quoted", group: "Trade", label: "Merchant: opens at the shout's amount (£250)", open: MERCHANT_QUOTED, setup: bind },
  { id: "tr-merchant-loggedout", group: "Trade", label: "Merchant: logged out", open: MERCHANT, loggedIn: false },
  { id: "tr-loading", group: "Trade", label: "Merchant: waiting for offer", open: MERCHANT, timing: { quoteMs: 120_000 }, setup: bind },
  { id: "tr-stall", group: "Trade", label: "Stall: offer ready", open: STALL, setup: bind },
  { id: "tr-stall-missing", group: "Trade", label: "Stall: can't be matched", open: STALL, market: { stallMissing: true }, setup: bind },
  { id: "tr-stall-venmo", group: "Trade", label: "Stall: Venmo (Peer Pay only, no player can take it)", open: VENMO_STALL, market: { ...US_LAUNCH, stallMissing: true }, setup: bind },
  { id: "tr-confirm", group: "Trade", label: "Stall: second screen with rate warning", open: STALL, market: { stallRateFactor: 1.04 }, setup: bind, clicks: ["Accept"] },
  { id: "tr-confirm-merchant", group: "Trade", label: "Merchant: second screen", open: MERCHANT, setup: bind, clicks: ["Accept"] },
  { id: "tr-confirm-external", group: "Trade", label: "Merchant: second screen, external wallet pays gas", open: MERCHANT, sponsored: false, setup: bind, clicks: ["Accept"] },
  { id: "tr-confirm-upi", group: "Trade", label: "UPI merchant: second screen with the Amazon Pay notice", open: UPI_MERCHANT, market: CNY_INR, setup: bind, clicks: ["Accept"] },
  { id: "tr-signaling", group: "Trade", label: "Merchant: placing offer", open: MERCHANT, timing: { txMs: 120_000 }, setup: bind, clicks: ["Accept", "Accept"] },
  {
    id: "tr-e2e",
    group: "Trade",
    label: "End to end: accept, pay, verify, complete",
    open: MERCHANT,
    setup: bind,
    clicks: ["Accept", "Accept", '[class~="rb-pay__ack"] input', "I have paid", '[data-row="0"]', "Verify this payment"],
  },
  { id: "tr-open-order", group: "Trade", label: "Blocked by open order", open: MERCHANT, setup: (e) => place(e) },
  { id: "tr-error-gate", group: "Trade", label: "Blocked by expired order, nothing found", open: MERCHANT, setup: expiredNothingFound },
  { id: "tr-dismiss-confirm", group: "Trade", label: "Dismiss expired order (confirm)", open: MERCHANT, setup: placeExpired, clicks: ["Dismiss it"] },
  { id: "tr-market-offer", group: "Trade", label: "Stall: falls back to the market", open: STALL, market: { stallMissing: true }, setup: bind, clicks: ["See the best market offer"] },
  {
    id: "tr-market-confirm",
    group: "Trade",
    label: "Stall: market fallback, second screen",
    open: STALL,
    market: { stallMissing: true },
    setup: bind,
    clicks: ["See the best market offer", "Accept"],
  },

  // Payment
  { id: "pay-active", group: "Payment", label: "Revolut order", open: { id: "payment" }, setup: (e) => place(e) },
  {
    id: "pay-ext-missing",
    group: "Payment",
    label: "Revolut order, Peer extension missing (rules read)",
    open: { id: "payment" },
    ext: { installed: false, state: "needs_connection" },
    setup: (e) => place(e),
    clicks: [ACK],
  },
  {
    id: "pay-ext-waiting",
    group: "Payment",
    label: "Peer extension missing, store page opened (waiting)",
    open: { id: "payment" },
    ext: { installed: false, state: "needs_connection" },
    setup: (e) => place(e),
    clicks: [ACK, "Add to Chrome"],
  },
  {
    id: "pay-ext-appears",
    group: "Payment",
    label: "Peer extension installs 3 s after the store page opens",
    open: { id: "payment" },
    ext: { installed: false, state: "needs_connection", installAfterMs: 3_000 },
    setup: (e) => place(e),
    clicks: [ACK, "Add to Chrome"],
  },
  {
    id: "pay-ext-elsewhere",
    group: "Payment",
    label: "Peer extension installed elsewhere 3 s after the scroll opens (no click)",
    open: { id: "payment" },
    ext: { installed: false, state: "needs_connection" },
    setup: async (e) => {
      await place(e);
      window.setTimeout(() => {
        e.extension.installed = true;
      }, 3_000);
    },
    clicks: [ACK],
  },
  {
    id: "pay-ext-outdated",
    group: "Payment",
    label: "Revolut order, Peer extension too old (0.6.2)",
    open: { id: "payment" },
    ext: { version: "0.6.2" },
    setup: (e) => place(e),
    clicks: [ACK],
  },
  { id: "pay-ready", group: "Payment", label: "Revolut order, rules read, PeerAuth installed", open: { id: "payment" }, setup: (e) => place(e), clicks: [ACK] },
  {
    id: "pay-expiring",
    group: "Payment",
    label: "Revolut order in its last 15 minutes (rules read)",
    open: { id: "payment" },
    setup: async (e) => {
      await place(e);
      e.clock.offset = 6 * 3_600_000 - 9 * 60_000;
    },
    clicks: [ACK],
  },
  { id: "pay-wise", group: "Payment", label: "Wise order (web link and QR, rules read)", open: { id: "payment" }, setup: (e) => place(e, { fiat: "100", currency: "EUR", platform: "wise" }), clicks: [ACK] },
  { id: "pay-paypal", group: "Payment", label: "PayPal order (warning that says something new)", open: { id: "payment" }, setup: (e) => place(e, { fiat: "60", currency: "EUR", platform: "paypal" }) },
  { id: "pay-venmo", group: "Payment", label: "Venmo order (note, deep link)", open: { id: "payment" }, setup: (e) => place(e, { fiat: "250", currency: "USD", platform: "venmo" }) },
  {
    id: "pay-venmo-read",
    group: "Payment",
    label: "Venmo order, rules read (note, deep link)",
    open: { id: "payment" },
    setup: (e) => place(e, { fiat: "250", currency: "USD", platform: "venmo" }),
    clicks: [ACK],
  },
  { id: "pay-alipay", group: "Payment", label: "Alipay order (QR only, rules read)", open: { id: "payment" }, market: CNY_INR, setup: (e) => place(e, ALIPAY_ORDER), clicks: [ACK] },
  { id: "pay-alipay-rules", group: "Payment", label: "Alipay order (rules not yet read)", open: { id: "payment" }, market: CNY_INR, setup: (e) => place(e, ALIPAY_ORDER) },
  { id: "pay-alipay-nopid", group: "Payment", label: "Alipay order without the seller's payment code", open: { id: "payment" }, market: CNY_INR, pidMissing: true, setup: reloadAlipayNoPid },
  { id: "pay-upi", group: "Payment", label: "UPI order (Amazon Pay, QR only, rules read)", open: { id: "payment" }, market: CNY_INR, setup: (e) => place(e, UPI_ORDER), clicks: [ACK] },
  { id: "pay-fee-waived", group: "Payment", label: "Order with RampRidge's fee waived (TOFIAT seller)", open: { id: "payment" }, market: { referrerFee: false }, setup: (e) => place(e) },
  { id: "pay-zelle", group: "Payment", label: "Zelle order (choose bank)", open: { id: "payment" }, setup: (e) => place(e, { fiat: "80", currency: "USD", platform: "zelle" }) },
  {
    id: "pay-zelle-expired",
    group: "Payment",
    label: "Zelle order expired before a bank was chosen",
    open: { id: "payment" },
    setup: async (e) => {
      await place(e, { fiat: "80", currency: "USD", platform: "zelle" });
      e.clock.offset = 7 * 3_600_000;
    },
  },
  {
    id: "pay-zelle-chosen",
    group: "Payment",
    label: "Zelle order, bank chosen",
    open: { id: "payment" },
    setup: async (e) => {
      await place(e, { fiat: "80", currency: "USD", platform: "zelle" });
      const bank = BUY_PLATFORMS.zelle.verifyMethods[0];
      if (bank) e.store.getState().setVerifyMethod(bank.id);
    },
  },
  {
    id: "pay-expired",
    group: "Payment",
    label: "Expired order",
    open: { id: "payment" },
    setup: async (e) => {
      await place(e);
      e.clock.offset = 7 * 3_600_000;
    },
  },
  { id: "pay-cancel-confirm", group: "Payment", label: "Cancel: confirm", open: { id: "payment" }, setup: (e) => place(e), clicks: ["Cancel offer"] },
  { id: "pay-dismiss-confirm", group: "Payment", label: "Expired: dismiss (confirm)", open: { id: "payment" }, setup: placeExpired, clicks: ["Dismiss offer"] },
  { id: "pay-verify-failed", group: "Payment", label: "Release failed (paid)", open: { id: "payment" }, chain: { fulfil: "network" }, setup: releaseFails },
  { id: "pay-nothing-found", group: "Payment", label: "Expired, nothing found yet (paid)", open: { id: "payment" }, setup: expiredNothingFound },
  { id: "pay-cancelling", group: "Payment", label: "Cancel: in progress", open: { id: "payment" }, timing: { txMs: 120_000 }, setup: (e) => place(e), clicks: ["Cancel offer", "Yes, cancel it"] },
  {
    id: "pay-cancelled",
    group: "Payment",
    label: "Cancelled",
    open: { id: "payment" },
    setup: async (e) => {
      await place(e);
      await e.store.getState().cancelOrder();
    },
  },
  {
    id: "pay-resumed",
    group: "Payment",
    label: "Resumed after refresh (checking chain)",
    open: { id: "payment" },
    chain: { readMs: 120_000 },
    setup: async (e) => {
      e.storage.save(storedOrder());
      e.store.getState().bindSender(e.sender);
      await waitFor(e.store, (s) => s.recovering && s.order !== null);
    },
  },
  { id: "pay-paid-claimed", group: "Payment", label: "Reloaded after saying they paid", open: { id: "payment" }, setup: reloadPaidClaimed },
  {
    id: "pay-paid-claimed-steps",
    group: "Payment",
    label: "Reloaded after saying they paid: I haven't paid yet",
    open: { id: "payment" },
    setup: reloadPaidClaimed,
    clicks: ["I haven't paid yet"],
  },
  { id: "pay-none", group: "Payment", label: "No open order", open: { id: "payment" }, setup: bind },
  { id: "pay-loggedout", group: "Payment", label: "Logged out", open: { id: "payment" }, loggedIn: false },

  // Verify
  { id: "ver-ready", group: "Verify", label: "Ready: Verify with Peer", open: { id: "verify" }, setup: (e) => place(e) },
  { id: "ver-alipay", group: "Verify", label: "Ready: Alipay (PeerAuth 0.6.7)", open: { id: "verify" }, market: CNY_INR, setup: (e) => place(e, ALIPAY_ORDER) },
  { id: "ver-upi", group: "Verify", label: "Ready: UPI (Amazon Pay, PeerAuth 0.6.8)", open: { id: "verify" }, market: CNY_INR, setup: (e) => place(e, UPI_ORDER) },
  {
    id: "ver-alipay-select",
    group: "Verify",
    label: "Select the payment: Alipay",
    open: { id: "verify" },
    market: CNY_INR,
    setup: async (e) => {
      await place(e, ALIPAY_ORDER);
      void e.store.getState().markPaid();
      await waitFor(e.store, (s) => s.step === "selectPayment" || s.step === "error");
    },
  },
  {
    id: "ver-upi-select",
    group: "Verify",
    label: "Select the payment: UPI (Amazon Pay person-to-person only)",
    open: { id: "verify" },
    market: CNY_INR,
    setup: async (e) => {
      await place(e, UPI_ORDER);
      void e.store.getState().markPaid();
      await waitFor(e.store, (s) => s.step === "selectPayment");
    },
  },
  {
    id: "ver-upi-capturing",
    group: "Verify",
    label: "Capturing: UPI (log in to Amazon Pay)",
    open: { id: "verify" },
    market: CNY_INR,
    timing: { captureMs: null },
    setup: async (e) => {
      await place(e, UPI_ORDER);
      e.timing.captureMs = null;
      void e.store.getState().markPaid();
      await waitFor(e.store, (s) => s.verifying === "capturing");
    },
  },
  { id: "ver-paypal", group: "Verify", label: "Ready: PayPal account choice", open: { id: "verify" }, setup: (e) => place(e, { fiat: "60", currency: "EUR", platform: "paypal" }) },
  {
    id: "ver-checking",
    group: "Verify",
    label: "Checking for the extension",
    open: { id: "verify" },
    ext: { state: "hang" },
    setup: async (e) => {
      await place(e);
      void e.store.getState().markPaid();
      await waitFor(e.store, (s) => s.verifying === "checking");
    },
  },
  ...(["install", "unsupported", "connect", "capturing"] as const).map(
    (kind): Scenario => ({
      id: `ver-${kind}`,
      group: "Verify",
      label: { install: "Extension missing", unsupported: "Unsupported browser", connect: "Needs connection", capturing: "Capturing payments" }[kind],
      open: { id: "verify" },
      ext: kind === "install" || kind === "unsupported" ? { installed: false } : kind === "connect" ? { state: "needs_connection" } : {},
      canInstall: kind !== "unsupported",
      timing: kind === "capturing" ? { captureMs: null } : {},
      setup: async (e) => {
        await place(e);
        if (kind === "capturing") e.timing.captureMs = null;
        void e.store.getState().markPaid();
        const target = { install: "needsInstall", unsupported: "unsupportedBrowser", connect: "needsConnection", capturing: "capturing" }[kind];
        await waitFor(e.store, (s) => s.verifying === target);
      },
    }),
  ),
  {
    id: "ver-install-waiting",
    group: "Verify",
    label: "Extension missing, store page opened (waiting)",
    open: { id: "verify" },
    ext: { installed: false, state: "needs_connection" },
    setup: async (e) => {
      await place(e);
      void e.store.getState().markPaid();
      await waitFor(e.store, (s) => s.verifying === "needsInstall");
    },
    clicks: ["Add to Chrome"],
  },
  {
    id: "ver-install-appears",
    group: "Verify",
    label: "Extension installs 3 s after the store page opens, then asks to connect",
    open: { id: "verify" },
    ext: { installed: false, state: "needs_connection", installAfterMs: 3_000 },
    setup: async (e) => {
      await place(e);
      void e.store.getState().markPaid();
      await waitFor(e.store, (s) => s.verifying === "needsInstall");
    },
    clicks: ["Add to Chrome"],
  },
  {
    id: "ver-update",
    group: "Verify",
    label: "Extension too old for Revolut (0.6.2)",
    open: { id: "verify" },
    ext: { version: "0.6.2" },
    setup: async (e) => {
      await place(e);
      void e.store.getState().markPaid();
      await waitFor(e.store, (s) => s.verifying === "needsUpdate");
    },
  },
  { id: "ver-select", group: "Verify", label: "Select the payment", open: { id: "verify" }, setup: toSelect },
  { id: "ver-select-picked", group: "Verify", label: "Select the payment (one picked)", open: { id: "verify" }, setup: toSelect, clicks: ["[data-row=\"0\"]"] },
  {
    id: "ver-fulfilling",
    group: "Verify",
    label: "Verifying (releasing USDC)",
    open: { id: "verify" },
    chain: { fulfil: "hang" },
    setup: async (e) => {
      await toSelect(e);
      void e.store.getState().choosePayment(e.store.getState().payments[0]!.index);
      await waitFor(e.store, (s) => s.step === "fulfilling");
    },
  },
  {
    id: "ver-completed",
    group: "Verify",
    label: "Completed (celebrate, coins, announce)",
    open: { id: "verify" },
    setup: toSelect,
    clicks: ["[data-row=\"0\"]", "Verify this payment"],
  },
  {
    id: "ver-announce-fails",
    group: "Verify",
    label: "Completed, announcement fails",
    open: { id: "verify" },
    announceFails: true,
    setup: toSelect,
    clicks: ["[data-row=\"0\"]", "Verify this payment"],
  },
  {
    id: "ver-payee-error",
    group: "Verify",
    label: "Error: wrong payment picked",
    open: { id: "verify" },
    chain: { fulfil: "payee" },
    setup: async (e) => {
      await toSelect(e);
      await e.store.getState().choosePayment(e.store.getState().payments[1]!.index);
    },
  },
  { id: "ver-release-failed", group: "Verify", label: "Error: release failed", open: { id: "verify" }, chain: { fulfil: "network" }, setup: releaseFails },
  {
    id: "ver-no-payments",
    group: "Verify",
    label: "Error: no payments found",
    open: { id: "verify" },
    setup: async (e) => {
      await place(e);
      (e as Env & { emptyCapture?: boolean }).emptyCapture = true;
      void e.store.getState().markPaid();
      await waitFor(e.store, (s) => s.step === "error");
    },
  },
];

// ---------------------------------------------------------------------------
// Environment

/** A fresh store and fakes per scenario; `_generation` changes on Restart. */
function buildEnv(s: Scenario, _generation: number) {
  const timing: Timing = { txMs: 0, quoteMs: 0, captureMs: 0 };
  const after: Timing = { txMs: 1200, quoteMs: 500, captureMs: 1800, ...s.timing };
  const clock = { offset: 0, now: () => Date.now() + clock.offset };
  const market = fakeMarket({ quotes: "ok", referrerFee: true, managerFeeBps: 0, stallRateFactor: 1, stallMissing: false, pricesError: false, ...s.market }, timing);
  const chain = fakeChain({ lockMs: 6 * 3_600_000, fulfil: "ok", signal: "ok", readMs: 0, ...s.chain }, timing, clock.now);
  const storage = memoryOrderStorage();
  const sender: TxSender = s.sponsored === false ? { ...chain.sender, kind: "external", sponsored: false } : chain.sender;
  const extOptions: ExtensionOptions = { installed: true, state: "ready", ...s.ext };
  const env: Env & { emptyCapture?: boolean } = { store: null as never, sender, timing, clock, storage, extension: extOptions };
  const extension = fakeExtension(extOptions, timing, () => {
    const order = env.store.getState().order;
    const method = order ? resolveVerifyMethod(order.platform, order.verifyMethodId) : null;
    return { platform: method?.actionPlatform ?? "revolut", rows: env.emptyCapture || !order ? [] : capturedRows(order.platform, order.fiatToSendText, order.currency) };
  });
  env.store = createBuyStore({
    getClient: () => chain.client,
    extension,
    storage,
    quotes: market.quotes,
    // Curator's maker for the payee: the platform's fixture handle, with the Alipay PID unless the scenario drops it.
    fetchPayeeHandle: async (platform) =>
      platform === "alipay"
        ? { handle: PAYEES.alipay ?? "seller@example.com", business: false, ...(s.pidMissing ? {} : { recipientId: ALIPAY_PID }) }
        : (PAYEES[platform] ?? "revtag"),
    canInstallExtension: () => s.canInstall ?? true,
    openInstallPage: fakeInstallPage(extOptions),
    // Faster than Peer's 5 s so the "appears after install" scenario moves on quickly.
    extensionPollMs: 2_000,
    now: clock.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5_000))),
    random: () => 0.31,
    indexerTimeoutMs: 1_500,
    signalReconcileMs: 90_000,
  });
  const deps: Partial<BuyUiDeps> = {
    store: env.store,
    getBuyQuotes: market.quotes,
    getBestPricesByPlatform: market.getBestPricesByPlatform as BuyUiDeps["getBestPricesByPlatform"],
    getDepositQuote: market.getDepositQuote,
    cashClient: () => cash,
    now: clock.now,
    ...(COMPUTER === "1" ? { verifyNeedsComputer: () => true } : COMPUTER === "0" ? { verifyNeedsComputer: () => false } : {}),
  };
  const cash = fakeCash(s.sells ?? "none");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  // Idempotent: StrictMode runs effects twice in development.
  let started: Promise<void> | null = null;
  const start = () => {
    started ??= (async () => {
      if (s.setup && s.loggedIn !== false) await s.setup(env);
      Object.assign(timing, after);
    })();
    return started;
  };
  return { env, deps, queryClient, start };
}

// ---------------------------------------------------------------------------
// App

const BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));

/** The baked minimap image around the bank, so screenshots show the HUD as in game. */
function useHarnessMinimap(canvas: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const img = new Image();
    img.src = "/game/world/minimap.png";
    img.onload = () => {
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const s = el.width / MINIMAP_SIZE.width;
      // minimap.json: minX 3164, maxY 3462, 4 px per tile; centred on a tile inside the bank.
      const px = (3184 + 0.5 - 3164) * 4;
      const py = (3462 + 1 - (3439 + 0.5)) * 4;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, el.width, el.height);
      ctx.imageSmoothingEnabled = false;
      ctx.translate(el.width / 2, el.height / 2);
      ctx.scale(s, s);
      ctx.drawImage(img, -px, -py);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(el.width / 2 - 1.5 * s, el.height / 2 - 1.5 * s, 3 * s, 3 * s);
    };
  }, [canvas]);
}

function Backdrop() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (SCENE && ref.current ? mountBankBackdrop(ref.current) : undefined), []);
  return <div ref={ref} className="bh-scene" />;
}

function App() {
  const [id, setId] = useState(() => (params.get("state") && BY_ID.has(params.get("state")!) ? params.get("state")! : "ex-slots"));
  const [run, setRun] = useState(0);
  const scenario = BY_ID.get(id) ?? SCENARIOS[0]!;
  const built = useMemo(() => buildEnv(scenario, run), [scenario, run]);
  const [ready, setReady] = useState<"pending" | "ok" | string>("pending");
  const [loggedIn, setLoggedIn] = useState(scenario.loggedIn !== false);
  const [current, setCurrent] = useState<OpenInterface | null>(scenario.open);
  const [lines, setLines] = useState<ChatLine[]>(() => [gameMessage("Welcome to RampRidge."), gameMessage("Trades only settle through the bank. Never send money to a player directly.")]);
  const [fireworks, setFireworks] = useState(0);
  const mobile = useIsMobile();
  const minimap = useRef<HTMLCanvasElement>(null);
  useHarnessMinimap(minimap);

  useEffect(() => {
    setReady("pending");
    setLoggedIn(scenario.loggedIn !== false);
    setCurrent(scenario.open);
    let live = true;
    built
      .start()
      .then(() => live && setReady("ok"))
      .catch((e: unknown) => live && setReady(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [built, scenario]);

  const say = useCallback((line: ChatLine) => setLines((l) => appendLines(l, [line])), []);
  const game = useMemo<GameContextValue>(
    () => ({
      sender: loggedIn ? built.env.sender : null,
      walletReady: true,
      login: () => {
        setLoggedIn(true);
        say(gameMessage("(dev) Logged in."));
      },
      publicClient,
      me: { pid: "p-zezima", name: "Zezima", verifiedWallet: BUYER.toLowerCase() },
      open: (target) => setCurrent(target),
      close: () => setCurrent(null),
      message: (text) => say(gameMessage(text)),
      playSound: (name) => console.info(`[sound] ${name}`),
      celebrate: () => setFireworks((n) => n + 1),
      announce: async (_kind, tx) => {
        await new Promise((r) => setTimeout(r, 400));
        if (scenario.announceFails) throw new Error("announce failed");
        say(chatLine("news", `Zezima bought USDC at the Bank of RampRidge. (${tx.slice(0, 10)}...)`));
      },
      setStall: async () => undefined,
      stallDepositId: null,
      liquidCurrencies: scenario.liquid === null ? null : new Set(scenario.liquid ?? FIXTURE_LIQUID),
    }),
    [loggedIn, built, say, scenario],
  );

  // Scripted clicks for scenarios that start mid-interaction; body[data-ready] marks the end for screenshots.
  useEffect(() => {
    document.body.dataset.ready = ready === "pending" ? "0" : ready === "ok" ? "" : "err";
    if (ready !== "ok") return;
    let cancelled = false;
    void (async () => {
      for (const target of scenario.clicks ?? []) {
        await new Promise((r) => setTimeout(r, 700));
        let el: HTMLElement | null = null;
        for (let waited = 0; !el && waited < 8000 && !cancelled; waited += 200) {
          el = findClickable(target);
          if (!el) await new Promise((r) => setTimeout(r, 200));
        }
        if (cancelled) return;
        if (!el) {
          console.warn(`[harness] nothing to click for "${target}"`);
          continue;
        }
        el.click();
      }
      await new Promise((r) => setTimeout(r, 900));
      if (!cancelled) document.body.dataset.ready = "1";
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, scenario]);

  useEffect(() => {
    if (!fireworks) return;
    const t = window.setTimeout(() => setFireworks(0), 2400);
    return () => window.clearTimeout(t);
  }, [fireworks]);

  const Component = current ? (interfaces[current.id] as ComponentType<{ open: OpenInterface }> | undefined) : undefined;
  const iface =
    ready === "pending" ? null : ready !== "ok" ? (
      <Window title="Harness" width={360} height={140} onClose={() => setRun((r) => r + 1)}>
        <p className="rs-window__pad rs-p12 rs-c-red rs-shadow">{ready}</p>
      </Window>
    ) : current && Component ? (
      <Component key={`${id}:${run}:${JSON.stringify(current)}`} open={current} />
    ) : current ? (
      <Window title={`${current.id} (another module)`} width={320} height={120} onClose={() => setCurrent(null)}>
        <p className="rs-window__pad rs-p12 rs-c-orange rs-shadow">The {current.id} interface belongs to another module.</p>
      </Window>
    ) : null;

  return (
    <QueryClientProvider client={built.queryClient}>
      <GameContext.Provider value={game}>
        <BuyUiDepsProvider value={built.deps}>
          <GameFrame
            viewport={<Backdrop />}
            minimap={{ canvasRef: minimap, runEnergy: 100, running: true, onToggleRun: () => undefined, usdcBalance: loggedIn ? "1250.40" : null }}
            chat={{ lines, playerName: "Zezima", onSend: (text) => say(chatLine("public", text, { name: "Zezima" })) }}
            side={{
              active: mobile ? null : "inventory",
              onChange: () => undefined,
              panels: {
                inventory: (
                  <InventoryPanel
                    items={loggedIn ? [{ name: "Coins", icon: <Sprite name={coinsSpriteFor(1250)} />, quantity: 1250, stackable: true, examine: "1,250.40 USDC." }] : []}
                    notice={loggedIn ? undefined : "Log in to see your USDC."}
                  />
                ),
              },
            }}
            interfaces={iface}
          />
          {fireworks > 0 && <div className="bh-fireworks" aria-hidden="true" />}
          {!BARE && (
            <div className="bh-switch rs-game">
              <select value={id} onChange={(e) => setId(e.target.value)} aria-label="Scenario">
                {(["Exchange", "Trade", "Payment", "Verify"] as const).map((g) => (
                  <optgroup key={g} label={g}>
                    {SCENARIOS.filter((s) => s.group === g).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <StoneButton onClick={() => setRun((r) => r + 1)}>Restart</StoneButton>
              {!current && <StoneButton onClick={() => setCurrent(scenario.open)}>Reopen</StoneButton>}
              <span className="rs-p11 rs-c-yellow rs-shadow">{ready === "pending" ? "Setting up..." : `${id} / step ${built.env.store.getState().step}`}</span>
            </div>
          )}
        </BuyUiDepsProvider>
      </GameContext.Provider>
    </QueryClientProvider>
  );
}

/** A button by its accessible name or text, or any element by a CSS selector starting with "[" or "#". */
function findClickable(target: string): HTMLElement | null {
  if (target.startsWith("[") || target.startsWith("#")) return document.querySelector<HTMLElement>(target);
  const all = Array.from(document.querySelectorAll<HTMLElement>(".rs-gameframe__interfaces button, .rs-gameframe__interfaces a"));
  return all.find((el) => !(el as HTMLButtonElement).disabled && (el.getAttribute("aria-label") === target || el.textContent?.trim() === target)) ?? null;
}

// One root even if Vite re-runs this module after an edit.
const host = window as typeof window & { __buyHarnessRoot?: Root };
const rootEl = document.getElementById("root");
if (rootEl) {
  host.__buyHarnessRoot ??= createRoot(rootEl);
  host.__buyHarnessRoot.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
