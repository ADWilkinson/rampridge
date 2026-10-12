/**
 * Live payee check. `prepare()` is Peer Cash's unsigned path: it registers the
 * payee with the curator (`/v2/makers/create`) and builds the deposit
 * transactions without sending anything, so a success means the curator
 * accepts this handle. Only some rails prove the account exists:
 * live-validated rails (Venmo, Cash App, Revolut, Monzo) answer 404 for an
 * account the curator cannot find, and identity-attested rails (Wise, PayPal,
 * Alipay) answer "identityAttestation is required" for a handle never
 * registered with a signed attestation. Elsewhere (Zelle, Chime, UPI, X Money)
 * any well-formed handle is accepted, so a success there is `confirmed:
 * false`: a typo that belongs to someone else would let buyers pay that
 * person.
 */

import { isCashError, RECOMMENDED_MIN_CASHOUT_AMOUNT, type CashClient, type CurrencyType } from "@zkp2p/cash";
import { registrationRouteFor, type PayeeRegistrationRoute } from "./cash";
import { displayPayee, normalizePayee, payeeField, platformName } from "./payees";

export type PayeeCheck =
  | {
      kind: "valid";
      offchainId: string;
      /** Curator payee hash, when returned. */
      payeeHash: string | null;
      /**
       * Peer verified this account exists and belongs to the payee: true on
       * live-validated rails and on identity-attested rails (whose handles
       * only register with an attestation); false where any well-formed
       * handle is accepted, so the seller must double-check it themselves.
       */
      confirmed: boolean;
    }
  | { kind: "notFound"; offchainId: string; message: string; registration: PayeeRegistrationRoute | null }
  | { kind: "needsIdentityAttestation"; offchainId: string; message: string; registration: PayeeRegistrationRoute }
  | { kind: "invalidFormat"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

export interface PayeeCheckInput {
  platform: string;
  /** Currencies the leg offers; the first supported one is used for the check. */
  currencies: readonly CurrencyType[];
  payee: string;
  /** Whether the platform requires an identity attestation for new payees (from capabilities). */
  requiresIdentityAttestation: boolean;
}

const IDENTITY_REQUIRED = /identityattestation is required|identity attestation|creating the maker|create the maker/i;

/** Rails where the curator looks the account up live and rejects one it cannot find. */
const LIVE_VALIDATED_RAILS: ReadonlySet<string> = new Set(["venmo", "cashapp", "revolut", "monzo"]);
/** Rails whose payees only register with a signed identity attestation of the account. */
const IDENTITY_ATTESTED_RAILS: ReadonlySet<string> = new Set(["wise", "paypal", "alipay"]);

/** Whether an accepted payee on this rail is proven to be a real account owned by the payee. */
export function payeeConfirmedBy(platform: string, requiresIdentityAttestation: boolean): boolean {
  const id = platform.toLowerCase();
  return LIVE_VALIDATED_RAILS.has(id) || IDENTITY_ATTESTED_RAILS.has(id) || requiresIdentityAttestation;
}
const NOT_FOUND = /user not found|not found for|account not found|does not exist/i;

interface CauseInfo {
  status: number | null;
  message: string;
}

function causeInfo(err: unknown): CauseInfo {
  const cause = isCashError(err) ? err.cause : err;
  const status =
    cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number" ? cause.status : null;
  const messages = [cause instanceof Error ? cause.message : "", err instanceof Error ? err.message : ""];
  return { status, message: messages.join(" ").trim() };
}

/** Classifies a failed `prepare()` for one payee into a player-facing result. */
export function classifyPayeeError(
  input: Pick<PayeeCheckInput, "platform" | "requiresIdentityAttestation">,
  offchainId: string,
  err: unknown,
): PayeeCheck {
  const name = platformName(input.platform);
  const shown = displayPayee(input.platform, offchainId);
  const { label } = payeeField(input.platform);
  const registration = registrationRouteFor(input.platform, input.requiresIdentityAttestation);
  const needsAttestation = (): PayeeCheck => ({
    kind: "needsIdentityAttestation",
    offchainId,
    registration: "peerExtensionIdentity",
    message: `${shown} isn't registered for selling on ${name} yet. Register it once with the PeerAuth extension or at peer.xyz.`,
  });

  if (isCashError(err) && err.code === "PAYEE_VERIFICATION_REQUIRED") return needsAttestation();

  if (isCashError(err) && err.code !== "PAYEE_REGISTRATION_FAILED") {
    switch (err.code) {
      case "UNSUPPORTED_PLATFORM":
      case "UNSUPPORTED_PLATFORM_CURRENCY":
      case "ORACLE_UNSUPPORTED_CURRENCY":
      case "INVALID_PAYOUT_CURRENCIES":
      case "INVALID_PAYOUT_PLATFORMS":
        return { kind: "error", retryable: false, message: `${name} can't pay out in that currency.` };
      default:
        return { kind: "error", retryable: err.retryable, message: `Couldn't check your ${label} right now. Try again.` };
    }
  }

  const { status, message } = causeInfo(err);
  if (IDENTITY_REQUIRED.test(message)) {
    if (input.requiresIdentityAttestation) return needsAttestation();
    return {
      kind: "notFound",
      offchainId,
      registration,
      message: `${shown} isn't registered for selling on ${name} yet. Register it once ${
        registration ? "with the PeerAuth extension or " : ""
      }at peer.xyz.`,
    };
  }
  // Peer web treats a bare 400 from makers/create on PayPal as "register first".
  if (status === 400 && input.platform === "paypal") return needsAttestation();
  if (status === 404 || NOT_FOUND.test(message)) {
    return {
      kind: "notFound",
      offchainId,
      registration,
      message: registration
        ? `We couldn't find ${shown} on ${name}. Check it's typed correctly; if it is, register it once with the PeerAuth extension or at peer.xyz.`
        : `We couldn't find ${shown} on ${name}. Check your ${label}.`,
    };
  }
  if (status === 400 || status === 422) {
    return { kind: "invalidFormat", message: `${name} doesn't accept that ${label}. Check it and try again.` };
  }
  if (status === 429) return { kind: "error", retryable: true, message: "Too many checks. Wait a moment, then try again." };
  if (/timed out|timeout/i.test(message)) {
    return { kind: "error", retryable: true, message: "The handle check timed out. Try again." };
  }
  return { kind: "error", retryable: true, message: `Couldn't check your ${label} right now. Try again.` };
}

/** Stable identity of a payee check: same platform and handle means the same answer. */
export function payeeCheckKey(platform: string, offchainId: string): string {
  return `${platform}\u0000${offchainId}`;
}

/** Runs the local format check, then the live curator check. Never touches the chain. */
export async function checkPayee(cash: Pick<CashClient, "prepare">, input: PayeeCheckInput): Promise<PayeeCheck> {
  const format = normalizePayee(input.platform, input.payee);
  if (!format.ok) return { kind: "invalidFormat", message: format.message };
  const currency = input.currencies[0];
  if (!currency) {
    return { kind: "error", retryable: false, message: `Pick a currency for ${platformName(input.platform)} first.` };
  }
  try {
    const plan = await cash.prepare({
      // Registration does not depend on the amount, so the check uses a fixed
      // valid amount and never re-runs while the player edits the amount.
      amount: RECOMMENDED_MIN_CASHOUT_AMOUNT,
      receive: { platform: input.platform, currency, payee: format.offchainId },
    });
    return {
      kind: "valid",
      offchainId: format.offchainId,
      payeeHash: plan.register.hashedOnchainIds[0] ?? null,
      confirmed: payeeConfirmedBy(input.platform, input.requiresIdentityAttestation),
    };
  } catch (err) {
    return classifyPayeeError(input, format.offchainId, err);
  }
}
