/**
 * Golden fixture schema: real buyer fulfilments on Base, recorded as
 * transaction hashes plus the decoded, public parameters needed to assert
 * against. Nothing here is a payee handle: payees appear only as the on-chain
 * payee hash and, for the Curator lookup, a keccak256 of the handle.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";

export interface GoldenFulfilment {
  id: string;
  /** Peer payment-method name from the SDK catalog (also RampRidge's BuyPlatformId). */
  platform: string;
  /** ISO fiat code. */
  currency: string;
  intentHash: Hex;
  orchestrator: Address;
  escrow: Address;
  depositId: string;
  owner: Address;
  to: Address;
  /** Gross USDC the intent reserved (base units). */
  amount: string;
  /** Fiat per USDC, 18 decimals. */
  conversionRate: string;
  paymentMethod: Hex;
  fiatCurrency: Hex;
  /** On-chain payee hash of the deposit's payment method. */
  payeeDetails: Hex;
  /** Intent timestamp (s). */
  signaledAt: number;
  referralFees: { recipient: Address; fee: string }[];
  signal: {
    txHash: Hex;
    blockNumber: number;
    /** msg.sender of signalIntent (the intent owner). */
    caller: Address;
    /** The transaction itself was the signalIntent call (not a bundled user operation). */
    direct: boolean;
    suffixCodes: string[] | null;
    /** Curator gating-signature expiry (s). */
    signatureExpiration: number;
    /** EscrowV2 FundsLocked expiryTime at signal (s). */
    lockExpiry: number;
    /** The escrow lock's expiryTime in the block before the fulfilment (s); later than lockExpiry when the intent was extended. */
    lockExpiryAtFulfil: number;
    gatingSignatureLength: number;
  };
  fulfil: {
    txHash: Hex;
    blockNumber: number;
    /** Block timestamp (s). */
    blockTimestamp: number;
    /** msg.sender of fulfillIntent. */
    caller: Address;
    direct: boolean;
    txFrom: Address;
    suffixCodes: string[] | null;
    /** releaseAmount the attestation signed (base units). */
    releaseAmount: string;
    /** IntentFulfilled amount: what the recipient received after fees (base units). */
    netAmount: string;
    fundsTransferredTo: Address;
    signer: Address;
    signatureCount: number;
    attestationSource: string | null;
    metadataKeys: string[];
    /** Payment amount in fiat minor units, as attested. */
    paymentAmountMinor: string;
    paymentTimestampMs: string;
    timestampBufferSeconds: number;
    dataHash: Hex;
    postIntentHookData: Hex;
  };
  payeeLookup: {
    /** Curator returned a handle for (platform, payeeDetails). */
    found: boolean;
    /** keccak256(utf8(handle)) of that handle, never the handle itself. */
    handleKeccak: Hex | null;
    /** keccak256(utf8(handle)) equals the on-chain payee hash. */
    handleHashesToPayee: boolean;
  };
}

export interface GoldenFixtureFile {
  generatedAt: string;
  scannedBlocks: { from: number; to: number };
  /** Fulfilments seen while scanning, by platform and attestation source (for coverage reporting). */
  seen: Record<string, Record<string, number>>;
  cases: GoldenFulfilment[];
}

export const FIXTURE_PATH = fileURLToPath(new URL("../fixtures/fulfilments.json", import.meta.url));

export function loadFixtures(): GoldenFixtureFile {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenFixtureFile;
}
