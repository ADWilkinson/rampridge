/**
 * Decoding of real Peer fulfilments on Base, independent of RampRidge's own
 * code: the fulfillIntent calldata, the payment attestation inside it, and
 * the inversion of the SDK's `encodePaymentAttestation` /
 * `encodeVerifyPaymentData` back into the attestation-service response that
 * must have produced it.
 *
 * Layouts (read from Peer's own code, current main):
 * - zkp2p-clients packages/sdk/src/utils/encode.ts
 *     paymentProof     = abi.encode(tuple(bytes32 intentHash, uint256 releaseAmount, bytes32 dataHash,
 *                                         bytes[] signatures, bytes encodedPaymentDetails, bytes metadata))
 *     verificationData = abi.encode(tuple(bytes32 intentHash, bytes paymentProof, bytes data))
 *     data             = abi.encode(address signer)
 * - attestation-service src/unified/paymentDetailsEncoder.ts
 *     encodedPaymentDetails = abi.encode(paymentTuple) || abi.encode(snapshotTuple)
 *     paymentTuple  = (bytes32 method, bytes32 payeeId, uint256 amount, bytes32 currency, uint256 timestampMs, bytes32 paymentId)
 *     snapshotTuple = (bytes32 intentHash, uint256 amount, bytes32 paymentMethod, bytes32 fiatCurrency,
 *                      bytes32 payeeDetails, uint256 conversionRate, uint256 signalTimestamp, uint256 timestampBufferSeconds)
 * - attestation-service src/unified/attestationMetadata.ts
 *     metadata = "0x" or abi.encode(string json), json carries { source: "buyer-tee" | "seller-tee", ... }
 */

import { Attribution } from "ox/erc8021";
import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  size,
  slice,
  type Abi,
  type Address,
  type Hex,
} from "viem";

export const FULFILL_SELECTOR = "0xac7a520c";
export const SIGNAL_SELECTOR = "0xf3ff8655";
export const INTENT_FULFILLED_TOPIC = "0xd50b3b21bc45b85ddfaec58dbf56fe9b88754d08f47dcf5143b63258a57ad944";
export const INTENT_SIGNALED_TOPIC = "0xf8c114f83581b2cf0b9f130782a93024aa8933e7d188901156bd68bdd558a20a";

const PAYMENT_ATTESTATION = [
  {
    type: "tuple",
    components: [
      { name: "intentHash", type: "bytes32" },
      { name: "releaseAmount", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
      { name: "signatures", type: "bytes[]" },
      { name: "encodedPaymentDetails", type: "bytes" },
      { name: "metadata", type: "bytes" },
    ],
  },
] as const;

const VERIFY_PAYMENT_DATA = [
  {
    type: "tuple",
    components: [
      { name: "intentHash", type: "bytes32" },
      { name: "paymentProof", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

const PAYMENT_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "method", type: "bytes32" },
      { name: "payeeId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "currency", type: "bytes32" },
      { name: "timestampMs", type: "uint256" },
      { name: "paymentId", type: "bytes32" },
    ],
  },
] as const;

const SNAPSHOT_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "intentHash", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "paymentMethod", type: "bytes32" },
      { name: "fiatCurrency", type: "bytes32" },
      { name: "payeeDetails", type: "bytes32" },
      { name: "conversionRate", type: "uint256" },
      { name: "signalTimestamp", type: "uint256" },
      { name: "timestampBufferSeconds", type: "uint256" },
    ],
  },
] as const;

export interface FulfillCallArgs {
  paymentProof: Hex;
  intentHash: Hex;
  verificationData: Hex;
  postIntentHookData: Hex;
}

export interface DecodedCalldata<T> {
  args: T;
  /** The ABI encoding alone (selector + args), with no trailing attribution. */
  canonical: Hex;
  /** Everything after the ABI encoding ("0x" when nothing was appended). */
  suffix: Hex;
  /** ERC-8021 codes in the suffix, or null when the suffix is not ERC-8021. */
  suffixCodes: string[] | null;
}

function splitSuffix(abi: Abi, functionName: string, args: readonly unknown[], data: Hex) {
  const canonical = encodeFunctionData({ abi, functionName, args } as never);
  if (!data.toLowerCase().startsWith(canonical.toLowerCase())) {
    throw new Error(`${functionName} calldata does not start with its own canonical ABI encoding`);
  }
  const suffix = `0x${data.slice(canonical.length)}` as Hex;
  let suffixCodes: string[] | null = null;
  if (suffix !== "0x") {
    const parsed = Attribution.fromData(data);
    suffixCodes = parsed ? [...parsed.codes] : null;
  }
  return { canonical, suffix, suffixCodes };
}

export function decodeFulfillCalldata(abi: Abi, data: Hex): DecodedCalldata<FulfillCallArgs> {
  const decoded = decodeFunctionData({ abi, data });
  if (decoded.functionName !== "fulfillIntent") throw new Error(`not fulfillIntent: ${decoded.functionName}`);
  const args = (decoded.args as readonly [FulfillCallArgs])[0];
  return { args, ...splitSuffix(abi, "fulfillIntent", decoded.args as readonly unknown[], data) };
}

export interface SignalCallArgs {
  escrow: Address;
  depositId: bigint;
  amount: bigint;
  to: Address;
  paymentMethod: Hex;
  fiatCurrency: Hex;
  conversionRate: bigint;
  referralFees: readonly { recipient: Address; fee: bigint }[];
  gatingServiceSignature: Hex;
  signatureExpiration: bigint;
  postIntentHook: Address;
  preIntentHookData: Hex;
  data: Hex;
}

export function decodeSignalCalldata(abi: Abi, data: Hex): DecodedCalldata<SignalCallArgs> {
  const decoded = decodeFunctionData({ abi, data });
  if (decoded.functionName !== "signalIntent") throw new Error(`not signalIntent: ${decoded.functionName}`);
  const args = (decoded.args as readonly [SignalCallArgs])[0];
  return { args, ...splitSuffix(abi, "signalIntent", decoded.args as readonly unknown[], data) };
}

export interface PaymentAttestation {
  intentHash: Hex;
  releaseAmount: bigint;
  dataHash: Hex;
  signatures: readonly Hex[];
  encodedPaymentDetails: Hex;
  metadata: Hex;
}

export function decodePaymentProof(paymentProof: Hex): PaymentAttestation {
  const [tuple] = decodeAbiParameters(PAYMENT_ATTESTATION, paymentProof);
  return tuple as PaymentAttestation;
}

export interface VerifyPaymentData {
  intentHash: Hex;
  paymentProof: Hex;
  signer: Address;
}

export function decodeVerificationData(verificationData: Hex): VerifyPaymentData {
  const [tuple] = decodeAbiParameters(VERIFY_PAYMENT_DATA, verificationData);
  const [signer] = decodeAbiParameters([{ type: "address" }], tuple.data);
  return { intentHash: tuple.intentHash, paymentProof: tuple.paymentProof, signer: getAddress(signer) };
}

export interface PaymentDetails {
  payment: {
    method: Hex;
    payeeId: Hex;
    amount: bigint;
    currency: Hex;
    timestampMs: bigint;
    paymentId: Hex;
  };
  snapshot: {
    intentHash: Hex;
    amount: bigint;
    paymentMethod: Hex;
    fiatCurrency: Hex;
    payeeDetails: Hex;
    conversionRate: bigint;
    signalTimestamp: bigint;
    timestampBufferSeconds: bigint;
  };
}

/** Splits encodedPaymentDetails into its two static tuples (6 and 8 words). */
export function decodePaymentDetails(encoded: Hex): PaymentDetails {
  if (size(encoded) !== 14 * 32) throw new Error(`unexpected encodedPaymentDetails size ${size(encoded)}`);
  const [payment] = decodeAbiParameters(PAYMENT_TUPLE, slice(encoded, 0, 6 * 32));
  const [snapshot] = decodeAbiParameters(SNAPSHOT_TUPLE, slice(encoded, 6 * 32));
  return { payment, snapshot } as PaymentDetails;
}

export function decodeMetadata(metadata: Hex): Record<string, unknown> | null {
  if (!metadata || metadata === "0x") return null;
  const [json] = decodeAbiParameters([{ type: "string" }], metadata);
  return JSON.parse(json) as Record<string, unknown>;
}

/** The attestation-service JSON body (`AttestationResponse` in the SDK) that encodes to this paymentProof. */
export interface ReconstructedAttestationResponse {
  success: true;
  message: string;
  statusCode: 200;
  responseObject: {
    platform: string;
    actionType: string;
    signature: Hex;
    signer: Address;
    domainSeparator: Hex;
    typeHash: Hex;
    typedDataSpec: { primaryType: string; types: Record<string, { type: string; name: string }[]> };
    typedDataValue: { intentHash: Hex; releaseAmount: string; dataHash: Hex };
    proofInput: string;
    encodedPaymentDetails: Hex;
    metadata: Hex;
  };
}

export const PAYMENT_ATTESTATION_TYPE_HASH = keccak256(
  new TextEncoder().encode("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
);

/**
 * Inverts sdk `encodePaymentAttestation` + `encodeVerifyPaymentData`: the
 * response the attestation service returned for this fulfilment. The SDK
 * encodes exactly one signature, so a proof carrying several cannot have come
 * from `fulfillIntent.prepare` and is rejected here.
 */
export function reconstructAttestationResponse(
  args: FulfillCallArgs,
  route: { platform: string; actionType: string },
  domainSeparator: Hex,
): ReconstructedAttestationResponse {
  const proof = decodePaymentProof(args.paymentProof);
  if (proof.signatures.length !== 1) throw new Error(`proof has ${proof.signatures.length} signatures`);
  const verification = decodeVerificationData(args.verificationData);
  if (verification.paymentProof.toLowerCase() !== args.paymentProof.toLowerCase()) {
    throw new Error("verificationData does not wrap the same paymentProof");
  }
  return {
    success: true,
    message: "Payment verified",
    statusCode: 200,
    responseObject: {
      platform: route.platform,
      actionType: route.actionType,
      signature: proof.signatures[0] as Hex,
      signer: verification.signer,
      domainSeparator,
      typeHash: PAYMENT_ATTESTATION_TYPE_HASH,
      typedDataSpec: {
        primaryType: "PaymentAttestation",
        types: {
          PaymentAttestation: [
            { type: "bytes32", name: "intentHash" },
            { type: "uint256", name: "releaseAmount" },
            { type: "bytes32", name: "dataHash" },
          ],
        },
      },
      typedDataValue: {
        intentHash: proof.intentHash,
        releaseAmount: proof.releaseAmount.toString(),
        dataHash: proof.dataHash,
      },
      proofInput: "",
      encodedPaymentDetails: proof.encodedPaymentDetails,
      metadata: proof.metadata,
    },
  };
}

export interface FulfilledEvent {
  intentHash: Hex;
  fundsTransferredTo: Address;
  amount: bigint;
  isManualRelease: boolean;
}

export function decodeIntentFulfilled(abi: Abi, log: { data: Hex; topics: readonly Hex[] }): FulfilledEvent {
  const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  if (decoded.eventName !== "IntentFulfilled") throw new Error(`not IntentFulfilled: ${decoded.eventName}`);
  const args = decoded.args as unknown as FulfilledEvent;
  return { ...args, fundsTransferredTo: getAddress(args.fundsTransferredTo) };
}

// ---------------------------------------------------------------------------
// Locating the orchestrator call inside a transaction (direct or ERC-4337)
// ---------------------------------------------------------------------------

export interface CallFrame {
  type: string;
  from: Address;
  to: Address;
  input: Hex;
  calls?: CallFrame[];
  error?: string;
}

export type Rpc = <T = unknown>(method: string, params: unknown[]) => Promise<T>;

export interface LocatedCall {
  from: Address;
  input: Hex;
  /** The call was the transaction itself (an EOA or relayer sent it directly). */
  direct: boolean;
  txFrom: Address;
  txTo: Address;
}

/**
 * The call to `orchestrator` with `selector` in `txHash` whose decoded args
 * satisfy `match` (e.g. the right intent). Uses the transaction itself when
 * it is that call, otherwise a callTracer trace (bundled user operations,
 * smart-account batches).
 */
export async function locateCall(
  rpc: Rpc,
  txHash: Hex,
  orchestrator: Address,
  selector: Hex,
  match: (input: Hex) => boolean,
): Promise<LocatedCall> {
  const tx = await rpc<{ from: Address; to: Address; input: Hex }>("eth_getTransactionByHash", [txHash]);
  const txFrom = getAddress(tx.from);
  const txTo = getAddress(tx.to);
  if (txTo === getAddress(orchestrator) && tx.input.startsWith(selector) && match(tx.input)) {
    return { from: txFrom, input: tx.input, direct: true, txFrom, txTo };
  }
  const trace = await rpc<CallFrame>("debug_traceTransaction", [txHash, { tracer: "callTracer" }]);
  const found: CallFrame[] = [];
  const walk = (frame: CallFrame) => {
    if (
      frame.type === "CALL" &&
      !frame.error &&
      frame.to &&
      getAddress(frame.to) === getAddress(orchestrator) &&
      frame.input.startsWith(selector) &&
      match(frame.input)
    ) {
      found.push(frame);
    }
    for (const child of frame.calls ?? []) walk(child);
  };
  walk(trace);
  if (found.length !== 1) throw new Error(`expected one matching orchestrator call in ${txHash}, found ${found.length}`);
  const frame = found[0] as CallFrame;
  return { from: getAddress(frame.from), input: frame.input, direct: false, txFrom, txTo };
}
