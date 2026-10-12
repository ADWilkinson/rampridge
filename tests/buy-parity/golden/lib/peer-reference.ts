/**
 * What Peer's own clients do, transcribed from zkp2p-clients main
 * (packages/core/src/platforms/*.ts verifyConfig, clients/web
 * buyerTeeRouting.ts, helpers/buyerTeeFulfillIntentProof.ts) and the
 * attestation service (src/unified/releaseAmount.ts). Used as the oracle the
 * golden replays compare RampRidge against.
 */

/** Buyer-TEE attestation routes Peer's web app uses, per payment method (platform, actionType, includeMetadataIndex). */
export const PEER_BUYER_TEE_ROUTES: Record<string, ReadonlyArray<{ platform: string; actionType: string; includeMetadataIndex: boolean }>> = {
  venmo: [{ platform: "venmo", actionType: "transfer_venmo", includeMetadataIndex: true }],
  cashapp: [{ platform: "cashapp", actionType: "transfer_cashapp", includeMetadataIndex: true }],
  revolut: [{ platform: "revolut", actionType: "transfer_revolut", includeMetadataIndex: true }],
  wise: [{ platform: "wise", actionType: "transfer_wise", includeMetadataIndex: false }],
  zelle: [
    { platform: "zelle", actionType: "transfer_zelle_bofa", includeMetadataIndex: true },
    { platform: "zelle", actionType: "transfer_zelle_chase", includeMetadataIndex: true },
    { platform: "zelle", actionType: "transfer_zelle_citi", includeMetadataIndex: true },
  ],
  paypal: [
    { platform: "paypal", actionType: "transfer_paypal", includeMetadataIndex: false },
    { platform: "paypal", actionType: "transfer_business_paypal", includeMetadataIndex: false },
  ],
  monzo: [{ platform: "monzo", actionType: "transfer_monzo", includeMetadataIndex: false }],
  chime: [{ platform: "chime", actionType: "transfer_chime", includeMetadataIndex: false }],
  n26: [{ platform: "n26", actionType: "transfer_n26", includeMetadataIndex: false }],
  luxon: [{ platform: "luxon", actionType: "transfer_luxon", includeMetadataIndex: false }],
  mercadopago: [{ platform: "mercadopago", actionType: "transfer_mercadopago", includeMetadataIndex: false }],
  monobank: [{ platform: "monobank", actionType: "transfer_monobank", includeMetadataIndex: false }],
  xmoney: [{ platform: "xmoney", actionType: "transfer_xmoney", includeMetadataIndex: false }],
};

/** Peer web `buildBuyerTeeFulfillIntentProofInput` params: the row's params plus `index` where the route needs it. */
export function peerProofParams(
  rowParams: Record<string, string | number | boolean>,
  originalIndex: number,
  includeMetadataIndex: boolean,
): Record<string, string | number | boolean> {
  return { ...rowParams, ...(includeMetadataIndex ? { index: originalIndex } : {}) };
}

/**
 * attestation-service `calculateReleaseAmount`: paid fiat (minor units, 2
 * decimals) x 1e18 x 1e4 / rate, capped at the intent amount.
 */
export function attestedRelease(paidMinor: bigint, conversionRate: bigint, intentAmount: bigint): bigint {
  const release = (paidMinor * 10n ** 18n * 10n ** 4n) / conversionRate;
  return release < intentAmount ? release : intentAmount;
}

/**
 * zkp2p-clients packages/core/src/utils/intentHelpers.ts `calculateFiatFromRequestedUSDC`
 * (the "send exactly" amount Peer's web app shows): floor(amount x rate / 1e18) in
 * 6-decimal fiat, then rounded up to the cent.
 */
export function peerFiatToSend(tokenAmount: bigint, conversionRate: bigint): bigint {
  const raw = (tokenAmount * conversionRate) / 10n ** 18n;
  const penny = 10n ** 4n;
  const remainder = raw % penny;
  return remainder > 0n ? raw - remainder + penny : raw;
}

/** The least fiat (minor units, 2 decimals) whose attested release is the whole intent: ceil(amount x rate / 1e22). */
export function minimumFullPaymentMinor(tokenAmount: bigint, conversionRate: bigint): bigint {
  const scale = 10n ** 22n;
  return (tokenAmount * conversionRate + scale - 1n) / scale;
}
