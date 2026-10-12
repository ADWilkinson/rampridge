/**
 * BUY on the Base fork: a REAL Curator quote (mode "eligible", 50 bps
 * RampRidge fee) is signalled from an impersonated fork address with Curator's
 * real /v3/sign gating signature, then cancelled, all through the app's own
 * buy modules (market.ts, buy/chain.ts) and an EOA TxSender built with the
 * app's sender stack. Fulfilment cannot use a real payment, so the app's
 * fulfil builder is driven with a structurally valid attestation: first
 * signed by an untrusted key (the contract must reject it at the witness
 * check, after every other check passed), then by a witness trusted on the
 * fork only, which must release exactly the intent's USDC and fee legs. Two
 * live-offer cases close it: a seller with a rate-manager fee (the release
 * must equal "You receive") and a deposit listed with Galleon's TOFIAT code
 * (Curator pays RampRidge's wallet twice unless RampRidge's fee is waived).
 */

import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BUY_REFERRER_FEE, PEER_ATTRIBUTION } from "@/config";
import { PEER_ABIS, createPeerClient } from "@/peer/client";
import {
  BUY_REFERRER_FEE_PRECISE,
  cancelBuyIntent,
  decodeSignalCall,
  fulfillBuyIntent,
  parseFulfilledAmount,
  parseLockExpiry,
  parseSignaledIntent,
  readEscrowIntent,
  signalBuyIntent,
  type SignalResult,
} from "@/peer/buy/chain";
import { fiatToSend, netAfterReferralFees } from "@/peer/buy/amounts";
import { toBuyError } from "@/peer/buy/errors";
import { getBuyQuotes, type BuyQuote } from "@/peer/market";
import { BUY_PLATFORMS, buyableCurrencies, platformsForCurrency } from "@/peer/platforms";
import { forkClient, randomAddress, rpc, setEthBalance, usdcBalance } from "./helpers/anvil";
import {
  fillableOnFork,
  fillableQuotes,
  forkAttestationService,
  readDeposit,
  readIntent,
  signedAttestation,
  sweepQuote,
  trustWitnessOnFork,
  verifierFor,
  type AttestationInput,
} from "./helpers/buy";
import {
  clearRecordedRequests,
  installOffchain,
  recordedRequests,
  setAttestationHandler,
  startRpcRecording,
  stopRpcRecording,
  uninstallOffchain,
} from "./helpers/offchain";
import { ESCROW, ORCHESTRATOR, PAYMASTER_ALLOWLIST, REFERRER_FEE_WALLET, attributionCodes, currencyHash, paymentMethodHash } from "./helpers/peer";
import { eoaSender } from "./helpers/senders";

const BUY_ATTRIBUTION = [...PEER_ATTRIBUTION];

let buyer: Address;
let quotes: BuyQuote[] = [];
let quote: BuyQuote;
let signal: SignalResult;
let liquidityBefore: bigint;

const sender = () => eoaSender(buyer);
const client = () => createPeerClient({ sender: sender() });

beforeAll(async () => {
  await installOffchain();
  buyer = randomAddress();
  await setEthBalance(buyer, "1");
});

afterAll(() => {
  uninstallOffchain();
});

/** Signals the first quote the fork accepts (live liquidity can move between quoting and signalling). */
async function signalFirstFillable(): Promise<{ quote: BuyQuote; signal: SignalResult }> {
  const failures: string[] = [];
  for (const candidate of quotes) {
    try {
      return { quote: candidate, signal: await signalBuyIntent(client(), sender(), candidate) };
    } catch (error) {
      failures.push(`${candidate.id}: ${toBuyError(error, { stage: "signal" }).code} ${String(error).slice(0, 200)}`);
    }
  }
  throw new Error(`no quote could be signalled on the fork:\n${failures.join("\n")}`);
}

describe("buy: live quote", () => {
  test("Curator quotes eligible liquidity with the 50 bps RampRidge fee priced in", async () => {
    clearRecordedRequests();
    const found = await fillableQuotes(client(), buyer);
    quotes = found.quotes;
    expect(quotes.length).toBeGreaterThan(0);

    const request = recordedRequests((r) => r.url.includes("/quote") && r.method === "POST")[0];
    expect(request?.served).toBe("network");
    expect(request?.url).toContain("/v3/quote/exact-fiat");
    expect(request?.body).toMatchObject({
      mode: "eligible",
      user: buyer.toLowerCase(),
      recipient: buyer.toLowerCase(),
      destinationChainId: 8453,
      escrowAddresses: [ESCROW],
      referralFees: [{ recipient: BUY_REFERRER_FEE.recipient, feeBps: 50 }],
    });

    for (const q of quotes) {
      expect(BUY_PLATFORMS[q.platform].live).toBe(true);
      expect(q.fees.referrerBps).toBe(50);
      // 50 bps of the gross the intent reserves, floored, exactly as the orchestrator takes it.
      expect(q.fees.referrer).toBe((q.signalAmount * BUY_REFERRER_FEE_PRECISE) / 10n ** 18n);
      expect(q.usdcAmount).toBe(q.signalAmount - q.fees.service - q.fees.manager - q.fees.referrer);
      expect(q.raw.disputeProtectionRequiresStake).toBe(false);
      expect(q.raw.whitelistEnabled).toBe(false);
    }
  });
});

describe("buy: signal and cancel through the app's chain module", () => {
  test("signalBuyIntent: Curator signs for the fork caller and the intent lands as quoted", async () => {
    clearRecordedRequests();
    ({ quote, signal } = await signalFirstFillable());
    liquidityBefore = (await readDeposit(quote.depositId)).remainingDeposits + signal.amount;

    // /v3/sign was asked for exactly this caller, recipient and fee leg.
    const signs = recordedRequests((r) => r.url.endsWith("/v3/sign") && r.status === 200);
    const signed = signs.at(-1);
    expect(signed?.served).toBe("network");
    expect(signed?.body).toMatchObject({
      callerAddress: buyer,
      toAddress: buyer,
      depositId: quote.depositId,
      amount: quote.signalAmount.toString(),
      conversionRate: quote.rate.toString(),
      escrowAddress: ESCROW,
      orchestratorAddress: ORCHESTRATOR,
      paymentMethod: paymentMethodHash(quote.platform),
      fiatCurrency: currencyHash(quote.currency),
      referralFees: [{ recipient: BUY_REFERRER_FEE.recipient, fee: BUY_REFERRER_FEE_PRECISE.toString() }],
    });

    expect(signal.depositId).toBe(BigInt(quote.depositId));
    expect(signal.amount).toBe(quote.signalAmount);
    expect(signal.rate).toBe(quote.rate);
    expect(signal.orchestrator).toBe(ORCHESTRATOR);
    expect(signal.txHash).not.toBeNull();
  });

  test("the on-chain intent records recipient, amount, rate, payee and the fee legs", async () => {
    const intent = await readIntent(signal.intentHash);
    expect(getAddress(intent.owner)).toBe(getAddress(buyer));
    expect(getAddress(intent.to)).toBe(getAddress(buyer));
    expect(getAddress(intent.escrow)).toBe(ESCROW);
    expect(intent.depositId).toBe(BigInt(quote.depositId));
    expect(intent.amount).toBe(quote.signalAmount);
    expect(intent.conversionRate).toBe(quote.rate);
    expect(intent.paymentMethod).toBe(paymentMethodHash(quote.platform));
    expect(intent.fiatCurrency).toBe(currencyHash(quote.currency));
    expect(intent.payeeId).toBe(quote.payeeDetailsHash);

    // Exactly one leg pays RampRidge, at exactly 50 bps; the legs together take what the quote said.
    const ours = intent.referralFees.filter((leg) => getAddress(leg.recipient) === getAddress(REFERRER_FEE_WALLET));
    expect(ours).toEqual([{ recipient: REFERRER_FEE_WALLET, fee: BUY_REFERRER_FEE_PRECISE }]);
    const legsTotal = quote.signalAmount - netAfterReferralFees(quote.signalAmount, intent.referralFees);
    expect(legsTotal).toBe(quote.fees.service + quote.fees.referrer);
    expect(quote.signalAmount - legsTotal - quote.fees.manager).toBe(quote.usdcAmount);

    // The escrow locked exactly the gross amount, with the expiry the app reported.
    const deposit = await readDeposit(quote.depositId);
    expect(liquidityBefore - deposit.remainingDeposits).toBe(quote.signalAmount);
    const lock = await readEscrowIntent(client(), quote.escrow, quote.depositId, signal.intentHash);
    expect(lock).toEqual({ open: true, expiresAt: signal.expiresAt });
  });

  test("the signal transaction parses with the app's receipt parsers and carries attribution", async () => {
    const receipt = await forkClient.getTransactionReceipt({ hash: signal.txHash as Hex });
    const parsed = parseSignaledIntent(receipt.logs, buyer, { depositId: BigInt(quote.depositId), orchestrator: ORCHESTRATOR });
    expect(parsed).toEqual({
      intentHash: signal.intentHash,
      orchestrator: ORCHESTRATOR,
      depositId: BigInt(quote.depositId),
      amount: quote.signalAmount,
      rate: quote.rate,
      signaledAt: signal.signaledAt,
    });
    expect(parseLockExpiry(receipt.logs, signal.intentHash)).toBe(signal.expiresAt);
    // Someone else's address never matches.
    expect(parseSignaledIntent(receipt.logs, randomAddress())).toBeNull();

    const tx = await forkClient.getTransaction({ hash: signal.txHash as Hex });
    expect(tx.to && getAddress(tx.to)).toBe(ORCHESTRATOR);
    expect(PAYMASTER_ALLOWLIST.has(ORCHESTRATOR.toLowerCase())).toBe(true);
    expect(attributionCodes(tx.input).slice(0, 2)).toEqual(BUY_ATTRIBUTION);
    const call = decodeSignalCall(tx.input);
    expect(call?.referralFees.some((leg) => getAddress(leg.recipient) === getAddress(REFERRER_FEE_WALLET))).toBe(true);
  });

  test("cancelBuyIntent closes the intent and restores the seller's liquidity", async () => {
    const txHash = await cancelBuyIntent(client(), sender(), signal.intentHash, signal.orchestrator);
    const deposit = await readDeposit(quote.depositId);
    expect(deposit.remainingDeposits).toBe(liquidityBefore);
    expect(await readEscrowIntent(client(), quote.escrow, quote.depositId, signal.intentHash)).toEqual({ open: false });
    const intent = await readIntent(signal.intentHash);
    expect(intent.owner).toBe("0x0000000000000000000000000000000000000000");
    const tx = await forkClient.getTransaction({ hash: txHash });
    expect(attributionCodes(tx.input).slice(0, 2)).toEqual(BUY_ATTRIBUTION);
    // A second cancel is refused by the contract, and the app maps it to "already closed".
    const again = await cancelBuyIntent(client(), sender(), signal.intentHash, signal.orchestrator).catch((e: unknown) => e);
    expect(toBuyError(again, { stage: "cancel" }).code).toBe("intent_closed");
  });
});

interface CallFrame {
  type: string;
  from: string;
  to: string;
  input: string;
  output?: string;
  error?: string;
  revertReason?: string;
  calls?: CallFrame[];
}

function frames(root: CallFrame): CallFrame[] {
  return [root, ...(root.calls ?? []).flatMap(frames)];
}

/** The innermost reverted frame: where a revert actually started. */
function deepestFailure(frame: CallFrame): CallFrame {
  const child = (frame.calls ?? []).find((c) => c.error);
  return child ? deepestFailure(child) : frame;
}

describe("buy: fulfil", () => {
  let fresh: SignalResult;
  let freshQuote: BuyQuote;
  let rejectedAt: string | null = null;

  /** Builds the attestation the service would return for the fresh intent. */
  async function attestationFor(witness: ReturnType<typeof privateKeyToAccount>, paymentId: string) {
    const intent = await readIntent(fresh.intentHash);
    const verifier = await verifierFor(intent.paymentMethod);
    const method = BUY_PLATFORMS[freshQuote.platform].verifyMethods[0];
    if (!method) throw new Error("platform has no verify method");
    const fiat = fiatToSend(intent.amount, intent.conversionRate, freshQuote.currency);
    const input: AttestationInput = {
      intentHash: fresh.intentHash,
      intent,
      paidCents: fiat / 10_000n,
      paidAtMs: intent.timestamp * 1000n + 60_000n,
      paymentId,
      releaseAmount: intent.amount,
      platform: method.actionPlatform,
      actionType: method.actionType,
    };
    return { verifier, response: await signedAttestation(input, witness, verifier.domainSeparator), method };
  }

  const proof = (method: { actionType: string; actionPlatform: string }) => ({
    proofType: "buyerTee" as const,
    encryptedSessionMaterial: "fork-test-session-material",
    params: { id: "fork-payment", index: 0 },
    actionType: method.actionType,
    actionPlatform: method.actionPlatform,
  });

  test("a fresh intent is signalled for the fulfil tests", async () => {
    ({ quote: freshQuote, signal: fresh } = await signalFirstFillable());
    expect((await readIntent(fresh.intentHash)).amount).toBe(freshQuote.signalAmount);
  });

  test("the app's fulfil calldata reaches proof verification and is rejected only at the witness check", async () => {
    const untrusted = privateKeyToAccount(generatePrivateKey());
    const { verifier, response, method } = await attestationFor(untrusted, `fork-untrusted-${Date.now()}`);
    const nonceBefore = await forkClient.getTransactionCount({ address: buyer });
    setAttestationHandler(() => response);
    clearRecordedRequests();
    startRpcRecording();
    const error = await fulfillBuyIntent(client(), sender(), fresh.intentHash, fresh.orchestrator, proof(method)).catch(
      (e: unknown) => e,
    );
    const rpcCalls = stopRpcRecording();
    setAttestationHandler(null);

    // The app's preflight caught the rejection: nothing was sent and the order is still open.
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Not enough valid witness signatures");
    expect(await forkClient.getTransactionCount({ address: buyer })).toBe(nonceBefore);
    expect(rpcCalls.some((c) => c.method === "eth_sendTransaction")).toBe(false);
    expect(await readEscrowIntent(client(), freshQuote.escrow, freshQuote.depositId, fresh.intentHash)).toMatchObject({ open: true });

    // What the app sent the attestation service: the on-chain intent, unchanged.
    const intent = await readIntent(fresh.intentHash);
    const sent = recordedRequests((r) => r.url.includes("/buyer/verify/"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`https://attestation-service.zkp2p.xyz/buyer/verify/${method.actionPlatform}/${method.actionType}`);
    expect(sent[0]?.body).toMatchObject({
      encryptedSessionMaterial: "fork-test-session-material",
      params: { id: "fork-payment", index: 0 },
      chainId: 8453,
      intent: {
        intentHash: fresh.intentHash,
        amount: intent.amount.toString(),
        timestampMs: (intent.timestamp * 1000n).toString(),
        paymentMethod: intent.paymentMethod,
        fiatCurrency: intent.fiatCurrency,
        conversionRate: intent.conversionRate.toString(),
        payeeDetails: intent.payeeId,
      },
    });

    // The exact call the app simulated, decoded against the deployed ABI: the SDK's fulfil shape.
    const preflight = rpcCalls.find((c) => {
      const tx = c.params[0] as { to?: string } | undefined;
      return c.method === "eth_call" && tx?.to?.toLowerCase() === ORCHESTRATOR.toLowerCase();
    });
    const tx = preflight?.params[0] as { from: Address; to: Address; data: Hex };
    expect(getAddress(tx.from)).toBe(getAddress(buyer));
    expect(attributionCodes(tx.data).slice(0, 2)).toEqual(BUY_ATTRIBUTION);
    const call = decodeFunctionData({ abi: PEER_ABIS.orchestrator, data: tx.data });
    expect(call.functionName).toBe("fulfillIntent");
    const params = call.args?.[0] as { intentHash: Hex; paymentProof: Hex; verificationData: Hex; postIntentHookData: Hex };
    expect(params.intentHash).toBe(fresh.intentHash);
    expect(params.postIntentHookData).toBe("0x");
    const [attestation] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { type: "bytes32" },
            { type: "uint256" },
            { type: "bytes32" },
            { type: "bytes[]" },
            { type: "bytes" },
            { type: "bytes" },
          ],
        },
      ],
      params.paymentProof,
    );
    const signed = response.responseObject;
    expect(attestation).toEqual([
      fresh.intentHash,
      intent.amount,
      signed.typedDataValue.dataHash,
      [signed.signature],
      signed.encodedPaymentDetails,
      signed.metadata,
    ]);
    const [verification] = decodeAbiParameters(
      [{ type: "tuple", components: [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }] }],
      params.verificationData,
    );
    expect(verification[0]).toBe(fresh.intentHash);
    expect(verification[1]).toBe(params.paymentProof);
    expect(decodeAbiParameters([{ type: "address" }], verification[2])[0]).toBe(untrusted.address);

    // Trace that exact call: the orchestrator accepted the intent and caller, routed to the
    // platform's payment verifier, which checked the attestation against the intent snapshot and
    // asked the attestation verifier about the witness. The only failure is that last answer.
    const trace = await rpc<CallFrame>("debug_traceCall", [
      { from: tx.from, to: tx.to, data: tx.data },
      "latest",
      { tracer: "callTracer" },
    ]);
    expect(frames(trace).some((f) => f.to.toLowerCase() === verifier.verifier.toLowerCase())).toBe(true);
    const deepest = deepestFailure(trace);
    expect(deepest.to.toLowerCase()).toBe(verifier.attestationVerifier.toLowerCase());
    expect(deepest.revertReason).toBe("ThresholdSigVerifierUtils: Not enough valid witness signatures");
    rejectedAt = deepest.to;
  });

  test("with a witness trusted on the fork, fulfilBuyIntent releases the intent's USDC and pays every fee leg", async () => {
    const witness = privateKeyToAccount(generatePrivateKey());
    const { verifier, response, method } = await attestationFor(witness, `fork-trusted-${Date.now()}`);
    await trustWitnessOnFork(verifier.attestationVerifier, witness.address);

    const intent = await readIntent(fresh.intentHash);
    const buyerBefore = await usdcBalance(buyer);
    const feeBefore = await usdcBalance(REFERRER_FEE_WALLET);
    const legsBefore = await Promise.all(intent.referralFees.map((leg) => usdcBalance(leg.recipient)));

    setAttestationHandler(() => response);
    const result = await fulfillBuyIntent(client(), sender(), fresh.intentHash, fresh.orchestrator, proof(method));
    setAttestationHandler(null);

    const receipt: TransactionReceipt = await forkClient.getTransactionReceipt({ hash: result.txHash });
    // The player receives exactly the "You receive" figure the quote showed.
    expect(result.released).toBe(freshQuote.usdcAmount);
    expect(parseFulfilledAmount(receipt.logs, fresh.intentHash)).toBe(freshQuote.usdcAmount);
    expect(await usdcBalance(buyer)).toBe(buyerBefore + freshQuote.usdcAmount);

    const ourLeg = intent.referralFees.find((leg) => getAddress(leg.recipient) === getAddress(REFERRER_FEE_WALLET));
    expect(ourLeg?.fee).toBe(BUY_REFERRER_FEE_PRECISE);
    expect(await usdcBalance(REFERRER_FEE_WALLET)).toBe(feeBefore + (intent.amount * BUY_REFERRER_FEE_PRECISE) / 10n ** 18n);
    for (const [i, leg] of intent.referralFees.entries()) {
      expect(await usdcBalance(leg.recipient)).toBe((legsBefore[i] ?? 0n) + (intent.amount * leg.fee) / 10n ** 18n);
    }
    const distributed = parseEventLogs({ abi: PEER_ABIS.orchestrator, logs: receipt.logs, eventName: "IntentReferralFeeDistributed" });
    expect(distributed.length).toBe(intent.referralFees.length);

    const tx = await forkClient.getTransaction({ hash: result.txHash });
    expect(attributionCodes(tx.input).slice(0, 2)).toEqual(BUY_ATTRIBUTION);
    const call = decodeFunctionData({ abi: PEER_ABIS.orchestrator, data: tx.input });
    expect(call.functionName).toBe("fulfillIntent");
    const params = call.args?.[0] as { intentHash: Hex; paymentProof: Hex; verificationData: Hex; postIntentHookData: Hex };
    expect(params.intentHash).toBe(fresh.intentHash);
    expect(params.postIntentHookData).toBe("0x");
    const [verification] = decodeAbiParameters(
      [{ type: "tuple", components: [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }] }],
      params.verificationData,
    );
    expect(verification[0]).toBe(fresh.intentHash);
    expect(verification[1]).toBe(params.paymentProof);
    expect(decodeAbiParameters([{ type: "address" }], verification[2])[0]).toBe(witness.address);

    // The intent is gone; the rejected attempt failed at this verifier's witness check, which this one passed.
    expect((await readIntent(fresh.intentHash)).owner).toBe("0x0000000000000000000000000000000000000000");
    expect(rejectedAt?.toLowerCase()).toBe(verifier.attestationVerifier.toLowerCase());
  });
});

/**
 * Asks Curator to sign the quote exactly as the app first does (with RampRidge's
 * fee) and reports whether the signed legs pay RampRidge's wallet twice: what
 * Curator does for a deposit listed with Galleon's TOFIAT referral code, whose
 * integration share goes to the same wallet.
 */
async function signsTwoLegsToUs(client: ReturnType<typeof createPeerClient>, taker: Address, q: BuyQuote): Promise<boolean> {
  const prepared = await client.signalIntent.prepare({
    depositId: BigInt(q.depositId),
    amount: q.signalAmount,
    toAddress: taker,
    processorName: q.platform,
    payeeDetails: q.payeeDetailsHash,
    fiatCurrencyCode: q.currency,
    conversionRate: q.rate,
    escrowAddress: q.escrow,
    postIntentHook: zeroAddress,
    preIntentHookData: "0x",
    data: "0x",
    referrerFeeConfig: { ...BUY_REFERRER_FEE },
    txOverrides: { referrer: [...PEER_ATTRIBUTION] },
  });
  const legs = decodeSignalCall(prepared.data)?.referralFees ?? [];
  return legs.filter((leg) => getAddress(leg.recipient) === getAddress(REFERRER_FEE_WALLET)).length > 1;
}

/**
 * The first live, fork-fillable quote that passes `cheap` and then `want`
 * (which may ask Curator to sign), asking Curator about at most a dozen offers.
 */
async function findQuote(
  taker: Address,
  cheap: (q: BuyQuote) => boolean,
  want: (q: BuyQuote, client: ReturnType<typeof createPeerClient>) => Promise<boolean>,
): Promise<BuyQuote | null> {
  const client = createPeerClient({ sender: eoaSender(taker) });
  let asked = 0;
  for (const currency of ["EUR", "USD", "GBP"] as const) {
    const result = await getBuyQuotes({ fiatAmount: "20", currency, recipient: taker, client, quotesToReturn: 20 });
    for (const q of result.quotes) {
      if (!cheap(q) || !(await fillableOnFork(q))) continue;
      if (asked >= 12) return null;
      asked += 1;
      if (await want(q, client)) return q;
    }
  }
  return null;
}

async function trustedFulfil(taker: Address, quote: BuyQuote, signal: SignalResult) {
  const witness = privateKeyToAccount(generatePrivateKey());
  const { attestationVerifier } = await verifierFor(paymentMethodHash(quote.platform));
  await trustWitnessOnFork(attestationVerifier, witness.address);
  const method = BUY_PLATFORMS[quote.platform].verifyMethods[0];
  if (!method) throw new Error("no verify method");
  setAttestationHandler(forkAttestationService(witness));
  try {
    const takerSender = eoaSender(taker);
    return await fulfillBuyIntent(createPeerClient({ sender: takerSender }), takerSender, signal.intentHash, signal.orchestrator, {
      proofType: "buyerTee",
      encryptedSessionMaterial: "fork-test-session-material",
      params: { id: `fork-payment-${signal.intentHash}`, index: 0 },
      actionType: method.actionType,
      actionPlatform: method.actionPlatform,
    });
  } finally {
    setAttestationHandler(null);
  }
}

async function managerFeeOf(quote: BuyQuote): Promise<{ recipient: Address; fee: bigint }> {
  const [recipient, fee] = (await forkClient.readContract({
    address: ESCROW,
    abi: PEER_ABIS.escrow,
    functionName: "getManagerFee",
    args: [BigInt(quote.depositId)],
  })) as readonly [Address, bigint];
  return { recipient, fee };
}

describe("buy: a seller with a rate-manager fee", () => {
  test("the release equals the quoted net and the manager is paid its fee", async (ctx) => {
    const taker = randomAddress();
    await setEthBalance(taker, "1");
    const managed = await findQuote(
      taker,
      (q) => q.fees.manager > 0n,
      async (q, client) => !(await signsTwoLegsToUs(client, taker, q)),
    );
    if (!managed) {
      ctx.skip("no live quote from a deposit with a rate-manager fee right now");
      return;
    }
    const manager = await managerFeeOf(managed);
    const managerBefore = await usdcBalance(manager.recipient);
    const takerSender = eoaSender(taker);
    const signalled = await signalBuyIntent(createPeerClient({ sender: takerSender }), takerSender, managed);
    const result = await trustedFulfil(taker, managed, signalled);
    // "You receive" is the release: Curator's tokenAmount alone would overstate it by the manager's cut.
    expect(result.released).toBe(managed.usdcAmount);
    expect(BigInt(managed.raw.tokenAmount) - managed.usdcAmount).toBe(managed.fees.manager);
    expect(await usdcBalance(taker)).toBe(managed.usdcAmount);
    expect(await usdcBalance(manager.recipient)).toBe(managerBefore + managed.fees.manager);
  });
});

describe("buy: a deposit listed with Galleon's TOFIAT referral code", () => {
  test("Curator pays RampRidge's wallet Peer's integration share, so the RampRidge fee is waived and the buy goes through", async (ctx) => {
    const taker = randomAddress();
    await setEthBalance(taker, "1");
    const tofiat = await findQuote(taker, () => true, (q, client) => signsTwoLegsToUs(client, taker, q));
    if (!tofiat) {
      ctx.skip("no live quote from a TOFIAT-referred deposit right now");
      return;
    }
    const takerSender = eoaSender(taker);
    clearRecordedRequests();
    const signalled = await signalBuyIntent(createPeerClient({ sender: takerSender }), takerSender, tofiat);
    expect(signalled.referrerFeeWaived).toBe(true);

    // Signed twice: first with RampRidge's fee (two legs to one wallet), then without it.
    const signs = recordedRequests((r) => r.url.endsWith("/v3/sign") && r.status === 200);
    expect(signs.map((r) => (r.body as { referralFees: unknown[] }).referralFees.length)).toEqual([1, 0]);

    const intent = await readIntent(signalled.intentHash);
    const recipients = intent.referralFees.map((leg) => getAddress(leg.recipient));
    expect(new Set(recipients).size).toBe(recipients.length);
    // The one leg to RampRidge's wallet is Peer's integration share, out of Peer's own fee.
    expect(intent.referralFees.filter((leg) => getAddress(leg.recipient) === getAddress(REFERRER_FEE_WALLET))).toEqual([
      { recipient: REFERRER_FEE_WALLET, fee: BUY_REFERRER_FEE_PRECISE },
    ]);

    const manager = await managerFeeOf(tofiat);
    const managerCut = (intent.amount * manager.fee) / 10n ** 18n;
    const feeWalletBefore = await usdcBalance(REFERRER_FEE_WALLET);
    const result = await trustedFulfil(taker, tofiat, signalled);
    const released = netAfterReferralFees(intent.amount, intent.referralFees) - managerCut;
    expect(result.released).toBe(released);
    expect(await usdcBalance(taker)).toBe(released);
    // The buyer gets the quoted net plus the waived fee: what the store shows after signalling.
    expect(released).toBeGreaterThanOrEqual(tofiat.usdcAmount + tofiat.fees.referrer);
    expect(released - (tofiat.usdcAmount + tofiat.fees.referrer)).toBeLessThanOrEqual(1n);
    // The wallet gets the integration share (and, on Galleon's own vaults, the rate manager's cut too).
    const managerToWallet = getAddress(manager.recipient) === getAddress(REFERRER_FEE_WALLET) ? managerCut : 0n;
    expect(await usdcBalance(REFERRER_FEE_WALLET)).toBe(
      feeWalletBefore + (intent.amount * BUY_REFERRER_FEE_PRECISE) / 10n ** 18n + managerToWallet,
    );
  });
});

/**
 * Every live platform and currency pair, against live liquidity: for each pair
 * Curator can fill right now, a quote is signalled from a fresh fork address
 * with Curator's real gating signature, the on-chain intent must carry the
 * pair's currency and payment-method hashes and RampRidge's 50 bps leg (or
 * Peer's TOFIAT share in its place), and it is cancelled. Pairs with no
 * eligible liquidity (Venmo and PayPal are all Peer Pay; most UPI and minor
 * currencies are empty) are skipped and listed.
 */
describe("buy: every live currency and platform pair", () => {
  type Outcome = { pair: string; result: string };
  const outcomes: Outcome[] = [];
  const signalled = new Set<string>();

  afterAll(() => {
    const report =
      `[buy sweep] ${signalled.size} currencies signalled: ${[...signalled].sort().join(" ")}\n` +
      outcomes.map((o) => `  ${o.pair.padEnd(16)} ${o.result}`).join("\n");
    console.info(report);
    // FORK_SWEEP_REPORT=<path> keeps the table when the reporter hides a passing file's console output.
    if (process.env.FORK_SWEEP_REPORT) writeFileSync(process.env.FORK_SWEEP_REPORT, `${report}\n`);
  });

  test.each(buyableCurrencies().map((currency) => [currency]))("%s", async (currency) => {
    for (const platform of platformsForCurrency(currency)) {
      const pair = `${platform.id}/${currency}`;
      const taker = randomAddress();
      await setEthBalance(taker, "1");
      const takerSender = eoaSender(taker);
      const takerClient = createPeerClient({ sender: takerSender });
      const found = await sweepQuote(takerClient, taker, platform.id, currency);
      if (found === "unavailable") {
        outcomes.push({ pair, result: "Curator kept answering 503 (V3 admission state unavailable); not checked" });
        continue;
      }
      if (!found) {
        outcomes.push({ pair, result: "no eligible liquidity" });
        continue;
      }
      const { quote: q, nearby } = found;
      expect(q.platform).toBe(platform.id);
      expect(q.currency).toBe(currency);
      expect(q.raw.disputeProtectionRequiresStake).toBe(false);
      expect(q.raw.whitelistEnabled).toBe(false);

      clearRecordedRequests();
      const s = await signalBuyIntent(takerClient, takerSender, q);
      const sign = recordedRequests((r) => r.url.endsWith("/v3/sign") && r.status === 200).at(-1);
      expect(sign?.served).toBe("network");

      const intent = await readIntent(s.intentHash);
      expect(getAddress(intent.owner)).toBe(getAddress(taker));
      expect(intent.paymentMethod).toBe(paymentMethodHash(platform.id));
      expect(intent.fiatCurrency).toBe(currencyHash(currency));
      expect(intent.payeeId).toBe(q.payeeDetailsHash);
      expect(intent.amount).toBe(q.signalAmount);
      expect(intent.conversionRate).toBe(q.rate);
      // Exactly one leg to RampRidge's wallet at 50 bps: RampRidge's fee, or Peer's TOFIAT share when it is waived.
      const ours = intent.referralFees.filter((leg) => getAddress(leg.recipient) === getAddress(REFERRER_FEE_WALLET));
      expect(ours).toEqual([{ recipient: REFERRER_FEE_WALLET, fee: BUY_REFERRER_FEE_PRECISE }]);
      if (!s.referrerFeeWaived) {
        // The orchestrator floors each leg; Curator's fee figures can round up by under a base unit per leg.
        // So the legs never take more than quoted, and "You receive" never shows more than arrives.
        const legsTotal = q.signalAmount - netAfterReferralFees(q.signalAmount, intent.referralFees);
        const quoted = q.fees.service + q.fees.referrer;
        expect(legsTotal).toBeLessThanOrEqual(quoted);
        expect(quoted - legsTotal).toBeLessThanOrEqual(BigInt(intent.referralFees.length));
      }

      await cancelBuyIntent(takerClient, takerSender, s.intentHash, s.orchestrator);
      expect(await readEscrowIntent(takerClient, q.escrow, q.depositId, s.intentHash)).toEqual({ open: false });

      signalled.add(currency);
      const fiat = Number(q.fiatAmount) / 1e6;
      outcomes.push({
        pair,
        result: `signalled ${fiat} ${currency}${nearby ? " (nearby)" : ""} -> ${Number(q.usdcAmount) / 1e6} USDC, deposit ${q.depositId}${s.referrerFeeWaived ? ", TOFIAT" : ""}, cancelled`,
      });
    }
  });

  test("the majors were signalled", () => {
    for (const code of ["USD", "EUR", "GBP"]) expect(signalled, code).toContain(code);
  });
});
