import type { PeerExtensionSdk, PeerMetadataMessage, PeerMetadataMessageCallback, PeerMetadataRow } from "@zkp2p/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  buildBuyerTeeProof,
  buyerCaptureParams,
  canInstallPeerExtension,
  captureFailureText,
  extensionBrowser,
  getExtensionStatus,
  isExtensionVersionBelow,
  openExtensionInstallPage,
  ProofError,
  selectableRows,
  startBuyerCapture,
} from "../../extension";
import { resolveVerifyMethod } from "../../platforms";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

function message(rows: PeerMetadataRow[], platform = "venmo", session = "enc-session"): PeerMetadataMessage {
  return {
    metadata: rows,
    platform,
    requestId: "req-1",
    expiresAt: Date.now() + 300_000,
    buyerTeeCapture: session ? { encryptedSessionMaterial: session } : null,
  };
}

function row(index: number, extra: Partial<PeerMetadataRow> = {}): PeerMetadataRow {
  return { hidden: true, originalIndex: index, params: { PAYMENT_ID: `p${index}` }, ...extra };
}

function fakeExtension(overrides: Partial<PeerExtensionSdk> = {}) {
  const listeners = new Set<PeerMetadataMessageCallback>();
  const sdk: PeerExtensionSdk = {
    isAvailable: () => true,
    getState: async () => "ready",
    checkConnectionStatus: async () => "connected",
    requestConnection: async () => true,
    getVersion: async () => "0.7.2",
    authenticate: vi.fn(),
    onMetadataMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    openInstallPage: vi.fn(),
    ...overrides,
  };
  return { sdk, listeners, emit: (m: PeerMetadataMessage) => [...listeners].forEach((cb) => cb(m)) };
}

describe("extension status", () => {
  it("only offers install on desktop Chromium", () => {
    expect(canInstallPeerExtension(CHROME_MAC)).toBe(true);
    expect(canInstallPeerExtension("Mozilla/5.0 (Android 14; Mobile) Chrome/141.0 Mobile Safari/537.36")).toBe(false);
    expect(canInstallPeerExtension("Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/131.0")).toBe(false);
    expect(canInstallPeerExtension("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1")).toBe(false);
  });

  it("maps availability and connection", async () => {
    expect(await getExtensionStatus(fakeExtension({ isAvailable: () => false }).sdk, { canInstall: true })).toBe(
      "needs_install",
    );
    expect(await getExtensionStatus(fakeExtension({ isAvailable: () => false }).sdk, { canInstall: false })).toBe(
      "unsupported_browser",
    );
    expect(await getExtensionStatus(fakeExtension({ getState: async () => "needs_connection" }).sdk)).toBe(
      "needs_connection",
    );
    expect(await getExtensionStatus(fakeExtension().sdk)).toBe("ready");
  });

  it("asks for an update below Peer's minimum build for the platform, and lets an unreadable version through", async () => {
    const at = (getVersion: PeerExtensionSdk["getVersion"]) => fakeExtension({ getVersion }).sdk;
    expect(await getExtensionStatus(at(async () => "0.7.1"), { platform: "monobank" })).toBe("needs_update");
    expect(await getExtensionStatus(at(async () => "0.7.2"), { platform: "monobank" })).toBe("ready");
    expect(await getExtensionStatus(at(async () => "0.7.0"), { platform: "xmoney" })).toBe("needs_update");
    expect(await getExtensionStatus(at(async () => "0.6.2"), { platform: "revolut" })).toBe("needs_update");
    expect(await getExtensionStatus(at(async () => "0.6.3"), { platform: "revolut" })).toBe("ready");
    expect(await getExtensionStatus(at(async () => "dev"), { platform: "monobank" })).toBe("ready");
    expect(
      await getExtensionStatus(
        at(async () => {
          throw new Error("Timeout");
        }),
        { platform: "monobank" },
      ),
    ).toBe("ready");
    // The extension answers its version to any page, so an old build is flagged before it is connected
    // (Peer web checks the version before "Sign in"); a current one still asks for the connection.
    expect(await getExtensionStatus(fakeExtension({ getState: async () => "needs_connection", getVersion: async () => "0.1.0" }).sdk, { platform: "venmo" })).toBe(
      "needs_update",
    );
    expect(await getExtensionStatus(fakeExtension({ getState: async () => "needs_connection" }).sdk, { platform: "venmo" })).toBe("needs_connection");
    // Without a platform there is no minimum to compare with.
    expect(await getExtensionStatus(fakeExtension({ getState: async () => "needs_connection", getVersion: async () => "0.1.0" }).sdk)).toBe("needs_connection");
    expect(isExtensionVersionBelow("0.7.1.25", "0.7.1")).toBe(false);
    expect(isExtensionVersionBelow("v0.6.2", "0.6.3")).toBe(true);
  });
});

describe("capture", () => {
  it("authenticates in buyer TEE mode without providerConfig", () => {
    const params = buyerCaptureParams(resolveVerifyMethod("zelle", "bofa")!);
    expect(params).toEqual({
      actionType: "transfer_zelle_bofa",
      platform: "zelle",
      attestationActionType: "transfer_zelle_bofa",
      attestationPlatform: "zelle",
      attestationServiceUrl: "https://attestation-service.zkp2p.xyz",
      captureMode: "buyerTee",
    });
    expect(params).not.toHaveProperty("providerConfig");
  });

  it("delivers one matching message then unsubscribes, idempotently", () => {
    const ext = fakeExtension();
    const onMessage = vi.fn();
    const stop = startBuyerCapture({ method: resolveVerifyMethod("venmo")!, onMessage, sdk: ext.sdk });
    expect(ext.sdk.authenticate).toHaveBeenCalledOnce();
    ext.emit(message([row(0)], "revolut"));
    expect(onMessage).not.toHaveBeenCalled();
    ext.emit(message([row(0)], "venmo"));
    ext.emit(message([row(1)], "venmo"));
    expect(onMessage).toHaveBeenCalledOnce();
    expect(ext.listeners.size).toBe(0);
    stop();
    stop();
  });

  it("keeps listening past an error from an abandoned tab, and ignores seller-credential captures", () => {
    const ext = fakeExtension();
    const onMessage = vi.fn();
    startBuyerCapture({ method: resolveVerifyMethod("revolut")!, onMessage, sdk: ext.sdk });
    ext.emit({ ...message([], "revolut", ""), errorMessage: "Provider authentication was cancelled." });
    ext.emit({ ...message([], "revolut", ""), sarCredentialCapture: { encryptedSessionMaterial: "seller" } } as never);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(ext.listeners.size).toBe(1);
    ext.emit(message([row(0)], "revolut"));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(ext.listeners.size).toBe(0);
  });

  it("removes the listener when authenticate throws", () => {
    const ext = fakeExtension({
      authenticate: () => {
        throw new Error("bridge missing");
      },
    });
    expect(() => startBuyerCapture({ method: resolveVerifyMethod("wise")!, onMessage: vi.fn(), sdk: ext.sdk })).toThrow();
    expect(ext.listeners.size).toBe(0);
  });
});

describe("selectable rows", () => {
  it("keeps hidden rows with params and only Venmo payments sent", () => {
    const rows = selectableRows(
      message([
        row(0, { amount: "- $25.00", recipient: "alice" }),
        row(1, { amount: "+ $10.00", recipient: "bob" }),
        { hidden: false, originalIndex: 2, amount: "- $5.00" },
      ]),
      "venmo",
    );
    expect(rows.map((r) => r.index)).toEqual([0]);
    expect(rows[0]).toMatchObject({ amount: "25.00", recipient: "alice", currency: "USD", sent: true });
  });

  it("requires COMPLETED outgoing Revolut rows and never falls back", () => {
    const msg = message(
      [
        row(0, { amount: "-10150", currency: "GBP", state: "COMPLETED", recipient: "<b>Sam</b>" }),
        row(1, { amount: "-500", currency: "GBP", state: "PENDING" }),
        row(2, { amount: "2000", currency: "GBP", state: "COMPLETED" }),
      ],
      "revolut",
    );
    const rows = selectableRows(msg, "revolut");
    expect(rows.map((r) => r.index)).toEqual([0]);
    expect(rows[0]).toMatchObject({ amount: "101.5", recipient: "Sam" });
    expect(selectableRows(message([row(1, { amount: "-500", state: "PENDING" })], "revolut"), "revolut")).toEqual([]);
  });

  it("falls back to every row with params when nothing looks sent on lenient platforms", () => {
    const rows = selectableRows(message([row(0, { amount: "+ $3.00" }), row(1, { amount: "+ $4.00" })]), "venmo");
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
  });

  it("lists Monzo newest first, as Peer does", () => {
    const monzo = message(
      [
        row(0, { amount: "-2000", recipientName: "Sam" }),
        row(1, { amount: "1500", recipientName: "Kim" }),
        row(2, { amount: "-2000", recipientName: "Sam" }),
      ],
      "monzo",
    );
    expect(selectableRows(monzo, "monzo").map((r) => r.index)).toEqual([2, 0]);
  });

  it("reads localized PayPal amounts without the sign", () => {
    const pp = (amount: string) =>
      selectableRows(message([row(0, { amount, type: "SEND_MONEY_SENT", recipient: "a@b.c" })], "paypal"), "paypal")[0]?.amount;
    expect(pp("-$101.50")).toBe("101.50");
    expect(pp("1.234,50 €")).toBe("1234.50");
    expect(pp("10,00 €")).toBe("10.00");
    expect(pp("$1,234.50 USD")).toBe("1234.50");
  });

  it("reads Cash App cents and X Money micros", () => {
    expect(selectableRows(message([row(0, { amount: "2550", recipient: "$x" })], "cashapp"), "cashapp")[0]?.amount).toBe(
      "25.5",
    );
    const x = selectableRows(
      message([row(0, { amount: "12340000", currency: "usd", direction: "Debit", date: "1760000000000" })], "xmoney"),
      "xmoney",
    );
    expect(x[0]).toMatchObject({ amount: "12.34", currency: "USD", sent: true });
  });
});

describe("capture failure text", () => {
  it("names the fix Peer's web app names, and otherwise shows the extension's reason", () => {
    expect(captureFailureText("Capture failed: Attestation timestamp skew exceeds 300000ms", "Revolut")).toMatch(/clock/);
    expect(captureFailureText("Unable to open provider authentication tab.", "Revolut")).toMatch(/Reload this page/);
    expect(captureFailureText("Provider authentication was cancelled.", "Revolut")).toMatch(/tab closed/);
    expect(captureFailureText("Expected status 2xx, got 401", "Venmo")).toMatch(/login expired/);
    expect(captureFailureText("Something odd.", "Wise")).toBe("The Peer extension couldn't read your Wise payments: Something odd. Check again.");
    expect(captureFailureText(undefined, "Wise")).toMatch(/Log in to Wise/);
  });
});

describe("buyer TEE proof", () => {
  const capture = message([row(3, { amount: "- $25.00" })]);

  it("adds the row index for index-located platforms", () => {
    for (const platform of ["venmo", "cashapp", "revolut"] as const) {
      const proof = buildBuyerTeeProof(capture, platform, row(3));
      expect(proof.params).toEqual({ PAYMENT_ID: "p3", index: 3 });
      expect(proof.proofType).toBe("buyerTee");
      expect(proof.encryptedSessionMaterial).toBe("enc-session");
    }
  });

  it("does not add an index for id-located platforms", () => {
    for (const platform of ["wise", "paypal", "monzo", "chime", "mercadopago", "monobank", "xmoney"] as const) {
      expect(buildBuyerTeeProof(capture, platform, row(3)).params, platform).toEqual({ PAYMENT_ID: "p3" });
    }
  });

  it("routes Zelle through the bank's generic action and refuses without a bank", () => {
    const proof = buildBuyerTeeProof(capture, "zelle", row(3), resolveVerifyMethod("zelle", "chase"));
    expect(proof).toMatchObject({ actionPlatform: "zelle", actionType: "transfer_zelle_chase", params: { index: 3 } });
    expect(() => buildBuyerTeeProof(capture, "zelle", row(3), null)).toThrow(ProofError);
  });

  it("uses the business PayPal route when chosen", () => {
    const proof = buildBuyerTeeProof(capture, "paypal", row(3), resolveVerifyMethod("paypal", "business"));
    expect(proof).toMatchObject({ actionPlatform: "paypal", actionType: "transfer_business_paypal" });
  });

  it("rejects missing session material, params or a foreign method", () => {
    expect(() => buildBuyerTeeProof(message([], "venmo", ""), "venmo", row(1))).toThrow(ProofError);
    expect(() => buildBuyerTeeProof(capture, "venmo", { hidden: false, originalIndex: 1 })).toThrow(ProofError);
    expect(() => buildBuyerTeeProof(capture, "venmo", row(1), resolveVerifyMethod("wise"))).toThrow(ProofError);
  });
});

describe("installing the extension", () => {
  it("opens PeerAuth's Chrome Web Store page from config in a new tab", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    try {
      openExtensionInstallPage();
      expect(open).toHaveBeenCalledWith(
        "https://chromewebstore.google.com/detail/peerauth-authenticate-and/ijpgccednehjpeclfcllnjjcmiohdjih",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names the browser the install button adds it to", () => {
    expect(extensionBrowser(CHROME_MAC, false)).toBe("chrome");
    // Brave sends Chrome's user agent; navigator.brave tells it apart.
    expect(extensionBrowser(CHROME_MAC, true)).toBe("brave");
    expect(extensionBrowser(`${CHROME_MAC} Edg/141.0`, false)).toBe("other");
    expect(extensionBrowser(`${CHROME_MAC} OPR/120.0`, false)).toBe("other");
  });
});
