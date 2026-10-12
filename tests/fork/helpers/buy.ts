/**
 * Buy-side helpers: a live Curator quote the fork can fill, on-chain intent
 * reads, and the attestation the Peer attestation service would return.
 */

import {
  concat,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { MarketError, getBuyQuotes, type BuyQuote } from "@/peer/market";
import type { BuyPlatformId, FiatCode } from "@/peer/platforms";
import { APIError, type Zkp2pClient } from "@zkp2p/sdk";
import { forkClient, impersonatedWallet, mined, setEthBalance } from "./anvil";
import { ESCROW, ORCHESTRATOR, PEER_CONTRACT_ABIS } from "./offchain";

/** The fiat amounts and currencies tried, in order, for a quote the fork can fill. */
export const QUOTE_CANDIDATES: ReadonlyArray<{ currency: FiatCode; fiatAmount: string }> = [
  { currency: "GBP", fiatAmount: "20" },
  { currency: "EUR", fiatAmount: "20" },
  { currency: "USD", fiatAmount: "20" },
  { currency: "GBP", fiatAmount: "50" },
  { currency: "EUR", fiatAmount: "50" },
];

export interface OnchainIntent {
  owner: Address;
  to: Address;
  escrow: Address;
  depositId: bigint;
  amount: bigint;
  timestamp: bigint;
  paymentMethod: Hex;
  fiatCurrency: Hex;
  conversionRate: bigint;
  payeeId: Hex;
  referralFees: readonly { recipient: Address; fee: bigint }[];
  postIntentHook: Address;
  data: Hex;
}

export async function readIntent(intentHash: Hex): Promise<OnchainIntent> {
  return (await forkClient.readContract({
    address: ORCHESTRATOR,
    abi: PEER_CONTRACT_ABIS.orchestrator,
    functionName: "getIntent",
    args: [intentHash],
  } as never)) as OnchainIntent;
}

export interface OnchainDepositLiquidity {
  remainingDeposits: bigint;
  outstandingIntentAmount: bigint;
  depositor: Address;
}

export async function readDeposit(depositId: string | bigint): Promise<OnchainDepositLiquidity> {
  return (await forkClient.readContract({
    address: ESCROW,
    abi: PEER_CONTRACT_ABIS.escrow,
    functionName: "getDeposit",
    args: [BigInt(depositId)],
  } as never)) as OnchainDepositLiquidity;
}

/**
 * Live quotes for `recipient`, keeping only those whose deposit the fork can
 * actually fill right now (Curator sees mainnet a few blocks ahead of the fork).
 */
/** True when the fork's copy of the quote's deposit can still fill it. */
export async function fillableOnFork(quote: BuyQuote): Promise<boolean> {
  if (quote.escrow.toLowerCase() !== ESCROW.toLowerCase()) return false;
  return (await readDeposit(quote.depositId)).remainingDeposits >= quote.signalAmount;
}

export async function fillableQuotes(
  client: Zkp2pClient,
  recipient: Address,
  platforms?: readonly BuyPlatformId[],
): Promise<{ quotes: BuyQuote[]; currency: FiatCode; fiatAmount: string }> {
  for (const candidate of QUOTE_CANDIDATES) {
    const result = await getBuyQuotes({ ...candidate, recipient, client, ...(platforms ? { platforms } : {}) }).catch(
      (error: unknown) => {
        // A currency none of the requested platforms takes; anything else is a real failure.
        if (error instanceof MarketError) return null;
        throw error;
      },
    );
    if (!result) continue;
    const fillable: BuyQuote[] = [];
    for (const quote of result.quotes) {
      if (await fillableOnFork(quote)) fillable.push(quote);
    }
    if (fillable.length > 0) return { quotes: fillable, ...candidate };
  }
  throw new Error("Curator returned no quote the fork can fill for any candidate currency");
}

// ---------------------------------------------------------------------------
// The live pair sweep
// ---------------------------------------------------------------------------

/**
 * Rough fiat per USD, only to ask each currency for about 20 USD of USDC.
 * Curator's nearby suggestions cover whatever the rough figure misses.
 */
export const SWEEP_FIAT_PER_USD: Readonly<Record<FiatCode, number>> = {
  USD: 1, EUR: 0.92, GBP: 0.78, AUD: 1.5, CAD: 1.37, NZD: 1.65, SGD: 1.3, HKD: 7.8, CHF: 0.85, JPY: 150,
  CNY: 7.2, MXN: 18.5, ARS: 1000, AED: 3.67, SAR: 3.75, ILS: 3.7, TRY: 34, ZAR: 18, KES: 129, UGX: 3700,
  INR: 84, IDR: 16000, MYR: 4.4, PHP: 57, THB: 34, VND: 25000, PLN: 3.9, CZK: 23, HUF: 360, RON: 4.6,
  DKK: 6.9, NOK: 10.8, SEK: 10.5, UAH: 41,
};

/** About 20 USD in `currency`, as a whole-number fiat amount. */
export function sweepAmount(currency: FiatCode): string {
  return String(Math.max(1, Math.round(20 * SWEEP_FIAT_PER_USD[currency])));
}

/**
 * A live quote for one platform and currency that the fork can fill: an exact
 * one for about 20 USD, else the nearest suggested amount below or above (a
 * dust deposit such as Alipay's only quotes as a nearby suggestion). Null when
 * Curator has no eligible liquidity for the pair; "unavailable" when Curator
 * kept answering 503 past the app's own short retry, even after the sweep
 * waited a few seconds more (other sessions quoting at the same time).
 */
export async function sweepQuote(
  client: Zkp2pClient,
  recipient: Address,
  platform: BuyPlatformId,
  currency: FiatCode,
): Promise<{ quote: BuyQuote; fiatAmount: string; nearby: boolean } | null | "unavailable"> {
  const fiatAmount = sweepAmount(currency);
  let result: Awaited<ReturnType<typeof getBuyQuotes>> | null = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      result = await getBuyQuotes({ fiatAmount, currency, platforms: [platform], recipient, client, quotesToReturn: 10 });
      break;
    } catch (error) {
      // A currency none of the requested platforms takes; anything else is a real failure.
      if (error instanceof MarketError) return null;
      if (!(error instanceof APIError && error.status === 503)) throw error;
      if (attempt >= 2) return "unavailable";
      await new Promise((resolve) => setTimeout(resolve, 3_000 * (attempt + 1)));
    }
  }
  for (const quote of result.quotes) {
    if (quote.platform === platform && (await fillableOnFork(quote))) return { quote, fiatAmount, nearby: false };
  }
  for (const near of [...result.nearby.below, ...result.nearby.above]) {
    if (near.quote.platform === platform && (await fillableOnFork(near.quote))) return { quote: near.quote, fiatAmount, nearby: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payment attestations (what attestation-service.zkp2p.xyz returns)
// ---------------------------------------------------------------------------

/** EIP-712 type the UnifiedPaymentVerifier checks witness signatures against (verified against a mainnet fulfilment). */
export const PAYMENT_ATTESTATION_TYPE = "PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)";
export const PAYMENT_ATTESTATION_TYPEHASH = keccak256(stringToHex(PAYMENT_ATTESTATION_TYPE));

const REGISTRY_ABI = parseAbi(["function getVerifier(bytes32 _paymentMethod) view returns (address)"]);
const ORCHESTRATOR_REGISTRY_ABI = parseAbi(["function paymentVerifierRegistry() view returns (address)"]);
const VERIFIER_ABI = parseAbi([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function attestationVerifier() view returns (address)",
]);
const MULTI_ATTESTATION_ABI = parseAbi([
  "function owner() view returns (address)",
  "function addWitness(address _witness)",
  "function isWitness(address _witness) view returns (bool)",
]);

export interface VerifierContext {
  verifier: Address;
  attestationVerifier: Address;
  domainSeparator: Hex;
}

export async function verifierFor(paymentMethod: Hex): Promise<VerifierContext> {
  const registry = await forkClient.readContract({
    address: ORCHESTRATOR,
    abi: ORCHESTRATOR_REGISTRY_ABI,
    functionName: "paymentVerifierRegistry",
  });
  const verifier = await forkClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "getVerifier", args: [paymentMethod] });
  const [domainSeparator, attestationVerifier] = await Promise.all([
    forkClient.readContract({ address: verifier, abi: VERIFIER_ABI, functionName: "DOMAIN_SEPARATOR" }),
    forkClient.readContract({ address: verifier, abi: VERIFIER_ABI, functionName: "attestationVerifier" }),
  ]);
  return { verifier, attestationVerifier, domainSeparator };
}

/** FORK ONLY: makes `witness` a trusted attestation signer by impersonating the verifier's owner. */
export async function trustWitnessOnFork(attestationVerifier: Address, witness: Address): Promise<void> {
  const owner = await forkClient.readContract({ address: attestationVerifier, abi: MULTI_ATTESTATION_ABI, functionName: "owner" });
  await setEthBalance(owner, "1");
  await mined(
    await impersonatedWallet(owner).writeContract({
      address: attestationVerifier,
      abi: MULTI_ATTESTATION_ABI,
      functionName: "addWitness",
      args: [witness],
    }),
  );
  const trusted = await forkClient.readContract({
    address: attestationVerifier,
    abi: MULTI_ATTESTATION_ABI,
    functionName: "isWitness",
    args: [witness],
  });
  if (!trusted) throw new Error("witness was not added on the fork");
}

export interface AttestationInput {
  intentHash: Hex;
  intent: OnchainIntent;
  /** Fiat paid, in cents. */
  paidCents: bigint;
  /** When the payment happened (ms). */
  paidAtMs: bigint;
  paymentId: string;
  releaseAmount: bigint;
  platform: string;
  actionType: string;
}

/**
 * The payment details the attestation service signs, in the layout the
 * deployed verifier decodes (taken from a real Revolut fulfilment on Base):
 * the payment as seen on the platform, then the intent snapshot it settles.
 */
export function encodePaymentDetails(input: AttestationInput): Hex {
  const { intent } = input;
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      intent.paymentMethod,
      intent.payeeId,
      input.paidCents,
      intent.fiatCurrency,
      input.paidAtMs,
      keccak256(stringToHex(input.paymentId)),
      input.intentHash,
      input.releaseAmount,
      intent.paymentMethod,
      intent.fiatCurrency,
      intent.payeeId,
      intent.conversionRate,
      intent.timestamp,
      2_592_000n,
    ],
  );
}

/** A complete `/buyer/verify` response signed by `witness`. */
export async function signedAttestation(input: AttestationInput, witness: LocalAccount, domainSeparator: Hex) {
  const encodedPaymentDetails = encodePaymentDetails(input);
  const dataHash = keccak256(encodedPaymentDetails);
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }],
      [PAYMENT_ATTESTATION_TYPEHASH, input.intentHash, input.releaseAmount, dataHash],
    ),
  );
  const digest = keccak256(concat(["0x1901", domainSeparator, structHash]));
  if (!witness.sign) throw new Error("witness cannot sign raw digests");
  const signature = await witness.sign({ hash: digest });
  return {
    success: true,
    message: "fork attestation",
    statusCode: 200,
    responseObject: {
      platform: input.platform,
      actionType: input.actionType,
      signature,
      signer: witness.address,
      domainSeparator,
      typeHash: PAYMENT_ATTESTATION_TYPEHASH,
      typedDataSpec: {
        primaryType: "PaymentAttestation",
        types: {
          PaymentAttestation: [
            { name: "intentHash", type: "bytes32" },
            { name: "releaseAmount", type: "uint256" },
            { name: "dataHash", type: "bytes32" },
          ],
        },
      },
      typedDataValue: { intentHash: input.intentHash, releaseAmount: input.releaseAmount.toString(), dataHash },
      proofInput: "0x",
      encodedPaymentDetails,
      metadata: encodeAbiParameters([{ type: "string" }], ['{"source":"buyer-tee"}']),
    },
  };
}

/** The `intent` block the SDK posts to `/buyer/verify/{platform}/{actionType}`. */
interface VerifyRequestIntent {
  intentHash: Hex;
  amount: string;
  timestampMs: string;
  paymentMethod: Hex;
  fiatCurrency: Hex;
  conversionRate: string;
  payeeDetails: Hex;
}

/**
 * An attestation service for the fork: answers `/buyer/verify` the way the
 * real one does for a matching payment, from the intent the app posts, signed
 * by `witness`. Only a witness trusted on the fork (`trustWitnessOnFork`)
 * makes the resulting proof pass on-chain.
 */
export function forkAttestationService(witness: LocalAccount) {
  let paymentCount = 0;
  return async (path: string, body: unknown) => {
    const [, , , platform = "", actionType = ""] = path.split("/");
    const sent = (body as { intent?: VerifyRequestIntent }).intent;
    if (!sent) throw new Error("verify request without an intent");
    const amount = BigInt(sent.amount);
    const rate = BigInt(sent.conversionRate);
    const verifier = await verifierFor(sent.paymentMethod);
    const intent = await readIntent(sent.intentHash);
    paymentCount += 1;
    return signedAttestation(
      {
        intentHash: sent.intentHash,
        intent,
        // Fiat owed, rounded up to the cent, as the player is told to send.
        paidCents: (amount * rate + 10n ** 22n - 1n) / 10n ** 22n,
        paidAtMs: BigInt(sent.timestampMs) + 60_000n,
        paymentId: `fork-payment-${sent.intentHash}-${paymentCount}`,
        releaseAmount: amount,
        platform,
        actionType,
      },
      witness,
      verifier.domainSeparator,
    );
  };
}
