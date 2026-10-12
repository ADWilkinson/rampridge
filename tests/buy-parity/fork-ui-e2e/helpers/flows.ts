/**
 * Player actions through RampRidge's real buy UI (dev/buy-e2e.html), step
 * screenshots, and the store snapshots the scenarios assert against.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import type { Page, Viewport } from "./cdp";
import type { ViteServer } from "./vite";

export interface StepRecord {
  n: number;
  label: string;
  file: string;
  ui: string;
}

export class Recorder {
  readonly steps: StepRecord[] = [];
  readonly notes: string[] = [];
  private n = 0;

  constructor(
    readonly dir: string,
    readonly scenario: string,
    readonly viewport: Viewport,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async shot(page: Page, label: string): Promise<StepRecord> {
    this.n += 1;
    const file = path.join(this.dir, `${this.scenario}-${this.viewport.name}-${String(this.n).padStart(2, "0")}-${label}.png`);
    await page.screenshot(file);
    const step = { n: this.n, label, file, ui: await page.uiText().catch(() => "") };
    this.steps.push(step);
    return step;
  }

  note(text: string): void {
    this.notes.push(text);
  }
}

export interface OrderSnapshot {
  owner: Address;
  intentHash: Hex;
  depositId: string;
  escrow: Address;
  orchestrator: Address | null;
  platform: string;
  currency: string;
  usdcGross: string;
  usdcExpected: string;
  rate: string;
  fiatToSend: string;
  fiatToSendText: string;
  payeeHandle: string | null;
  payeeDetailsHash: Hex;
  signalTxHash: Hex | null;
  signaledAt: number;
  expiresAt: number;
  status: string;
  paidClaimedAt: number | null;
  fees: { service: string; manager: string; referrer: string; total: string; referrerBps: number | null } | null;
}

export interface QuoteSnapshot {
  id: string;
  depositId: string;
  escrow: Address;
  platform: string;
  currency: string;
  fiatAmount: string;
  usdcAmount: string;
  signalAmount: string;
  rate: string;
  payeeHandle: string;
  payeeDetailsHash: Hex;
  fees: { service: string; manager: string; referrer: string; total: string };
}

export interface StoreSnapshot {
  step: string;
  verifying: string | null;
  pending: string | null;
  error: { code: string; message: string; recoverable: boolean; detail?: string } | null;
  errorReturnStep: string | null;
  notice: string | null;
  order: OrderSnapshot | null;
  completion: { intentHash: Hex; fulfillTxHash: Hex; usdcReceived: string; indexed: boolean } | null;
  quotes: QuoteSnapshot[];
  selectedQuote: QuoteSnapshot | null;
  payments: Array<{ index: number; amount: string | null; recipient: string | null; date: string | null; sent: boolean }>;
  recovering: boolean;
  current: string | null;
}

export function snapshot(page: Page): Promise<StoreSnapshot> {
  return page.eval<StoreSnapshot>(`(() => {
    const s = window.__e2e.state();
    const strip = (q) => q ? { ...q, raw: undefined } : null;
    return JSON.parse(JSON.stringify({
      step: s.step, verifying: s.verifying, pending: s.pending, error: s.error, errorReturnStep: s.errorReturnStep,
      notice: s.notice, order: s.order, completion: s.completion, quotes: s.quotes.map(strip), selectedQuote: strip(s.selectedQuote),
      payments: s.payments.map((p) => ({ ...p, row: undefined })), recovering: s.recovering,
      current: window.__e2e.current ? window.__e2e.current.id : null,
    }, (k, v) => typeof v === 'bigint' ? v.toString() : v));
  })()`);
}

export interface HarnessParams {
  buyer: Address;
  ext?: "ready" | "missing" | "needs_connection" | "decline" | "outdated" | "clock_skew";
  extVersion?: string;
  captureMs?: number;
  clock?: number;
  open?: string;
}

export function harnessUrl(base: string, p: HarnessParams): string {
  const q = new URLSearchParams({ buyer: p.buyer, ext: p.ext ?? "ready", captureMs: String(p.captureMs ?? 1500), open: p.open ?? "exchange" });
  if (p.extVersion) q.set("extVersion", p.extVersion);
  if (p.clock) q.set("clock", String(p.clock));
  return `${base}/dev/buy-e2e.html?${q.toString()}`;
}

export async function loadHarness(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitFor("window.__e2e?.ready === true", 120_000, "harness ready");
  await page.waitFor("window.__e2e.state().owner !== null && !window.__e2e.state().recovering", 60_000, "recovery done");
  await new Promise((r) => setTimeout(r, 500));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exchange -> Buy -> Revolut, amount set with the pad -> Confirm -> best quote shown. */
export async function requestQuote(page: Page, rec: Recorder, opts: { decreaseBy10: number }): Promise<StoreSnapshot> {
  await page.waitFor(`document.body.innerText.includes('Grand Exchange')`, 30_000, "Grand Exchange");
  await rec.shot(page, "exchange-slots");
  await page.click("Buy USDC (slot 1)");
  await page.waitFor(`document.body.innerText.includes('Buy offer')`, 30_000, "Buy offer screen");
  const currency = await page.uiText();
  if (!currency.includes("USD - US Dollar")) {
    await page.click(/^Currency: /);
    await page.click(/US Dollar/);
  }
  await page.click("Choose a payment method");
  await page.waitFor(`document.body.innerText.includes('Choose how you will pay')`, 30_000, "platform picker");
  await page.waitFor(`!document.body.innerText.includes('Checking...')`, 45_000, "platform prices");
  await rec.shot(page, "platform-picker");
  await page.click(/Revolut/, { within: ".rb-picker" });
  for (let i = 0; i < opts.decreaseBy10; i += 1) await page.click("Decrease by 10");
  await page.waitFor(`document.body.innerText.includes('You will receive')`, 60_000, "guide price");
  await rec.shot(page, "buy-offer");
  await page.click("Confirm", { within: ".rb-setup__confirm" });
  await page.waitFor(`document.body.innerText.includes('Confirm offer') || window.__e2e.state().step === 'error'`, 60_000, "quote");
  await rec.shot(page, "quote");
  const snap = await snapshot(page);
  if (snap.step === "error") throw new Error(`quote failed: ${JSON.stringify(snap.error)}`);
  return snap;
}

/** "Confirm offer": signals through the fork sender and lands on the Payment scroll. */
export async function confirmOffer(page: Page, rec: Recorder): Promise<StoreSnapshot> {
  await page.click("Confirm offer");
  await sleep(300);
  await rec.shot(page, "placing-offer");
  await page.waitFor(
    `(window.__e2e.state().step === 'awaitingPayment' && window.__e2e.state().order?.status === 'active' && document.body.innerText.includes('Before you pay')) || window.__e2e.state().step === 'error'`,
    120_000,
    "payment scroll",
  );
  const snap = await snapshot(page);
  await rec.shot(page, "payment-scroll");
  if (snap.step === "error") throw new Error(`signal failed: ${JSON.stringify(snap.error)}`);
  return snap;
}

/**
 * Ticks the Payment scroll's rules acknowledgement when the scroll has one (the proposed
 * fixes.patch hides the payee, QR and "I have paid" until it is ticked); a no-op otherwise.
 */
export async function acknowledgeRules(page: Page): Promise<void> {
  await page.eval<boolean>(`(() => {
    const box = document.querySelector('.rb-pay__ack input');
    if (box && !box.checked) box.click();
    return true;
  })()`);
  await sleep(100);
}

/** What the Payment scroll tells the player to send, read from the page as a player would. */
export async function readScroll(page: Page): Promise<{ amountText: string; payee: string; minor: number }> {
  await acknowledgeRules(page);
  // The scroll's lead: "Send £20.00" over "to @handle on Revolut" (the handle shows once the rules are ticked).
  const read = await page.eval<{ amount: string; payee: string }>(`(() => {
    const amount = document.querySelector('.rb-pay__hero .rb-pay__amount')?.textContent.trim() ?? '';
    const payee = document.querySelector('.rb-pay__hero .rb-pay__to .rb-strong')?.textContent.trim() ?? '';
    return { amount, payee };
  })()`);
  const numeric = read.amount.replace(/[^0-9.]/g, "");
  const [whole, frac = ""] = numeric.split(".");
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return { amountText: read.amount, payee: read.payee.replace(/^@/, ""), minor };
}

export interface Payment {
  id: string;
  amount: number;
  completedDate: number;
  currency: string;
  recipient?: { username?: string };
  state: string;
  type: string;
  description?: string;
}

/** Opens the buyer's fake Revolut account with some history: an earlier coffee and an incoming transfer. */
export async function openRevolut(vite: ViteServer, buyer: Address, now: number): Promise<void> {
  const history: Payment[] = [
    { id: crypto.randomUUID(), amount: -350, completedDate: now - 3 * 3_600_000, currency: "USD", recipient: { username: "cornercafe" }, state: "COMPLETED", type: "TRANSFER", description: "Coffee" },
    { id: crypto.randomUUID(), amount: 4000, completedDate: now - 26 * 3_600_000, currency: "USD", state: "COMPLETED", type: "TRANSFER", description: "From Sam" },
  ];
  await vite.post("/__e2e/revolut/session", { cookie: buyer.toLowerCase(), transactions: history });
}

/** The buyer sends money on "Revolut". */
export async function pay(vite: ViteServer, buyer: Address, p: { username: string; minor: number; currency: string; at: number }): Promise<string> {
  const id = crypto.randomUUID();
  await vite.post("/__e2e/revolut/pay", {
    cookie: buyer.toLowerCase(),
    id,
    amount: -p.minor,
    completedDate: p.at,
    currency: p.currency,
    recipient: { username: p.username },
    state: "COMPLETED",
    type: "TRANSFER",
  });
  return id;
}

/** "I have paid" (or "I paid before it expired") on the scroll, then the extension capture lands on the payment list. */
export async function paidAndCapture(page: Page, rec: Recorder, button: string | RegExp = "I have paid"): Promise<StoreSnapshot> {
  await acknowledgeRules(page);
  await page.click(button);
  await page.waitFor(`window.__e2e.current?.id === 'verify'`, 15_000, "verify window");
  await page.waitFor(`window.__e2e.state().verifying === 'capturing' || window.__e2e.state().step !== 'verifying'`, 15_000, "capturing");
  await rec.shot(page, "verify-capturing");
  return waitForPaymentList(page, rec);
}

export async function waitForPaymentList(page: Page, rec: Recorder): Promise<StoreSnapshot> {
  await page.waitFor(`window.__e2e.state().step === 'selectPayment' || window.__e2e.state().step === 'error'`, 60_000, "payment list");
  await sleep(300);
  await rec.shot(page, "select-payment");
  return snapshot(page);
}

/** Clicks the listed payment whose row names `recipient`, then "Verify this payment". */
export async function pickAndVerify(page: Page, rec: Recorder, recipient: string): Promise<void> {
  const clicked = await page.eval<boolean>(`(() => {
    const rows = Array.from(document.querySelectorAll('.rb-payrow'));
    const row = rows.find((r) => (r.textContent ?? '').includes('to @${recipient}') || (r.textContent ?? '').includes('to ${recipient}'));
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`no payment row to ${recipient}: ${await page.uiText()}`);
  await sleep(200);
  await rec.shot(page, `picked-${recipient}`);
  await page.click("Verify this payment");
}

/** Clicks the listed payment at the extension's row index (data-row), then "Verify this payment". */
export async function pickIndexAndVerify(page: Page, rec: Recorder, index: number): Promise<void> {
  const ok = await page.eval<boolean>(`(() => {
    const row = document.querySelector('.rb-payrow[data-row="${index}"]');
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!ok) throw new Error(`no payment row ${index}: ${await page.uiText()}`);
  await sleep(200);
  await rec.shot(page, `picked-row-${index}`);
  await page.click("Verify this payment");
}

/** Waits for the release: "Verifying your payment" then "Congratulations!" (or an error). */
export async function waitForOutcome(page: Page, rec: Recorder): Promise<StoreSnapshot> {
  await page.waitFor(`window.__e2e.state().step !== 'selectPayment'`, 15_000, "fulfil start");
  if ((await snapshot(page)).step === "fulfilling") await rec.shot(page, "fulfilling");
  await page.waitFor(`['completed', 'error'].includes(window.__e2e.state().step)`, 180_000, "release outcome");
  await sleep(600);
  const snap = await snapshot(page);
  await rec.shot(page, snap.step === "completed" ? "congratulations" : `error-${snap.error?.code ?? "unknown"}`);
  return snap;
}
