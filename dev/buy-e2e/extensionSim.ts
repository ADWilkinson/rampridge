/**
 * A simulated Peer browser extension for the fork e2e, built to the real
 * extension's contracts (zkp2p-clients clients/extension at origin/main):
 *
 * - Page API (`window.peer`), as Content/injectScript.ts defines it:
 *   requestConnection, checkConnectionStatus, getVersion, authenticate,
 *   onMetadataMessage, talking to the content script over window.postMessage
 *   with the PageToContentAction / ContentToPageAction message types and
 *   payload shapes of utils/types/messages/{pageToContent,contentToPage}.ts.
 * - Content script + background, simulated in-page: connection approval
 *   (Content/index.ts), `open_new_tab` with captureMode "buyerTee"
 *   (Background/buyerTeeFlow.ts resolveBuyerTeeCaptureConfig: trusted
 *   attestation origins only), the provider template's transactionsExtraction
 *   for Revolut (Curator /providers/revolut/transfer_revolut.json), rows built
 *   like utils/offscreenHelpers.ts toMetadataMessage + buyerTeeCapture.ts
 *   (params {} on every row), session material encrypted with the real
 *   @zkp2p/zkp2p-attestation encryptBuyerTeeSessionMaterial to the mock
 *   enclave key, and the metadata message posted with expiresAt now + 5 min
 *   (Background/index.ts sendMetadataToOriginalTab).
 *
 * The "provider tab" is the fake Revolut account served by the dev server.
 * Like Chrome, installing the extension does not inject `window.peer` into a
 * page that is already open: only a page loaded with the extension present
 * gets it.
 */

import { encryptBuyerTeeSessionMaterial } from "@zkp2p/zkp2p-attestation";

export type ExtensionMode =
  /** Not installed: no window.peer. */
  | "missing"
  /** Installed and already approved for this site. */
  | "ready"
  /** Installed, not yet approved; approves when asked. */
  | "needs_connection"
  /** Installed, not yet approved; the player declines when asked. */
  | "decline"
  /** An old build from before buyer TEE capture: returns rows but no session capture. */
  | "outdated"
  /**
   * Up to date, but the computer's clock is off: the enclave attestation
   * freshness check in @zkp2p/zkp2p-attestation fails while staging the
   * capture, so the rows are suppressed and the error is posted instead.
   */
  | "clock_skew";

export interface ExtensionSimOptions {
  mode: ExtensionMode;
  version: string;
  /** Delay before the "provider tab" capture answers (the player logging in). */
  captureDelayMs: number;
  /** The player's Revolut session cookie (one fake Revolut account per buyer). */
  revolutCookie: string;
  /** The page clock (the harness can run it ahead for expiry). */
  now: () => number;
}

export interface ExtensionSimHandle {
  options: ExtensionSimOptions;
  /** Every page -> content message seen, for assertions. */
  received: Array<{ type: string; [key: string]: unknown }>;
  /** Every metadata message posted to the page. */
  posted: unknown[];
  /** Changes how later requests behave (e.g. ready -> outdated) without reinstalling the page API. */
  setMode(mode: ExtensionMode): void;
}

const PageToContentAction = {
  CHECK_CONNECTION_STATUS: "check_connection_status",
  FETCH_EXTENSION_VERSION: "fetch_extension_version",
  OPEN_NEW_TAB: "open_new_tab",
  REQUEST_PEER_CONNECTION: "request_peer_connection",
} as const;

const ContentToPageAction = {
  CONNECTION_APPROVAL_RESPONSE: "connection_approval_response",
  CONNECTION_STATUS_RESPONSE: "connection_status_response",
  EXTENSION_VERSION_RESPONSE: "extension_version_response",
  METADATA_MESSAGES_RESPONSE: "metadata_messages_response",
} as const;

const TRUSTED_ATTESTATION_ORIGINS = new Set(["https://attestation-service.zkp2p.xyz", "https://attestation-service-staging.zkp2p.xyz"]);

/** Curator /providers/revolut/transfer_revolut.json metadata.transactionsExtraction.transactionJsonPathSelectors. */
const REVOLUT_SELECTORS: Record<string, string[]> = {
  recipient: ["recipient", "username"],
  amount: ["amount"],
  date: ["completedDate"],
  paymentId: ["id"],
  currency: ["currency"],
  state: ["state"],
  type: ["type"],
};

type Row = Record<string, unknown> & { hidden: boolean; originalIndex: number; params?: Record<string, string | number | boolean> };

function pick(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function randomId(): string {
  return crypto.randomUUID();
}

/** resolveTrustedAttestationServiceUrl from the extension. */
function trustedAttestationOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Attestation service URL is invalid.");
  }
  if (!TRUSTED_ATTESTATION_ORIGINS.has(url.origin) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("Attestation service URL must use a trusted ZKP2P endpoint.");
  }
  return url.origin;
}

export function installPeerExtensionSim(options: ExtensionSimOptions): ExtensionSimHandle {
  const handle: ExtensionSimHandle = {
    options,
    received: [],
    posted: [],
    setMode(mode) {
      options.mode = mode;
    },
  };
  if (options.mode === "missing") return handle;

  let connection: "connected" | "disconnected" | "pending" = options.mode === "needs_connection" || options.mode === "decline" ? "disconnected" : "connected";

  const postToPage = (message: Record<string, unknown>) => {
    if (message.type === ContentToPageAction.METADATA_MESSAGES_RESPONSE) handle.posted.push(message);
    window.postMessage(message, "*");
  };

  const postMetadataError = (platform: string, errorMessage: string) =>
    postToPage({
      type: ContentToPageAction.METADATA_MESSAGES_RESPONSE,
      status: "loaded",
      requestId: "",
      platform,
      metadata: [],
      expiresAt: options.now(),
      errorMessage,
    });

  const requestApproval = async (): Promise<boolean> => {
    if (connection === "connected") return true;
    connection = "pending";
    await new Promise((r) => setTimeout(r, 400));
    const approved = options.mode !== "decline";
    connection = approved ? "connected" : "disconnected";
    return approved;
  };

  /** The extension's provider tab: replay the transactions request, extract rows, stage the buyer TEE capture. */
  const capture = async (payload: Record<string, unknown>) => {
    const platform = String(payload.platform ?? "");
    const actionType = String(payload.actionType ?? "");
    if (platform !== "revolut" || actionType !== "transfer_revolut") {
      postMetadataError(platform, `The e2e extension only simulates Revolut (got ${platform}/${actionType}).`);
      return;
    }
    await new Promise((r) => setTimeout(r, options.captureDelayMs));
    const response = await fetch("/__e2e/revolut/transactions", { headers: { "x-e2e-revolut-cookie": options.revolutCookie } });
    if (!response.ok) {
      postMetadataError(platform, "Unable to read Revolut transactions.");
      return;
    }
    const list = (await response.json()) as unknown[];
    const outdated = options.mode === "outdated";
    const rows: Row[] = list.map((tx, originalIndex) => {
      const fields: Record<string, unknown> = {};
      for (const [name, path] of Object.entries(REVOLUT_SELECTORS)) fields[name] = pick(tx, path);
      const hidden = Object.values(fields).some((v) => v === undefined || v === null);
      // Pre-TEE builds sent rows without per-row params; buyerTeeCapture.ts gives every row params {}.
      return outdated ? { ...fields, hidden, originalIndex } : { ...fields, hidden, originalIndex, params: {} };
    });
    const requestId = randomId();
    if (outdated) {
      postToPage({
        type: ContentToPageAction.METADATA_MESSAGES_RESPONSE,
        status: "loaded",
        requestId,
        platform,
        metadata: rows,
        expiresAt: options.now() + 5 * 60 * 1000,
      });
      return;
    }
    let encryptedSessionMaterial: string;
    try {
      if (options.mode === "clock_skew") throw new Error("Attestation timestamp skew exceeds 300000ms");
      const key = (await (await fetch("/__e2e/attest/enclave-key")).json()) as { publicKeyDerB64: string; publicKeySha256Hex: string };
      encryptedSessionMaterial = await encryptBuyerTeeSessionMaterial({
        key: { publicKeyDer: base64ToBytes(key.publicKeyDerB64), publicKeySha256Hex: key.publicKeySha256Hex },
        platform: "revolut",
        actionType: "transfer_revolut",
        sessionMaterial: {
          Cookie: options.revolutCookie,
          "x-device-id": `e2e-device-${options.revolutCookie.slice(2, 10)}`,
          url: "https://app.revolut.com/api/retail/user/current/transactions/last?count=20",
        },
      } as Parameters<typeof encryptBuyerTeeSessionMaterial>[0]);
    } catch (error) {
      // stageBuyerTeeCaptureForMetadata: a capture failure suppresses the rows and reports the error.
      postToPage({
        type: ContentToPageAction.METADATA_MESSAGES_RESPONSE,
        status: "loaded",
        requestId,
        platform,
        metadata: [],
        expiresAt: options.now() + 5 * 60 * 1000,
        errorMessage: error instanceof Error ? error.message : "Session capture failed.",
      });
      return;
    }
    postToPage({
      type: ContentToPageAction.METADATA_MESSAGES_RESPONSE,
      status: "loaded",
      requestId,
      platform,
      metadata: rows,
      expiresAt: options.now() + 5 * 60 * 1000,
      buyerTeeCapture: { encryptedSessionMaterial },
    });
  };

  // ---- content script (Content/index.ts handlePageMessage) ----
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data as { type?: string } & Record<string, unknown>;
    if (!data || typeof data.type !== "string") return;
    if (!(Object.values(PageToContentAction) as string[]).includes(data.type)) return;
    handle.received.push({ ...data, type: data.type });
    void (async () => {
      switch (data.type) {
        case PageToContentAction.REQUEST_PEER_CONNECTION: {
          const approved = await requestApproval();
          postToPage({ type: ContentToPageAction.CONNECTION_APPROVAL_RESPONSE, approved, origin: window.location.origin });
          return;
        }
        case PageToContentAction.CHECK_CONNECTION_STATUS:
          postToPage({ type: ContentToPageAction.CONNECTION_STATUS_RESPONSE, origin: window.location.origin, status: connection });
          return;
        case PageToContentAction.FETCH_EXTENSION_VERSION:
          postToPage({ type: ContentToPageAction.EXTENSION_VERSION_RESPONSE, status: "loaded", version: options.version });
          return;
        case PageToContentAction.OPEN_NEW_TAB: {
          const platform = String(data.platform ?? "");
          if (connection !== "connected" && !(await requestApproval())) {
            postMetadataError(platform, "Peer extension connection required.");
            return;
          }
          if (options.mode !== "outdated" && data.captureMode === "buyerTee") {
            try {
              if (!trustedAttestationOrigin(data.attestationServiceUrl)) throw new Error("Session capture requires an attestation service URL.");
            } catch (error) {
              postMetadataError(platform, error instanceof Error ? error.message : "Attestation service URL is invalid.");
              return;
            }
          }
          await capture(data);
          return;
        }
      }
    })();
  });

  // ---- page API (Content/injectScript.ts) ----
  const sendMessageWithResponse = <T>(message: Record<string, unknown>, responseType: string, timeout = 30_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", handler);
        reject(new Error(`Timeout waiting for ${responseType}`));
      }, timeout);
      const handler = (event: MessageEvent) => {
        if (event.source !== window) return;
        if ((event.data as { type?: string })?.type === responseType) {
          clearTimeout(timer);
          window.removeEventListener("message", handler);
          resolve(event.data as T);
        }
      };
      window.addEventListener("message", handler);
      window.postMessage(message, "*");
    });

  const listeners = new Set<(data: unknown) => void>();
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const d = event.data as Record<string, unknown>;
    if (d?.type !== ContentToPageAction.METADATA_MESSAGES_RESPONSE) return;
    const message = {
      requestId: d.requestId,
      metadata: d.metadata,
      platform: d.platform,
      expiresAt: d.expiresAt,
      errorMessage: d.errorMessage,
      buyerTeeCapture: d.buyerTeeCapture,
      sarCredentialCapture: d.sarCredentialCapture,
    };
    listeners.forEach((cb) => {
      try {
        cb(message);
      } catch {
        // injectScript swallows listener errors.
      }
    });
  });

  const peer = {
    async requestConnection(): Promise<boolean> {
      const r = await sendMessageWithResponse<{ approved: boolean }>({ type: PageToContentAction.REQUEST_PEER_CONNECTION }, ContentToPageAction.CONNECTION_APPROVAL_RESPONSE);
      return r.approved;
    },
    async checkConnectionStatus() {
      const r = await sendMessageWithResponse<{ status: "connected" | "disconnected" | "pending" }>(
        { type: PageToContentAction.CHECK_CONNECTION_STATUS },
        ContentToPageAction.CONNECTION_STATUS_RESPONSE,
      );
      return r.status;
    },
    async getVersion(): Promise<string> {
      const r = await sendMessageWithResponse<{ version: string }>({ type: PageToContentAction.FETCH_EXTENSION_VERSION }, ContentToPageAction.EXTENSION_VERSION_RESPONSE);
      return r.version;
    },
    authenticate(params: Record<string, unknown>): void {
      window.postMessage({ type: PageToContentAction.OPEN_NEW_TAB, ...params }, "*");
    },
    onMetadataMessage(callback: (data: unknown) => void): () => void {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  Object.defineProperty(window, "peer", { value: peer, writable: false, configurable: false });
  window.dispatchEvent(new Event("peer#initialized"));
  document.documentElement.setAttribute("data-peer-injected", "true");
  return handle;
}
