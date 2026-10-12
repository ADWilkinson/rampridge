/**
 * Verifies that a transaction contains the Peer event a player claims, so
 * world announcements only ever reflect real on-chain settlement.
 *
 * - bought: an orchestrator's IntentFulfilled paid out to the player's wallet,
 *   backed by the orchestrator's USDC Transfer of that amount to the wallet
 *   and the verifier's PaymentVerified for that intent. Deposits may hold any
 *   token and IntentFulfilled does not name it, so the Transfer is what proves
 *   USDC moved; PaymentVerified (only the orchestrator can trigger it) is what
 *   proves fiat was paid. Manual releases by the seller prove neither.
 * - listed: the escrow's DepositReceived from the player's wallet, with the
 *   payment method and currency added in the same transaction.
 */

import { getContracts } from "@zkp2p/sdk";
import { decodeEventLog, erc20Abi } from "viem";
import type { Abi, AbiEvent, Hex } from "viem";
import type { PeerContracts, ReceiptLog, ReceiptRead } from "./chain.js";
import { CHAIN_ID } from "./chain.js";
import { badRequest, conflict, forbidden } from "./http.js";
import type { HttpError } from "./http.js";
import { currencyCode, platformName } from "./stall.js";
import { formatFixed, formatUsdc } from "./units.js";

/** Only fresh settlements are news. */
export const ANNOUNCE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** PaymentVerified amounts are in the currency's minor unit (cents). */
const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "UGX", "CLP", "ISK"]);

function pickEvents(abi: Abi | undefined, names: readonly string[]): AbiEvent[] {
  const events = (abi ?? []).filter(
    (item): item is AbiEvent => item.type === "event" && names.includes(item.name),
  );
  for (const name of names) {
    if (!events.some((e) => e.name === name)) throw new Error(`Peer SDK ABI is missing the ${name} event`);
  }
  return events;
}

const { abis } = getContracts(CHAIN_ID, "production");
const ORCHESTRATOR_EVENTS = pickEvents(abis.orchestratorV3 ?? abis.orchestrator, ["IntentFulfilled"]);
const ESCROW_EVENTS = pickEvents(abis.escrowV2 ?? abis.escrow, [
  "DepositReceived",
  "DepositPaymentMethodAdded",
  "DepositCurrencyAdded",
]);
const VERIFIER_EVENTS = pickEvents(abis.unifiedPaymentVerifier, ["PaymentVerified"]);
const TRANSFER_EVENTS = pickEvents(erc20Abi, ["Transfer"]);

interface Decoded {
  log: ReceiptLog;
  eventName: string;
  args: Record<string, unknown>;
}

/** Decodes `abi` events emitted by `addresses` (any contract when null). */
function decodeFrom(logs: readonly ReceiptLog[], addresses: readonly string[] | null, abi: AbiEvent[]): Decoded[] {
  const out: Decoded[] = [];
  for (const log of logs) {
    if (addresses && !addresses.includes(log.address.toLowerCase())) continue;
    if (log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      out.push({ log, eventName: decoded.eventName, args: decoded.args as unknown as Record<string, unknown> });
    } catch {
      // Another event from the same contract.
    }
  }
  return out;
}

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");
const asBigInt = (value: unknown) => (typeof value === "bigint" ? value : 0n);

export interface VerifiedAnnouncement {
  kind: "bought" | "listed";
  /** Log that proves it, used to dedupe several players in one bundled transaction. */
  logIndex: number;
  usdc: string;
  fiat: string | null;
  currency: string | null;
  platform: string;
}

function checkReceipt(receipt: ReceiptRead | null, now: number): ReceiptRead {
  if (!receipt) throw conflict("That transaction isn't confirmed yet. Try again in a few seconds.");
  if (receipt.status !== "success") throw badRequest("That transaction failed on-chain.");
  if (now - receipt.blockTimestampMs > ANNOUNCE_MAX_AGE_MS) {
    throw badRequest("That transaction is too old to announce.");
  }
  return receipt;
}

function fiatFromMinorUnits(amount: bigint, currency: string | null): string | null {
  if (!currency || ZERO_DECIMAL_CURRENCIES.has(currency)) return null;
  return formatFixed(amount, 2, 2);
}

const UNVERIFIED_PURCHASE = "That purchase wasn't settled by a verified payment, so it can't be announced.";

/**
 * The orchestrator's payout for `fulfil`: its last token Transfer before the
 * event and after any earlier IntentFulfilled in the transaction. With no
 * post-intent hook, OrchestratorV3 transfers netAmount to the intent's
 * recipient immediately before emitting IntentFulfilled, so this is that
 * transfer whatever token the deposit held.
 */
function payoutFor(fulfil: Decoded, allFulfilled: readonly Decoded[], transfers: readonly Decoded[]): Decoded | null {
  const at = fulfil.log.logIndex;
  const orchestrator = lower(fulfil.log.address);
  const after = allFulfilled.reduce((max, d) => (d.log.logIndex < at ? Math.max(max, d.log.logIndex) : max), -1);
  let payout: Decoded | null = null;
  for (const t of transfers) {
    const index = t.log.logIndex;
    if (index <= after || index >= at || lower(t.args.from) !== orchestrator) continue;
    if (!payout || index > payout.log.logIndex) payout = t;
  }
  return payout;
}

export function verifyBought(
  receipt: ReceiptRead | null,
  wallet: string,
  contracts: PeerContracts,
  now: number,
  claimed: ReadonlySet<number> = new Set(),
): VerifiedAnnouncement {
  const { logs } = checkReceipt(receipt, now);
  const recipient = wallet.toLowerCase();
  const allFulfilled = decodeFrom(logs, contracts.orchestrators, ORCHESTRATOR_EVENTS).filter(
    (d) => d.eventName === "IntentFulfilled",
  );
  const toWallet = allFulfilled.filter((d) => lower(d.args.fundsTransferredTo) === recipient);
  if (toWallet.length === 0) throw forbidden("That transaction didn't pay USDC to your verified wallet.");
  const transfers = decodeFrom(logs, null, TRANSFER_EVENTS).filter((d) => d.eventName === "Transfer");
  const payments = decodeFrom(logs, contracts.verifiers, VERIFIER_EVENTS).filter(
    (d) => d.eventName === "PaymentVerified",
  );

  const verified: VerifiedAnnouncement[] = [];
  let rejection: HttpError | null = null;
  for (const match of toWallet) {
    const amount = asBigInt(match.args.amount);
    const payout = payoutFor(match, allFulfilled, transfers);
    const paidUsdc =
      payout !== null &&
      lower(payout.log.address) === contracts.usdc &&
      lower(payout.args.to) === recipient &&
      asBigInt(payout.args.value) === amount;
    if (!paidUsdc) {
      rejection ??= forbidden("That transaction didn't pay USDC to your verified wallet.");
      continue;
    }
    const intentHash = lower(match.args.intentHash);
    const payment = payments.find((d) => lower(d.args.intentHash) === intentHash);
    if (match.args.isManualRelease !== false || !payment) {
      rejection ??= forbidden(UNVERIFIED_PURCHASE);
      continue;
    }
    const currency = currencyCode(String(payment.args.currency));
    verified.push({
      kind: "bought",
      logIndex: match.log.logIndex,
      usdc: formatUsdc(amount),
      fiat: fiatFromMinorUnits(asBigInt(payment.args.amount), currency),
      currency,
      platform: platformName(String(payment.args.method)) ?? "peer",
    });
  }
  if (verified.length === 0) throw rejection ?? forbidden(UNVERIFIED_PURCHASE);
  const unclaimed = verified.find((v) => !claimed.has(v.logIndex));
  if (!unclaimed) throw conflict("That purchase has already been announced.");
  return unclaimed;
}

export function verifyListed(
  receipt: ReceiptRead | null,
  wallet: string,
  contracts: PeerContracts,
  now: number,
  claimed: ReadonlySet<number> = new Set(),
): VerifiedAnnouncement {
  const { logs } = checkReceipt(receipt, now);
  const events = decodeFrom(logs, contracts.escrows, ESCROW_EVENTS);
  const received = events.filter(
    (d) =>
      d.eventName === "DepositReceived" &&
      lower(d.args.depositor) === wallet.toLowerCase() &&
      lower(d.args.token) === contracts.usdc,
  );
  if (received.length === 0) throw forbidden("That transaction didn't create a USDC deposit from your verified wallet.");
  const match = received.find((d) => !claimed.has(d.log.logIndex));
  if (!match) throw conflict("That deposit has already been announced.");

  const depositId = asBigInt(match.args.depositId);
  const sameDeposit = (d: Decoded) => d.log.address === match.log.address && asBigInt(d.args.depositId) === depositId;
  const method = events.find((d) => d.eventName === "DepositPaymentMethodAdded" && sameDeposit(d));
  const currency = events.find(
    (d) =>
      d.eventName === "DepositCurrencyAdded" &&
      sameDeposit(d) &&
      (!method || lower(d.args.paymentMethod) === lower(method.args.paymentMethod)),
  );
  return {
    kind: "listed",
    logIndex: match.log.logIndex,
    usdc: formatUsdc(asBigInt(match.args.amount)),
    fiat: null,
    currency: currency ? currencyCode(String(currency.args.currency)) : null,
    platform: (method && platformName(String(method.args.paymentMethod))) ?? "peer",
  };
}
