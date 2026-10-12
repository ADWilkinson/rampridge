import { describe, expect, it, vi } from "vitest";

const apiGetPayeeDetails = vi.hoisted(() => vi.fn());
vi.mock("@zkp2p/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zkp2p/sdk")>()),
  apiGetPayeeDetails,
}));

import { fetchPayee } from "../chain";
import { getPaymentInstructions } from "../instructions";
import { recoverBuyOrder } from "../recovery";
import { deserializeOrder, serializeOrder } from "../storage";
import { BUYER, PAYEE_HASH, fakeClient, pvIntentView, storedOrder } from "./helpers";

const NOW = 1_791_711_741_000;

function curator(responseObject: Record<string, unknown>) {
  apiGetPayeeDetails.mockResolvedValueOnce({ success: true, message: "", statusCode: 200, responseObject });
}

describe("Revolut Business payees (Peer noQrPolicy parity)", () => {
  it("reads the business flag the way Peer's web app does: metadata.profileType first, then isBusiness", async () => {
    curator({ offchainId: "biztag", isBusiness: true, metadata: { profileType: "BUSINESS" } });
    expect(await fetchPayee("revolut", PAYEE_HASH)).toEqual({ handle: "biztag", business: true });
    curator({ offchainId: "biztag", isBusiness: true, metadata: null });
    expect(await fetchPayee("revolut", PAYEE_HASH)).toEqual({ handle: "biztag", business: true });
    curator({ offchainId: "revtag", isBusiness: false, metadata: { profileType: "PERSONAL" } });
    expect(await fetchPayee("revolut", PAYEE_HASH)).toEqual({ handle: "revtag", business: false });
    curator({ offchainId: "revtag", isBusiness: true, metadata: { profileType: "PERSONAL" } });
    expect(await fetchPayee("revolut", PAYEE_HASH)).toEqual({ handle: "revtag", business: false });
    curator({ offchainId: "" });
    expect(await fetchPayee("revolut", PAYEE_HASH)).toBeNull();
  });

  it("drops the revolut.me QR and link and adds the in-app steps for a business payee", () => {
    const personal = getPaymentInstructions(storedOrder({ platform: "revolut", currency: "GBP", payeeHandle: "revtag" }));
    expect(personal.qrValue).toBe("https://revolut.me/revtag");
    const business = getPaymentInstructions(
      storedOrder({ platform: "revolut", currency: "GBP", payeeHandle: "biztag", payeeBusiness: true }),
    );
    expect(business).toMatchObject({ qrValue: null, deepLink: null, webLink: null, payee: "biztag", payeeDisplay: "@biztag" });
    expect(business.rules[0]?.text).toMatch(/paste the Revtag/i);
  });

  it("keeps the flag across storage and adopts it from Curator for an order placed in another client", async () => {
    const stored = storedOrder({ payeeBusiness: true });
    expect(deserializeOrder(serializeOrder(stored))?.payeeBusiness).toBe(true);
    expect(deserializeOrder(serializeOrder(storedOrder()))).not.toHaveProperty("payeeBusiness");

    const fc = fakeClient();
    fc.accountIntents.mockResolvedValue([pvIntentView()]);
    const result = await recoverBuyOrder({
      client: fc.client,
      owner: BUYER,
      stored: null,
      now: NOW,
      lookupPayee: async () => ({ handle: "biztag", business: true }),
      dismissed: new Set(),
    });
    expect(result).toMatchObject({ kind: "active", order: { payeeHandle: "biztag", payeeBusiness: true } });
  });
});
