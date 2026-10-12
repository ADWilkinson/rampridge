/**
 * GOLDEN REPLAY OF REAL FULFILMENTS.
 *
 * For each real buyer-TEE fulfilment on Base in fixtures/fulfilments.json
 * (built by discover.ts from IntentFulfilled logs on OrchestratorV3):
 *
 * 1. Signal side: RampRidge's decodeSignalCall / parseSignaledIntent /
 *    parseLockExpiry against the intent's real signal transaction, and
 *    readEscrowIntent / readIntentExpiry / fetchPayeeHandle against the real
 *    chain state and Curator.
 * 2. Fork Base at the fulfilment block minus one and drive RampRidge's OWN
 *    fulfil path (src/peer/buy/chain.ts fulfillBuyIntent with the client from
 *    src/peer/client.ts and an anvil-backed TxSender from src/wallet), with
 *    ONLY the attestation service's HTTP call mocked to return the response
 *    reconstructed from the historical calldata. Our calldata must equal the
 *    historical calldata apart from the ERC-8021 suffix, the fork transaction
 *    must succeed, emit IntentFulfilled and pay the intent's `to` exactly the
 *    released USDC, and parseFulfilledAmount must agree.
 * 3. The same fulfilment through the buy store (stored order -> extension
 *    capture -> choosePayment -> completed), whose completion must report the
 *    USDC the chain released.
 *
 * Nothing is signed or sent to Base mainnet: the fork forks through a
 * read-only proxy (lib/fork.ts) and every transaction lands on anvil.
 */

import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { GOLDEN_FORK_URL } = vi.hoisted(() => ({
  GOLDEN_FORK_URL: `http://127.0.0.1:${process.env.GOLDEN_FORK_PORT ?? "8553"}`,
}));

// The app's chain reads and writes go to the golden fork, whatever VITE_BASE_RPC_URL another suite set.
vi.mock("@/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config")>()),
  BASE_RPC_URL: GOLDEN_FORK_URL,
}));

import type { BuyerTeePaymentProofInput, PeerExtensionSdk, PeerMetadataMessage, PeerMetadataMessageCallback, PeerMetadataRow } from "@zkp2p/sdk";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { BASE_RPC_URL, PEER_ATTRIBUTION, USDC_ADDRESS } from "@/config";
import { fiatToSend } from "@/peer/buy/amounts";
import {
  decodeSignalCall,
  fetchPayeeHandle,
  fulfillBuyIntent,
  parseFulfilledAmount,
  parseLockExpiry,
  parseSignaledIntent,
  readEscrowIntent,
  readIntentExpiry,
} from "@/peer/buy/chain";
import { toBuyError } from "@/peer/buy/errors";
import { recoverBuyOrder } from "@/peer/buy/recovery";
import type { OrderStorage } from "@/peer/buy/storage";
import { createBuyStore } from "@/peer/buy/store";
import type { BuyOrder } from "@/peer/buy/types";
import { PEER_ABIS, clearPeerClients, createPeerClient, getReadOnlyPeerClient } from "@/peer/client";
import { buildBuyerTeeProof } from "@/peer/extension";
import { BUY_PLATFORMS, resolveVerifyMethod, type BuyPlatformId, type FiatCode, type VerifyMethod } from "@/peer/platforms";
import { createExternalSender, type ChainReader } from "@/wallet/senders";
import type { Eip1193Like } from "@/wallet/provider";
import type { TxSender, WalletCall } from "@/wallet/types";
import { installAttestationMock, type AttestationMock } from "./lib/attestation";
import {
  FULFILL_SELECTOR,
  SIGNAL_SELECTOR,
  decodeFulfillCalldata,
  decodeIntentFulfilled,
  decodePaymentDetails,
  decodePaymentProof,
  decodeSignalCalldata,
  locateCall,
  reconstructAttestationResponse,
  type LocatedCall,
  type PaymentDetails,
} from "./lib/decode";
import { loadFixtures, type GoldenFulfilment } from "./lib/fixtures";
import { coinbaseSmartSender } from "./lib/smart";
import { GOLDEN_PROXY_URL, refusedMethods, startGoldenFork, type GoldenFork } from "./lib/fork";
import { PEER_BUYER_TEE_ROUTES, attestedRelease, peerProofParams } from "./lib/peer-reference";

const ORCH_ABI = PEER_ABIS.orchestrator;
const BASE_BUILDER_CODE = "bc_nbn6qkni";
/** What every RampRidge transaction must carry (src/config PEER_ATTRIBUTION, then the SDK's Base builder code). */
const RAMPRIDGE_SUFFIX_CODES = [...PEER_ATTRIBUTION, BASE_BUILDER_CODE];
const ENCRYPTED_SESSION = "golden-replay-encrypted-session-material";

const fixtures = loadFixtures();
const only = process.env.GOLDEN_CASES?.split(",").map((s) => s.trim());
const CASES = only ? fixtures.cases.filter((c) => only.includes(c.id) || only.includes(c.platform)) : fixtures.cases;

const forkClient = createPublicClient({
  chain: base,
  transport: http(GOLDEN_FORK_URL, { retryCount: 0, timeout: 120_000 }),
}) as unknown as PublicClient;

const forkProvider: Eip1193Like = {
  request: ({ method, params }) => forkClient.request({ method: method as never, params: params as never }),
};

let gf: GoldenFork;
let attestation: AttestationMock;

beforeAll(async () => {
  // Every app chain read and write must go to the golden fork (never Base mainnet or another suite's fork).
  expect(BASE_RPC_URL).toBe(GOLDEN_FORK_URL);
  expect(CASES.length).toBeGreaterThan(0);
  gf = await startGoldenFork((CASES[0] as GoldenFulfilment).fulfil.blockNumber - 1);
  attestation = installAttestationMock([new URL(GOLDEN_FORK_URL).origin, new URL(GOLDEN_PROXY_URL).origin]);
}, 180_000);

/** Per-case notes on what each replay exercised (not pass/fail), written when GOLDEN_NOTES_FILE is set. */
const notes = new Map<string, Record<string, string>>();
function summary(c: GoldenFulfilment): Record<string, string> {
  let entry = notes.get(c.id);
  if (!entry) {
    entry = {};
    notes.set(c.id, entry);
  }
  return entry;
}

afterAll(async () => {
  // GOLDEN_NOTES_FILE=path writes what each replay exercised (client, call style, lock extension, adoption).
  if (process.env.GOLDEN_NOTES_FILE && notes.size > 0) {
    writeFileSync(process.env.GOLDEN_NOTES_FILE, `${JSON.stringify(Object.fromEntries(notes), null, 2)}\n`);
  }
  attestation?.restore();
  await gf?.stop();
  // The proxy must never have been asked to send or sign anything.
  expect(refusedMethods).toEqual([]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Historical {
  fulfilCall: LocatedCall;
  signalCall: LocatedCall;
  signalLogs: Log[];
  fulfilArgs: ReturnType<typeof decodeFulfillCalldata>;
  details: PaymentDetails;
}

async function loadHistorical(c: GoldenFulfilment): Promise<Historical> {
  const fulfilCall = await locateCall(gf.mainnet, c.fulfil.txHash, c.orchestrator, FULFILL_SELECTOR, (input) => {
    try {
      return decodeFulfillCalldata(ORCH_ABI, input).args.intentHash.toLowerCase() === c.intentHash.toLowerCase();
    } catch {
      return false;
    }
  });
  const signalCall = await locateCall(gf.mainnet, c.signal.txHash, c.orchestrator, SIGNAL_SELECTOR, (input) => {
    try {
      const a = decodeSignalCalldata(ORCH_ABI, input).args;
      return a.depositId === BigInt(c.depositId) && a.amount === BigInt(c.amount) && getAddress(a.to) === c.to;
    } catch {
      return false;
    }
  });
  const receipt = await gf.mainnet<{ logs: Log[] }>("eth_getTransactionReceipt", [c.signal.txHash]);
  const fulfilArgs = decodeFulfillCalldata(ORCH_ABI, fulfilCall.input);
  const details = decodePaymentDetails(decodePaymentProof(fulfilArgs.args.paymentProof).encodedPaymentDetails);
  return { fulfilCall, signalCall, signalLogs: receipt.logs, fulfilArgs, details };
}

async function setEth(address: Address): Promise<void> {
  await gf.fork("anvil_setBalance", [address, "0xde0b6b3a7640000"]);
}

/** The next fork block gets the real fulfilment block's timestamp. */
async function atFulfilTime(c: GoldenFulfilment): Promise<void> {
  await gf.fork("evm_setNextBlockTimestamp", [c.fulfil.blockTimestamp]);
}

function usdcBalance(owner: Address): Promise<bigint> {
  return forkClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

/** IntentFulfilled events the orchestrator emitted for `intentHash`, decoded independently of RampRidge. */
function fulfilledEvents(logs: readonly Log[], intentHash: Hex, orchestrator: Address) {
  return logs
    .filter((l) => getAddress(l.address) === getAddress(orchestrator) && l.topics[0] !== undefined)
    .flatMap((l) => {
      try {
        const e = decodeIntentFulfilled(ORCH_ABI, { data: l.data, topics: l.topics as Hex[] });
        return e.intentHash.toLowerCase() === intentHash.toLowerCase() ? [{ ...e, address: getAddress(l.address) }] : [];
      } catch {
        return [];
      }
    });
}

/** A TxSender from the app's own external-wallet factory, sending as `address` on the fork. */
function forkSender(address: Address): { sender: TxSender; calls: WalletCall[] } {
  const inner = createExternalSender(
    address,
    { getProvider: async () => forkProvider, switchToBase: async () => undefined },
    { reader: forkClient as unknown as ChainReader, receiptTimeoutMs: 120_000 },
  );
  const calls: WalletCall[] = [];
  const sender: TxSender = {
    ...inner,
    async sendCalls(batch, opts) {
      calls.push(...batch);
      return inner.sendCalls(batch, opts);
    },
  };
  return { sender, calls };
}

/** The verify method RampRidge would prove this payment with (Zelle needs a bank: the first one). */
function rampridgeMethod(platform: BuyPlatformId): VerifyMethod {
  const method = resolveVerifyMethod(platform) ?? BUY_PLATFORMS[platform].verifyMethods[0];
  if (!method) throw new Error(`no verify method for ${platform}`);
  return method;
}

/** A captured payment row the platform's "sent" filter accepts. Proof params are opaque to RampRidge. */
function capturedRow(platform: BuyPlatformId, method: VerifyMethod, originalIndex: number): PeerMetadataRow {
  const params = { PAYMENT_ID: `golden-${platform}`, SENDER_ID: "golden-sender" };
  const base = { hidden: false, originalIndex, params, recipient: "golden-recipient", date: "2026-10-01" };
  switch (platform) {
    case "venmo":
      return { ...base, amount: "- $10.00" };
    case "cashapp":
      return { ...base, amount: "1000", currency: "USD" };
    case "revolut":
      return { ...base, amount: "-1000", currency: "GBP", state: "COMPLETED" };
    case "wise":
      return { ...base, amount: "10.00 EUR" };
    case "zelle":
      return { ...base, amount: "10.00" };
    case "paypal":
      return method.id === "business" ? { ...base, amount: "10.00" } : { ...base, amount: "10.00", type: "SEND_MONEY_SENT" };
    case "monzo":
      return { ...base, amount: "-1000", recipientName: "golden-recipient" };
    case "chime":
      return { ...base, amount: "10", status: "SUCCEEDED" };
    case "monobank":
      return { ...base, amount: "1000" };
    case "xmoney":
      return { ...base, amount: "10000000", currency: "usd", date: "1790000000000", direction: "Debit" };
    default:
      return { ...base, amount: "10.00" };
  }
}

function captureMessage(method: VerifyMethod, row: PeerMetadataRow, expiresAt: number): PeerMetadataMessage {
  return {
    platform: method.actionPlatform,
    requestId: "golden",
    expiresAt,
    metadata: [row],
    buyerTeeCapture: { encryptedSessionMaterial: ENCRYPTED_SESSION },
  } as PeerMetadataMessage;
}

/** Asserts the attestation request RampRidge made is the one Peer's web app makes for this intent. */
function expectAttestationRequest(
  c: GoldenFulfilment,
  details: PaymentDetails,
  method: VerifyMethod,
  row: PeerMetadataRow,
): void {
  expect(attestation.requests).toHaveLength(1);
  const req = attestation.requests[0] as (typeof attestation.requests)[number];
  const peerRoutes = PEER_BUYER_TEE_ROUTES[c.platform] ?? [];
  const route = peerRoutes.find((r) => r.platform === method.actionPlatform && r.actionType === method.actionType);
  expect(route, `RampRidge route ${method.actionPlatform}/${method.actionType} is one Peer's web app uses`).toBeDefined();
  expect(req.origin).toBe("https://attestation-service.zkp2p.xyz");
  expect(req.method).toBe("POST");
  expect(req.path).toBe(`/buyer/verify/${route?.platform}/${route?.actionType}`);
  expect(req.body.chainId).toBe(8453);
  expect(req.body.encryptedSessionMaterial).toBe(ENCRYPTED_SESSION);
  expect(req.body.params).toEqual(
    peerProofParams(row.params as Record<string, string>, row.originalIndex, route?.includeMetadataIndex ?? false),
  );
  // The intent context must be exactly what the real attestation service signed over (its snapshot tuple).
  const intent = req.body.intent ?? {};
  expect(String(intent.intentHash).toLowerCase()).toBe(c.intentHash.toLowerCase());
  expect(intent.amount).toBe(details.snapshot.amount.toString());
  expect(intent.amount).toBe(c.amount);
  expect(String(intent.paymentMethod).toLowerCase()).toBe(details.snapshot.paymentMethod.toLowerCase());
  expect(String(intent.fiatCurrency).toLowerCase()).toBe(details.snapshot.fiatCurrency.toLowerCase());
  expect(intent.conversionRate).toBe(details.snapshot.conversionRate.toString());
  expect(String(intent.payeeDetails).toLowerCase()).toBe(details.snapshot.payeeDetails.toLowerCase());
  expect(intent.timestampMs).toBe((details.snapshot.signalTimestamp * 1000n).toString());
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The order as RampRidge stores it at signal time. usdcExpected is set to the
 * gross amount on purpose (never the real net), so any figure a test reads
 * back as "received" must have come from the chain or the indexer.
 */
function storedOrderFor(c: GoldenFulfilment, method: VerifyMethod): BuyOrder {
  const platform = c.platform as BuyPlatformId;
  return {
    owner: c.owner.toLowerCase() as Address,
    intentHash: c.intentHash,
    depositId: c.depositId,
    escrow: c.escrow,
    orchestrator: c.orchestrator,
    platform,
    currency: c.currency as FiatCode,
    usdcGross: BigInt(c.amount),
    usdcExpected: BigInt(c.amount),
    rate: BigInt(c.conversionRate),
    fiatToSend: fiatToSend(BigInt(c.amount), BigInt(c.conversionRate), c.currency as FiatCode),
    fiatToSendText: "0",
    payeeHandle: "redacted",
    payeeDetailsHash: c.payeeDetails,
    signalTxHash: c.signal.txHash,
    signaledAt: c.signaledAt * 1000,
    expiresAt: c.signal.lockExpiry * 1000,
    verifyMethodId: BUY_PLATFORMS[platform].methodChoice === "none" ? null : method.id,
    memo: null,
    status: "active",
    fees: null,
    paidClaimedAt: null,
  };
}

const noPayee = async () => "redacted";

function memoryStorage(seed: BuyOrder[]): OrderStorage & { orders: Map<string, BuyOrder> } {
  const orders = new Map<string, BuyOrder>(seed.map((o) => [o.owner.toLowerCase(), o]));
  const dismissed = new Map<string, Set<string>>();
  return {
    orders,
    load: (owner) => orders.get(owner.toLowerCase()) ?? null,
    save: (order) => void orders.set(order.owner.toLowerCase(), order),
    clear: (owner) => void orders.delete(owner.toLowerCase()),
    dismiss: (owner, hash) => {
      const set = dismissed.get(owner.toLowerCase()) ?? new Set<string>();
      set.add(hash.toLowerCase());
      dismissed.set(owner.toLowerCase(), set);
    },
    dismissed: (owner) => dismissed.get(owner.toLowerCase()) ?? new Set<string>(),
  };
}

function fakeExtension(message: (platform: string) => PeerMetadataMessage) {
  const listeners = new Set<PeerMetadataMessageCallback>();
  const authenticated: unknown[] = [];
  const sdk: PeerExtensionSdk = {
    isAvailable: () => true,
    getState: async () => "ready",
    checkConnectionStatus: async () => "connected",
    requestConnection: async () => true,
    getVersion: async () => "golden",
    authenticate: (params) => {
      authenticated.push(params);
      setTimeout(() => [...listeners].forEach((cb) => cb(message(params.platform))), 0);
    },
    onMetadataMessage: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    openInstallPage: () => undefined,
  } as PeerExtensionSdk;
  return { sdk, authenticated };
}

// ---------------------------------------------------------------------------
// Fixture-level checks (no fork)
// ---------------------------------------------------------------------------

describe("golden fixtures", () => {
  it("cover at least 6 buyer-TEE fulfilments across RampRidge platforms", () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(6);
    for (const c of fixtures.cases) {
      expect(c.fulfil.attestationSource).toBe("buyer-tee");
      expect(Object.keys(BUY_PLATFORMS)).toContain(c.platform);
      expect(c.fulfil.signatureCount).toBe(1);
    }
    expect(new Set(fixtures.cases.map((c) => c.platform)).size).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Per fulfilment
// ---------------------------------------------------------------------------

describe.each(CASES)("$id ($currency, fulfil $fulfil.txHash)", (c) => {
  const platform = c.platform as BuyPlatformId;
  let hist: Historical;

  beforeAll(async () => {
    await gf.resetTo(c.fulfil.blockNumber - 1);
    clearPeerClients();
    hist = await loadHistorical(c);
  }, 300_000);

  it("fixture matches the real transactions", () => {
    const a = hist.fulfilArgs.args;
    expect(a.intentHash.toLowerCase()).toBe(c.intentHash.toLowerCase());
    expect(hist.fulfilCall.from).toBe(c.fulfil.caller);
    expect(hist.signalCall.from).toBe(c.signal.caller);
    expect(hist.details.snapshot.intentHash.toLowerCase()).toBe(c.intentHash.toLowerCase());
    expect(hist.details.snapshot.amount).toBe(BigInt(c.amount));
    expect(hist.details.snapshot.conversionRate).toBe(BigInt(c.conversionRate));
    expect(hist.details.snapshot.signalTimestamp).toBe(BigInt(c.signaledAt));
    expect(hist.details.payment.amount).toBe(BigInt(c.fulfil.paymentAmountMinor));
    // Peer's own apps attribute their sends with ERC-8021 too; the replay compares calldata without it.
    expect(hist.fulfilArgs.suffixCodes?.at(-1)).toBe(BASE_BUILDER_CODE);
    Object.assign(summary(c), {
      client: (hist.fulfilArgs.suffixCodes ?? []).filter((code) => code !== BASE_BUILDER_CODE).join("+") || "none",
      fulfilSentBy: hist.fulfilCall.direct ? "EOA tx" : "nested call (ERC-4337)",
      lockExtended: String(c.signal.lockExpiryAtFulfil !== c.signal.lockExpiry),
    });
  });

  it("attested release follows the attestation service's formula, and RampRidge's fiat-to-send releases the full intent", () => {
    const amount = BigInt(c.amount);
    const rate = BigInt(c.conversionRate);
    const paid = BigInt(c.fulfil.paymentAmountMinor);
    expect(attestedRelease(paid, rate, amount)).toBe(BigInt(c.fulfil.releaseAmount));
    // What RampRidge tells the buyer to send (6-decimal fiat), in the platform's minor units.
    const toSend = fiatToSend(amount, rate, c.currency as FiatCode);
    expect(toSend % 10_000n).toBe(0n);
    const toSendMinor = toSend / 10_000n;
    // Never more than the payment that really released this intent in full ...
    if (BigInt(c.fulfil.releaseAmount) === amount) expect(toSendMinor).toBeLessThanOrEqual(paid);
    // ... and paying exactly that releases the whole intent.
    expect(attestedRelease(toSendMinor, rate, amount)).toBe(amount);
  });

  it("decodeSignalCall, parseSignaledIntent and parseLockExpiry read the real signal transaction", async () => {
    const call = decodeSignalCall(hist.signalCall.input);
    expect(call).not.toBeNull();
    expect(call?.referralFees.map((f) => ({ recipient: getAddress(f.recipient), fee: f.fee }))).toEqual(
      c.referralFees.map((f) => ({ recipient: getAddress(f.recipient), fee: BigInt(f.fee) })),
    );
    expect(call?.signatureExpiresAt).toBe(c.signal.signatureExpiration * 1000);
    // Not a signal call.
    expect(decodeSignalCall(hist.fulfilCall.input)).toBeNull();

    // The intent's referral legs as the orchestrator stored them (fork, block before the fulfilment).
    const onchain = (await forkClient.readContract({
      address: c.orchestrator,
      abi: ORCH_ABI,
      functionName: "getIntent",
      args: [c.intentHash],
    })) as { owner: Address; to: Address; referralFees: readonly { recipient: Address; fee: bigint }[]; amount: bigint };
    expect(getAddress(onchain.owner)).toBe(c.owner);
    expect(getAddress(onchain.to)).toBe(c.to);
    expect(onchain.amount).toBe(BigInt(c.amount));
    expect(onchain.referralFees.map((f) => ({ recipient: getAddress(f.recipient), fee: f.fee }))).toEqual(
      call?.referralFees.map((f) => ({ recipient: getAddress(f.recipient), fee: f.fee })),
    );

    const parsed = parseSignaledIntent(hist.signalLogs, c.owner, { depositId: BigInt(c.depositId), orchestrator: c.orchestrator });
    expect(parsed).toEqual({
      intentHash: c.intentHash,
      orchestrator: c.orchestrator,
      depositId: BigInt(c.depositId),
      amount: BigInt(c.amount),
      rate: BigInt(c.conversionRate),
      signaledAt: c.signaledAt * 1000,
    });
    // Lowercase owner (how the store binds wallets) finds it too; another owner, deposit or orchestrator does not.
    expect(parseSignaledIntent(hist.signalLogs, c.owner.toLowerCase() as Address)?.intentHash).toBe(c.intentHash);
    expect(parseSignaledIntent(hist.signalLogs, "0x000000000000000000000000000000000000dEaD")).toBeNull();
    expect(parseSignaledIntent(hist.signalLogs, c.owner, { depositId: BigInt(c.depositId) + 1n })).toBeNull();
    expect(
      parseSignaledIntent(hist.signalLogs, c.owner, { orchestrator: "0x888888359E981B5225CA48fbCdCeff702FC3b888" }),
    ).toBeNull();

    expect(parseLockExpiry(hist.signalLogs, c.intentHash)).toBe(c.signal.lockExpiry * 1000);
  });

  it("readEscrowIntent and readIntentExpiry see the open lock before the fulfilment", async () => {
    const client = getReadOnlyPeerClient();
    // The live lock, which includes any extension after signalling (parseLockExpiry gives the signal-time value).
    expect(await readEscrowIntent(client, c.escrow, c.depositId, c.intentHash)).toEqual({
      open: true,
      expiresAt: c.signal.lockExpiryAtFulfil * 1000,
    });
    expect(await readIntentExpiry(client, c.escrow, c.depositId, c.intentHash)).toBe(c.signal.lockExpiryAtFulfil * 1000);
    const unknownHash = keccak256(stringToHex(`golden-unknown-${c.id}`));
    expect(await readEscrowIntent(client, c.escrow, c.depositId, unknownHash)).toEqual({ open: false });
    expect(await readIntentExpiry(client, c.escrow, c.depositId, unknownHash)).toBeNull();
  });

  it("fetchPayeeHandle returns the deposit's payee from Curator", async () => {
    const handle = await fetchPayeeHandle(platform, c.payeeDetails);
    if (!c.payeeLookup.found) {
      expect(handle).toBeNull();
      return;
    }
    expect(handle).toBeTruthy();
    const hashed = keccak256(stringToHex(handle as string));
    expect(hashed).toBe(c.payeeLookup.handleKeccak);
    if (c.payeeLookup.handleHashesToPayee) expect(hashed.toLowerCase()).toBe(c.payeeDetails.toLowerCase());
  });

  it("recoverBuyOrder confirms the stored order from the chain, and adopts the open intent without one", async () => {
    const client = getReadOnlyPeerClient();
    const nowMs = c.fulfil.blockTimestamp * 1000;
    const stored = storedOrderFor(c, rampridgeMethod(platform));
    const confirmed = await recoverBuyOrder({ client, owner: c.owner, stored, now: nowMs, lookupPayee: noPayee, dismissed: new Set() });
    expect(confirmed.kind).toBe("active");
    if (confirmed.kind !== "active") return;
    expect(confirmed.verified).toBe(true);
    expect(confirmed.order.intentHash).toBe(c.intentHash);
    // The stored (signal-time) expiry is replaced by the live lock's, so an extended order is not shown as expired.
    expect(confirmed.order.expiresAt).toBe(c.signal.lockExpiryAtFulfil * 1000);
    expect(confirmed.order.usdcGross).toBe(BigInt(c.amount));
    expect(confirmed.order.payeeDetailsHash.toLowerCase()).toBe(c.payeeDetails.toLowerCase());

    // A new device: no stored order. The owner's newest open intent is adopted.
    const fresh = await recoverBuyOrder({ client, owner: c.owner, stored: null, now: nowMs, lookupPayee: noPayee, dismissed: new Set() });
    expect(fresh.kind).toBe("active");
    if (fresh.kind !== "active") return;
    if (fresh.order.intentHash !== c.intentHash) {
      // The owner had a newer open intent on a RampRidge platform: that one is shown first.
      expect(fresh.order.signaledAt).toBeGreaterThanOrEqual(c.signaledAt * 1000);
      summary(c).freshAdoption = "newer intent adopted";
      return;
    }
    summary(c).freshAdoption = "this intent adopted";
    expect(fresh.order.platform).toBe(platform);
    expect(fresh.order.currency).toBe(c.currency);
    expect(fresh.order.usdcGross).toBe(BigInt(c.amount));
    expect(fresh.order.rate).toBe(BigInt(c.conversionRate));
    expect(fresh.order.expiresAt).toBe(c.signal.lockExpiryAtFulfil * 1000);
    expect(fresh.order.orchestrator).toBe(c.orchestrator);
    expect(fresh.order.signalTxHash?.toLowerCase()).toBe(c.signal.txHash.toLowerCase());
    // What a new device tells the buyer they will receive must be what the chain later released.
    expect(fresh.order.usdcExpected).toBe(BigInt(c.fulfil.netAmount));
  });

  it("control: the historical fulfil calldata replays on the fork", async () => {
    const snap = await gf.snapshot();
    try {
      await setEth(hist.fulfilCall.from);
      await atFulfilTime(c);
      const hash = await gf.fork<Hex>("eth_sendTransaction", [
        { from: hist.fulfilCall.from, to: c.orchestrator, data: hist.fulfilCall.input },
      ]);
      const receipt = await forkClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      expect(receipt.status).toBe("success");
      const events = fulfilledEvents(receipt.logs, c.intentHash, c.orchestrator);
      expect(events).toHaveLength(1);
      expect(events[0]?.amount).toBe(BigInt(c.fulfil.netAmount));

      // Released elsewhere (e.g. the fulfil landed after a wallet error): the stored order settles as fulfilled
      // with what the buyer actually received.
      const settled = await recoverBuyOrder({
        client: getReadOnlyPeerClient(),
        owner: c.owner,
        stored: storedOrderFor(c, rampridgeMethod(platform)),
        now: c.fulfil.blockTimestamp * 1000,
        lookupPayee: noPayee,
        dismissed: new Set(),
      });
      expect(settled.kind).toBe("fulfilled");
      if (settled.kind === "fulfilled") {
        expect(settled.txHash?.toLowerCase()).toBe(c.fulfil.txHash.toLowerCase());
        expect(settled.usdcReceived).toBe(BigInt(c.fulfil.netAmount));
      }
    } finally {
      await gf.revert(snap);
    }
  });

  it("fulfillBuyIntent reproduces the real fulfilment with only the attestation call mocked", async () => {
    const snap = await gf.snapshot();
    try {
      const method = rampridgeMethod(platform);
      const row = capturedRow(platform, method, 3);
      const proof: BuyerTeePaymentProofInput = buildBuyerTeeProof(
        captureMessage(method, row, Date.now() + 600_000),
        platform,
        row,
        method,
      );
      const { sender, calls } = forkSender(hist.fulfilCall.from);
      await setEth(sender.address);
      attestation.requests.length = 0;
      attestation.otherHosts.clear();
      attestation.otherRequests.length = 0;
      attestation.arm(
        reconstructAttestationResponse(
          hist.fulfilArgs.args,
          { platform: method.actionPlatform, actionType: method.actionType },
          `0x${"00".repeat(32)}`,
        ),
      );
      const recipientBefore = await usdcBalance(c.to);
      await atFulfilTime(c);

      const result = await fulfillBuyIntent(createPeerClient({ sender }), sender, c.intentHash, c.orchestrator, proof);

      // The attestation request is the one Peer's web app makes for this intent.
      expectAttestationRequest(c, hist.details, method, row);
      // Besides the fork and the (mocked) attestation service, only the Peer indexer is consulted
      // (the SDK's ProtocolViewer intent read asks it for routing hints, exactly as in Peer's web app).
      expect(
        [...attestation.otherHosts].filter((host) => host !== "indexer.zkp2p.xyz"),
        attestation.otherRequests.join("\n"),
      ).toEqual([]);

      // Same calldata as the real fulfilment, apart from the ERC-8021 attribution suffix.
      expect(calls).toHaveLength(1);
      const sent = calls[0] as WalletCall;
      expect(getAddress(sent.to)).toBe(c.orchestrator);
      expect(sent.value ?? 0n).toBe(0n);
      const ours = decodeFulfillCalldata(ORCH_ABI, sent.data as Hex);
      expect(ours.canonical).toBe(hist.fulfilArgs.canonical);
      expect(ours.suffixCodes).toEqual(RAMPRIDGE_SUFFIX_CODES);
      expect(sent.data).toBe(`${hist.fulfilArgs.canonical}${ours.suffix.slice(2)}`);

      // The fork transaction succeeded, emitted IntentFulfilled and paid the recipient exactly the released USDC.
      const receipt: TransactionReceipt = await forkClient.getTransactionReceipt({ hash: result.txHash });
      expect(receipt.status).toBe("success");
      const events = fulfilledEvents(receipt.logs, c.intentHash, c.orchestrator);
      expect(events).toHaveLength(1);
      expect(events[0]?.amount).toBe(BigInt(c.fulfil.netAmount));
      expect(events[0]?.fundsTransferredTo).toBe(c.fulfil.fundsTransferredTo);
      expect(events[0]?.isManualRelease).toBe(false);
      const recipientAfter = await usdcBalance(c.to);
      expect(recipientAfter - recipientBefore).toBe(BigInt(c.fulfil.netAmount));

      // RampRidge's own reading of the receipt agrees.
      expect(result.released).toBe(BigInt(c.fulfil.netAmount));
      expect(parseFulfilledAmount(receipt.logs, c.intentHash)).toBe(BigInt(c.fulfil.netAmount));
      expect(parseFulfilledAmount(receipt.logs, keccak256(stringToHex("other-intent")))).toBeNull();

      // The lock is gone: the order can no longer be fulfilled.
      expect(await readEscrowIntent(getReadOnlyPeerClient(), c.escrow, c.depositId, c.intentHash)).toEqual({ open: false });

      // A second release (double click, or a retry after the first one landed) is refused before
      // anything is attested or sent, as a closed order.
      attestation.requests.length = 0;
      const again = await fulfillBuyIntent(createPeerClient({ sender }), sender, c.intentHash, c.orchestrator, proof).then(
        () => null,
        (error: unknown) => error,
      );
      expect(again).not.toBeNull();
      expect(toBuyError(again, { stage: "fulfill", platform }).code).toBe("intent_closed");
      expect(attestation.requests).toHaveLength(0);
      expect(calls).toHaveLength(1);
    } finally {
      attestation.disarm();
      await gf.revert(snap);
    }
  });

  it("fulfillBuyIntent through a Privy-style Coinbase Smart Wallet (one ERC-4337 user operation) releases the same USDC", async () => {
    const snap = await gf.snapshot();
    try {
      const method = rampridgeMethod(platform);
      const row = capturedRow(platform, method, 1);
      const proof = buildBuyerTeeProof(captureMessage(method, row, Date.now() + 600_000), platform, row, method);
      const smart = await coinbaseSmartSender(forkClient, gf.fork);
      attestation.requests.length = 0;
      attestation.arm(
        reconstructAttestationResponse(
          hist.fulfilArgs.args,
          { platform: method.actionPlatform, actionType: method.actionType },
          `0x${"00".repeat(32)}`,
        ),
      );
      const recipientBefore = await usdcBalance(c.to);
      await atFulfilTime(c);

      // No orchestrator: what a recovered order carries when the indexer could not name it. The SDK must
      // still route the fulfil to the intent's own orchestrator (V3), not the default one.
      const result = await fulfillBuyIntent(createPeerClient({ sender: smart.sender }), smart.sender, c.intentHash, null, proof);

      expectAttestationRequest(c, hist.details, method, row);
      expect(smart.batches).toHaveLength(1);
      expect(smart.batches[0]).toHaveLength(1);
      const sent = (smart.batches[0] as { to: Address; data?: Hex }[])[0];
      expect(getAddress(sent?.to as Address)).toBe(c.orchestrator);
      const ours = decodeFulfillCalldata(ORCH_ABI, sent?.data as Hex);
      expect(ours.canonical).toBe(hist.fulfilArgs.canonical);
      expect(ours.suffixCodes).toEqual(RAMPRIDGE_SUFFIX_CODES);

      expect(result.txHash).toBe(smart.bundleTxs[0]);
      const receipt = await forkClient.getTransactionReceipt({ hash: result.txHash });
      expect(receipt.status).toBe("success");
      const events = fulfilledEvents(receipt.logs, c.intentHash, c.orchestrator);
      expect(events).toHaveLength(1);
      expect(events[0]?.amount).toBe(BigInt(c.fulfil.netAmount));
      expect(result.released).toBe(BigInt(c.fulfil.netAmount));
      expect((await usdcBalance(c.to)) - recipientBefore).toBe(BigInt(c.fulfil.netAmount));
    } finally {
      attestation.disarm();
      await gf.revert(snap);
    }
  });

  it("during a Peer indexer outage, fulfillBuyIntent with no known orchestrator still routes to OrchestratorV3 and releases the USDC", async () => {
    const snap = await gf.snapshot();
    try {
      const method = rampridgeMethod(platform);
      const row = capturedRow(platform, method, 2);
      const proof = buildBuyerTeeProof(captureMessage(method, row, Date.now() + 600_000), platform, row, method);
      const { sender, calls } = forkSender(hist.fulfilCall.from);
      await setEth(sender.address);
      clearPeerClients();
      attestation.requests.length = 0;
      attestation.otherRequests.length = 0;
      attestation.outage(["indexer.zkp2p.xyz"]);
      attestation.arm(
        reconstructAttestationResponse(
          hist.fulfilArgs.args,
          { platform: method.actionPlatform, actionType: method.actionType },
          `0x${"00".repeat(32)}`,
        ),
      );
      await atFulfilTime(c);
      const result = await fulfillBuyIntent(createPeerClient({ sender }), sender, c.intentHash, null, proof);
      // The outage was real: the SDK asked the indexer and fell back to on-chain routing.
      expect(attestation.otherRequests.some((r) => r.includes("indexer.zkp2p.xyz") && r.includes("outage"))).toBe(true);
      expectAttestationRequest(c, hist.details, method, row);
      expect(calls).toHaveLength(1);
      expect(getAddress((calls[0] as WalletCall).to)).toBe(c.orchestrator);
      expect(decodeFulfillCalldata(ORCH_ABI, (calls[0] as WalletCall).data as Hex).canonical).toBe(hist.fulfilArgs.canonical);
      expect(result.released).toBe(BigInt(c.fulfil.netAmount));
    } finally {
      attestation.outage([]);
      attestation.disarm();
      clearPeerClients();
      await gf.revert(snap);
    }
  });

  it("the buy store completes the stored order with the USDC the chain released", async () => {
    const snap = await gf.snapshot();
    try {
      clearPeerClients();
      const method = rampridgeMethod(platform);
      const row = capturedRow(platform, method, 0);
      const owner = c.owner;
      const nowMs = c.fulfil.blockTimestamp * 1000;
      const { sender, calls } = forkSender(owner);
      await setEth(owner);
      const stored = storedOrderFor(c, method);
      const storage = memoryStorage([stored]);
      const ext = fakeExtension(() => captureMessage(method, row, nowMs + 600_000));
      const warnings: string[] = [];
      attestation.requests.length = 0;
      attestation.otherHosts.clear();
      attestation.otherRequests.length = 0;
      attestation.arm(
        reconstructAttestationResponse(
          hist.fulfilArgs.args,
          { platform: method.actionPlatform, actionType: method.actionType },
          `0x${"00".repeat(32)}`,
        ),
      );
      const store = createBuyStore({
        getClient: (s) => createPeerClient({ sender: s }),
        extension: ext.sdk,
        storage,
        quotes: async () => {
          throw new Error("no quotes in a golden replay");
        },
        fetchPayeeHandle: async () => "redacted",
        canInstallExtension: () => true,
        now: () => nowMs,
        sleep: async () => undefined,
        random: () => 0,
        indexerTimeoutMs: 1_000,
        signalReconcileMs: 1_000,
        pollIntervalMs: 60_000,
        every: () => () => undefined,
        onFocus: () => () => undefined,
        warn: (message, detail) => void warnings.push(`${message} ${detail}`),
      });

      store.getState().bindSender(sender);
      const recovered = await waitFor(
        () => store.getState(),
        (s) => !s.recovering && s.step === "awaitingPayment" && s.order?.intentHash === c.intentHash,
        120_000,
        "recovered order",
      );
      // Chain facts merged into the stored order.
      expect(recovered.order?.usdcGross).toBe(BigInt(c.amount));
      expect(recovered.order?.rate).toBe(BigInt(c.conversionRate));
      expect(recovered.order?.payeeDetailsHash.toLowerCase()).toBe(c.payeeDetails.toLowerCase());
      expect(recovered.order?.expiresAt).toBe(c.signal.lockExpiryAtFulfil * 1000);
      expect(recovered.order?.platform).toBe(platform);
      expect(recovered.order?.currency).toBe(c.currency);

      await store.getState().markPaid();
      const selecting = await waitFor(
        () => store.getState(),
        (s) => s.step === "selectPayment" || s.step === "error",
        60_000,
        "payment list",
      );
      expect(selecting.error, JSON.stringify(selecting.error)).toBeNull();
      expect(ext.authenticated).toHaveLength(1);
      expect(selecting.payments).toHaveLength(1);

      await atFulfilTime(c);
      await store.getState().choosePayment((selecting.payments[0] as { index: number }).index);
      const done = await waitFor(
        () => store.getState(),
        (s) => s.step === "completed" || s.step === "error",
        180_000,
        "completion",
      );
      expect(done.error, `${JSON.stringify(done.error)} ${warnings.join(" | ")}`).toBeNull();
      expect(done.step).toBe("completed");
      expect(calls).toHaveLength(1);
      expectAttestationRequest(c, hist.details, method, row);
      const receipt = await forkClient.getTransactionReceipt({ hash: done.completion?.fulfillTxHash as Hex });
      expect(receipt.status).toBe("success");
      const released = parseFulfilledAmount(receipt.logs, c.intentHash);
      expect(released).toBe(BigInt(c.fulfil.netAmount));
      expect(done.completion?.usdcReceived).toBe(released);
      expect(done.completion?.intentHash).toBe(c.intentHash);
      expect(done.completion?.platform).toBe(platform);
      expect(done.order?.status).toBe("fulfilled");
      expect(storage.load(owner)).toBeNull();
    } finally {
      attestation.disarm();
      await gf.revert(snap);
    }
  });
});
