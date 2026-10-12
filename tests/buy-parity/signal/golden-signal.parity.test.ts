/**
 * GOLDEN SIGNAL: RampRidge's buy signal (src/peer/buy/chain.ts
 * signalBuyIntent) against the Peer web app, on a Base fork at the latest
 * block.
 *
 * For five platform/currency pairs a LIVE Curator quote (mode "eligible",
 * RampRidge's 50 bps referrer fee) is signalled by a fresh fork account
 * through RampRidge's own external-wallet TxSender, with the REAL Curator
 * /v3/sign signature for that account. The resulting call and on-chain
 * intent are compared field by field with what the Peer web app's code
 * (helpers/webReference.ts, zkp2p-clients main) hands the same SDK for the
 * same quote, and with real recent web-app signalIntent calls decoded from
 * Base mainnet. Each intent is then cancelled with RampRidge's
 * cancelBuyIntent and the deposit's liquidity must come back in full.
 *
 * Nothing touches Base mainnet: transactions land on the fork only, and the
 * mainnet proxy refuses every send method.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BUY_REFERRER_FEE, PEER_ATTRIBUTION } from "@/config";
import { fiatToSend } from "@/peer/buy/amounts";
import { BUY_REFERRER_FEE_PRECISE, DEFAULT_INTENT_TTL_MS, decodeSignalCall, parseSignaledIntent } from "@/peer/buy/chain";
import { createPeerClient } from "@/peer/client";
import { BUY_PLATFORMS } from "@/peer/platforms";
import { scopeUserOperation } from "@/wallet/sequence";
import {
  FALLBACK_PAIRS,
  PRIMARY_PAIRS,
  RAMPRIDGE_FEE_PRECISE,
  bareSignalCalldata,
  directCalldata,
  fillableQuotes,
  hasDuplicateRecipient,
  label,
  runSignalCase,
  suffixFor,
  webReference,
  type Pair,
  type SignalCase,
} from "./helpers/cases";
import { assertOwnFork, eoaSender, forkClient, fundedAccount, revert, snapshot, usdcBalance } from "./helpers/fork";
import {
  BASE_BUILDER_CODE,
  ESCROW,
  GATING_SERVICE,
  ORCHESTRATOR,
  WEB_REFERRER_CODE,
  attributionCodes,
  currencyHash,
  depositGatingService,
  effectiveRate,
  gatingSigner,
  netRelease,
  paymentMethodHash,
  paymentMethodName,
  type SignalParams,
} from "./helpers/peer";
import { recentTofiatDeposits, tofiatQuote } from "./helpers/tofiat";
import { recentWebSignals, type WebSignal } from "./helpers/webMainnet";
import type { BuyQuote } from "@/peer/market";

const RAMPRIDGE_CODES = [...PEER_ATTRIBUTION, BASE_BUILDER_CODE];
const WEB_CODES = [WEB_REFERRER_CODE, BASE_BUILDER_CODE];
const CASES = 5;
/** Curator's /v3/sign signatures are valid for one hour (3,600 s), as every real web signal shows. */
const SIGNATURE_WINDOW_S = 3_600n;
/** The fork's block timestamps can trail wall-clock time slightly. */
const FORK_CLOCK_SLACK_S = 60n;

const cases: SignalCase[] = [];
/** A quote on a deposit whose Curator legs already pay RampRidge's wallet (TOFIAT integration share). */
let tofiat: { pair: Pair; quote: BuyQuote } | null = null;
let forkStart: Hex;

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Every field the web app and RampRidge must agree on (everything but the signature and its expiry). */
function comparable(p: SignalParams) {
  return {
    escrow: p.escrow.toLowerCase(),
    depositId: p.depositId,
    amount: p.amount,
    to: p.to.toLowerCase(),
    paymentMethod: p.paymentMethod.toLowerCase(),
    fiatCurrency: p.fiatCurrency.toLowerCase(),
    conversionRate: p.conversionRate,
    postIntentHook: p.postIntentHook.toLowerCase(),
    data: p.data,
    referralFees: p.referralFees.map((l) => ({ recipient: l.recipient.toLowerCase(), fee: l.fee })),
    preIntentHookData: p.preIntentHookData,
  };
}

beforeAll(async () => {
  await assertOwnFork();
  forkStart = await snapshot();
  const tried: string[] = [];
  for (const pair of [...PRIMARY_PAIRS, ...FALLBACK_PAIRS]) {
    if (cases.length >= CASES) break;
    if (!BUY_PLATFORMS[pair.platform].live) continue;
    const fork = await fundedAccount();
    const sender = eoaSender(fork);
    const client = createPeerClient({ sender });
    const quotes = await fillableQuotes(client, pair, fork.address);
    let chosen: BuyQuote | null = null;
    let chosenReference: Awaited<ReturnType<typeof webReference>> | null = null;
    for (const quote of quotes) {
      // Deposits listed with Galleon's TOFIAT code already carry a leg to RampRidge's fee wallet;
      // they are exercised by their own test below, the golden cases use ordinary liquidity.
      const reference = await webReference(client, quote, fork.address);
      if (hasDuplicateRecipient(reference.withFee.params.referralFees)) {
        tofiat ??= { pair, quote };
        continue;
      }
      chosen = quote;
      chosenReference = reference;
      break;
    }
    tried.push(`${label(pair)}:${quotes.length}`);
    if (!chosen) continue;
    cases.push(
      await runSignalCase({ pair, quote: chosen, client, sender, calldata: directCalldata, web: chosenReference ?? undefined }),
    );
  }
  if (cases.length < CASES) throw new Error(`Only ${cases.length} pairs had a fillable quote (${tried.join(", ")})`);
});

afterAll(async () => {
  if (forkStart) await revert(forkStart);
});

describe.each(Array.from({ length: CASES }, (_, i) => i))("golden signal case %i", (i) => {
  const c = () => {
    const value = cases[i];
    if (!value) throw new Error(`case ${i} did not run`);
    return value;
  };

  test("signals through RampRidge's TxSender with Curator's real /v3/sign signature for that account", () => {
    const { signal, onchain, owner, quote, signalReceipt } = c();
    expect(signalReceipt.status).toBe("success");
    expect(signal.orchestrator).toBe(ORCHESTRATOR);
    expect(onchain.owner).toBe(owner);
    expect(onchain.escrow).toBe(ESCROW);
    expect(onchain.depositId).toBe(BigInt(quote.depositId));
  });

  test("the call RampRidge sent is byte-identical to the Peer web app's for the same quote, bar signature and attribution", () => {
    const { sent, sentData, web } = c();
    const webParams = web.withFee.params;
    expect(web.applyWebReferrerFee, "the quote priced a referrer fee, so the web app applies its fee config").toBe(true);
    expect(comparable(sent)).toEqual(comparable(webParams));
    // Re-encode the web app's call with RampRidge's signature: the bare calldata must match byte for byte.
    const webWithOurSignature = bareSignalCalldata({
      ...webParams,
      gatingServiceSignature: sent.gatingServiceSignature,
      signatureExpiration: sent.signatureExpiration,
    });
    expect(sentData).toBe(`${webWithOurSignature}${suffixFor(RAMPRIDGE_CODES).slice(2)}`);
    expect(web.withFee.data).toBe(`${bareSignalCalldata(webParams)}${suffixFor(WEB_CODES).slice(2)}`);
  });

  test("amount: the quote's gross signalIntentAmount, which the web app also signals", () => {
    const { quote, onchain, sent, signal } = c();
    const raw = quote.raw as unknown as { signalIntentAmount?: string; tokenAmount: string };
    expect(raw.signalIntentAmount, "Curator returned the gross amount").toBeDefined();
    expect(onchain.amount).toBe(BigInt(raw.signalIntentAmount!));
    expect(onchain.amount).toBe(quote.signalAmount);
    expect(sent.amount).toBe(quote.signalAmount);
    expect(signal.amount).toBe(onchain.amount);
    expect(onchain.amount).toBeGreaterThan(BigInt(raw.tokenAmount));
  });

  test("conversionRate: Curator's taker rate, at or above the deposit's on-chain minimum", async () => {
    const { quote, onchain, signal, web } = c();
    const raw = quote.raw as unknown as { takerConversionRate?: string; conversionRate: string };
    expect(onchain.conversionRate).toBe(BigInt(raw.takerConversionRate ?? raw.conversionRate));
    expect(onchain.conversionRate).toBe(quote.rate);
    expect(onchain.conversionRate).toBe(web.withFee.params.conversionRate);
    expect(signal.rate).toBe(onchain.conversionRate);
    const floor = await effectiveRate(forkClient, onchain.depositId, onchain.paymentMethod, onchain.fiatCurrency);
    expect(onchain.conversionRate).toBeGreaterThanOrEqual(floor);
  });

  test("payment method and currency hashes: the SDK catalog's, as the web app resolves them", () => {
    const { pair, quote, onchain } = c();
    expect(onchain.paymentMethod).toBe(paymentMethodHash(pair.platform));
    expect(paymentMethodName(onchain.paymentMethod)).toBe(pair.platform);
    expect(onchain.fiatCurrency).toBe(currencyHash(pair.currency));
    expect(onchain.fiatCurrency.toLowerCase()).toBe(String(quote.raw.intent.fiatCurrencyCode).toLowerCase());
    // The payee the payment scroll shows is the one the intent is bound to.
    expect(onchain.payeeId.toLowerCase()).toBe(quote.payeeDetailsHash.toLowerCase());
  });

  test("toAddress: the signalling wallet itself, as the web app does by default", () => {
    const { onchain, owner } = c();
    expect(onchain.to).toBe(owner);
    expect(onchain.postIntentHook).toBe(zeroAddress);
    expect(onchain.data).toBe("0x");
  });

  test("referral legs: Curator's Peer legs for a plain web buyer, plus exactly one 50 bps leg to RampRidge's wallet", () => {
    const { onchain, web } = c();
    const ours = onchain.referralFees.filter((l) => sameAddress(l.recipient, BUY_REFERRER_FEE.recipient));
    expect(ours).toEqual([{ recipient: BUY_REFERRER_FEE.recipient, fee: RAMPRIDGE_FEE_PRECISE }]);
    expect(RAMPRIDGE_FEE_PRECISE).toBe(5n * 10n ** 15n);
    expect(BUY_REFERRER_FEE_PRECISE).toBe(RAMPRIDGE_FEE_PRECISE);
    const peerLegs = onchain.referralFees.filter((l) => !sameAddress(l.recipient, BUY_REFERRER_FEE.recipient));
    expect(peerLegs.map((l) => ({ recipient: l.recipient.toLowerCase(), fee: l.fee }))).toEqual(
      web.plain.params.referralFees.map((l) => ({ recipient: l.recipient.toLowerCase(), fee: l.fee })),
    );
    expect(hasDuplicateRecipient(onchain.referralFees)).toBe(false);
  });

  test("'You receive' never exceeds what fulfilment releases: gross minus every leg and the manager fee, each floored as OrchestratorV3 does", () => {
    const { quote, onchain, managerFee } = c();
    const released = netRelease(onchain.amount, onchain.referralFees, managerFee);
    const detail = JSON.stringify(
      {
        pair: label(c().pair),
        depositId: quote.depositId,
        amount: onchain.amount,
        legs: onchain.referralFees,
        managerFee,
        quoteFees: quote.fees,
        raw: {
          tokenAmount: quote.raw.tokenAmount,
          zkp2pFeeAmount: quote.raw.zkp2pFeeAmount,
          managerFeeAmount: (quote.raw as { managerFeeAmount?: string }).managerFeeAmount,
          totalFeeAmount: (quote.raw as { totalFeeAmount?: string }).totalFeeAmount,
          referrerFeeAmount: (quote.raw as { referrerFeeAmount?: string }).referrerFeeAmount,
        },
        released,
        shown: quote.usdcAmount,
      },
      (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(released, `shown more USDC than the intent releases: ${detail}`).toBeGreaterThanOrEqual(quote.usdcAmount);
    // Only per-leg flooring may separate them: Curator floors Peer's fee once, the orchestrator floors each leg.
    expect(released - quote.usdcAmount, detail).toBeLessThanOrEqual(BigInt(onchain.referralFees.length + 1));
    expect((onchain.amount * RAMPRIDGE_FEE_PRECISE) / 10n ** 18n).toBe(quote.fees.referrer);
    expect(quote.fees.manager, detail).toBe((onchain.amount * managerFee) / 10n ** 18n);
  });

  test("fiat to send covers amount x rate and matches the fiat the player asked to pay", () => {
    const { quote, onchain } = c();
    const owed = (onchain.amount * onchain.conversionRate) / 10n ** 18n;
    const toSend = fiatToSend(onchain.amount, onchain.conversionRate, quote.currency);
    expect(toSend).toBeGreaterThanOrEqual(owed);
    // Exact-fiat quotes: the gross USDC is floored, so amount x rate never exceeds the asked amount.
    expect(owed).toBeLessThanOrEqual(quote.fiatAmount);
    expect(toSend).toBe(quote.fiatAmount);
  });

  test("gating signature: Curator's gating service signed it for this msg.sender, valid for Curator's one-hour window", async () => {
    const { sent, owner, blockTimestamp, sentData, signal } = c();
    const gate = await depositGatingService(forkClient, sent.depositId, sent.paymentMethod);
    expect(gate).toBe(GATING_SERVICE);
    expect(await gatingSigner(sent, owner)).toBe(gate);
    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect(await gatingSigner(sent, other)).not.toBe(gate);
    // Curator signs for one hour from its own clock; the fork's block clock may trail it by a few seconds.
    const remaining = sent.signatureExpiration - blockTimestamp;
    expect(remaining).toBeGreaterThan(SIGNATURE_WINDOW_S - 300n);
    expect(remaining).toBeLessThanOrEqual(SIGNATURE_WINDOW_S + FORK_CLOCK_SLACK_S);
    // RampRidge's own decoder (used to judge whether an unseen send can still land) reads the same expiry and legs.
    const decoded = decodeSignalCall(sentData);
    expect(decoded?.signatureExpiresAt).toBe(Number(sent.signatureExpiration) * 1000);
    expect(decoded?.referralFees).toEqual(sent.referralFees);
    expect(signal.txHash).not.toBeNull();
  });

  test("the escrow lock: amount reserved, expiry 6 h after signalling as RampRidge assumes", () => {
    const { escrowLock, onchain, signal, before, afterSignal, prunedDuringSignal } = c();
    expect(escrowLock.amount).toBe(onchain.amount);
    expect(signal.expiresAt).toBe(Number(escrowLock.expiryTime) * 1000);
    expect(signal.expiresAt - signal.signaledAt).toBe(DEFAULT_INTENT_TTL_MS);
    if (prunedDuringSignal.length === 0) {
      expect(afterSignal.remainingDeposits).toBe(before.remainingDeposits - onchain.amount);
      expect(afterSignal.outstandingIntentAmount).toBe(before.outstandingIntentAmount + onchain.amount);
    }
  });

  test("ERC-8021 attribution: RampRidge's codes then Peer's Base builder code, where the web app has zkp2p-web", () => {
    const { sentData, cancelData, web } = c();
    expect(attributionCodes(sentData)).toEqual(RAMPRIDGE_CODES);
    expect(attributionCodes(cancelData)).toEqual(RAMPRIDGE_CODES);
    expect(attributionCodes(web.withFee.data)).toEqual(WEB_CODES);
  });

  test("cancelBuyIntent releases the lock and restores the deposit's liquidity", async () => {
    const { afterSignal, afterCancel, before, onchain, prunedDuringSignal, afterCancelEscrow, afterCancelOwnerIntents, afterCancelIntent, signal, owner, availableBefore, availableAfterCancel } = c();
    expect(afterCancel.remainingDeposits).toBe(afterSignal.remainingDeposits + onchain.amount);
    expect(afterCancel.outstandingIntentAmount).toBe(afterSignal.outstandingIntentAmount - onchain.amount);
    if (prunedDuringSignal.length === 0) {
      expect(afterCancel).toEqual(before);
      expect(availableAfterCancel).toBe(availableBefore);
    }
    expect(afterCancelEscrow).toEqual({ open: false });
    expect(afterCancelOwnerIntents).not.toContain(signal.intentHash);
    expect(afterCancelIntent.owner).toBe(zeroAddress);
    expect(await usdcBalance(owner)).toBe(0n);
  });
});

describe("a deposit whose Curator legs already pay RampRidge's wallet (TOFIAT integration share)", () => {
  test("signals without a duplicate recipient (OrchestratorV3 rejects one) and leaves the buyer at least the quoted USDC", async (ctx) => {
    const fork = await fundedAccount();
    const sender = eoaSender(fork);
    const client = createPeerClient({ sender });
    let target = tofiat;
    if (!target) {
      const found = await tofiatQuote(client, fork.address, await recentTofiatDeposits());
      target = found ? { pair: { platform: found.deposit.platform, currency: found.deposit.currency }, quote: found.quote } : null;
    }
    if (!target) {
      ctx.skip("no TOFIAT-listed deposit with fillable liquidity right now");
      return;
    }
    const reference = await webReference(client, target.quote, fork.address);
    // Precondition: with RampRidge's fee config Curator signs two legs to the same wallet.
    expect(hasDuplicateRecipient(reference.withFee.params.referralFees)).toBe(true);
    expect(reference.plain.params.referralFees.some((l) => sameAddress(l.recipient, BUY_REFERRER_FEE.recipient))).toBe(true);
    const snap = await snapshot();
    try {
      const result = await runSignalCase({ pair: target.pair, quote: target.quote, client, sender, calldata: directCalldata, web: reference });
      expect(hasDuplicateRecipient(result.onchain.referralFees)).toBe(false);
      // Exactly what Curator signs for a plain Peer web buyer on this deposit.
      expect(comparable(result.sent).referralFees).toEqual(comparable(result.web.plain.params).referralFees);
      expect(netRelease(result.onchain.amount, result.onchain.referralFees, result.managerFee)).toBeGreaterThanOrEqual(
        result.quote.usdcAmount,
      );
      expect(result.afterCancel.remainingDeposits).toBe(result.afterSignal.remainingDeposits + result.onchain.amount);
    } finally {
      await revert(snap);
    }
  });
});

describe("real Peer web app signals on Base mainnet", () => {
  let web: WebSignal[] = [];

  beforeAll(async () => {
    const platforms = [...new Set(cases.map((x) => x.pair.platform))];
    web = await recentWebSignals({ platforms, perPlatform: 3, maxBlocks: 400_000n });
  });

  test("at least three recent web-app signals for the same platforms", () => {
    expect(web.length).toBeGreaterThanOrEqual(3);
    for (const w of web) expect(cases.map((x) => x.pair.platform)).toContain(w.platform);
  });

  test("the web app's on-chain call has RampRidge's shape: EscrowV2, no hooks, no data, and by default recipient = signer", () => {
    // A web buyer can name another recipient (custom address or Relay delivery); the default, which
    // RampRidge always uses, is the signing wallet itself.
    expect(web.some((w) => sameAddress(w.params.to, w.caller))).toBe(true);
    for (const w of web) {
      expect(w.params.escrow, w.txHash).toBe(ESCROW);
      expect(w.params.postIntentHook, w.txHash).toBe(zeroAddress);
      expect(w.params.data, w.txHash).toBe("0x");
      expect(w.params.preIntentHookData, w.txHash).toBe("0x");
      expect(w.params.to, w.txHash).not.toBe(zeroAddress);
      for (const ours of cases.filter((x) => x.pair.platform === w.platform)) {
        expect(ours.sent.paymentMethod).toBe(w.params.paymentMethod);
        expect(ours.sent.preIntentHookData).toBe(w.params.preIntentHookData);
        expect(ours.sent.postIntentHook).toBe(w.params.postIntentHook);
        expect(ours.sent.data).toBe(w.params.data);
      }
    }
  });

  test("Peer's own legs in RampRidge intents are legs real web intents carry", () => {
    const webLegs = new Set(web.flatMap((w) => w.params.referralFees.map((l) => `${l.recipient.toLowerCase()}:${l.fee}`)));
    for (const ours of cases) {
      const peer = ours.onchain.referralFees.filter((l) => !sameAddress(l.recipient, BUY_REFERRER_FEE.recipient));
      expect(peer.length, label(ours.pair)).toBeGreaterThan(0);
      for (const leg of peer) expect(webLegs, `${label(ours.pair)} ${leg.recipient}`).toContain(`${leg.recipient.toLowerCase()}:${leg.fee}`);
    }
  });

  test("the gating signature window is the same one-hour window the web app gets", () => {
    const windows = web.map((w) => w.params.signatureExpiration - w.blockTimestamp);
    for (const remaining of windows) {
      expect(remaining).toBeGreaterThan(SIGNATURE_WINDOW_S - 600n);
      expect(remaining).toBeLessThanOrEqual(SIGNATURE_WINDOW_S);
    }
    for (const ours of cases) {
      const remaining = ours.sent.signatureExpiration - ours.blockTimestamp;
      expect(remaining).toBeGreaterThan(SIGNATURE_WINDOW_S - 600n);
    }
  });

  test("attribution: web calldata ends zkp2p-web + builder code; RampRidge's carries its own codes before the same builder code", () => {
    for (const w of web) expect(w.codes).toEqual(WEB_CODES);
    for (const ours of cases) {
      const codes = attributionCodes(ours.sentData);
      expect(codes.at(-1)).toBe(BASE_BUILDER_CODE);
      expect(codes).not.toContain(WEB_REFERRER_CODE);
    }
  });

  test("RampRidge's decoder reads real web calldata: legs and signature expiry", () => {
    for (const w of web) {
      const decoded = decodeSignalCall(w.input);
      expect(decoded, w.txHash).not.toBeNull();
      expect(decoded!.referralFees).toEqual(w.params.referralFees);
      expect(decoded!.signatureExpiresAt).toBe(Number(w.params.signatureExpiration) * 1000);
    }
  });

  test("RampRidge's receipt parsing finds each real web intent, including inside ERC-4337 bundles", () => {
    for (const w of web) {
      const bundled = w.txTo !== null && !sameAddress(w.txTo, ORCHESTRATOR);
      const scope = scopeUserOperation(w.receipt, w.caller as Address);
      if (bundled) expect(scope.outcome, w.txHash).toBe("success");
      const logs = scope.outcome === "success" ? scope.logs : w.receipt.logs;
      const parsed = parseSignaledIntent(logs, w.caller as Address, { depositId: w.params.depositId, orchestrator: ORCHESTRATOR });
      expect(parsed, w.txHash).not.toBeNull();
      expect(parsed!.intentHash).toBe(w.intentHash);
      expect(parsed!.amount).toBe(w.params.amount);
      expect(parsed!.rate).toBe(w.params.conversionRate);
      expect(parsed!.depositId).toBe(w.params.depositId);
    }
  });
});
