import {
  createWalletClient,
  custom,
  hexToBigInt,
  hexToBytes,
  isHex,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
} from "viem";
import { WALLET_CHAIN } from "./constants";
import { addressesEqual } from "./format";
import type { NormalizedCall } from "./sequence";

/** Minimal EIP-1193 surface shared by Privy, injected and WalletConnect providers. */
export interface Eip1193Like {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

type TypedDataField = { name: string; type: string };

/**
 * EIP-712 payload as carried by `eth_signTypedData_v4`, in the viem shape:
 * `types` never contains `EIP712Domain`, because viem-style signers (smart
 * wallet client, Privy cross-app) derive it from `domain`.
 */
export interface TypedDataPayload {
  domain: Record<string, unknown>;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
  /**
   * The caller's own `EIP712Domain` field list, when it sent one. A raw
   * EIP-1193 signer derives the domain separator from it, so it is passed back
   * unchanged to those signers (see `signTypedDataWith`).
   */
  domainType?: TypedDataField[];
}

export interface RoutedProviderHandlers {
  address: Address;
  /** `personal_sign`: the message bytes, hex encoded. */
  signMessage(message: Hex): Promise<Hex>;
  signTypedData(payload: TypedDataPayload): Promise<Hex>;
  /** Sends one transaction through the wallet's TxSender and resolves with its hash once confirmed. */
  sendTransaction(call: NormalizedCall): Promise<Hash>;
  /** Read-only JSON-RPC (eth_call, eth_getBalance, ...), served by the public Base client. */
  read(method: string, params: unknown): Promise<unknown>;
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

const SIGNING_METHODS_UNSUPPORTED = new Set([
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v1",
  "eth_signTypedData_v3",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
  "wallet_showCallsStatus",
  "wallet_getCapabilities",
  "wallet_addEthereumChain",
  "wallet_watchAsset",
  "wallet_requestPermissions",
  "wallet_getPermissions",
]);

function firstParam(params: unknown): unknown {
  return Array.isArray(params) ? params[0] : undefined;
}

function parseTypedData(raw: unknown): TypedDataPayload {
  const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof value !== "object" || value === null) throw rpcError(-32602, "Invalid typed data");
  const record = value as Record<string, unknown>;
  const types = record.types;
  if (typeof types !== "object" || types === null || typeof record.primaryType !== "string") {
    throw rpcError(-32602, "Invalid typed data");
  }
  const { EIP712Domain: domainType, ...messageTypes } = types as Record<string, TypedDataField[] | undefined>;
  return {
    domain: normalizeDomain(record.domain),
    types: messageTypes as TypedDataPayload["types"],
    primaryType: record.primaryType,
    message: (record.message ?? {}) as Record<string, unknown>,
    ...(Array.isArray(domainType) ? { domainType } : {}),
  };
}

/**
 * viem serialises a bigint `chainId` as a decimal string. Signers that derive
 * `EIP712Domain` from `domain` only count a numeric `chainId`, so a string one
 * would silently drop the chain from the domain separator.
 */
function normalizeDomain(raw: unknown): Record<string, unknown> {
  const domain = { ...((typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>) };
  const { chainId } = domain;
  if (typeof chainId === "string" && /^(0x[0-9a-f]+|\d+)$/i.test(chainId)) {
    const value = Number(chainId);
    if (Number.isSafeInteger(value)) domain.chainId = value;
  }
  return domain;
}

function parseTransaction(raw: unknown, address: Address): NormalizedCall {
  if (typeof raw !== "object" || raw === null) throw rpcError(-32602, "Invalid transaction");
  const tx = raw as Record<string, unknown>;
  if (typeof tx.from === "string" && !addressesEqual(tx.from, address)) {
    throw rpcError(4100, "Transaction sender does not match the connected wallet");
  }
  if (typeof tx.chainId === "string" && isHex(tx.chainId) && Number(hexToBigInt(tx.chainId)) !== WALLET_CHAIN.id) {
    throw rpcError(4901, "This wallet only transacts on Base");
  }
  if (typeof tx.to !== "string" || !isHex(tx.to) || tx.to.length !== 42) {
    throw rpcError(-32602, "Contract deployment is not supported");
  }
  const data = typeof tx.data === "string" && isHex(tx.data) ? tx.data : "0x";
  const value = typeof tx.value === "string" && isHex(tx.value) ? hexToBigInt(tx.value) : 0n;
  return { to: tx.to as Address, data, value };
}

/**
 * An EIP-1193 provider whose account is the TxSender's address. Signing goes to
 * the wallet behind the sender and transactions go through `sendCalls`, so a
 * viem WalletClient (or an SDK holding one) behaves exactly like the sender:
 * the smart account is `msg.sender`, gas is sponsored where the sender is, and
 * `eth_sendTransaction` resolves after the transaction confirms.
 */
export function createRoutedProvider(handlers: RoutedProviderHandlers): Eip1193Like {
  const { address } = handlers;
  return {
    async request({ method, params }) {
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return [address];
        case "eth_chainId":
          return toHex(WALLET_CHAIN.id);
        case "net_version":
          return String(WALLET_CHAIN.id);
        case "wallet_switchEthereumChain": {
          const target = firstParam(params) as { chainId?: unknown } | undefined;
          if (typeof target?.chainId === "string" && Number(target.chainId) === WALLET_CHAIN.id) return null;
          throw rpcError(4902, "This wallet only transacts on Base");
        }
        case "personal_sign": {
          const list = Array.isArray(params) ? params : [];
          const [first, second] = list;
          // Some callers send [address, message]; the spec order is [message, address].
          const message = typeof first === "string" && addressesEqual(first, address) ? second : first;
          const signer = message === first ? second : first;
          if (typeof signer === "string" && !addressesEqual(signer, address)) {
            throw rpcError(4100, "Signer does not match the connected wallet");
          }
          if (typeof message !== "string" || !isHex(message)) throw rpcError(-32602, "personal_sign expects hex data");
          return handlers.signMessage(message);
        }
        case "eth_signTypedData_v4": {
          const list = Array.isArray(params) ? params : [];
          if (typeof list[0] === "string" && !addressesEqual(list[0], address)) {
            throw rpcError(4100, "Signer does not match the connected wallet");
          }
          return handlers.signTypedData(parseTypedData(list[1]));
        }
        case "eth_sendTransaction":
        case "wallet_sendTransaction":
          return handlers.sendTransaction(parseTransaction(firstParam(params), address));
        default:
          if (SIGNING_METHODS_UNSUPPORTED.has(method)) throw rpcError(4200, `${method} is not supported`);
          return handlers.read(method, params);
      }
    },
  };
}

/**
 * Signs typed data through a raw EIP-1193 wallet (embedded or external EOA).
 * Such wallets hash the domain with `types.EIP712Domain`; MetaMask and Rabby
 * treat a missing entry as an empty domain and sign the wrong separator. viem
 * adds `EIP712Domain` (derived from `domain`) unless the caller's own list is
 * passed back, which keeps the exact domain type the caller asked for.
 */
export function signTypedDataWith(client: WalletClient, address: Address, payload: TypedDataPayload): Promise<Hex> {
  const types = payload.domainType ? { EIP712Domain: payload.domainType, ...payload.types } : payload.types;
  return client.signTypedData({
    account: address,
    domain: payload.domain,
    types,
    primaryType: payload.primaryType,
    message: payload.message,
  });
}

/** A viem WalletClient on Base whose `account.address` is `address`, backed by `provider`. */
export function walletClientFor(address: Address, provider: Eip1193Like): WalletClient {
  return createWalletClient({
    account: address,
    chain: WALLET_CHAIN,
    // Wallet prompts must never be retried automatically: a retry is a second prompt or a second transaction.
    transport: custom(provider, { retryCount: 0 }),
  });
}

/**
 * Decodes `personal_sign` hex back to text when it is valid UTF-8. Wallet APIs
 * that take a string (Privy cross-app, smart-wallet UIs) then show and sign the
 * same text the caller signed; non-text payloads stay as hex.
 */
export function personalSignPayload(message: Hex): string | { raw: Hex } {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(message));
  } catch {
    return { raw: message };
  }
}
