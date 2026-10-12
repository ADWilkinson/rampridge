/**
 * What the Peer web app passes to `client.signalIntent.prepare` for a Curator
 * quote, re-derived from zkp2p-clients main (45ff5b08, 2026-10-11) so a
 * RampRidge intent can be compared field by field with the web app's for the
 * same quote:
 *
 * - quote -> SwapQuote: clients/web/src/hooks/swap/processSingleRawQuote.ts
 *   (`hashedOnchainId = intent.payeeDetails`, `escrowAddress =
 *   intent.escrowAddress`, `usdcAmount = tokenAmount`, depositId from
 *   `intent.depositId ?? depositId`) and rawQuoteReferrerFeeFields.ts
 *   (`getPreferredConversionRateRaw`, `mapRawQuoteReferrerFeeFields`).
 * - SwapQuote -> IntentCreationParams: hooks/swap/useSubmitIntent.ts and
 *   intentFeeParams.ts (`applyWebReferrerFee` when the quote carries a
 *   referrer fee; processor name from the method hash,
 *   core/utils/paymentMethodResolver.ts computeProcessorNameForIntent).
 * - IntentCreationParams -> prepare(): hooks/transactions/
 *   useIntentCreationManager.ts (amount = signalIntentAmount ?? tokenAmount,
 *   no pre-signed signature, so the SDK fetches /v3/sign) and
 *   useSignalIntent.ts (postIntentHook zero, data and preIntentHookData "0x",
 *   `txOverrides.referrer = "zkp2p-web"`, `referrerFeeConfig` =
 *   WEB_REFERRER_FEE_CONFIG when applyWebReferrerFee).
 *
 * For an integrator the web app's WEB_REFERRER_FEE_CONFIG is the integrator's
 * own fee config, so RampRidge's BUY_REFERRER_FEE takes its place here.
 */

import { getPaymentMethodsCatalog, type GetQuoteSingleResponse, type SignalIntentMethodParams } from "@zkp2p/sdk";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { WEB_REFERRER_CODE } from "./peer";

type RawQuote = GetQuoteSingleResponse & {
  takerConversionRate?: string | null;
  effectiveConversionRate?: string | null;
  referrerFeeAmount?: string | null;
  referrerFeeBps?: number | null;
  signalIntentAmount?: string | null;
  depositId?: string | number;
  intent: GetQuoteSingleResponse["intent"] & {
    conversionRate?: string | null;
    processorIntentData?: { conversionRate?: string | null; depositId?: string | number } | null;
  };
};

/** rawQuoteReferrerFeeFields.getPreferredConversionRateRaw */
export function webPreferredConversionRate(raw: RawQuote): bigint | null {
  const value =
    raw.takerConversionRate ??
    raw.effectiveConversionRate ??
    raw.conversionRate ??
    raw.intent?.conversionRate ??
    raw.intent?.processorIntentData?.conversionRate;
  return value == null ? null : BigInt(value.toString());
}

/** rawQuoteReferrerFeeFields.mapRawQuoteReferrerFeeFields(...).signalIntentAmount */
export function webSignalIntentAmount(raw: RawQuote): bigint | undefined {
  const hasCuratorReferrerFeeFields = raw.referrerFeeAmount !== undefined || raw.referrerFeeBps !== undefined;
  const value = hasCuratorReferrerFeeFields ? raw.signalIntentAmount : (raw.signalIntentAmount ?? raw.intent?.amount);
  if (value == null) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

/** intentFeeParams.deriveIntentFeeParams(...).applyWebReferrerFee */
export function webAppliesReferrerFee(raw: RawQuote): boolean {
  const referrerFeeInUsd = raw.referrerFeeAmount != null ? Number(BigInt(raw.referrerFeeAmount)) / 1e6 : 0;
  return (raw.referrerFeeBps ?? 0) > 0 || referrerFeeInUsd > 0;
}

const catalog = getPaymentMethodsCatalog(8453, "production");

/** processSingleRawQuote's payment method hash, then computeProcessorNameForIntent's method name. */
export function webProcessorName(raw: RawQuote): { name: string; methodHash: Hex } {
  const declared = raw.paymentMethod ?? raw.intent?.processorName ?? "";
  const methodHash = declared.startsWith("0x")
    ? (declared as Hex)
    : ((catalog[declared.trim().toLowerCase()]?.paymentMethodHash ?? null) as Hex | null);
  if (!methodHash) throw new Error(`web app cannot resolve a method hash for ${declared}`);
  const name = Object.entries(catalog).find(([, entry]) => entry.paymentMethodHash.toLowerCase() === methodHash.toLowerCase())?.[0];
  if (!name) throw new Error(`Unsupported payment method hash: ${methodHash}`);
  return { name, methodHash };
}

export interface WebSignalInputs {
  /** What useSignalIntent hands to `client.signalIntent.prepare`. */
  params: SignalIntentMethodParams;
  applyWebReferrerFee: boolean;
}

/**
 * The prepare() parameters the web app builds for `raw`, signalled by
 * `account` (the logged-in wallet, which is also the default recipient).
 */
export function webSignalInputs(
  raw: RawQuote,
  currency: string,
  account: Address,
  integratorFee: { recipient: Address; feeBps: number },
): WebSignalInputs {
  const tokenAmount = BigInt(raw.tokenAmount);
  const signalIntentAmount = webSignalIntentAmount(raw);
  const applyWebReferrerFee = webAppliesReferrerFee(raw);
  if (applyWebReferrerFee && signalIntentAmount === undefined) {
    throw new Error("Quote data is missing the signal intent amount. Refresh the quote and try again.");
  }
  const rate = webPreferredConversionRate(raw);
  if (rate === null) throw new Error("Conversion rate is required for orchestrator flow");
  const depositIdRaw = raw.intent?.depositId ?? raw.depositId;
  const escrow = raw.intent?.escrowAddress;
  if (!escrow) throw new Error("Missing escrow address for orchestrator flow");
  const params: SignalIntentMethodParams = {
    depositId: BigInt(String(depositIdRaw)),
    amount: signalIntentAmount ?? tokenAmount,
    toAddress: getAddress(account),
    processorName: webProcessorName(raw).name,
    payeeDetails: raw.intent.payeeDetails,
    fiatCurrencyCode: currency,
    conversionRate: rate,
    preIntentHookData: "0x",
    postIntentHook: zeroAddress,
    data: "0x",
    escrowAddress: getAddress(escrow),
    txOverrides: { referrer: WEB_REFERRER_CODE },
    ...(applyWebReferrerFee ? { referrerFeeConfig: { ...integratorFee } } : {}),
  };
  return { params, applyWebReferrerFee };
}
