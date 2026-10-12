/**
 * One-time payee registration through the public PeerAuth extension, driven
 * from this origin exactly as third-party integrators (usdctofiat.xyz) do:
 * `requestConnection` approves the origin, `authenticate` opens the provider
 * tab inside the extension, and the captured session comes back through
 * `onMetadataMessage`.
 *
 * - Wise, PayPal, Alipay: a buyer-TEE capture (`register_<platform>`) becomes
 *   a signed identity attestation from the attestation service, bound to the
 *   wallet that will create the deposit, and the payee is registered with the
 *   curator carrying `metadata.identityAttestation`.
 * - Cash App: a seller-credential capture is uploaded to the curator.
 *
 * After either, the bare handle is registered and `prepare()` accepts it.
 */

import {
  apiPostDepositDetails,
  apiRequestIdentityAttestation,
  apiUploadSellerCredentialBundle,
  peerExtensionSdk,
  type PeerAuthenticateParams,
  type PeerBuyerTeePaymentParams,
  type PeerExtensionSdk,
  type PeerExtensionState,
  type PeerMetadataMessage,
  type PeerMetadataRow,
} from "@zkp2p/sdk";
import type { Address } from "viem";
import { PEER_API_URL, PEER_ATTESTATION_URL, PEER_EXTENSION_INSTALL_URL } from "@/config";

/** Peer's own web app, where a handle can also be registered once (desktop Chrome). */
export const PEER_WEB_URL = "https://app.peer.xyz";

export type PeerRegistrationKind = "identity" | "sellerCredential";

const IDENTITY_PLATFORMS = new Set(["wise", "paypal", "alipay"]);
const SELLER_CREDENTIAL_PLATFORMS = new Set(["cashapp"]);
/** Seller-credential capture needs PeerAuth 0.6.4+ (older versions return a buyer-TEE capture). */
const SELLER_CREDENTIAL_MIN_VERSION = "0.6.4";
/**
 * The PeerAuth version that can capture `register_<platform>` (Peer web's
 * extensionRegistration.minExtensionVersion): Wise and PayPal 0.6.3, Alipay 0.6.7.
 */
const IDENTITY_MIN_VERSION: Record<string, string> = { wise: "0.6.3", paypal: "0.6.3", alipay: "0.6.7" };

/** The minimum PeerAuth version that can register a payee on this platform, or null when it can't. */
export function peerRegistrationMinVersion(platform: string): string | null {
  const kind = peerRegistrationKind(platform);
  if (kind === "sellerCredential") return SELLER_CREDENTIAL_MIN_VERSION;
  if (kind === "identity") return Object.hasOwn(IDENTITY_MIN_VERSION, platform) ? (IDENTITY_MIN_VERSION[platform] ?? null) : null;
  return null;
}
const CAPTURE_TIMEOUT_MS = 15 * 60_000;

export function peerRegistrationKind(platform: string): PeerRegistrationKind | null {
  if (IDENTITY_PLATFORMS.has(platform)) return "identity";
  if (SELLER_CREDENTIAL_PLATFORMS.has(platform)) return "sellerCredential";
  return null;
}

/** PeerAuth is a desktop Chromium extension; phones and other browsers can never install it. */
export function canUsePeerExtension(userAgent?: string): boolean {
  const ua = userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent);
  return /Chrome|Chromium|Edg\//.test(ua) && !/Mobile|Android|iPhone|iPad/.test(ua);
}

export type PeerRegistrationPhase =
  | "idle"
  | "checkingExtension"
  | "connecting"
  | "awaitingCapture"
  | "attesting"
  | "registering"
  | "registered"
  | "failed";

export type PeerRegistrationErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "EXTENSION_MISSING"
  | "EXTENSION_OUTDATED"
  | "CONNECTION_DENIED"
  | "CAPTURE_FAILED"
  | "CAPTURE_TIMEOUT"
  | "HANDLE_MISMATCH"
  | "ATTESTATION_FAILED"
  | "REGISTRATION_FAILED"
  | "CANCELLED";

const ERROR_COPY: Record<PeerRegistrationErrorCode, string> = {
  UNSUPPORTED_PLATFORM: "This payout method doesn't need extension registration.",
  EXTENSION_MISSING: "Install the PeerAuth extension in desktop Chrome, then try again.",
  EXTENSION_OUTDATED: "Update the PeerAuth extension, then try again.",
  CONNECTION_DENIED: "Allow RampRidge in the PeerAuth prompt, then try again.",
  CAPTURE_FAILED: "PeerAuth couldn't read your account. Try again.",
  CAPTURE_TIMEOUT: "Registration timed out. Start it again when you're ready.",
  HANDLE_MISMATCH: "The account you signed in to doesn't match the handle you entered.",
  ATTESTATION_FAILED: "Peer couldn't verify your account. Try again.",
  REGISTRATION_FAILED: "Peer didn't accept the registration. Check the handle and try again.",
  CANCELLED: "Registration cancelled.",
};

export class PeerRegistrationError extends Error {
  readonly code: PeerRegistrationErrorCode;
  constructor(code: PeerRegistrationErrorCode, message?: string, cause?: unknown) {
    super(message ?? ERROR_COPY[code], cause === undefined ? undefined : { cause });
    this.name = "PeerRegistrationError";
    this.code = code;
  }
}

export interface PeerRegistrationServices {
  requestIdentityAttestation: typeof apiRequestIdentityAttestation;
  registerPayee: typeof apiPostDepositDetails;
  uploadSellerCredential: typeof apiUploadSellerCredentialBundle;
}

const DEFAULT_SERVICES: PeerRegistrationServices = {
  requestIdentityAttestation: apiRequestIdentityAttestation,
  registerPayee: apiPostDepositDetails,
  uploadSellerCredential: apiUploadSellerCredentialBundle,
};

export interface PeerRegistrationInput {
  platform: string;
  /** Normalised handle (curator offchainId), from `normalizePayee`. */
  offchainId: string;
  /** The wallet that will create the deposit. Identity attestations are bound to it. */
  callerAddress: Address;
  signal?: AbortSignal;
  onPhase?: (phase: PeerRegistrationPhase) => void;
  /** Defaults to the SDK's `window.peer` wrapper. */
  extension?: PeerExtensionSdk;
  timeoutMs?: number;
  services?: Partial<PeerRegistrationServices>;
}

export interface PeerRegistrationResult {
  platform: string;
  offchainId: string;
}

function isVersionBelow(version: string, minimum: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

function createAttemptId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isFlatParams(value: unknown): value is PeerBuyerTeePaymentParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
}

/** The identity params of the first visible captured row (PayPal's are `{}`, Wise's carry PROFILE_ID). */
export function identityParamsFrom(metadata: readonly PeerMetadataRow[] | null | undefined): PeerBuyerTeePaymentParams {
  const row = (metadata ?? []).find((r) => !r.hidden && isFlatParams(r.params));
  if (!row || !isFlatParams(row.params)) {
    throw new PeerRegistrationError("CAPTURE_FAILED", "PeerAuth didn't return your account details. Try again.");
  }
  return row.params;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new PeerRegistrationError("CANCELLED");
}

type AuthenticateWithAttempt = PeerAuthenticateParams & { captureAttemptId: string };

/**
 * Subscribes before opening the capture so no message is missed, then waits
 * for this platform's capture. window.peer never forwards captureAttemptId
 * (Peer's injectScript rebuilds the message without it), so a missing id is
 * the normal case and is accepted, as in Peer's own web app. A message that
 * does carry a different id belongs to another attempt and is ignored. The
 * checks after capture (credential platform, offchainId, attestation bound to
 * the caller, curator validation) still tie the result to this handle.
 */
function awaitCapture(
  extension: PeerExtensionSdk,
  params: AuthenticateWithAttempt,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<PeerMetadataMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (outcome: PeerMetadataMessage | PeerRegistrationError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe?.();
      if (outcome instanceof PeerRegistrationError) reject(outcome);
      else resolve(outcome);
    };
    const onAbort = () => finish(new PeerRegistrationError("CANCELLED"));
    const timer = setTimeout(() => finish(new PeerRegistrationError("CAPTURE_TIMEOUT")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      unsubscribe = extension.onMetadataMessage((message) => {
        if (message.platform !== params.platform) return;
        const echoed = (message as PeerMetadataMessage & { captureAttemptId?: unknown }).captureAttemptId;
        if (typeof echoed === "string" && echoed !== params.captureAttemptId) return;
        if (message.errorMessage) {
          finish(new PeerRegistrationError("CAPTURE_FAILED", message.errorMessage));
          return;
        }
        finish(message);
      });
      if (settled) unsubscribe();
      else extension.authenticate(params);
    } catch (err) {
      finish(new PeerRegistrationError("EXTENSION_MISSING", undefined, err));
    }
  });
}

function messageOf(err: unknown): string | undefined {
  return err instanceof Error && err.message ? err.message : undefined;
}

/**
 * Runs the whole extension registration for one handle. Resolves once the
 * curator has the payee; re-check the payee afterwards. Throws a
 * PeerRegistrationError with a player-facing message on any failure.
 */
export async function registerPayeeWithPeerExtension(input: PeerRegistrationInput): Promise<PeerRegistrationResult> {
  const kind = peerRegistrationKind(input.platform);
  if (!kind) throw new PeerRegistrationError("UNSUPPORTED_PLATFORM");
  const extension = input.extension ?? peerExtensionSdk;
  const services = { ...DEFAULT_SERVICES, ...input.services };
  const onPhase = input.onPhase ?? (() => undefined);
  const { platform, offchainId, callerAddress, signal } = input;

  throwIfAborted(signal);
  onPhase("checkingExtension");
  const state: PeerExtensionState = await extension.getState();
  if (state === "needs_install") throw new PeerRegistrationError("EXTENSION_MISSING");
  if (state === "needs_connection") {
    onPhase("connecting");
    let approved = false;
    try {
      approved = await extension.requestConnection();
    } catch (err) {
      throw new PeerRegistrationError("CONNECTION_DENIED", undefined, err);
    }
    if (!approved) throw new PeerRegistrationError("CONNECTION_DENIED");
  }
  throwIfAborted(signal);

  // An older PeerAuth can't capture this platform: ask for an update before opening anything.
  const minVersion = peerRegistrationMinVersion(platform);
  if (minVersion) {
    const version = await Promise.resolve()
      .then(() => extension.getVersion())
      .catch(() => null);
    if (typeof version === "string" && version && isVersionBelow(version, minVersion)) {
      throw new PeerRegistrationError("EXTENSION_OUTDATED", `Update the PeerAuth extension to ${minVersion} or newer, then try again.`);
    }
  }

  const params: AuthenticateWithAttempt =
    kind === "identity"
      ? {
          actionType: `register_${platform}`,
          attestationServiceUrl: PEER_ATTESTATION_URL,
          captureMode: "buyerTee",
          platform,
          captureAttemptId: createAttemptId(),
        }
      : {
          actionType: `transfer_${platform}`,
          captureMode: "sellerCredential",
          platform,
          callerAddress,
          captureAttemptId: createAttemptId(),
        };

  onPhase("awaitingCapture");
  const message = await awaitCapture(extension, params, signal, input.timeoutMs ?? CAPTURE_TIMEOUT_MS);
  throwIfAborted(signal);

  if (kind === "sellerCredential") {
    const capture = message.sarCredentialCapture;
    if (!capture?.credentialBundle) {
      throw new PeerRegistrationError("CAPTURE_FAILED", "PeerAuth didn't return a seller credential. Update it and try again.");
    }
    if (String(capture.credentialBundle.platform).toLowerCase() !== platform) {
      throw new PeerRegistrationError("CAPTURE_FAILED");
    }
    // The curator hashes the exact offchainId, so the captured handle must match what the deposit will use.
    if (capture.offchainId !== offchainId) throw new PeerRegistrationError("HANDLE_MISMATCH");
    onPhase("registering");
    let uploaded: Awaited<ReturnType<PeerRegistrationServices["uploadSellerCredential"]>>;
    try {
      uploaded = await services.uploadSellerCredential(
        { platform: "cashapp", offchainId, bundle: capture.credentialBundle },
        PEER_API_URL,
      );
    } catch (err) {
      throw new PeerRegistrationError("REGISTRATION_FAILED", messageOf(err), err);
    }
    if (!uploaded?.success) throw new PeerRegistrationError("REGISTRATION_FAILED", uploaded?.message || undefined);
    onPhase("registered");
    return { platform, offchainId };
  }

  const encryptedSessionMaterial = message.buyerTeeCapture?.encryptedSessionMaterial;
  if (!encryptedSessionMaterial) {
    throw new PeerRegistrationError("CAPTURE_FAILED", "PeerAuth didn't return a verifiable session. Try again.");
  }
  const identityParams = identityParamsFrom(message.metadata);

  onPhase("attesting");
  let attestation: Awaited<ReturnType<PeerRegistrationServices["requestIdentityAttestation"]>>;
  try {
    attestation = await services.requestIdentityAttestation(
      { callerAddress, encryptedSessionMaterial, params: identityParams },
      PEER_ATTESTATION_URL,
      platform,
      `register_${platform}`,
    );
  } catch (err) {
    throw new PeerRegistrationError("ATTESTATION_FAILED", messageOf(err), err);
  }
  if (!attestation?.success || !attestation.responseObject) {
    throw new PeerRegistrationError("ATTESTATION_FAILED", attestation?.message || undefined);
  }
  throwIfAborted(signal);

  onPhase("registering");
  let registered: Awaited<ReturnType<PeerRegistrationServices["registerPayee"]>>;
  try {
    registered = await services.registerPayee(
      { processorName: platform, offchainId, metadata: { identityAttestation: attestation.responseObject } },
      PEER_API_URL,
    );
  } catch (err) {
    throw new PeerRegistrationError("REGISTRATION_FAILED", messageOf(err), err);
  }
  if (!registered?.success) throw new PeerRegistrationError("REGISTRATION_FAILED", registered?.message || undefined);
  onPhase("registered");
  return { platform, offchainId };
}

/** Current extension state without prompting: install, approve this origin, or ready. */
export function getPeerExtensionState(extension: PeerExtensionSdk = peerExtensionSdk): Promise<PeerExtensionState> {
  return extension.getState().catch(() => "needs_install" as const);
}

/** Opens the Chrome Web Store page for PeerAuth. */
export function openPeerExtensionInstall(): void {
  if (typeof window === "undefined") return;
  window.open(PEER_EXTENSION_INSTALL_URL, "_blank", "noopener,noreferrer");
}
