import { describe, expect, it } from "vitest";
import { RECOMMENDED_MIN_CASHOUT_AMOUNT } from "@zkp2p/cash";
import { APIError } from "@zkp2p/sdk";
import { checkPayee } from "../validatePayee";
import { cashError, hash, mockCashClient, plan } from "./helpers";

const registrationFailed = (message: string, status?: number) =>
  cashError("PAYEE_REGISTRATION_FAILED", status === undefined ? new Error(message) : new APIError(message, status), true);

describe("checkPayee", () => {
  it("returns valid with the curator hash and checks with a fixed amount", async () => {
    const client = mockCashClient();
    client.prepare.mockResolvedValue(plan());
    const result = await checkPayee(client, {
      platform: "revolut",
      currencies: ["GBP", "EUR"],
      payee: "@zezima1abc",
      requiresIdentityAttestation: false,
    });
    expect(result).toEqual({ kind: "valid", offchainId: "zezima1abc", payeeHash: hash(99), confirmed: true });
    expect(client.prepare).toHaveBeenCalledWith({
      amount: RECOMMENDED_MIN_CASHOUT_AMOUNT,
      receive: { platform: "revolut", currency: "GBP", payee: "zezima1abc" },
    });
  });

  it("confirms a handle only where Peer proves the account exists", async () => {
    const client = mockCashClient();
    client.prepare.mockResolvedValue(plan());
    const check = (platform: string, currency: "USD" | "GBP" | "EUR" | "INR" | "CNY", payee: string, requiresIdentityAttestation = false) =>
      checkPayee(client, { platform, currencies: [currency], payee, requiresIdentityAttestation });

    // Live-validated: the curator looked the account up.
    for (const [platform, currency, payee] of [
      ["venmo", "USD", "zezima"],
      ["cashapp", "USD", "$zezima"],
      ["revolut", "GBP", "zezima1abc"],
      ["monzo", "GBP", "zezima"],
    ] as const) {
      expect(await check(platform, currency, payee)).toMatchObject({ kind: "valid", confirmed: true });
    }
    // Identity-attested: only an attested account registers.
    expect(await check("wise", "EUR", "zezimaw", true)).toMatchObject({ kind: "valid", confirmed: true });
    expect(await check("paypal", "USD", "zezima", true)).toMatchObject({ kind: "valid", confirmed: true });
    expect(await check("alipay", "CNY", "zezima@example.com", true)).toMatchObject({ kind: "valid", confirmed: true });
    // Accepted as typed: a typo that belongs to someone else would pass.
    expect(await check("zelle", "USD", "zezima@example.com")).toMatchObject({ kind: "valid", confirmed: false });
    expect(await check("zelle", "USD", "+1 (415) 555-0100")).toMatchObject({ kind: "valid", confirmed: false });
    expect(await check("chime", "USD", "$zezima")).toMatchObject({ kind: "valid", confirmed: false });
    expect(await check("upi", "INR", "zezima@okhdfc")).toMatchObject({ kind: "valid", confirmed: false });
    expect(await check("xmoney", "USD", "@zezima")).toMatchObject({ kind: "valid", confirmed: false });
  });

  it("never calls the curator for an impossible handle", async () => {
    const client = mockCashClient();
    const result = await checkPayee(client, { platform: "revolut", currencies: ["GBP"], payee: "bad tag", requiresIdentityAttestation: false });
    expect(result.kind).toBe("invalidFormat");
    expect(client.prepare).not.toHaveBeenCalled();
  });

  it("maps PAYEE_VERIFICATION_REQUIRED to needsIdentityAttestation", async () => {
    const client = mockCashClient();
    client.prepare.mockRejectedValue(cashError("PAYEE_VERIFICATION_REQUIRED"));
    const result = await checkPayee(client, { platform: "wise", currencies: ["EUR"], payee: "zezimaw", requiresIdentityAttestation: true });
    expect(result).toMatchObject({ kind: "needsIdentityAttestation", offchainId: "zezimaw", registration: "peerExtensionIdentity" });
  });

  it("maps a curator 404 on a live-validated rail to notFound", async () => {
    const client = mockCashClient();
    client.prepare.mockRejectedValue(registrationFailed("User not found", 404));
    const venmo = await checkPayee(client, { platform: "venmo", currencies: ["USD"], payee: "@ghost", requiresIdentityAttestation: false });
    expect(venmo).toMatchObject({ kind: "notFound", offchainId: "ghost", registration: null });
    if (venmo.kind === "notFound") expect(venmo.message).toContain("@ghost");

    const cashapp = await checkPayee(client, { platform: "cashapp", currencies: ["USD"], payee: "$ghost", requiresIdentityAttestation: false });
    expect(cashapp).toMatchObject({ kind: "notFound", registration: "peerExtensionCredential" });
  });

  it("treats 'unregistered' wording without a status as notFound", async () => {
    const client = mockCashClient();
    client.prepare.mockRejectedValue(registrationFailed("Venmo user not found for handle"));
    const result = await checkPayee(client, { platform: "venmo", currencies: ["USD"], payee: "ghost", requiresIdentityAttestation: false });
    expect(result.kind).toBe("notFound");
  });

  it("treats the curator's attestation wording as needsIdentityAttestation on identity rails", async () => {
    const client = mockCashClient();
    client.prepare.mockRejectedValue(registrationFailed("identityAttestation is required", 400));
    const result = await checkPayee(client, { platform: "paypal", currencies: ["USD"], payee: "zezima", requiresIdentityAttestation: true });
    expect(result.kind).toBe("needsIdentityAttestation");
  });

  it("treats a bare PayPal 400 as registration required (Peer web parity) but 400 elsewhere as invalid", async () => {
    const client = mockCashClient();
    client.prepare.mockRejectedValue(registrationFailed("Bad Request", 400));
    const paypal = await checkPayee(client, { platform: "paypal", currencies: ["USD"], payee: "zezima", requiresIdentityAttestation: true });
    expect(paypal.kind).toBe("needsIdentityAttestation");
    const monzo = await checkPayee(client, { platform: "monzo", currencies: ["GBP"], payee: "zezima", requiresIdentityAttestation: false });
    expect(monzo.kind).toBe("invalidFormat");
  });

  it("reports rate limits and outages as retryable errors", async () => {
    const client = mockCashClient();
    client.prepare.mockRejectedValueOnce(registrationFailed("Too Many Requests", 429));
    expect(await checkPayee(client, { platform: "venmo", currencies: ["USD"], payee: "a", requiresIdentityAttestation: false })).toMatchObject({
      kind: "error",
      retryable: true,
    });
    client.prepare.mockRejectedValueOnce(registrationFailed("Internal", 503));
    expect(await checkPayee(client, { platform: "venmo", currencies: ["USD"], payee: "a", requiresIdentityAttestation: false })).toMatchObject({
      kind: "error",
      retryable: true,
    });
  });

  it("reports an unsupported corridor as a non-retryable error", async () => {
    const client = mockCashClient();
    client.prepare.mockRejectedValue(cashError("UNSUPPORTED_PLATFORM_CURRENCY"));
    const result = await checkPayee(client, { platform: "venmo", currencies: ["EUR"], payee: "a", requiresIdentityAttestation: false });
    expect(result).toMatchObject({ kind: "error", retryable: false });
  });
});
