/**
 * Read-only access to Base and the Peer contracts. Everything a handler needs
 * from the chain goes through ChainGateway so tests can substitute fixtures.
 */

import { getContracts, Zkp2pClient } from "@zkp2p/sdk";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import type { Hex, PublicClient } from "viem";
import { base } from "viem/chains";
import { baseRpcUrl } from "./env.js";

export const CHAIN_ID = 8453;
export const PEER_API_URL = "https://api.zkp2p.xyz";
export const USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/**
 * EscrowV2's per-deposit switch for a payment method. The protocol viewer
 * (and so the SDK's getDeposit) still lists methods the seller turned off
 * with setPaymentMethodActive(false), but signalIntent reverts on them.
 */
export const PAYMENT_METHOD_ACTIVE_ABI = parseAbi([
  "function getDepositPaymentMethodActive(uint256 _depositId, bytes32 _paymentMethod) view returns (bool)",
]);
/** The SDK requires an account; the server never signs, so any fixed address works. */
const READ_ONLY_ACCOUNT = "0x0000000000000000000000000000000000000001";

/** Lowercase addresses of the production Peer deployment. */
export interface PeerContracts {
  /** The escrow `signalIntent` accepts; stalls must live here. */
  escrow: string;
  escrows: string[];
  orchestrators: string[];
  /** Contracts allowed to emit PaymentVerified. */
  verifiers: string[];
  usdc: string;
}

export function peerContracts(): PeerContracts {
  const { addresses } = getContracts(CHAIN_ID, "production");
  const lower = (list: Array<string | undefined>) =>
    [...new Set(list.filter((a): a is string => typeof a === "string").map((a) => a.toLowerCase()))];
  return {
    escrow: addresses.escrow.toLowerCase(),
    escrows: lower([addresses.escrow, addresses.escrowV2, ...(addresses.escrowAddresses ?? [])]),
    orchestrators: lower([
      addresses.orchestrator,
      addresses.orchestratorV2,
      addresses.orchestratorV3,
      ...(addresses.orchestratorAddresses ?? []),
    ]),
    verifiers: lower([addresses.unifiedPaymentVerifier]),
    usdc: (addresses.usdc ?? USDC_ADDRESS).toLowerCase(),
  };
}

export interface DepositRead {
  depositId: bigint;
  depositor: string;
  token: string;
  acceptingIntents: boolean;
  /** Token units available to new intents. */
  available: bigint;
  paymentMethods: Array<{
    /** bytes32 payment method hash. */
    hash: Hex;
    /** False when the seller has switched the method off; intents on it revert. */
    active: boolean;
    currencies: Array<{ code: Hex; minConversionRate: bigint }>;
  }>;
}

export interface ReceiptLog {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number;
}

export interface ReceiptRead {
  status: "success" | "reverted";
  /** Block timestamp, ms. */
  blockTimestampMs: number;
  logs: ReceiptLog[];
}

/** An EIP-4361 (Sign-In with Ethereum) proof to check. */
export interface SiweProof {
  message: string;
  signature: Hex;
  /** The message must name this domain, nonce and address and be valid at `time`. */
  domain: string;
  nonce: string;
  address: Hex;
  time: Date;
}

export interface ChainGateway {
  contracts: PeerContracts;
  /**
   * The deposit on the current escrow, or null when it does not exist. Each
   * payment method carries EscrowV2's active flag. RPC failures throw.
   */
  readDeposit(depositId: bigint): Promise<DepositRead | null>;
  /** EscrowV2's effective rate (oracle and rate-manager aware), or null if unavailable. */
  effectiveRate(depositId: bigint, paymentMethod: Hex, currency: Hex): Promise<bigint | null>;
  /** The mined receipt, or null when the transaction is unknown or pending. */
  getReceipt(tx: Hex): Promise<ReceiptRead | null>;
  /**
   * Parses and validates the SIWE message (domain, nonce, address, time), then
   * checks the signature, accepting ERC-1271 and ERC-6492 smart wallets.
   */
  verifySiweMessage(proof: SiweProof): Promise<boolean>;
}

/** The SDK's error when no configured escrow has the deposit (as opposed to an RPC failure). */
function isMissingDeposit(err: unknown): boolean {
  return err instanceof Error && /deposit not found/i.test(err.message);
}

/** viem's error for an unknown or still-pending transaction. */
function isMissingReceipt(err: unknown): boolean {
  return err instanceof Error && err.name === "TransactionReceiptNotFoundError";
}

export function createChainGateway(rpcUrl: string = baseRpcUrl()): ChainGateway {
  const transport = http(rpcUrl, { timeout: 10_000, retryCount: 2 });
  const publicClient = createPublicClient({ chain: base, transport }) as PublicClient;
  const walletClient = createWalletClient({ account: READ_ONLY_ACCOUNT, chain: base, transport });
  const client = new Zkp2pClient({
    walletClient,
    chainId: CHAIN_ID,
    runtimeEnv: "production",
    baseApiUrl: PEER_API_URL,
    rpcUrl,
    timeouts: { api: 10_000 },
  });
  const contracts = peerContracts();

  return {
    contracts,
    async readDeposit(depositId) {
      let view: Awaited<ReturnType<Zkp2pClient["getDeposit"]>>;
      try {
        // Production has a single upgraded escrow, which getDeposit tries first.
        view = await client.getDeposit(depositId);
      } catch (err) {
        if (isMissingDeposit(err)) return null;
        throw err;
      }
      const escrow = contracts.escrow as Hex;
      const active = await Promise.all(
        view.paymentMethods.map((pm) =>
          publicClient.readContract({
            address: escrow,
            abi: PAYMENT_METHOD_ACTIVE_ABI,
            functionName: "getDepositPaymentMethodActive",
            args: [view.depositId, pm.paymentMethod as Hex],
          }),
        ),
      );
      return {
        depositId: view.depositId,
        depositor: view.deposit.depositor.toLowerCase(),
        token: view.deposit.token.toLowerCase(),
        acceptingIntents: view.deposit.acceptingIntents,
        available: view.availableLiquidity,
        paymentMethods: view.paymentMethods.map((pm, i) => ({
          hash: pm.paymentMethod as Hex,
          active: active[i] === true,
          currencies: pm.currencies.map((c) => ({ code: c.code as Hex, minConversionRate: c.minConversionRate })),
        })),
      };
    },
    async effectiveRate(depositId, paymentMethod, currency) {
      try {
        const rate = await client.getEffectiveRate({
          escrow: contracts.escrow as Hex,
          depositId,
          paymentMethod,
          fiatCurrency: currency,
        });
        return rate > 0n ? rate : null;
      } catch {
        return null;
      }
    },
    async getReceipt(tx) {
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: tx });
      } catch (err) {
        if (isMissingReceipt(err)) return null;
        throw err;
      }
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      return {
        status: receipt.status,
        blockTimestampMs: Number(block.timestamp) * 1000,
        logs: receipt.logs.map((log) => ({
          address: log.address.toLowerCase(),
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex,
        })),
      };
    },
    async verifySiweMessage({ message, signature, domain, nonce, address, time }) {
      return publicClient.verifySiweMessage({ message, signature, domain, nonce, address, time });
    },
  };
}
