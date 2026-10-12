import { describe, expect, it, vi } from "vitest";
import type { PeerAuthenticateParams, PeerExtensionSdk, PeerExtensionState, PeerMetadataMessage } from "@zkp2p/sdk";
import { PEER_API_URL, PEER_ATTESTATION_URL } from "@/config";
import {
  canUsePeerExtension,
  identityParamsFrom,
  peerRegistrationKind,
  registerPayeeWithPeerExtension,
  PeerRegistrationError,
  type PeerRegistrationPhase,
} from "../identity";
import { OWNER } from "./helpers";

type Listener = (message: PeerMetadataMessage) => void;

function fakeExtension(opts: { state?: PeerExtensionState; approve?: boolean; version?: string } = {}) {
  let listener: Listener | null = null;
  let lastParams: (PeerAuthenticateParams & { captureAttemptId?: string }) | null = null;
  const extension = {
    isAvailable: () => opts.state !== "needs_install",
    getState: vi.fn(async () => opts.state ?? "ready"),
    requestConnection: vi.fn(async () => opts.approve ?? true),
    checkConnectionStatus: vi.fn(),
    getVersion: vi.fn(async () => opts.version ?? "0.7.0"),
    openInstallPage: vi.fn(),
    authenticate: vi.fn((params: PeerAuthenticateParams) => {
      lastParams = params;
    }),
    onMetadataMessage: vi.fn((cb: Listener) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  } satisfies PeerExtensionSdk;
  return {
    extension,
    params: () => lastParams,
    emit: (message: Partial<PeerMetadataMessage> & { captureAttemptId?: string }) =>
      listener?.({ expiresAt: 0, metadata: [], platform: "wise", requestId: "r", ...message } as PeerMetadataMessage),
    subscribed: () => listener !== null,
  };
}

function services() {
  return {
    requestIdentityAttestation: vi.fn().mockResolvedValue({ success: true, message: "", statusCode: 200, responseObject: { signature: "0xsig" } }),
    registerPayee: vi.fn().mockResolvedValue({ success: true, message: "", statusCode: 200, responseObject: { hashedOnchainId: "0xhash" } }),
    uploadSellerCredential: vi.fn().mockResolvedValue({ success: true, message: "", statusCode: 200, responseObject: {} }),
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PeerRegistrationError) return err.code;
    throw err;
  }
  return "resolved";
}

describe("registerPayeeWithPeerExtension", () => {
  it("registers a new Wise payee with an identity attestation bound to the deposit wallet", async () => {
    const fake = fakeExtension({ state: "needs_connection" });
    const svc = services();
    const phases: PeerRegistrationPhase[] = [];
    const run = registerPayeeWithPeerExtension({
      platform: "wise",
      offchainId: "zezimaw",
      callerAddress: OWNER,
      extension: fake.extension,
      services: svc,
      onPhase: (p) => phases.push(p),
    });

    await vi.waitFor(() => expect(fake.params()).not.toBeNull());
    const params = fake.params()!;
    expect(fake.extension.requestConnection).toHaveBeenCalled();
    expect(params).toMatchObject({
      actionType: "register_wise",
      captureMode: "buyerTee",
      platform: "wise",
      attestationServiceUrl: PEER_ATTESTATION_URL,
    });
    // A late reply to another attempt is ignored.
    fake.emit({ captureAttemptId: "someone-else", buyerTeeCapture: { encryptedSessionMaterial: "nope" } });
    fake.emit({
      captureAttemptId: params.captureAttemptId,
      buyerTeeCapture: { encryptedSessionMaterial: "enc" },
      metadata: [
        { hidden: true, originalIndex: 0, params: { PROFILE_ID: "hidden" } },
        { hidden: false, originalIndex: 1, params: { PROFILE_ID: "123" } },
      ],
    });

    await expect(run).resolves.toEqual({ platform: "wise", offchainId: "zezimaw" });
    expect(svc.requestIdentityAttestation).toHaveBeenCalledWith(
      { callerAddress: OWNER, encryptedSessionMaterial: "enc", params: { PROFILE_ID: "123" } },
      PEER_ATTESTATION_URL,
      "wise",
      "register_wise",
    );
    expect(svc.registerPayee).toHaveBeenCalledWith(
      { processorName: "wise", offchainId: "zezimaw", metadata: { identityAttestation: { signature: "0xsig" } } },
      PEER_API_URL,
    );
    expect(phases).toEqual(["checkingExtension", "connecting", "awaitingCapture", "attesting", "registering", "registered"]);
    expect(fake.subscribed()).toBe(false);
  });

  it("uploads a Cash App seller credential and rejects a different cashtag", async () => {
    const fake = fakeExtension();
    const svc = services();
    const run = registerPayeeWithPeerExtension({
      platform: "cashapp",
      offchainId: "zezima",
      callerAddress: OWNER,
      extension: fake.extension,
      services: svc,
    });
    await vi.waitFor(() => expect(fake.params()).not.toBeNull());
    expect(fake.params()).toMatchObject({ actionType: "transfer_cashapp", captureMode: "sellerCredential", callerAddress: OWNER });
    const bundle = { platform: "cashapp" } as never;
    fake.emit({ platform: "cashapp", captureAttemptId: fake.params()!.captureAttemptId, sarCredentialCapture: { credentialBundle: bundle, offchainId: "zezima" } });
    await expect(run).resolves.toEqual({ platform: "cashapp", offchainId: "zezima" });
    expect(svc.uploadSellerCredential).toHaveBeenCalledWith({ platform: "cashapp", offchainId: "zezima", bundle }, PEER_API_URL);

    const mismatch = registerPayeeWithPeerExtension({ platform: "cashapp", offchainId: "zezima", callerAddress: OWNER, extension: fake.extension, services: svc });
    await vi.waitFor(() => expect(fake.subscribed()).toBe(true));
    fake.emit({ platform: "cashapp", captureAttemptId: fake.params()!.captureAttemptId, sarCredentialCapture: { credentialBundle: bundle, offchainId: "someoneelse" } });
    expect(await code(mismatch)).toBe("HANDLE_MISMATCH");
  });

  it("explains a missing, unapproved or outdated extension", async () => {
    const base = { platform: "wise", offchainId: "a", callerAddress: OWNER, services: services() };
    expect(await code(registerPayeeWithPeerExtension({ ...base, extension: fakeExtension({ state: "needs_install" }).extension }))).toBe("EXTENSION_MISSING");
    expect(
      await code(registerPayeeWithPeerExtension({ ...base, extension: fakeExtension({ state: "needs_connection", approve: false }).extension })),
    ).toBe("CONNECTION_DENIED");
    expect(
      await code(registerPayeeWithPeerExtension({ ...base, platform: "cashapp", extension: fakeExtension({ version: "0.6.3" }).extension })),
    ).toBe("EXTENSION_OUTDATED");
    expect(await code(registerPayeeWithPeerExtension({ ...base, platform: "revolut", extension: fakeExtension().extension }))).toBe(
      "UNSUPPORTED_PLATFORM",
    );
  });

  it("accepts a capture without an echoed attempt id (window.peer never forwards it), and surfaces capture errors", async () => {
    const fake = fakeExtension();
    const unechoed = registerPayeeWithPeerExtension({ platform: "wise", offchainId: "a", callerAddress: OWNER, extension: fake.extension, services: services() });
    await vi.waitFor(() => expect(fake.subscribed()).toBe(true));
    fake.emit({ buyerTeeCapture: { encryptedSessionMaterial: "enc" }, metadata: [{ hidden: false, originalIndex: 0, params: { PROFILE_ID: "1" } }] });
    expect(await code(unechoed)).toBe("resolved");

    const failed = registerPayeeWithPeerExtension({ platform: "wise", offchainId: "a", callerAddress: OWNER, extension: fake.extension, services: services() });
    await vi.waitFor(() => expect(fake.subscribed()).toBe(true));
    fake.emit({ errorMessage: "Login cancelled" });
    await expect(failed).rejects.toMatchObject({ code: "CAPTURE_FAILED", message: "Login cancelled" });
  });

  it("maps attestation and curator rejections, and supports cancel and timeout", async () => {
    const fake = fakeExtension();
    const svc = services();
    svc.requestIdentityAttestation.mockResolvedValueOnce({ success: false, message: "Profile mismatch", statusCode: 400, responseObject: null });
    const attest = registerPayeeWithPeerExtension({ platform: "paypal", offchainId: "a", callerAddress: OWNER, extension: fake.extension, services: svc });
    await vi.waitFor(() => expect(fake.subscribed()).toBe(true));
    fake.emit({ platform: "paypal", captureAttemptId: fake.params()!.captureAttemptId, buyerTeeCapture: { encryptedSessionMaterial: "e" }, metadata: [{ hidden: false, originalIndex: 0, params: {} }] });
    await expect(attest).rejects.toMatchObject({ code: "ATTESTATION_FAILED", message: "Profile mismatch" });

    const controller = new AbortController();
    const cancelled = registerPayeeWithPeerExtension({ platform: "wise", offchainId: "a", callerAddress: OWNER, extension: fake.extension, services: svc, signal: controller.signal });
    await vi.waitFor(() => expect(fake.subscribed()).toBe(true));
    controller.abort();
    expect(await code(cancelled)).toBe("CANCELLED");

    const timedOut = registerPayeeWithPeerExtension({ platform: "wise", offchainId: "a", callerAddress: OWNER, extension: fake.extension, services: svc, timeoutMs: 5 });
    expect(await code(timedOut)).toBe("CAPTURE_TIMEOUT");
  });
});

describe("registration helpers", () => {
  it("knows which rails register through the extension", () => {
    expect(peerRegistrationKind("wise")).toBe("identity");
    expect(peerRegistrationKind("paypal")).toBe("identity");
    expect(peerRegistrationKind("cashapp")).toBe("sellerCredential");
    expect(peerRegistrationKind("venmo")).toBeNull();
  });

  it("detects desktop Chromium", () => {
    expect(canUsePeerExtension("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36")).toBe(true);
    expect(canUsePeerExtension("Mozilla/5.0 (iPhone) AppleWebKit Version/18.0 Mobile Safari")).toBe(false);
    expect(canUsePeerExtension("Mozilla/5.0 (Linux; Android 14) Chrome/141.0 Mobile Safari/537.36")).toBe(false);
  });

  it("requires visible identity params", () => {
    expect(identityParamsFrom([{ hidden: false, originalIndex: 0, params: {} }])).toEqual({});
    expect(() => identityParamsFrom([{ hidden: true, originalIndex: 0, params: {} }])).toThrow(PeerRegistrationError);
  });
});
