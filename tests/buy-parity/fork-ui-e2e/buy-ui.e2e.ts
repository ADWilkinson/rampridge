/**
 * FULL UI BUY ON A BASE FORK, END TO END.
 *
 * RampRidge's real Exchange -> quote -> Confirm offer -> Payment scroll ->
 * I have paid -> Verify -> pick payment -> release -> Congratulations, in
 * headless Chrome, against:
 * - Peer's deployed contracts on an anvil fork of Base at the latest block
 *   (reset before every scenario so Curator's quotes and signatures match it),
 * - the LIVE Curator API (quotes for real makers, /v3/sign for the fork buyer),
 * - a simulated Peer extension speaking the real page API and message shapes,
 * - a local attestation service applying the real service's buyer TEE checks
 *   and signing with a witness the fork's MultiAttestationVerifier trusts
 *   (added by impersonating its owner, fork only).
 *
 * Nothing is signed for mainnet: the buyer is a random address anvil
 * impersonates, and every JSON-RPC call the page makes is pinned to the fork.
 *
 *   export FORK_UPSTREAM_RPC_URL=...   # an archive-capable Base mainnet RPC; never printed
 *   bunx vitest run --config dev/buy-e2e/vitest.e2e.config.ts
 *
 * Screenshots: $E2E_SHOTS (default: $TMPDIR/rampridge-buy-e2e/shots). Chrome
 * profiles: $E2E_CHROME_PROFILES (default: $TMPDIR/rampridge-buy-e2e/profiles).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Attribution } from "ox/erc8021";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { domainSeparator } from "../../../dev/buy-e2e/server/attestor";
import { DESKTOP, PHONE, launchChrome, removeProfiles, type Page, type Viewport } from "./helpers/cdp";
import {
  Recorder,
  confirmOffer,
  harnessUrl,
  loadHarness,
  openRevolut,
  paidAndCapture,
  pay,
  pickAndVerify,
  pickIndexAndVerify,
  readScroll,
  requestQuote,
  snapshot,
  waitForOutcome,
  waitForPaymentList,
  type StoreSnapshot,
} from "./helpers/flows";
import { ESCROW, Fork, ORCHESTRATOR, REFERRER, UPV3, events, randomAddress } from "./helpers/fork";
import { ViteServer } from "./helpers/vite";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORK = path.join(tmpdir(), "rampridge-buy-e2e");
const SHOTS = process.env.E2E_SHOTS ?? path.join(WORK, "shots");
const PROFILES = process.env.E2E_CHROME_PROFILES ?? path.join(WORK, "profiles");
const FORK_PORT = Number(process.env.E2E_FORK_PORT ?? "8551");
const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? "5291");
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
/** OrchestratorV3 referral legs are 18-decimal fractions: 50 bps. */
const REFERRER_FEE_PRECISE = 5n * 10n ** 15n;
const WRONG_PAYEE = "jamieflatmate";

const fork = new Fork(FORK_PORT);
const witnessKey = generatePrivateKey();
const witness = privateKeyToAccount(witnessKey);
const vite = new ViteServer(VITE_PORT, { VITE_BASE_RPC_URL: fork.url, E2E_WITNESS_KEY: witnessKey }, ROOT);
let cdpPort = 9420 + Math.floor(Math.random() * 200);
const results: Array<Record<string, unknown>> = [];
/** What the UI showed in states that RampRidge gets wrong today; asserted by the known-bug tests at the end. */
const observed: {
  paymentRowDates?: Array<string | null>;
  outdatedText?: string;
  clockSkewText?: string;
  afterInstalledClickText?: string;
  installPanelText?: string;
  underpaidCompletedText?: string;
  selectPaymentButtons?: string[];
  scrollWhileListing?: string;
  underpaid?: { paidMinor: number; orderFiat: string };
} = {};

interface Ctx {
  page: Page;
  rec: Recorder;
  buyer: Address;
  url: (extra?: Partial<Parameters<typeof harnessUrl>[1]>) => string;
}

async function prepare(name: string, viewport: Viewport, ua?: string): Promise<Ctx> {
  const block = await fork.resetToLatest();
  const verifier = await fork.revolutVerifier();
  // The mock signs over exactly the domain the deployed verifier checks.
  expect(getAddress(verifier.verifier)).toBe(getAddress(UPV3));
  expect(verifier.domainSeparator.toLowerCase()).toBe(domainSeparator(8453, UPV3).toLowerCase());
  await fork.trustWitness(verifier.attestationVerifier, witness.address);
  const buyer = randomAddress();
  await fork.setEth(buyer, "0.05");
  await openRevolut(vite, buyer, Date.now());
  const page = await launchChrome(PROFILES, cdpPort++);
  await page.viewport(viewport, ua ? { userAgent: ua } : {});
  await page.send("Emulation.setLocaleOverride", { locale: "en-US" });
  const rec = new Recorder(SHOTS, name, viewport);
  rec.note(`fork block ${block}, buyer ${buyer}, witness ${witness.address}`);
  return { page, rec, buyer, url: (extra = {}) => harnessUrl(vite.url, { buyer, ...extra }) };
}

async function finish(ctx: Ctx, outcome: Record<string, unknown>): Promise<void> {
  const guard = await ctx.page.eval<{ blocked: string[]; attestation: unknown[]; curator: unknown[] }>("window.__e2e?.guard ?? {blocked:[],attestation:[],curator:[]}").catch(() => null);
  const pageErrors = await ctx.page.eval<string[]>("window.__e2e?.errors ?? []").catch(() => []);
  results.push({
    scenario: ctx.rec.scenario,
    viewport: ctx.rec.viewport.name,
    buyer: ctx.buyer,
    notes: ctx.rec.notes,
    steps: ctx.rec.steps.map((s) => ({ label: s.label, file: s.file, ui: s.ui.slice(0, 700) })),
    guard,
    pageErrors,
    consoleTail: ctx.page.logs.filter((l) => /error|warn|\[buy\]/i.test(l)).slice(-15),
    ...outcome,
  });
  writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify(results, null, 2));
  // No JSON-RPC ever left for anything but the fork.
  expect(guard?.blocked ?? []).toEqual([]);
  await ctx.page.close();
}

function codes(data: Hex): string[] {
  const parsed = Attribution.fromData(data);
  return parsed && "codes" in parsed ? [...parsed.codes] : [];
}

/** Everything a completed purchase must have done on chain, and what the UI must have said about it. */
async function assertReleased(
  ctx: Ctx,
  before: { remaining: bigint; outstanding: bigint; buyerUsdc: bigint; referrerUsdc: bigint },
  order: NonNullable<StoreSnapshot["order"]>,
  done: StoreSnapshot,
  quoted: { usdcAmount: string } | null,
): Promise<Record<string, unknown>> {
  expect(done.step).toBe("completed");
  const completion = done.completion!;
  expect(completion.intentHash.toLowerCase()).toBe(order.intentHash.toLowerCase());
  const receipt = await fork.receipt(completion.fulfillTxHash);
  expect(receipt.status).toBe("success");
  expect(getAddress(receipt.to!)).toBe(getAddress(ORCHESTRATOR));
  const ev = events(receipt.logs);
  const fulfilled = ev.fulfilled.find((e) => e.args.intentHash.toLowerCase() === order.intentHash.toLowerCase());
  expect(fulfilled, "IntentFulfilled emitted").toBeTruthy();
  expect(getAddress(fulfilled!.args.fundsTransferredTo)).toBe(getAddress(ctx.buyer));
  expect(fulfilled!.args.isManualRelease).toBe(false);
  const net = fulfilled!.args.amount;
  const gross = BigInt(order.usdcGross);
  const unlocked = ev.unlocked.find((e) => e.args.intentHash.toLowerCase() === order.intentHash.toLowerCase());
  expect(unlocked, "escrow FundsUnlockedAndTransferred").toBeTruthy();
  const released = unlocked!.args.transferredAmount;
  // Paying exactly what the scroll said releases the whole intent.
  expect(released).toBe(gross);

  // 50 bps referrer leg to Galleon's fee wallet, from the release.
  const referral = ev.referral.filter((e) => getAddress(e.args.feeRecipient) === getAddress(REFERRER));
  expect(referral.length).toBe(1);
  expect(referral[0]!.args.feeAmount).toBe((released * REFERRER_FEE_PRECISE) / 10n ** 18n);
  const after = {
    deposit: await fork.deposit(BigInt(order.depositId)),
    buyerUsdc: await fork.usdc(ctx.buyer),
    referrerUsdc: await fork.usdc(REFERRER),
  };
  expect(after.buyerUsdc - before.buyerUsdc).toBe(net);
  expect(after.referrerUsdc - before.referrerUsdc).toBe(referral[0]!.args.feeAmount);
  // The seller's deposit paid out the gross amount; nothing is left locked for this order.
  expect(before.remaining - after.deposit.remainingDeposits).toBe(gross);
  expect(after.deposit.outstandingIntentAmount).toBe(before.outstanding);
  const intentAfter = await fork.intent(order.intentHash);
  expect(intentAfter.owner).toBe("0x0000000000000000000000000000000000000000");

  // What the player was told.
  expect(BigInt(completion.usdcReceived)).toBe(net);
  const ui = await ctx.page.uiText();
  const shown = (Number(net) / 1e6).toFixed(2);
  expect(ui).toContain("Congratulations!");
  expect(ui).toContain(`You bought ${shown} USDC.`);
  const chat = await ctx.page.eval<string[]>("window.__e2e.chat");
  expect(chat).toContain(`You bought ${shown} USDC.`);
  const announced = await ctx.page.eval<Array<{ kind: string; tx: string }>>("window.__e2e.announced");
  expect(announced.some((a) => a.kind === "bought" && a.tx.toLowerCase() === completion.fulfillTxHash.toLowerCase())).toBe(true);

  // ERC-8021 attribution on both transactions the player sent.
  const sent = await ctx.page.eval<Array<{ to: string; data: Hex; hash: Hex }>>("window.__e2e.sender.sent");
  const fulfilTx = sent.find((s) => s.hash.toLowerCase() === completion.fulfillTxHash.toLowerCase());
  expect(fulfilTx).toBeTruthy();
  expect(codes(fulfilTx!.data).slice(0, 2)).toEqual(["rampridge", "peer-ref-TOFIAT"]);
  if (order.signalTxHash) {
    const signalTx = sent.find((s) => s.hash.toLowerCase() === order.signalTxHash!.toLowerCase());
    if (signalTx) expect(codes(signalTx.data).slice(0, 2)).toEqual(["rampridge", "peer-ref-TOFIAT"]);
  }
  return {
    intentHash: order.intentHash,
    fulfillTx: completion.fulfillTxHash,
    grossUsdc: gross.toString(),
    netUsdc: net.toString(),
    quotedNetUsdc: quoted?.usdcAmount ?? null,
    referrerFee: referral[0]!.args.feeAmount.toString(),
    depositRemainingBefore: before.remaining.toString(),
    depositRemainingAfter: after.deposit.remainingDeposits.toString(),
    otherLegs: ev.transfers.map((t) => ({ to: t.args.to, value: t.args.value.toString() })),
    indexed: completion.indexed,
  };
}

type ChainBefore = Awaited<ReturnType<typeof chainBefore>>;

async function chainBefore(ctx: Ctx, depositId: string) {
  const d = await fork.deposit(BigInt(depositId));
  return {
    remaining: d.remainingDeposits,
    outstanding: d.outstandingIntentAmount,
    buyerUsdc: await fork.usdc(ctx.buyer),
    referrerUsdc: await fork.usdc(REFERRER),
  };
}

/**
 * The deposit read before signalling, net of any expired intents the signal pruned to make
 * room: their USDC went back to remainingDeposits and out of outstandingIntentAmount in the
 * same transaction, so from here on the deposit moves by exactly this order.
 */
async function prunedBySignal(ctx: Ctx, before: ChainBefore, order: NonNullable<StoreSnapshot["order"]>): Promise<ChainBefore> {
  expect(order.signalTxHash, "signal transaction recorded").toBeTruthy();
  const pruned = await fork.prunedAtSignal(order.signalTxHash!, BigInt(order.depositId), order.intentHash);
  if (pruned > 0n) ctx.rec.note(`signal pruned ${pruned} of expired intents from deposit ${order.depositId}`);
  return { ...before, remaining: before.remaining + pruned, outstanding: before.outstanding - pruned };
}

/** Signal through the UI, with the deposit read right before. */
async function placeOrder(ctx: Ctx) {
  const quoted = await requestQuote(ctx.page, ctx.rec, { decreaseBy10: 8 });
  const quote = quoted.quotes[0]!;
  expect(quote.platform).toBe("revolut");
  expect(getAddress(quote.escrow)).toBe(getAddress(ESCROW));
  const read = await chainBefore(ctx, quote.depositId);
  const placed = await confirmOffer(ctx.page, ctx.rec);
  const order = placed.order!;
  const before = await prunedBySignal(ctx, read, order);
  // The intent on chain is the one the scroll describes.
  const onchain = await fork.intent(order.intentHash);
  expect(getAddress(onchain.owner)).toBe(getAddress(ctx.buyer));
  expect(getAddress(onchain.to)).toBe(getAddress(ctx.buyer));
  expect(onchain.amount.toString()).toBe(order.usdcGross);
  expect(onchain.amount.toString()).toBe(quote.signalAmount);
  const legs = onchain.referralFees.filter((l) => getAddress(l.recipient) === getAddress(REFERRER));
  expect(legs.map((l) => l.fee)).toEqual([REFERRER_FEE_PRECISE]);
  const lock = await fork.lock(BigInt(order.depositId), order.intentHash);
  expect(Number(lock.expiryTime) * 1000).toBe(order.expiresAt);
  const scroll = await readScroll(ctx.page);
  expect(scroll.payee).toBe(quote.payeeHandle);
  expect((scroll.minor * 10_000).toString()).toBe(order.fiatToSend);
  ctx.rec.note(`quote ${quote.depositId} ${quote.payeeHandle}: pay ${scroll.amountText}, gross ${order.usdcGross}, expect ${order.usdcExpected} USDC`);
  return { quote, before, order, scroll };
}

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(PROFILES, { recursive: true });
  await fork.start();
  await vite.start();
});

afterAll(async () => {
  await vite.stop();
  await fork.stop();
  removeProfiles();
  writeFileSync(path.join(SHOTS, "observed.json"), JSON.stringify(observed, null, 2));
});

describe("RampRidge buy, full UI on a Base fork", () => {
  test("happy path (desktop): wrong payment rejected by the attestation, matching one releases USDC", async () => {
    const ctx = await prepare("happy", DESKTOP);
    try {
      await loadHarness(ctx.page, ctx.url());
      const { quote, before, order, scroll } = await placeOrder(ctx);
      // An earlier payment of the same amount to someone else, then the real one.
      const now = Date.now();
      await pay(vite, ctx.buyer, { username: WRONG_PAYEE, minor: scroll.minor, currency: "USD", at: now - 600_000 });
      await pay(vite, ctx.buyer, { username: scroll.payee, minor: scroll.minor, currency: "USD", at: now });
      const list = await paidAndCapture(ctx.page, ctx.rec);
      expect(list.step).toBe("selectPayment");
      // Sent payments only: the incoming transfer is filtered out; the coffee, the wrong one and the right one remain.
      expect(list.payments.map((p) => p.recipient)).toEqual([scroll.payee, WRONG_PAYEE, "cornercafe"]);
      observed.paymentRowDates = await ctx.page.eval<Array<string | null>>(
        "Array.from(document.querySelectorAll('.rb-payrow__date')).map((e) => e.textContent.trim() || null)",
      );

      await pickAndVerify(ctx.page, ctx.rec, WRONG_PAYEE);
      const rejected = await waitForOutcome(ctx.page, ctx.rec);
      expect(rejected.step).toBe("error");
      expect(rejected.error?.code).toBe("payee_mismatch");
      expect(rejected.errorReturnStep).toBe("selectPayment");
      const log = await vite.get<Array<{ status: number; message: string; intentHash: string }>>("/__e2e/attest/log");
      const forOrder = log.filter((d) => d.intentHash?.toLowerCase() === order.intentHash.toLowerCase());
      expect(forOrder.at(-1)).toMatchObject({ status: 400, message: "UnifiedPaymentVerifier: payee mismatch" });
      // Nothing moved on chain.
      expect((await fork.intent(order.intentHash)).amount.toString()).toBe(order.usdcGross);

      await ctx.page.click(/^(Pick another|Choose another|Back|Try another)/, { timeoutMs: 10_000 }).catch(async () => {
        ctx.rec.note(`error actions: ${await ctx.page.uiText()}`);
        throw new Error("no way back to the payment list after a payee mismatch");
      });
      await waitForPaymentList(ctx.page, ctx.rec);
      await pickAndVerify(ctx.page, ctx.rec, scroll.payee);
      const done = await waitForOutcome(ctx.page, ctx.rec);
      const chain = await assertReleased(ctx, before, order, done, quote);
      await finish(ctx, { outcome: "completed", chain });
    } catch (error) {
      await finish(ctx, { outcome: "failed", error: String(error) }).catch(() => undefined);
      throw error;
    }
  });

  test("happy path (phone 390x844): place, pay, verify, release", async () => {
    const ctx = await prepare("happy", PHONE);
    try {
      await loadHarness(ctx.page, ctx.url());
      const { quote, before, order, scroll } = await placeOrder(ctx);
      await pay(vite, ctx.buyer, { username: scroll.payee, minor: scroll.minor, currency: "USD", at: Date.now() });
      const list = await paidAndCapture(ctx.page, ctx.rec);
      expect(list.payments.map((p) => p.recipient)).toEqual([scroll.payee, "cornercafe"]);
      await pickAndVerify(ctx.page, ctx.rec, scroll.payee);
      const done = await waitForOutcome(ctx.page, ctx.rec);
      const chain = await assertReleased(ctx, before, order, done, quote);
      await finish(ctx, { outcome: "completed", chain });
    } catch (error) {
      await finish(ctx, { outcome: "failed", error: String(error) }).catch(() => undefined);
      throw error;
    }
  });

  test("cancel before paying: the intent is cancelled on chain and the seller's USDC unlocked", async () => {
    const ctx = await prepare("cancel", DESKTOP);
    try {
      await loadHarness(ctx.page, ctx.url());
      const { before, order } = await placeOrder(ctx);
      const locked = await fork.deposit(BigInt(order.depositId));
      expect(locked.outstandingIntentAmount - before.outstanding).toBe(BigInt(order.usdcGross));
      // "I have paid" by mistake: only the old coffee is listed, nothing matches, and the player is warned.
      const mistaken = await paidAndCapture(ctx.page, ctx.rec);
      expect(mistaken.payments.map((p) => p.recipient)).toEqual(["cornercafe"]);
      // Current copy, or the softer wording proposed in fixes.patch ("None of these show exactly ... do not pay again").
      expect(await ctx.page.uiText()).toMatch(/None of these (?:are for|show) exactly \$20\.00\./);
      // Looking for a way back to cancel: the list offers only "Verify this payment" and "Check again"...
      observed.selectPaymentButtons = await ctx.page.eval<string[]>(
        "Array.from(document.querySelectorAll('.rs-gameframe__interfaces button')).filter((b) => b.getClientRects().length > 0 && !b.classList.contains('rb-payrow')).map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim())",
      );
      // ...and the scroll, while the list is up, only sends the player back to it.
      await ctx.page.eval("window.__e2e.open({ id: 'payment' })");
      await ctx.page.waitFor(`document.body.innerText.includes('Continue verifying')`, 10_000, "scroll while verifying");
      await ctx.rec.shot(ctx.page, "scroll-while-listing");
      observed.scrollWhileListing = await ctx.page.uiText();
      // The only way out is a reload (the list is not persisted, the paid claim is).
      await ctx.page.reload();
      await ctx.page.waitFor("window.__e2e?.ready === true && window.__e2e.state().order !== null && !window.__e2e.state().recovering", 90_000, "reloaded (cancel)");
      await new Promise((r) => setTimeout(r, 800));
      await ctx.page.click(/^Buy offer: /);
      await ctx.page.waitFor(`window.__e2e.current?.id === 'verify'`, 10_000, "verify after reload (cancel)");
      await ctx.page.click("Back to payment");
      await ctx.page.waitFor(`document.body.innerText.includes("I haven't paid yet")`, 10_000, "paid-claimed scroll");
      await ctx.rec.shot(ctx.page, "scroll-paid-claimed");
      await ctx.page.click("I haven't paid yet");
      await ctx.page.click("Cancel offer");
      await ctx.rec.shot(ctx.page, "cancel-confirm");
      expect(await ctx.page.uiText()).toContain("Only cancel if you have not sent any money.");
      await ctx.page.click("Yes, cancel it");
      await ctx.page.waitFor(`window.__e2e.state().step === 'cancelled' || window.__e2e.state().step === 'error'`, 120_000, "cancelled");
      await new Promise((r) => setTimeout(r, 500));
      await ctx.rec.shot(ctx.page, "cancelled");
      const snap = await snapshot(ctx.page);
      expect(snap.step).toBe("cancelled");
      const ui = await ctx.page.uiText();
      expect(ui).toContain("Do not send any money for this offer.");
      expect(await ctx.page.eval<string[]>("window.__e2e.chat")).toContain("Your offer has been cancelled.");
      const after = await fork.deposit(BigInt(order.depositId));
      expect(after.remainingDeposits).toBe(before.remaining);
      expect(after.outstandingIntentAmount).toBe(before.outstanding);
      expect((await fork.intent(order.intentHash)).owner).toBe("0x0000000000000000000000000000000000000000");
      expect(await fork.usdc(ctx.buyer)).toBe(before.buyerUsdc);
      await ctx.page.click("Collect");
      await ctx.page.waitFor(`window.__e2e.current === null`, 10_000, "scroll closed");
      await ctx.page.eval("window.__e2e.open({ id: 'exchange' })");
      await new Promise((r) => setTimeout(r, 800));
      await ctx.rec.shot(ctx.page, "exchange-after-cancel");
      await finish(ctx, { outcome: "cancelled", ui });
    } catch (error) {
      await finish(ctx, { outcome: "failed", error: String(error) }).catch(() => undefined);
      throw error;
    }
  });

  test("page refresh after signalling and again after capture: the order is recovered and completes", async () => {
    const ctx = await prepare("refresh", DESKTOP);
    try {
      await loadHarness(ctx.page, ctx.url());
      const { quote, before, order, scroll } = await placeOrder(ctx);

      await ctx.page.reload();
      await ctx.page.waitFor("window.__e2e?.ready === true && !window.__e2e.state().recovering", 90_000, "reloaded");
      await ctx.page.waitFor(`window.__e2e.state().order?.intentHash === ${JSON.stringify(order.intentHash)}`, 60_000, "order recovered");
      await new Promise((r) => setTimeout(r, 800));
      await ctx.rec.shot(ctx.page, "reloaded-exchange");
      const slot = await ctx.page.uiText();
      expect(slot).toContain("Pay the seller");
      await ctx.page.click(/^Buy offer: /);
      await ctx.page.waitFor(`document.body.innerText.includes('Before you pay')`, 20_000, "scroll after reload");
      await ctx.rec.shot(ctx.page, "reloaded-scroll");
      const again = await readScroll(ctx.page);
      expect(again).toEqual(scroll);
      const recovered = (await snapshot(ctx.page)).order!;
      expect(recovered.fees).toEqual(order.fees);
      expect(recovered.usdcExpected).toBe(order.usdcExpected);

      await pay(vite, ctx.buyer, { username: scroll.payee, minor: scroll.minor, currency: "USD", at: Date.now() });
      await paidAndCapture(ctx.page, ctx.rec);

      await ctx.page.reload();
      await ctx.page.waitFor("window.__e2e?.ready === true && window.__e2e.state().order !== null && !window.__e2e.state().recovering", 90_000, "order recovered again");
      await new Promise((r) => setTimeout(r, 800));
      await ctx.rec.shot(ctx.page, "reloaded-after-capture");
      const paidSlot = await ctx.page.uiText();
      expect(paidSlot).toContain("Verify payment");
      expect((await snapshot(ctx.page)).order?.paidClaimedAt).not.toBeNull();
      await ctx.page.click(/^Buy offer: /);
      await ctx.page.waitFor(`window.__e2e.current?.id === 'verify'`, 10_000, "verify after reload");
      await ctx.rec.shot(ctx.page, "verify-ready");
      await ctx.page.click("Verify with Peer");
      await waitForPaymentList(ctx.page, ctx.rec);
      await pickAndVerify(ctx.page, ctx.rec, scroll.payee);
      const done = await waitForOutcome(ctx.page, ctx.rec);
      const chain = await assertReleased(ctx, before, order, done, quote);
      await finish(ctx, { outcome: "completed", chain, afterFirstReload: slot.slice(0, 300), afterSecondReload: paidSlot.slice(0, 300) });
    } catch (error) {
      await finish(ctx, { outcome: "failed", error: String(error) }).catch(() => undefined);
      throw error;
    }
  });

  test("expiry while on the scroll: shown as expired, a payment made in time still verifies", async () => {
    const ctx = await prepare("expiry", DESKTOP);
    try {
      await loadHarness(ctx.page, ctx.url());
      const { quote, before, order, scroll } = await placeOrder(ctx);
      // The player pays in time...
      const paidAt = Date.now() + 60_000;
      await pay(vite, ctx.buyer, { username: scroll.payee, minor: scroll.minor, currency: "USD", at: paidAt });
      // ...but comes back after the order expired: chain clock and page clock both move past expiry.
      const lock = await fork.lock(BigInt(order.depositId), order.intentHash);
      const chainNow = await fork.latestTimestamp();
      await fork.advance(Number(lock.expiryTime) - chainNow + 120);
      await ctx.page.eval(`window.__e2e.clock.offset = ${order.expiresAt + 120_000 - Date.now()}`);
      await ctx.page.waitFor(`document.body.innerText.includes('This offer has expired. Do not send money.')`, 15_000, "expired banner");
      await ctx.rec.shot(ctx.page, "scroll-expired");
      const ui = await ctx.page.uiText();
      expect(ui).not.toContain("I have paid");
      expect(ui).toContain("I paid before it expired");
      const stillLocked = await fork.lock(BigInt(order.depositId), order.intentHash);
      expect(stillLocked.intentHash.toLowerCase()).toBe(order.intentHash.toLowerCase());

      const list = await paidAndCapture(ctx.page, ctx.rec, "I paid before it expired");
      expect(list.step).toBe("selectPayment");
      await pickAndVerify(ctx.page, ctx.rec, scroll.payee);
      const done = await waitForOutcome(ctx.page, ctx.rec);
      const chain = await assertReleased(ctx, before, order, done, quote);
      await finish(ctx, { outcome: "completed after expiry", chain, expiredUi: ui.slice(0, 500) });
    } catch (error) {
      await finish(ctx, { outcome: "failed", error: String(error) }).catch(() => undefined);
      throw error;
    }
  });

  test("extension missing, phone browser, outdated extension, then connect and complete", async () => {
    const ctx = await prepare("extension", DESKTOP);
    const seen: Record<string, string> = {};
    try {
      await loadHarness(ctx.page, ctx.url({ ext: "missing" }));
      const { quote, before, order, scroll } = await placeOrder(ctx);
      await pay(vite, ctx.buyer, { username: scroll.payee, minor: scroll.minor, currency: "USD", at: Date.now() });

      // 1. Not installed.
      await ctx.page.click("I have paid");
      await ctx.page.waitFor(`window.__e2e.state().verifying === 'needsInstall'`, 15_000, "needs install");
      await ctx.rec.shot(ctx.page, "missing");
      seen.missing = await ctx.page.uiText();
      observed.installPanelText = seen.missing;
      expect(seen.missing).toMatch(/Peer extension/i);
      // Peer web's "Add to Chrome": opens the store, then waits for PeerAuth (checked every 5 s) with reload advice.
      await ctx.page.click(/^Add to (Chrome|Brave|browser)$/);
      await new Promise((r) => setTimeout(r, 1500));
      await ctx.rec.shot(ctx.page, "missing-after-installed-click");
      seen.afterInstalledClick = await ctx.page.uiText().catch(() => "(page reloaded)");
      observed.afterInstalledClickText = seen.afterInstalledClick;

      // 2. A phone browser cannot run the extension at all.
      const desktopUa = (await ctx.page.send<{ userAgent: string }>("Browser.getVersion")).userAgent;
      await ctx.page.viewport(PHONE, { userAgent: IPHONE_UA });
      await ctx.page.goto(ctx.url({ ext: "missing" }));
      await ctx.page.waitFor("window.__e2e?.ready === true && window.__e2e.state().order !== null && !window.__e2e.state().recovering", 90_000, "phone recovered");
      await ctx.page.click(/^Buy offer: /);
      await ctx.page.waitFor(`window.__e2e.current?.id === 'verify'`, 10_000, "verify (phone)");
      await ctx.page.click("Verify with Peer");
      await ctx.page.waitFor(`window.__e2e.state().verifying === 'unsupportedBrowser'`, 15_000, "unsupported browser");
      await ctx.rec.shot(ctx.page, "phone-unsupported");
      seen.phone = await ctx.page.uiText();
      expect(seen.phone).toMatch(/Chrome or Brave on a computer/i);

      // 3. An outdated extension (pre buyer-TEE build): rows but no session capture.
      await ctx.page.viewport(DESKTOP, { userAgent: desktopUa });
      await ctx.page.goto(ctx.url({ ext: "outdated" }));
      await ctx.page.waitFor("window.__e2e?.ready === true && window.__e2e.state().order !== null && !window.__e2e.state().recovering", 90_000, "desktop recovered");
      await ctx.page.click(/^Buy offer: /);
      await ctx.page.waitFor(`window.__e2e.current?.id === 'verify'`, 10_000, "verify (outdated)");
      await ctx.page.click("Verify with Peer");
      await ctx.page.waitFor(
        `['error', 'selectPayment'].includes(window.__e2e.state().step) || window.__e2e.state().verifying === 'needsUpdate'`,
        30_000,
        "outdated outcome",
      );
      await ctx.rec.shot(ctx.page, "outdated");
      seen.outdated = await ctx.page.uiText();
      const outdated = await snapshot(ctx.page);
      seen.outdatedCode = outdated.error?.code ?? outdated.verifying ?? outdated.step;

      observed.outdatedText = seen.outdated;

      // 4. The computer's clock is off: the extension cannot stage the session capture.
      await ctx.page.goto(ctx.url({ ext: "clock_skew" }));
      await ctx.page.waitFor("window.__e2e?.ready === true && window.__e2e.state().order !== null && !window.__e2e.state().recovering", 90_000, "recovered (clock)");
      await ctx.page.click(/^Buy offer: /);
      await ctx.page.waitFor(`window.__e2e.current?.id === 'verify'`, 10_000, "verify (clock)");
      await ctx.page.click("Verify with Peer");
      await ctx.page.waitFor(`window.__e2e.state().step === 'error'`, 30_000, "clock skew error");
      await ctx.rec.shot(ctx.page, "clock-skew");
      seen.clockSkew = await ctx.page.uiText();
      observed.clockSkewText = seen.clockSkew;
      seen.clockSkewDetail = (await snapshot(ctx.page)).error?.detail ?? "";

      // 5. Asked to connect, the player declines in the extension.
      await ctx.page.goto(ctx.url({ ext: "decline" }));
      await ctx.page.waitFor("window.__e2e?.ready === true && window.__e2e.state().order !== null && !window.__e2e.state().recovering", 90_000, "recovered (decline)");
      await ctx.page.click(/^Buy offer: /);
      await ctx.page.waitFor(`window.__e2e.current?.id === 'verify'`, 10_000, "verify (decline)");
      await ctx.page.click("Verify with Peer");
      await ctx.page.waitFor(`window.__e2e.state().verifying === 'needsConnection'`, 15_000, "needs connection (decline)");
      await ctx.page.click("Connect the Peer extension");
      await ctx.page.waitFor(`window.__e2e.state().notice !== null`, 15_000, "declined notice");
      await ctx.rec.shot(ctx.page, "connection-declined");
      seen.declined = await ctx.page.uiText();
      expect(seen.declined).toContain("Approve RampRidge in the Peer extension to continue.");

      // 6. Up to date but not yet connected: connect, capture, verify, release.
      await ctx.page.goto(ctx.url({ ext: "needs_connection" }));
      await ctx.page.waitFor("window.__e2e?.ready === true && window.__e2e.state().order !== null && !window.__e2e.state().recovering", 90_000, "recovered (connect)");
      await ctx.page.click(/^Buy offer: /);
      await ctx.page.waitFor(`window.__e2e.current?.id === 'verify'`, 10_000, "verify (connect)");
      await ctx.page.click("Verify with Peer");
      await ctx.page.waitFor(`window.__e2e.state().verifying === 'needsConnection'`, 15_000, "needs connection");
      await ctx.rec.shot(ctx.page, "needs-connection");
      seen.connect = await ctx.page.uiText();
      await ctx.page.click("Connect the Peer extension");
      await waitForPaymentList(ctx.page, ctx.rec);
      await pickAndVerify(ctx.page, ctx.rec, scroll.payee);
      const done = await waitForOutcome(ctx.page, ctx.rec);
      const chain = await assertReleased(ctx, before, order, done, quote);
      await finish(ctx, { outcome: "completed", chain, seen });
    } catch (error) {
      await finish(ctx, { outcome: "failed", error: String(error), seen }).catch(() => undefined);
      throw error;
    }
  });

  test("a payment already used for one order is refused on chain for the next (nullifier), via a stall trade", async () => {
    const ctx = await prepare("reuse", DESKTOP);
    try {
      await loadHarness(ctx.page, ctx.url());
      const first = await placeOrder(ctx);
      const paidAt = Date.now();
      await pay(vite, ctx.buyer, { username: first.scroll.payee, minor: first.scroll.minor, currency: "USD", at: paidAt });
      await paidAndCapture(ctx.page, ctx.rec);
      await pickAndVerify(ctx.page, ctx.rec, first.scroll.payee);
      const done = await waitForOutcome(ctx.page, ctx.rec);
      await assertReleased(ctx, first.before, first.order, done, first.quote);
      await ctx.page.click("Collect");
      await ctx.page.waitFor(`window.__e2e.state().step === 'idle'`, 10_000, "collected");

      // The seller tops the deposit back up (fork only), and the player trades with that seller's stall again.
      await fork.topUpDeposit(BigInt(first.order.depositId), BigInt(first.order.usdcGross) * 2n);
      const stall = {
        depositId: first.order.depositId,
        escrow: first.order.escrow,
        platform: "revolut",
        currency: "USD",
        available: "40",
        rate: "1.00",
      };
      await ctx.page.eval(`window.__e2e.open(${JSON.stringify({ id: "trade", target: { kind: "stall", pid: "p-seller", name: "Fork Seller", stall } })})`);
      await ctx.page.waitFor(`document.body.innerText.includes('Trading with')`, 15_000, "trade window");
      // The trade pad has no -/+ buttons: "..." opens the chatbox amount prompt.
      await ctx.page.click("Enter an amount");
      await ctx.page.waitFor(`document.activeElement instanceof HTMLInputElement`, 10_000, "amount prompt");
      await ctx.page.typeAndEnter((Number(BigInt(first.order.fiatToSend) / 10_000n) / 100).toFixed(2));
      await ctx.page.waitFor(`document.body.innerText.includes('$${(Number(BigInt(first.order.fiatToSend) / 10_000n) / 100).toFixed(2)} (Revolut)')`, 10_000, "amount set");
      await ctx.page.waitFor(
        `Array.from(document.querySelectorAll('.rs-gameframe__interfaces button')).some((b) => b.textContent.trim() === 'Accept' && !b.disabled)`,
        60_000,
        "stall quote",
      );
      await ctx.rec.shot(ctx.page, "trade-offer");
      await ctx.page.click("Accept");
      await ctx.page.waitFor(`document.body.innerText.includes('Are you sure you want to make this trade?') || window.__e2e.state().step === 'error'`, 60_000, "trade confirm");
      await ctx.rec.shot(ctx.page, "trade-confirm");
      const read2 = await chainBefore(ctx, first.order.depositId);
      await ctx.page.click("Accept");
      await ctx.page.waitFor(
        `(window.__e2e.state().step === 'awaitingPayment' && document.body.innerText.includes('Before you pay')) || window.__e2e.state().step === 'error'`,
        120_000,
        "second order placed",
      );
      await ctx.rec.shot(ctx.page, "second-scroll");
      const second = (await snapshot(ctx.page)).order!;
      expect(second.depositId).toBe(first.order.depositId);
      expect(second.payeeHandle).toBe(first.scroll.payee);
      expect(second.intentHash).not.toBe(first.order.intentHash);
      const before2 = await prunedBySignal(ctx, read2, second);

      // The player claims the first order's payment for this one: it is listed (right payee, right amount)...
      const list = await paidAndCapture(ctx.page, ctx.rec);
      expect(list.payments[0]?.recipient).toBe(first.scroll.payee);
      await pickIndexAndVerify(ctx.page, ctx.rec, list.payments[0]!.index);
      const refused = await waitForOutcome(ctx.page, ctx.rec);
      // ...the attestation signs it (the service does not track nullifiers), but the verifier refuses it on chain.
      const log = await vite.get<Array<{ status: number; intentHash: string; paymentId?: string }>>("/__e2e/attest/log");
      const forSecond = log.filter((d) => d.intentHash?.toLowerCase() === second.intentHash.toLowerCase());
      expect(forSecond.at(-1)?.status).toBe(200);
      expect(refused.step).toBe("error");
      expect(refused.error?.code).toBe("nullifier_used");
      expect(await ctx.page.uiText()).toContain("That payment was already used for another order. Pick a different one.");
      expect((await fork.intent(second.intentHash)).amount.toString()).toBe(second.usdcGross);

      // Paying properly for the second order then completes it.
      await pay(vite, ctx.buyer, { username: first.scroll.payee, minor: Number(BigInt(second.fiatToSend) / 10_000n), currency: "USD", at: Date.now() });
      await ctx.page.click("Pick another payment");
      await waitForPaymentList(ctx.page, ctx.rec);
      await ctx.page.click("Check again");
      const fresh = await waitForPaymentList(ctx.page, ctx.rec);
      await pickIndexAndVerify(ctx.page, ctx.rec, fresh.payments[0]!.index);
      const done2 = await waitForOutcome(ctx.page, ctx.rec);
      const chain = await assertReleased(ctx, before2, second, done2, null);
      await finish(ctx, { outcome: "nullifier refused, then completed", chain, refused: refused.error });
    } catch (error) {
      await finish(ctx, { outcome: "failed", error: String(error) }).catch(() => undefined);
      throw error;
    }
  });

  test("underpayment: the attestation releases proportionally and the UI reports what actually arrived", async () => {
    const ctx = await prepare("underpay", DESKTOP);
    try {
      await loadHarness(ctx.page, ctx.url());
      const { before, order, scroll } = await placeOrder(ctx);
      const short = scroll.minor - 500;
      await pay(vite, ctx.buyer, { username: scroll.payee, minor: short, currency: "USD", at: Date.now() });
      const list = await paidAndCapture(ctx.page, ctx.rec);
      expect(list.payments[0]?.recipient).toBe(scroll.payee);
      await pickAndVerify(ctx.page, ctx.rec, scroll.payee);
      const done = await waitForOutcome(ctx.page, ctx.rec);
      expect(done.step).toBe("completed");
      const receipt = await fork.receipt(done.completion!.fulfillTxHash);
      const ev = events(receipt.logs);
      const unlocked = ev.unlocked[0]!;
      // release = paid cents x 1e22 / rate, capped at the intent (attestation-service releaseAmount.ts).
      const expectedRelease = (BigInt(short) * 10n ** 22n) / BigInt(order.rate);
      expect(unlocked.args.transferredAmount).toBe(expectedRelease < BigInt(order.usdcGross) ? expectedRelease : BigInt(order.usdcGross));
      const net = ev.fulfilled[0]!.args.amount;
      expect(BigInt(done.completion!.usdcReceived)).toBe(net);
      const after = await fork.deposit(BigInt(order.depositId));
      // Only what was released left the deposit; the rest went back to the seller's liquidity.
      expect(before.remaining - after.remainingDeposits).toBe(unlocked.args.transferredAmount);
      expect(after.outstandingIntentAmount).toBe(before.outstanding);
      expect((await fork.usdc(ctx.buyer)) - before.buyerUsdc).toBe(net);
      const ui = await ctx.page.uiText();
      expect(ui).toContain(`You bought ${(Number(net) / 1e6).toFixed(2)} USDC.`);
      observed.underpaidCompletedText = ui;
      observed.underpaid = { paidMinor: short, orderFiat: scroll.amountText };
      await finish(ctx, { outcome: "completed (partial)", paidMinor: short, released: unlocked.args.transferredAmount.toString(), net: net.toString(), ui: ui.slice(0, 300) });
    } catch (error) {
      await finish(ctx, { outcome: "failed", error: String(error) }).catch(() => undefined);
      throw error;
    }
  });
});

/**
 * RampRidge defects the fork e2e exposed. Each asserts the behaviour the
 * player needs (and Peer's own web client provides), so it fails today;
 * `test.fails` keeps the suite green until the fix lands, then flips red so
 * the marker gets removed. The observations come from the scenarios above.
 */
/** E2E_EXPECT_FIXED=1 runs the bug checks as plain tests: green once the fixes are in (or with E2E_SRC_DIR=patched). */
const bugTest = process.env.E2E_EXPECT_FIXED === "1" ? test : test.fails;

describe("known RampRidge buy-flow bugs (test.fails until fixed)", () => {
  test("the scenarios recorded every observation the bug checks need", () => {
    expect(observed.paymentRowDates?.length).toBeGreaterThan(0);
    expect(observed.outdatedText).toBeTruthy();
    expect(observed.clockSkewText).toBeTruthy();
    expect(observed.afterInstalledClickText).toBeTruthy();
    expect(observed.installPanelText).toMatch(/Peer extension/i);
    expect(observed.underpaidCompletedText).toBeTruthy();
    expect(observed.selectPaymentButtons?.length).toBeGreaterThan(0);
    expect(observed.scrollWhileListing).toContain("Continue verifying");
  });

  bugTest("BUG-1 the payment picker shows Revolut dates as raw epoch milliseconds", () => {
    // Peer web parses Revolut's completedDate (new Date(metadata.date)); the player is told to "check the date too".
    for (const date of observed.paymentRowDates ?? []) expect(date ?? "").not.toMatch(/^\d{10,}$/);
  });

  bugTest("BUG-2 an outdated Peer extension is reported as a Revolut login problem instead of 'update the extension'", () => {
    // Peer web compares getVersion() with each method's minExtensionVersion (Revolut 0.6.3) and shows "Update Extension".
    expect(observed.outdatedText ?? "").toMatch(/update/i);
  });

  bugTest("BUG-3 a clock-skew capture failure is reported as a Revolut login problem instead of 'sync your clock'", () => {
    // Peer web maps "Attestation timestamp skew exceeds Nms" to "Your computer's clock appears to be out of sync...".
    expect(observed.clockSkewText ?? "").toMatch(/clock/i);
  });

  bugTest("BUG-4 after installing the extension the open tab can never see it, and the UI never says to reload", () => {
    // Chrome injects manifest content scripts on navigation only; window.peer appears after a reload, but
    // "I've installed it" only re-checks the same page and the copy says "Come back to this tab".
    // Peer web says "Try refreshing page" once "Add to Chrome" is pressed; RampRidge does the same.
    expect(observed.afterInstalledClickText ?? "").toMatch(/reload|refresh/i);
  });

  bugTest("BUG-6 once payments are listed there is no way back to the scroll to cancel (only a page reload escapes)", () => {
    // Every other Verify state has "Back to payment"; the list has only "Verify this payment" and "Check again",
    // and the scroll meanwhile shows only "Continue verifying". store.back() supports selectPayment -> awaitingPayment.
    expect(observed.selectPaymentButtons ?? []).toEqual(expect.arrayContaining([expect.stringMatching(/back/i)]));
  });

  bugTest("BUG-5 an underpaid order's success screen says the player paid the full amount", () => {
    const paid = `$${((observed.underpaid?.paidMinor ?? 0) / 100).toFixed(2)}`;
    expect(observed.underpaidCompletedText ?? "").toContain(`You paid ${paid}`);
  });
});
