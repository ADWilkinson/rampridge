/**
 * Peer protocol facts the parity suites assert against, all derived from the
 * installed SDK's production deployment (@zkp2p/sdk getContracts) or from
 * OrchestratorV3 itself (zkp2p-contracts contracts/OrchestratorV3.sol,
 * lib/ReferralFeeLib.sol), never restated from RampRidge's own code.
 */

import {
  getContracts,
  getGatingServiceAddress,
  getPaymentMethodsCatalog,
  resolveFiatCurrencyBytes32,
} from "@zkp2p/sdk";
import { Attribution } from "ox/erc8021";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  parseAbi,
  recoverMessageAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

const contracts = getContracts(8453, "production");

export const ESCROW: Address = getAddress(contracts.addresses.escrowV2 as Address);
export const ORCHESTRATOR: Address = getAddress(contracts.addresses.orchestratorV3 as Address);
export const USDC: Address = getAddress(contracts.addresses.usdc as Address);
export const WHITELIST_POLICY: Address = getAddress((contracts.addresses as { whitelistPolicy: Address }).whitelistPolicy);
export const GATING_SERVICE: Address = getAddress(getGatingServiceAddress(8453, "production") as Address);
export const ORCHESTRATOR_ABI = contracts.abis.orchestratorV3 as Abi;
export const ESCROW_ABI = (contracts.abis.escrowV2 ?? contracts.abis.escrow) as Abi;

/** The CDP paymaster allowlist RampRidge's Privy smart wallets are sponsored under (project memory, 2026-10-11). */
export const PAYMASTER_ALLOWLIST: ReadonlySet<string> = new Set([USDC, ESCROW, ORCHESTRATOR, WHITELIST_POLICY].map((a) => a.toLowerCase()));

/** Base builder code the SDK always appends last (packages/sdk/src/utils/attribution.ts BASE_BUILDER_CODE). */
export const BASE_BUILDER_CODE = "bc_nbn6qkni";
/** The Peer web app's ERC-8021 referrer (clients/web useSignalIntent txOverrides). */
export const WEB_REFERRER_CODE = "zkp2p-web";

const catalog = getPaymentMethodsCatalog(8453, "production");
const methodNameByHash = new Map(Object.entries(catalog).map(([name, entry]) => [entry.paymentMethodHash.toLowerCase(), name]));

export function paymentMethodHash(name: string): Hex {
  const entry = catalog[name];
  if (!entry) throw new Error(`No production payment method ${name}`);
  return entry.paymentMethodHash as Hex;
}

export function paymentMethodName(hash: Hex): string | null {
  return methodNameByHash.get(hash.toLowerCase()) ?? null;
}

export function currencyHash(code: string): Hex {
  return resolveFiatCurrencyBytes32(code) as Hex;
}

/** ERC-8021 codes on calldata, in order (empty when none). */
export function attributionCodes(data: Hex): string[] {
  try {
    const parsed = Attribution.fromData(data);
    return parsed && "codes" in parsed ? [...parsed.codes] : [];
  } catch {
    return [];
  }
}

export interface ReferralLeg {
  recipient: Address;
  fee: bigint;
}

/** OrchestratorV3 SignalIntentParams, as decoded from calldata. */
export interface SignalParams {
  escrow: Address;
  depositId: bigint;
  amount: bigint;
  to: Address;
  paymentMethod: Hex;
  fiatCurrency: Hex;
  conversionRate: bigint;
  gatingServiceSignature: Hex;
  signatureExpiration: bigint;
  postIntentHook: Address;
  data: Hex;
  referralFees: readonly ReferralLeg[];
  preIntentHookData: Hex;
}

export function decodeSignal(data: Hex): SignalParams {
  const decoded = decodeFunctionData({ abi: ORCHESTRATOR_ABI, data });
  if (decoded.functionName !== "signalIntent") throw new Error(`not signalIntent: ${decoded.functionName}`);
  return (decoded.args as readonly [SignalParams])[0];
}

/** ReferralFeeLib.hashReferralFees: keccak(abi.encode(bytes32[] of keccak(abi.encode(recipient, fee)))). */
export function hashReferralFees(legs: readonly ReferralLeg[]): Hex {
  const hashes = legs.map((leg) =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [leg.recipient, leg.fee])),
  );
  return keccak256(encodeAbiParameters([{ type: "bytes32[]" }], [hashes]));
}

/**
 * The signer of a gating signature for `caller`, recomputed exactly as
 * OrchestratorV3._isValidIntentGatingSignature does. Equal to the deposit's
 * gating service only when the signature is bound to this caller.
 */
export async function gatingSigner(params: SignalParams, caller: Address): Promise<Address> {
  const message = encodePacked(
    ["address", "address", "uint256", "uint256", "address", "address", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256"],
    [
      ORCHESTRATOR,
      params.escrow,
      params.depositId,
      params.amount,
      caller,
      params.to,
      params.paymentMethod,
      params.fiatCurrency,
      params.conversionRate,
      hashReferralFees(params.referralFees),
      params.signatureExpiration,
      8453n,
    ],
  );
  return recoverMessageAddress({ message: { raw: keccak256(message) }, signature: params.gatingServiceSignature });
}

// ---------------------------------------------------------------------------
// Fork reads
// ---------------------------------------------------------------------------

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
  referralFees: readonly ReferralLeg[];
  postIntentHook: Address;
  data: Hex;
}

export function readIntent(client: PublicClient, intentHash: Hex): Promise<OnchainIntent> {
  return client.readContract({
    address: ORCHESTRATOR,
    abi: ORCHESTRATOR_ABI,
    functionName: "getIntent",
    args: [intentHash],
  }) as Promise<OnchainIntent>;
}

export function accountIntents(client: PublicClient, owner: Address): Promise<readonly Hex[]> {
  return client.readContract({
    address: ORCHESTRATOR,
    abi: ORCHESTRATOR_ABI,
    functionName: "getAccountIntents",
    args: [owner],
  }) as Promise<readonly Hex[]>;
}

export interface DepositLiquidity {
  remainingDeposits: bigint;
  outstandingIntentAmount: bigint;
}

export async function readDeposit(client: PublicClient, depositId: bigint): Promise<DepositLiquidity> {
  const deposit = (await client.readContract({
    address: ESCROW,
    abi: ESCROW_ABI,
    functionName: "getDeposit",
    args: [depositId],
  })) as DepositLiquidity;
  return { remainingDeposits: deposit.remainingDeposits, outstandingIntentAmount: deposit.outstandingIntentAmount };
}

export async function readDepositIntent(
  client: PublicClient,
  depositId: bigint,
  intentHash: Hex,
): Promise<{ intentHash: Hex; amount: bigint; timestamp: bigint; expiryTime: bigint }> {
  return (await client.readContract({
    address: ESCROW,
    abi: ESCROW_ABI,
    functionName: "getDepositIntent",
    args: [depositId, intentHash],
  })) as { intentHash: Hex; amount: bigint; timestamp: bigint; expiryTime: bigint };
}

const GATING_ABI = parseAbi([
  "function getDepositGatingService(uint256 _depositId, bytes32 _paymentMethod) view returns (address)",
  "function getEffectiveRate(uint256 _depositId, bytes32 _paymentMethod, bytes32 _fiatCurrency) view returns (uint256)",
]);

export function depositGatingService(client: PublicClient, depositId: bigint, paymentMethod: Hex): Promise<Address> {
  return client.readContract({
    address: ESCROW,
    abi: GATING_ABI,
    functionName: "getDepositGatingService",
    args: [depositId, paymentMethod],
  });
}

export function effectiveRate(client: PublicClient, depositId: bigint, paymentMethod: Hex, fiatCurrency: Hex): Promise<bigint> {
  return client.readContract({
    address: ESCROW,
    abi: GATING_ABI,
    functionName: "getEffectiveRate",
    args: [depositId, paymentMethod, fiatCurrency],
  });
}

const PRECISE_UNIT = 10n ** 18n;

/**
 * USDC the intent releases to `to` when fulfilled in full, exactly as
 * OrchestratorV3._calculateAndTransferFees takes the fees: protocol fee,
 * each referral leg and the manager fee, each floored on the release amount.
 */
export function netRelease(amount: bigint, legs: readonly ReferralLeg[], managerFee: bigint, protocolFee = 0n): bigint {
  let fees = (amount * protocolFee) / PRECISE_UNIT;
  for (const leg of legs) fees += (amount * leg.fee) / PRECISE_UNIT;
  fees += (amount * managerFee) / PRECISE_UNIT;
  return amount - fees;
}
