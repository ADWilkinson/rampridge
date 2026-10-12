/**
 * A local stand-in for attestation-service.zkp2p.xyz's buyer TEE route
 * (`POST /buyer/verify/:platform/:actionType`), for the fork e2e only.
 *
 * It follows the real service step for step (attestation-service
 * src/api/buyer/buyerService.ts at origin/main, Oct 2026):
 *   request validation -> transformer lookup -> chain id -> intent
 *   normalisation (30-day timestamp buffer) -> decrypt the JWE session
 *   material (RSA-OAEP-256 + A256GCM, bound to the upload key's SPKI sha256)
 *   -> Revolut transformer (replays the captured request against the
 *   "bank", picks transactions[params.index], requires COMPLETED, TRANSFER,
 *   an outgoing amount and a recipient username) -> UnifiedPaymentVerifier
 *   checks (method, currency, payee hash, timestamp window, intent hash,
 *   rate, amount, release = paid x 1e22 / rate capped at the intent)
 *   -> encode (PaymentDetails, IntentSnapshot) -> EIP-712 sign
 *   PaymentAttestation over the UnifiedPaymentVerifier domain with the
 *   witness key -> ServiceResponse JSON.
 *
 * Differences from production, on purpose: one platform (Revolut), the
 * "bank" is an in-memory account instead of app.revolut.com over enclave
 * TLS, a cross-currency payment is refused instead of FX-converted, and the
 * signer is a local witness the fork trusts (never trusted on mainnet).
 */

import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { compactDecrypt } from "jose";
import {
  concat,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";

export const BUYER_TEE_PLATFORMS = [
  "venmo",
  "cashapp",
  "monzo",
  "wise",
  "revolut",
  "zelle",
  "chime",
  "paypal",
  "monobank",
  "alipay",
  "upi",
  "xmoney",
] as const;

/** attestation-service src/config/paymentMethodConfig.ts DEFAULT_TIMESTAMP_BUFFER_MS. */
export const DEFAULT_TIMESTAMP_BUFFER_MS = 30 * 24 * 60 * 60 * 1000;
const PRECISE_UNIT = 10n ** 18n;
const USDC_SCALE = 10_000n;
const REVOLUT_INDEX_MAX = 19;

export const UNIFIED_PAYMENT_DOMAIN = { name: "UnifiedPaymentVerifier", version: "1" } as const;
export const UNIFIED_PAYMENT_TYPES = {
  PaymentAttestation: [
    { name: "intentHash", type: "bytes32" },
    { name: "releaseAmount", type: "uint256" },
    { name: "dataHash", type: "bytes32" },
  ],
} as const;
export const UNIFIED_PAYMENT_TYPEHASH = keccak256(
  stringToHex("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
);

/** One Revolut transaction as `GET /api/retail/user/current/transactions/last?count=20` returns it. */
export interface RevolutTransaction {
  id: string;
  /** Minor units; negative for money sent. */
  amount: number;
  /** Epoch ms. */
  completedDate: number;
  currency: string;
  recipient?: { username?: string };
  state: string;
  type: string;
  description?: string;
}

/** The in-memory "bank": Revolut accounts keyed by session cookie, newest transaction first. */
export class FakeRevolut {
  private readonly accounts = new Map<string, RevolutTransaction[]>();

  reset(cookie: string, transactions: RevolutTransaction[] = []): void {
    this.accounts.set(cookie, [...transactions]);
  }

  pay(cookie: string, tx: RevolutTransaction): void {
    const list = this.accounts.get(cookie) ?? [];
    this.accounts.set(cookie, [tx, ...list]);
  }

  /** Returns null when the session is unknown (Revolut answers 401). */
  transactions(cookie: string): RevolutTransaction[] | null {
    const list = this.accounts.get(cookie);
    return list ? list.slice(0, 20) : null;
  }
}

export interface UploadKey {
  privateKey: KeyObject;
  publicKeyDer: Buffer;
  publicKeySha256Hex: string;
}

/** The enclave upload key (attestation-service src/common/nitroBridge/sellerUploadKey.ts). */
export function generateUploadKey(): UploadKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return { privateKey, publicKeyDer, publicKeySha256Hex: createHash("sha256").update(publicKeyDer).digest("hex") };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

interface IntentDetails {
  intentHash: Hex;
  amount: bigint;
  timestampMs: number;
  paymentMethod: Hex;
  fiatCurrency: Hex;
  conversionRate: bigint;
  payeeDetails: Hex;
  timestampBufferMs: number;
}

interface NormalizedPayment {
  intentHash: Hex;
  method: Hex;
  payeeId: Hex;
  amount: bigint;
  currency: Hex;
  timestampMs: number;
  paymentId: Hex;
}

export interface VerifyContext {
  chainId: number;
  /** UnifiedPaymentVerifierV3 (contracts-v2 addresses/base.json). */
  verifyingContract: Address;
  witness: LocalAccount;
  uploadKey: UploadKey;
  bank: FakeRevolut;
}

export interface VerifyDecision {
  at: number;
  platform: string;
  actionType: string;
  status: number;
  message: string;
  intentHash: string | null;
  params: unknown;
  /** Set on success. */
  releaseAmount?: string;
  paymentId?: string;
}

function hashString(value: string): Hex {
  return keccak256(stringToHex(value));
}

/** BuyerTeeVerifyInputSchema + IntentDetailsSchema, then normalizeIntentDetails. */
function parseRequest(body: unknown): { encrypted: string; params: Record<string, unknown>; chainId: number; intent: IntentDetails } {
  if (!body || typeof body !== "object") throw new HttpError(400, "Invalid buyer TEE verify input");
  const b = body as Record<string, unknown>;
  const encrypted = typeof b.encryptedSessionMaterial === "string" ? b.encryptedSessionMaterial.trim() : "";
  const params = b.params;
  const chainId = b.chainId;
  const raw = b.intent as Record<string, unknown> | undefined;
  if (
    !encrypted ||
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    typeof chainId !== "number" ||
    !Number.isSafeInteger(chainId) ||
    chainId < 0 ||
    !raw ||
    typeof raw !== "object"
  ) {
    throw new HttpError(400, "Invalid buyer TEE verify input");
  }
  for (const key of ["intentHash", "paymentMethod", "fiatCurrency", "payeeDetails"]) {
    if (typeof raw[key] !== "string" || !BYTES32.test(raw[key] as string)) throw new HttpError(400, "Invalid buyer TEE verify input");
  }
  for (const key of ["amount", "timestampMs", "conversionRate"]) {
    if (typeof raw[key] !== "string") throw new HttpError(400, "Invalid buyer TEE verify input");
  }
  let amount: bigint;
  let conversionRate: bigint;
  try {
    amount = BigInt((raw.amount as string).trim());
    conversionRate = BigInt((raw.conversionRate as string).trim());
  } catch {
    throw new HttpError(400, "Invalid amount");
  }
  const timestampMs = Number((raw.timestampMs as string).trim());
  if (amount < 0n) throw new HttpError(400, "amount must be non-negative");
  if (conversionRate <= 0n) throw new HttpError(400, "conversionRate must be positive");
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new HttpError(400, "timestampMs must be a safe integer");
  return {
    encrypted,
    params: params as Record<string, unknown>,
    chainId,
    intent: {
      intentHash: raw.intentHash as Hex,
      amount,
      timestampMs,
      paymentMethod: raw.paymentMethod as Hex,
      fiatCurrency: raw.fiatCurrency as Hex,
      conversionRate,
      payeeDetails: raw.payeeDetails as Hex,
      // The service ignores any caller buffer (the SDK sends "300000") and uses its own config.
      timestampBufferMs: DEFAULT_TIMESTAMP_BUFFER_MS,
    },
  };
}

/** decryptTeeSessionMaterial: compact JWE, RSA-OAEP-256/A256GCM, strict binding fields. */
async function decryptSession(encrypted: string, key: UploadKey, platform: string, actionType: string): Promise<unknown> {
  let plaintext: Uint8Array;
  try {
    plaintext = (
      await compactDecrypt(encrypted, key.privateKey, {
        keyManagementAlgorithms: ["RSA-OAEP-256"],
        contentEncryptionAlgorithms: ["A256GCM"],
      })
    ).plaintext;
  } catch {
    throw new HttpError(400, "Buyer TEE session material failed authentication");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(plaintext).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Buyer TEE session material payload is not valid JSON");
  }
  const keys = Object.keys(payload).sort().join(",");
  if (keys !== "actionType,boundPubKeySha256,platform,sessionMaterial") {
    throw new HttpError(400, "Buyer TEE session material payload is missing required binding fields");
  }
  if (String(payload.boundPubKeySha256).toLowerCase() !== key.publicKeySha256Hex) {
    throw new HttpError(400, "Buyer TEE session material is bound to a different public key");
  }
  if (String(payload.platform).toLowerCase() !== platform || String(payload.actionType).toLowerCase() !== actionType) {
    throw new HttpError(400, "Buyer TEE session material does not match the requested verifier");
  }
  return payload.sessionMaterial;
}

function header(material: Record<string, string>, name: string): string {
  const entry = Object.entries(material).find(([k, v]) => k.trim().toLowerCase() === name && typeof v === "string" && v.trim());
  return entry ? entry[1].trim() : "";
}

/** RevolutBuyerTeeTransformer.transform, with the bank replayed in memory. */
function revolutTransform(sessionMaterial: unknown, params: Record<string, unknown>, intent: IntentDetails, bank: FakeRevolut): NormalizedPayment {
  if (!sessionMaterial || typeof sessionMaterial !== "object" || Array.isArray(sessionMaterial)) {
    throw new HttpError(400, "Invalid Revolut buyer session material");
  }
  const material = sessionMaterial as Record<string, string>;
  const cookie = header(material, "cookie");
  if (!cookie || !header(material, "x-device-id")) throw new HttpError(400, "Invalid Revolut buyer session material");
  const index = params.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > REVOLUT_INDEX_MAX) {
    throw new HttpError(400, "Invalid Revolut query params");
  }
  const transactions = bank.transactions(cookie);
  if (!transactions) throw new HttpError(401, "Revolut session is unauthorized");
  const noMatch = (reason: string) => new HttpError(404, `No matching Revolut buyer payment found for index: ${reason}`);
  const tx = transactions[index];
  if (!tx) throw noMatch(`selected index ${index} is out of range`);
  if (tx.state !== "COMPLETED") throw noMatch("selected transaction state is not COMPLETED");
  if (tx.type !== "TRANSFER") throw noMatch("selected transaction type is not TRANSFER");
  if (!Number.isSafeInteger(tx.amount) || !Number.isSafeInteger(tx.completedDate) || !tx.id?.trim() || !tx.currency?.trim()) {
    throw new HttpError(400, `Invalid Revolut transaction at index ${index}`);
  }
  if (tx.amount >= 0) throw noMatch("selected transaction amount is not an outgoing debit");
  const username = tx.recipient?.username?.trim();
  if (!username) throw noMatch("selected transaction is missing recipient username");

  const minor = BigInt(-tx.amount);
  const amountMinor = tx.currency.trim() === "JPY" ? minor * 100n : minor;
  if (hashString(tx.currency.trim()).toLowerCase() !== intent.fiatCurrency.toLowerCase()) {
    // Production converts with an FX quote and a 3% penalty; this mock refuses instead.
    throw new HttpError(400, "Cross-currency payments are not supported by the fork attestor");
  }
  return {
    intentHash: intent.intentHash,
    method: hashString("revolut"),
    payeeId: hashString(username),
    amount: amountMinor,
    currency: intent.fiatCurrency,
    timestampMs: tx.completedDate,
    paymentId: hashString(tx.id.trim()),
  };
}

/** UnifiedPaymentVerifier.validatePaymentAgainstContext, in its check order and wording. */
function validate(payment: NormalizedPayment, intent: IntentDetails): bigint {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(payment.method, intent.paymentMethod)) throw new HttpError(400, "UnifiedPaymentVerifier: payment method mismatch");
  if (!eq(payment.currency, intent.fiatCurrency)) throw new HttpError(400, "UnifiedPaymentVerifier: currency mismatch");
  if (!eq(payment.payeeId, intent.payeeDetails)) throw new HttpError(400, "UnifiedPaymentVerifier: payee mismatch");
  if (BigInt(payment.timestampMs) + BigInt(intent.timestampBufferMs) < BigInt(intent.timestampMs)) {
    throw new HttpError(400, "UnifiedPaymentVerifier: payment timestamp before intent window");
  }
  if (!eq(intent.intentHash, payment.intentHash)) throw new HttpError(400, "UnifiedPaymentVerifier: intent hash mismatch");
  if (intent.conversionRate <= 0n) throw new HttpError(400, "UnifiedPaymentVerifier: invalid conversion rate");
  if (payment.amount <= 0n) throw new HttpError(400, "UnifiedPaymentVerifier: payment amount must be positive");
  const release = (payment.amount * PRECISE_UNIT * USDC_SCALE) / intent.conversionRate;
  const capped = release > intent.amount ? intent.amount : release;
  if (capped <= 0n) throw new HttpError(400, "UnifiedPaymentVerifier: release amount must be positive");
  return capped;
}

/** paymentDetailsEncoder.encodePaymentDetails: two static tuples, concatenated. */
export function encodePaymentDetails(payment: NormalizedPayment, intent: IntentDetails): Hex {
  const bufferSeconds = intent.timestampBufferMs === 0 ? 0n : (BigInt(intent.timestampBufferMs) + 999n) / 1000n;
  const paymentTuple = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }] }],
    [[payment.method, payment.payeeId, payment.amount, payment.currency, BigInt(payment.timestampMs), payment.paymentId]],
  );
  const snapshotTuple = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { type: "bytes32" },
          { type: "uint256" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
        ],
      },
    ],
    [
      [
        intent.intentHash,
        intent.amount,
        intent.paymentMethod,
        intent.fiatCurrency,
        intent.payeeDetails,
        intent.conversionRate,
        BigInt(intent.timestampMs) / 1000n,
        bufferSeconds,
      ],
    ],
  );
  return concat([paymentTuple, snapshotTuple]);
}

/** keccak256(abi.encode(EIP712Domain typehash, name, version, chainId, verifyingContract)), as the verifier's constructor computes it. */
export function domainSeparator(chainId: number, verifyingContract: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(stringToHex(UNIFIED_PAYMENT_DOMAIN.name)),
        keccak256(stringToHex(UNIFIED_PAYMENT_DOMAIN.version)),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );
}

/** One `/buyer/verify` call: HTTP status and the ServiceResponse body, plus a log entry. */
export async function verifyBuyerTee(
  platform: string,
  actionType: string,
  body: unknown,
  ctx: VerifyContext,
): Promise<{ status: number; body: unknown; decision: VerifyDecision }> {
  const intentHash = (body as { intent?: { intentHash?: string } } | null)?.intent?.intentHash ?? null;
  const params = (body as { params?: unknown } | null)?.params ?? null;
  const fail = (status: number, message: string) => ({
    status,
    body: { success: false, message, responseObject: null, statusCode: status },
    decision: { at: Date.now(), platform, actionType, status, message, intentHash, params },
  });
  if (!(BUYER_TEE_PLATFORMS as readonly string[]).includes(platform)) return fail(400, "Invalid buyer TEE platform path parameter");
  try {
    const request = parseRequest(body);
    if (platform !== "revolut" || actionType !== "transfer_revolut") throw new HttpError(400, "Unknown buyer TEE verifier");
    if (request.chainId !== ctx.chainId) {
      throw new HttpError(400, `Chain ID mismatch: requested ${request.chainId} but production deployment uses chain ${ctx.chainId}`);
    }
    const session = await decryptSession(request.encrypted, ctx.uploadKey, platform, actionType);
    const payment = revolutTransform(session, request.params, request.intent, ctx.bank);
    const releaseAmount = validate(payment, request.intent);
    const encodedPaymentDetails = encodePaymentDetails(payment, request.intent);
    const dataHash = keccak256(encodedPaymentDetails);
    const domain = { ...UNIFIED_PAYMENT_DOMAIN, chainId: request.chainId, verifyingContract: ctx.verifyingContract };
    const typedDataValue = { intentHash: request.intent.intentHash, releaseAmount: releaseAmount.toString(), dataHash };
    if (!ctx.witness.signTypedData) throw new Error("witness cannot sign typed data");
    const signature = await ctx.witness.signTypedData({
      domain,
      types: UNIFIED_PAYMENT_TYPES,
      primaryType: "PaymentAttestation",
      message: { intentHash: request.intent.intentHash, releaseAmount, dataHash },
    });
    const responseObject = {
      platform,
      actionType,
      signature,
      signer: ctx.witness.address,
      domainSeparator: domainSeparator(request.chainId, ctx.verifyingContract).toLowerCase(),
      typeHash: UNIFIED_PAYMENT_TYPEHASH,
      typedDataSpec: { primaryType: "PaymentAttestation", types: UNIFIED_PAYMENT_TYPES },
      typedDataValue,
      proofInput: JSON.stringify({ ...(body as object), encryptedSessionMaterial: "[redacted]" }),
      encodedPaymentDetails,
      metadata: encodeAbiParameters([{ type: "string" }], [JSON.stringify({ source: "buyer-tee" })]),
    };
    return {
      status: 200,
      body: { success: true, message: "Attestation output", responseObject, statusCode: 200 },
      decision: {
        at: Date.now(),
        platform,
        actionType,
        status: 200,
        message: "Attestation output",
        intentHash,
        params,
        releaseAmount: releaseAmount.toString(),
        paymentId: payment.paymentId,
      },
    };
  } catch (error) {
    if (error instanceof HttpError) return fail(error.status, error.message);
    return fail(500, `${platform} buyer TEE flow failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
