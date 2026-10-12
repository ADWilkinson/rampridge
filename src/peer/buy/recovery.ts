/**
 * Finds a wallet's open buy order from the chain so a refresh, a new device
 * or an order placed elsewhere is never lost.
 *
 * The ProtocolViewer lists every intent the account still has open, including
 * long-expired ones nobody pruned. Production OrchestratorV3 currently allows
 * multiple intents per account, so stale intents do not block new orders.
 * Expired intents stay fulfillable until pruned (fulfilIntent has no expiry
 * check), so a player who paid in time must still be able to verify: the
 * player's own stored order is always kept, and without one a recently
 * expired intent whose USDC is still locked is adopted too, unless the
 * player dismissed it on this device. Older stale intents are ignored. If the
 * chain ever enforces one intent per account, the AccountHasActiveIntent
 * revert names the blocker and the flow surfaces it.
 */

import {
  getCurrencyCodeFromHash,
  getPaymentMethodsCatalog,
  resolvePaymentMethodNameFromHash,
  type IndexerIntent,
  type Zkp2pClient,
} from "@zkp2p/sdk";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { CHAIN_ID } from "@/config";
import { PEER_RUNTIME_ENV } from "../client";
import { RATE_ONE } from "../format";
import { isBuyPlatformId, isFiatCode, needsRecipientId, recipientIdFor, type BuyPlatformId, type FiatCode } from "../platforms";
import { fiatToSend, fiatToSendText, netAfterReferralFees } from "./amounts";
import {
  DEFAULT_INTENT_TTL_MS,
  asPayeeRecord,
  fetchPayee,
  readEscrowIntent,
  readIntentExpiry,
  readManagerFee,
  type PayeeLookup,
} from "./chain";
import { pickMemo } from "./instructions";
import { localOrderStorage } from "./storage";
import type { BuyOrder } from "./types";

export type RecoveryResult =
  /**
   * An open order: a live one, the player's own stored order even if
   * expired, or a recently expired one whose USDC is still locked (a player
   * who paid in time can still verify it). `verified` is false when the chain
   * could not confirm it and only storage vouches for it.
   */
  | { kind: "active"; order: BuyOrder; verified: boolean }
  /** The stored order was released to the buyer. */
  | { kind: "fulfilled"; order: BuyOrder; txHash: Hex | null; usdcReceived: bigint | null }
  /** The stored order is gone from the escrow and the indexer says it was cancelled or pruned. */
  | { kind: "closed"; order: BuyOrder | null }
  /** No stored order and no live order on the chain. */
  | { kind: "none" };

/** EscrowV2 caps an intent's total lifetime (with extensions) at 5 days. */
const MAX_INTENT_LIFETIME_MS = 5 * 24 * 60 * 60 * 1000;

/** A freshly signalled order is trusted for this long even if a lagging node or the indexer cannot see it yet. */
const FRESH_ORDER_GRACE_MS = 2 * 60 * 1000;

/**
 * Without a stored copy, an expired intent is still adopted for this long
 * after signalling while its USDC stays locked: long enough for a player who
 * paid near the deadline to verify from another device, short enough that
 * long-abandoned intents nobody pruned never resurface.
 */
export const EXPIRED_ORDER_ADOPT_MS = 24 * 60 * 60 * 1000;

const catalog = getPaymentMethodsCatalog(CHAIN_ID, PEER_RUNTIME_ENV);

interface IntentFacts {
  intentHash: Hex;
  owner: Address;
  escrow: Address;
  depositId: string;
  amount: bigint;
  rate: bigint;
  paymentMethodHash: string;
  fiatCurrencyHash: string;
  payeeDetailsHash: Hex | null;
  referralFees: ReadonlyArray<{ fee: bigint }>;
  signaledAt: number;
  orchestrator: Address | null;
  expiresAt: number | null;
  signalTxHash: Hex | null;
  netFromIndexer: bigint | null;
  /** The rate manager's fee (18-decimal fraction of the release) the orchestrator takes on top of the referral legs, when known. */
  managerFee: bigint | null;
}

function toAddress(value: string | null | undefined): Address | null {
  return value && isAddress(value, { strict: false }) ? getAddress(value) : null;
}

function bigintOrNull(value: string | null | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

async function fromProtocolViewer(client: Zkp2pClient, owner: Address): Promise<IntentFacts[]> {
  const views = await client.getPvAccountIntents(owner);
  return views
    .filter((v) => v.intent.owner.toLowerCase() === owner.toLowerCase() && v.intent.amount > 0n)
    .flatMap((v) => {
      const escrow = toAddress(v.intent.escrow);
      if (!escrow) return [];
      const method = v.intent.paymentMethod.toLowerCase();
      const payee = v.deposit.paymentMethods.find((pm) => pm.paymentMethod.toLowerCase() === method);
      return [
        {
          intentHash: v.intentHash as Hex,
          owner,
          escrow,
          depositId: v.intent.depositId.toString(),
          amount: v.intent.amount,
          rate: v.intent.conversionRate,
          paymentMethodHash: v.intent.paymentMethod,
          fiatCurrencyHash: v.intent.fiatCurrency,
          payeeDetailsHash: (payee?.verificationData.payeeDetails as Hex | undefined) ?? null,
          referralFees: v.intent.referralFees,
          signaledAt: Number(v.intent.timestamp) * 1000,
          orchestrator: null,
          expiresAt: null,
          signalTxHash: null,
          netFromIndexer: null,
          managerFee: null,
        },
      ];
    });
}

/** Indexer fallback when the ProtocolViewer read fails; payee details come from the SDK's resolver. */
async function fromIndexer(client: Zkp2pClient, owner: Address): Promise<IntentFacts[]> {
  const intents = await client.indexer.getOwnerIntents(owner, ["SIGNALED"]);
  const facts: IntentFacts[] = [];
  for (const intent of intents) {
    const [escrowPart, depositPart] = intent.depositId.includes("_")
      ? intent.depositId.split("_")
      : [null, intent.depositId];
    const escrow = toAddress(escrowPart);
    const amount = bigintOrNull(intent.amount);
    const rate = bigintOrNull(intent.conversionRate);
    if (!escrow || !depositPart || amount === null || rate === null) continue;
    let payeeDetailsHash: Hex | null = null;
    try {
      payeeDetailsHash = (await client.getFulfillIntentInputs(intent.intentHash as Hex)).payeeDetails;
    } catch {
      payeeDetailsHash = null;
    }
    const expiry = bigintOrNull(intent.expiryTime);
    facts.push({
      intentHash: intent.intentHash as Hex,
      owner,
      escrow,
      depositId: depositPart,
      amount,
      rate,
      paymentMethodHash: intent.paymentMethodHash ?? "",
      fiatCurrencyHash: intent.fiatCurrency,
      payeeDetailsHash,
      referralFees: [],
      signaledAt: Number(bigintOrNull(intent.signalTimestamp) ?? 0n) * 1000,
      orchestrator: toAddress(intent.orchestratorAddress),
      expiresAt: expiry === null ? null : Number(expiry) * 1000,
      signalTxHash: (intent.signalTxHash as Hex | undefined) ?? null,
      netFromIndexer: bigintOrNull(intent.takerAmountNetFees),
      managerFee: bigintOrNull(intent.managerFee),
    });
  }
  return facts;
}

async function enrich(client: Zkp2pClient, facts: IntentFacts): Promise<IntentFacts> {
  const [expiresAt, indexed] = await Promise.all([
    facts.expiresAt ?? readIntentExpiry(client, facts.escrow, facts.depositId, facts.intentHash),
    facts.signalTxHash && facts.orchestrator
      ? Promise.resolve(null)
      : client.indexer.getIntentByHash(facts.intentHash).catch(() => null),
  ]);
  const indexedExpiry = bigintOrNull(indexed?.expiryTime);
  return {
    ...facts,
    expiresAt: expiresAt ?? (indexedExpiry === null ? null : Number(indexedExpiry) * 1000),
    orchestrator: facts.orchestrator ?? toAddress(indexed?.orchestratorAddress),
    signalTxHash: facts.signalTxHash ?? ((indexed?.signalTxHash as Hex | undefined) || null),
    netFromIndexer: facts.netFromIndexer ?? bigintOrNull(indexed?.takerAmountNetFees),
    // The indexer records the fee the orchestrator snapshotted at signal time.
    managerFee: facts.managerFee ?? bigintOrNull(indexed?.managerFee),
  };
}

/**
 * Reads the deposit's rate-manager fee from the escrow when the order's net
 * must be rebuilt from the chain (no indexed net and no snapshot from the
 * indexer). A failed read leaves it unknown.
 */
async function withManagerFee(client: Zkp2pClient, facts: IntentFacts): Promise<IntentFacts> {
  if (facts.netFromIndexer !== null || facts.managerFee !== null) return facts;
  return { ...facts, managerFee: await readManagerFee(client, facts.escrow, facts.depositId) };
}

function supported(facts: IntentFacts): { platform: BuyPlatformId; currency: FiatCode; payeeDetailsHash: Hex } | null {
  const platform = resolvePaymentMethodNameFromHash(facts.paymentMethodHash, catalog);
  const currency = getCurrencyCodeFromHash(facts.fiatCurrencyHash);
  if (!platform || !isBuyPlatformId(platform) || !currency || !isFiatCode(currency) || !facts.payeeDetailsHash) {
    return null;
  }
  return { platform, currency, payeeDetailsHash: facts.payeeDetailsHash };
}

/**
 * USDC the buyer receives. The stored figure (the confirmed quote's net) and
 * the indexer's net both include every fee the orchestrator takes at
 * release. Rebuilt from the chain, it is the gross less each referral leg
 * and the rate manager's fee, each floored as the orchestrator floors them
 * (the protocol fee is zero on OrchestratorV3 today); an unknown manager fee
 * leaves the figure from the legs alone.
 */
function expectedNet(facts: IntentFacts, same: BuyOrder | null): bigint {
  if (same) return same.usdcExpected;
  if (facts.netFromIndexer !== null) return facts.netFromIndexer;
  const afterLegs = facts.referralFees.length > 0 ? netAfterReferralFees(facts.amount, facts.referralFees) : facts.amount;
  const manager = facts.managerFee !== null && facts.managerFee > 0n ? (facts.amount * facts.managerFee) / RATE_ONE : 0n;
  return afterLegs > manager ? afterLegs - manager : 0n;
}

/** Builds the order, keeping what only local storage knows (memo, verify method, payee, fees, paid claim). */
function toOrder(facts: IntentFacts, stored: BuyOrder | null): BuyOrder | null {
  const known = supported(facts);
  if (!known) return null;
  const { platform, currency } = known;
  const same = stored && stored.intentHash.toLowerCase() === facts.intentHash.toLowerCase() ? stored : null;
  const toSend = fiatToSend(facts.amount, facts.rate, currency);
  const expected = expectedNet(facts, same);
  return {
    owner: facts.owner,
    intentHash: facts.intentHash,
    depositId: facts.depositId,
    escrow: facts.escrow,
    orchestrator: facts.orchestrator ?? same?.orchestrator ?? null,
    platform,
    currency,
    usdcGross: facts.amount,
    usdcExpected: expected,
    rate: facts.rate,
    fiatToSend: toSend,
    fiatToSendText: fiatToSendText(toSend, currency),
    payeeHandle: same?.payeeHandle ?? null,
    ...(same?.payeeBusiness ? { payeeBusiness: true } : {}),
    ...(same?.recipientId ? { recipientId: same.recipientId } : {}),
    payeeDetailsHash: known.payeeDetailsHash,
    signalTxHash: facts.signalTxHash ?? same?.signalTxHash ?? null,
    signaledAt: facts.signaledAt || same?.signaledAt || Date.now(),
    expiresAt: facts.expiresAt ?? same?.expiresAt ?? (facts.signaledAt || Date.now()) + DEFAULT_INTENT_TTL_MS,
    verifyMethodId: same?.verifyMethodId ?? null,
    memo: same?.memo ?? pickMemo(platform),
    status: "active",
    fees: same?.fees ?? null,
    paidClaimedAt: same?.paidClaimedAt ?? null,
  };
}

/**
 * What happened to a stored order the ProtocolViewer did not list. That list
 * is not proof of absence: the SDK reads each orchestrator separately and
 * silently drops one whose read failed. So the escrow's own lock decides
 * whether the order is still open, and an order is only reported closed when
 * the lock is gone and the indexer says why (or has no record of an order
 * old enough that it should). Anything inconclusive keeps the stored order.
 */
async function settleStored(client: Zkp2pClient, stored: BuyOrder, now: number): Promise<RecoveryResult> {
  const unconfirmed: RecoveryResult = { kind: "active", order: stored, verified: false };
  let indexed: IndexerIntent | null = null;
  let indexerFailed = false;
  try {
    indexed = await client.indexer.getIntentByHash(stored.intentHash);
  } catch {
    indexerFailed = true;
  }
  if (indexed?.status === "FULFILLED" || indexed?.status === "MANUALLY_RELEASED") {
    return {
      kind: "fulfilled",
      order: { ...stored, status: "fulfilled" },
      txHash: (indexed.fulfillTxHash as Hex | undefined) ?? null,
      usdcReceived: bigintOrNull(indexed.takerAmountNetFees) ?? bigintOrNull(indexed.releasedAmount),
    };
  }
  const lock = await readEscrowIntent(client, stored.escrow, stored.depositId, stored.intentHash);
  if (lock === null) return unconfirmed;
  if (lock.open) return { kind: "active", order: { ...stored, expiresAt: lock.expiresAt }, verified: true };
  const closed: RecoveryResult = { kind: "closed", order: { ...stored, status: "cancelled" } };
  if (indexed?.status === "PRUNED") return closed;
  if (!indexed && !indexerFailed && now - stored.signaledAt >= FRESH_ORDER_GRACE_MS) return closed;
  // The escrow no longer holds it, so it can't be paid: released or cancelled, and the indexer has not said
  // which yet. Shown as no longer payable (expired now) until it does, as Peer's web app stops showing the
  // payee once the intent leaves the chain; a fresh order a lagging node can't see yet keeps its expiry, and
  // a later read that finds the lock restores it.
  if (now - stored.signaledAt >= FRESH_ORDER_GRACE_MS) {
    return { kind: "active", order: { ...stored, expiresAt: Math.min(stored.expiresAt, now) }, verified: false };
  }
  return unconfirmed;
}

async function withPayee(order: BuyOrder, verified: boolean, lookupPayee: PayeeLookup): Promise<RecoveryResult> {
  // Alipay's QR also needs the seller's PID: an order without one looks the payee up again.
  if (order.payeeHandle && (!needsRecipientId(order.platform) || order.recipientId)) return { kind: "active", order, verified };
  const payee = asPayeeRecord(await lookupPayee(order.platform, order.payeeDetailsHash));
  const recipientId = recipientIdFor(order.platform, payee?.recipientId);
  const withId = recipientId ? { recipientId } : {};
  if (order.payeeHandle) return { kind: "active", order: { ...order, ...withId }, verified };
  const found = payee ? { payeeHandle: payee.handle, ...(payee.business ? { payeeBusiness: true } : {}), ...withId } : {};
  return { kind: "active", order: { ...order, payeeHandle: null, ...found }, verified };
}

/**
 * The newest intent this app can show that is still open: a live one, or one
 * signalled within EXPIRED_ORDER_ADOPT_MS whose USDC the escrow still locks
 * (expired but fulfillable). Dismissed intents are skipped.
 */
async function adoptable(
  client: Zkp2pClient,
  facts: IntentFacts[],
  dismissed: ReadonlySet<string>,
  now: number,
): Promise<BuyOrder | null> {
  const candidates = facts
    .filter(
      (f) =>
        supported(f) !== null &&
        f.signaledAt + MAX_INTENT_LIFETIME_MS > now &&
        !dismissed.has(f.intentHash.toLowerCase()),
    )
    .sort((a, b) => b.signaledAt - a.signaledAt);
  for (const candidate of candidates) {
    const enriched = await enrich(client, candidate);
    const expiresAt = enriched.expiresAt ?? enriched.signaledAt + DEFAULT_INTENT_TTL_MS;
    if (expiresAt > now) {
      const built = toOrder(await withManagerFee(client, enriched), null);
      if (built) return built;
      continue;
    }
    if (now - enriched.signaledAt > EXPIRED_ORDER_ADOPT_MS) continue;
    const lock = await readEscrowIntent(client, enriched.escrow, enriched.depositId, enriched.intentHash);
    if (!lock?.open) continue;
    const built = toOrder({ ...(await withManagerFee(client, enriched)), expiresAt: lock.expiresAt }, null);
    if (built) return built;
  }
  return null;
}

/**
 * The owner's open order. A stored active order always wins: it is confirmed
 * from the chain (ProtocolViewer, then the indexer if that read fails) and
 * merged with what only storage knows, or settled through the escrow when it
 * is not listed. Without one, the newest open intent on a platform this app
 * can show is adopted: a live one, or a recently expired one still locked in
 * escrow that the player has not dismissed. Payee handles are looked up when
 * storage lacks them.
 */
export async function recoverBuyOrder(params: {
  client: Zkp2pClient;
  owner: Address;
  stored: BuyOrder | null;
  now: number;
  /** Payee lookup (defaults to Curator's maker endpoint). */
  lookupPayee?: PayeeLookup;
  /** Lowercase intent hashes the player dismissed (defaults to this device's record). */
  dismissed?: ReadonlySet<string>;
}): Promise<RecoveryResult> {
  const { client, owner, stored, now, lookupPayee = fetchPayee } = params;
  const dismissed = params.dismissed ?? localOrderStorage.dismissed(owner);
  const storedActive = stored?.status === "active" ? stored : null;
  let facts: IntentFacts[];
  let verified = true;
  try {
    facts = await fromProtocolViewer(client, owner);
  } catch {
    try {
      facts = await fromIndexer(client, owner);
    } catch {
      return storedActive ? { kind: "active", order: storedActive, verified: false } : { kind: "none" };
    }
    verified = false;
  }

  if (storedActive) {
    const hash = storedActive.intentHash.toLowerCase();
    const mine = facts.find((f) => f.intentHash.toLowerCase() === hash);
    if (!mine) return settleStored(client, storedActive, now);
    const chosen = await enrich(client, mine);
    const built = toOrder(chosen, storedActive);
    if (built) return withPayee(built, verified, lookupPayee);
    // Listed on-chain but not fully resolvable here (e.g. the indexer fallback lacks payee details).
    return {
      kind: "active",
      order: {
        ...storedActive,
        expiresAt: chosen.expiresAt ?? storedActive.expiresAt,
        orchestrator: chosen.orchestrator ?? storedActive.orchestrator,
        signalTxHash: chosen.signalTxHash ?? storedActive.signalTxHash,
      },
      verified: false,
    };
  }

  const found = await adoptable(client, facts, dismissed, now);
  return found ? withPayee(found, verified, lookupPayee) : { kind: "none" };
}
