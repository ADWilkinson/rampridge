/**
 * The buy flow as the Exchange UI drives it: the app's buy store
 * (src/peer/buy/store.ts) from quote to completed release, against a REAL
 * Curator quote and signature and Peer's deployed contracts on the fork.
 *
 * Only two things are stand-ins: the Peer browser extension (it posts one
 * captured Revolut payment, as the real extension does after the buyer logs
 * in) and the attestation service (it signs the payment for the intent the
 * app posts, with a witness that only the fork trusts).
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PeerAuthenticateParams, PeerExtensionSdk, PeerMetadataMessageCallback, PeerMetadataRow } from "@zkp2p/sdk";
import type { StoreApi } from "zustand/vanilla";
import { readEscrowIntent, readManagerFee } from "@/peer/buy/chain";
import { RATE_ONE } from "@/peer/format";
import { netAfterReferralFees } from "@/peer/buy/amounts";
import { memoryOrderStorage } from "@/peer/buy/storage";
import { createBuyStore, type BuyDeps } from "@/peer/buy/store";
import type { BuyFlowStore, BuyStep } from "@/peer/buy/types";
import { PEER_ABIS, createPeerClient } from "@/peer/client";
import { forkClient, randomAddress, setEthBalance, usdcBalance } from "./helpers/anvil";
import { fillableOnFork, forkAttestationService, readIntent, trustWitnessOnFork, verifierFor } from "./helpers/buy";
import { installOffchain, recordedRequests, setAttestationHandler, uninstallOffchain } from "./helpers/offchain";
import { ORCHESTRATOR, paymentMethodHash } from "./helpers/peer";
import { eoaSender, faultySender } from "./helpers/senders";

/** A stand-in Peer extension that, once asked to authenticate, posts `rows` as the captured payments. */
function fakeExtension(rows: () => PeerMetadataRow[]) {
  const listeners = new Set<PeerMetadataMessageCallback>();
  const authenticated: PeerAuthenticateParams[] = [];
  const sdk: PeerExtensionSdk = {
    isAvailable: () => true,
    getState: async () => "ready",
    requestConnection: async () => true,
    checkConnectionStatus: async () => "connected",
    getVersion: async () => "fork",
    openInstallPage: () => undefined,
    onMetadataMessage(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    authenticate(params) {
      authenticated.push(params);
      setTimeout(() => {
        for (const listener of Array.from(listeners)) {
          listener({
            platform: params.platform,
            metadata: rows(),
            buyerTeeCapture: { encryptedSessionMaterial: "fork-encrypted-session" },
            expiresAt: Date.now() + 10 * 60_000,
            requestId: "fork-capture",
          });
        }
      }, 5);
    },
  };
  return { sdk, authenticated };
}

function waitForStep(store: StoreApi<BuyFlowStore>, steps: readonly BuyStep[], timeoutMs = 60_000): Promise<BuyFlowStore> {
  return new Promise((resolve, reject) => {
    const check = (state: BuyFlowStore) => {
      if (!steps.includes(state.step)) return false;
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
      return true;
    };
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`store stayed at ${store.getState().step} (${store.getState().error?.code ?? "no error"}), wanted ${steps.join("|")}`));
    }, timeoutMs);
    const unsubscribe = store.subscribe(check);
    check(store.getState());
  });
}

function storeDeps(storage: ReturnType<typeof memoryOrderStorage>, extension: PeerExtensionSdk, warnings: string[]): Partial<BuyDeps> {
  return {
    storage,
    extension,
    canInstallExtension: () => true,
    every: () => () => undefined,
    onFocus: () => () => undefined,
    indexerTimeoutMs: 3_000,
    signalReconcileMs: 20_000,
    warn: (message, detail) => warnings.push(`${message}: ${detail}`),
  };
}

let buyer: Address;
const warnings: string[] = [];

beforeAll(async () => {
  await installOffchain();
  buyer = randomAddress();
  await setEthBalance(buyer, "1");
});

afterAll(() => {
  uninstallOffchain();
});

describe("buy store: quote -> confirm -> recover -> verify -> release", () => {
  const storage = memoryOrderStorage();
  let paymentAmountMinor = "0";
  let paymentCurrency = "GBP";
  const extension = fakeExtension(() => [
    {
      // A completed outgoing Revolut transfer, as the extension reports it (minor units, negative).
      amount: `-${paymentAmountMinor}`,
      currency: paymentCurrency,
      date: new Date().toISOString(),
      recipient: "Fork Seller",
      state: "COMPLETED",
      hidden: false,
      originalIndex: 0,
      params: { id: "fork-revolut-transfer" },
    },
  ]);
  let store: StoreApi<BuyFlowStore>;

  test("quotes, confirms and lands an order the store persists", async () => {
    store = createBuyStore(storeDeps(storage, extension.sdk, warnings));
    store.getState().bindSender(eoaSender(buyer));
    await store.getState().recover();
    expect(store.getState().step).toBe("idle");

    let chosen = null;
    for (const currency of ["GBP", "EUR", "USD"] as const) {
      await store.getState().requestQuotes({ fiatAmount: "20", currency, platforms: ["revolut"] });
      const state = store.getState();
      if (state.step !== "quoted") continue;
      for (const q of state.quotes) {
        if (await fillableOnFork(q)) {
          chosen = q;
          break;
        }
      }
      if (chosen) break;
    }
    if (!chosen) throw new Error("no fillable Revolut quote in GBP, EUR or USD");
    store.getState().selectQuote(chosen.id);
    expect(store.getState().step).toBe("confirming");

    await store.getState().confirm();
    const state = store.getState();
    expect(state.error).toBeNull();
    expect(state.step).toBe("awaitingPayment");
    const order = state.order;
    if (!order) throw new Error("no order");
    expect(order.status).toBe("active");
    expect(getAddress(order.owner)).toBe(getAddress(buyer));
    expect(order.usdcGross).toBe(chosen.signalAmount);
    expect(order.rate).toBe(chosen.rate);
    // A TOFIAT-referred deposit is signed without RampRidge's fee, which then stays with the buyer.
    const waived = chosen.fees.referrer > 0n && order.fees?.referrer === 0n;
    expect(order.usdcExpected).toBe(waived ? chosen.usdcAmount + chosen.fees.referrer : chosen.usdcAmount);
    if (!waived) expect(order.fees?.referrer).toBe(chosen.fees.referrer);
    expect(order.payeeHandle).toBe(chosen.payeeHandle);
    expect(storage.load(buyer)?.intentHash).toBe(order.intentHash);
    paymentAmountMinor = (order.fiatToSend / 10_000n).toString();
    paymentCurrency = order.currency;

    const intent = await readIntent(order.intentHash);
    expect(intent.amount).toBe(order.usdcGross);
    expect(intent.paymentMethod).toBe(paymentMethodHash("revolut"));
  });

  test("a reload, and a new device with no saved order, both recover the same open order from the chain", async () => {
    const order = store.getState().order;
    if (!order) throw new Error("no order");

    const reloaded = createBuyStore(storeDeps(storage, extension.sdk, warnings));
    reloaded.getState().bindSender(eoaSender(buyer));
    await reloaded.getState().recover();
    expect(reloaded.getState().step).toBe("awaitingPayment");
    expect(reloaded.getState().order?.intentHash).toBe(order.intentHash);
    expect(reloaded.getState().order?.usdcExpected).toBe(order.usdcExpected);

    const newDevice = createBuyStore(storeDeps(memoryOrderStorage(), extension.sdk, warnings));
    newDevice.getState().bindSender(eoaSender(buyer));
    await newDevice.getState().recover();
    const recovered = newDevice.getState().order;
    expect(newDevice.getState().step).toBe("awaitingPayment");
    expect(recovered?.intentHash).toBe(order.intentHash);
    expect(recovered?.usdcGross).toBe(order.usdcGross);
    expect(recovered?.rate).toBe(order.rate);
    expect(recovered?.fiatToSend).toBe(order.fiatToSend);
    expect(recovered?.payeeDetailsHash).toBe(order.payeeDetailsHash);
    expect(recovered?.platform).toBe("revolut");
    // Rebuilt from the chain: the gross less each referral leg (Peer + RampRidge) and the deposit's rate-manager fee.
    const intent = await readIntent(order.intentHash);
    const managerFee = (await readManagerFee(createPeerClient(), order.escrow, order.depositId)) ?? 0n;
    const afterLegs = netAfterReferralFees(intent.amount, intent.referralFees);
    expect(recovered?.usdcExpected).toBe(afterLegs - (intent.amount * managerFee) / RATE_ONE);
  });

  test("a captured payment rejected on-chain keeps the order open and offers the pick again", async () => {
    setAttestationHandler(forkAttestationService(privateKeyToAccount(generatePrivateKey())));
    await store.getState().markPaid();
    const selecting = await waitForStep(store, ["selectPayment", "error"]);
    expect(selecting.error).toBeNull();
    expect(selecting.payments).toHaveLength(1);
    expect(selecting.payments[0]?.sent).toBe(true);
    expect(extension.authenticated.at(-1)).toMatchObject({ platform: "revolut", captureMode: "buyerTee" });

    await store.getState().choosePayment(0);
    const failed = store.getState();
    expect(failed.step).toBe("error");
    expect(failed.errorReturnStep).toBe("selectPayment");
    expect(failed.order?.status).toBe("active");
    expect(failed.error?.detail).toContain("Not enough valid witness signatures");
    const order = failed.order;
    if (!order) throw new Error("no order");
    expect(await readEscrowIntent(createPeerClient(), order.escrow, order.depositId, order.intentHash)).toMatchObject({ open: true });
  });

  test("with a witness the fork trusts, Retry releases the USDC and the store completes", async () => {
    const order = store.getState().order;
    if (!order) throw new Error("no order");
    const witness = privateKeyToAccount(generatePrivateKey());
    const { attestationVerifier } = await verifierFor(paymentMethodHash("revolut"));
    await trustWitnessOnFork(attestationVerifier, witness.address);
    setAttestationHandler(forkAttestationService(witness));

    const intent = await readIntent(order.intentHash);
    const before = await usdcBalance(buyer);
    await store.getState().retry();
    const done = await waitForStep(store, ["completed", "error"]);
    setAttestationHandler(null);
    expect(done.error).toBeNull();
    expect(done.step).toBe("completed");
    const net = netAfterReferralFees(intent.amount, intent.referralFees);
    expect(done.completion).toMatchObject({
      intentHash: order.intentHash,
      usdcReceived: net,
      fiatSent: order.fiatToSend,
      currency: order.currency,
      platform: "revolut",
    });
    expect(await usdcBalance(buyer)).toBe(before + net);
    expect(storage.load(buyer)).toBeNull();
    const verify = recordedRequests((r) => r.url.includes("/buyer/verify/revolut/"));
    expect(verify.at(-1)?.body).toMatchObject({ encryptedSessionMaterial: "fork-encrypted-session", params: { id: "fork-revolut-transfer", index: 0 } });
    const receipt = await forkClient.getTransactionReceipt({ hash: done.completion?.fulfillTxHash ?? "0x" });
    expect(receipt.status).toBe("success");
  });
});

describe("buy store: cancel", () => {
  test("cancelling an open order frees the seller's USDC and clears the saved order", async () => {
    const storage = memoryOrderStorage();
    const store = createBuyStore(storeDeps(storage, fakeExtension(() => []).sdk, warnings));
    const canceller = randomAddress();
    await setEthBalance(canceller, "1");
    store.getState().bindSender(eoaSender(canceller));
    await store.getState().recover();
    let quote = null;
    for (const currency of ["GBP", "EUR", "USD"] as const) {
      await store.getState().requestQuotes({ fiatAmount: "20", currency });
      for (const q of store.getState().quotes) {
        if (await fillableOnFork(q)) {
          quote = q;
          break;
        }
      }
      if (quote) break;
    }
    if (!quote) throw new Error("no fillable quote in GBP, EUR or USD");
    store.getState().selectQuote(quote.id);
    await store.getState().confirm();
    const order = store.getState().order;
    if (!order || store.getState().step !== "awaitingPayment") throw new Error(`not awaiting payment: ${store.getState().error?.message}`);

    await store.getState().cancelOrder();
    expect(store.getState().step).toBe("cancelled");
    expect(store.getState().order?.status).toBe("cancelled");
    expect(storage.load(canceller)).toBeNull();
    expect(await readEscrowIntent(createPeerClient(), order.escrow, order.depositId, order.intentHash)).toEqual({ open: false });

    // A fresh session finds nothing open, so the player can buy again.
    const next = createBuyStore(storeDeps(storage, fakeExtension(() => []).sdk, warnings));
    next.getState().bindSender(eoaSender(canceller));
    await next.getState().recover();
    expect(next.getState().step).toBe("idle");
    expect(next.getState().order).toBeNull();
  });
});

describe("buy store: a signal whose receipt the wallet lost", () => {
  test("the store finds the intent on the chain, shows the order and never signals twice", async () => {
    const storage = memoryOrderStorage();
    const taker = randomAddress();
    await setEthBalance(taker, "1");
    const sender = faultySender(eoaSender(taker), ["lose-receipt"]);
    const store = createBuyStore(storeDeps(storage, fakeExtension(() => []).sdk, warnings));
    store.getState().bindSender(sender);
    await store.getState().recover();
    let quote = null;
    for (const currency of ["GBP", "EUR", "USD"] as const) {
      await store.getState().requestQuotes({ fiatAmount: "20", currency });
      for (const q of store.getState().quotes) {
        if (await fillableOnFork(q)) {
          quote = q;
          break;
        }
      }
      if (quote) break;
    }
    if (!quote) throw new Error("no fillable quote in GBP, EUR or USD");
    store.getState().selectQuote(quote.id);
    await store.getState().confirm();

    const state = store.getState();
    expect(state.error).toBeNull();
    expect(state.step).toBe("awaitingPayment");
    expect(sender.sends()).toBe(1);
    const order = state.order;
    if (!order) throw new Error("no order");
    const open = (await forkClient.readContract({
      address: ORCHESTRATOR,
      abi: PEER_ABIS.orchestrator,
      functionName: "getAccountIntents",
      args: [taker],
    })) as readonly string[];
    expect(open.map((h) => h.toLowerCase())).toEqual([order.intentHash.toLowerCase()]);
    expect(storage.load(taker)?.intentHash).toBe(order.intentHash);

    // A second confirm cannot place another order while this one is open.
    await store.getState().requestQuotes({ fiatAmount: "20", currency: quote.currency });
    expect(store.getState().error?.code).toBe("active_intent");

    await store.getState().cancelOrder();
    expect(await readEscrowIntent(createPeerClient(), order.escrow, order.depositId, order.intentHash)).toEqual({ open: false });
  });
});
