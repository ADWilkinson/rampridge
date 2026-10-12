/**
 * Per-wallet browser persistence for the sell flow. The pending record is
 * written before the deposit transaction is sent and cleared only once the
 * order is fully listed (or provably never sent), so a refresh, crash or
 * second tab can always find and finish an in-flight deposit instead of
 * creating a duplicate. Payee handles are deliberately not stored.
 */

import type { Hex } from "viem";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

let fallbackStorage: KeyValueStorage | null = null;

/** localStorage when usable (private modes can throw), otherwise an in-memory store for this session. */
export function browserStorage(): KeyValueStorage {
  try {
    if (typeof localStorage !== "undefined") {
      const probe = "rampridge:sell:probe";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    // Storage disabled: fall through to memory.
  }
  fallbackStorage ??= memoryStorage();
  return fallbackStorage;
}

export type PendingSellStage =
  /** The deposit batch was handed to the wallet; outcome unknown until confirmed. */
  | "sending"
  /** createDeposit confirmed; `depositId` is known. Access policies may remain. */
  | "deposited";

/** Wallet state read just before the deposit batch was sent, the reference recovery compares against. */
export interface PendingSellBaseline {
  /** Mined (`latest`) transaction count of the wallet. */
  nonce: number;
  /** The address had contract code (smart account, Safe, EIP-7702 delegation). */
  isContract: boolean;
  /** USDC balance, base units as a decimal string. */
  usdcBalance: string;
}

export interface PendingSellRecord {
  v: 1;
  /** Lowercase depositor address. */
  owner: string;
  stage: PendingSellStage;
  /** ms since epoch when the deposit batch was about to be sent. */
  startedAt: number;
  /** Deposit amount, USDC base units as a decimal string. */
  amount: string;
  legs: { platform: string; currencies: string[] }[];
  /** The seller's spread on the oracle rate, basis points; absent for the market rate. */
  spreadBps?: number;
  /** Deposit ids the wallet already had before sending, when the indexer answered. */
  knownDepositIds: string[] | null;
  /** Null when the chain could not be read before sending. */
  baseline?: PendingSellBaseline | null;
  /** Payment-method hashes that need a post-deposit Peer Pay policy. */
  accessPolicyPaymentMethods: Hex[];
  /** Confirmed policy transactions by payment-method hash. */
  policyTxHashes: Record<string, Hex>;
  /** Policy transactions the wallet submitted but never saw confirm, by payment-method hash. */
  pendingPolicyTxHashes?: Record<string, Hex>;
  /** Payment methods the chain shows restricted although no confirmed transaction hash is on record. */
  policyVerified?: Hex[];
  createTxHash?: Hex;
  depositId?: string;
}

export interface PendingSellStore {
  read(owner: string): PendingSellRecord | null;
  write(record: PendingSellRecord): void;
  clear(owner: string): void;
}

const pendingKey = (owner: string) => `rampridge:sell:pending:${owner.toLowerCase()}`;
const lastKey = (owner: string) => `rampridge:sell:last:${owner.toLowerCase()}`;

const HEX = /^0x[0-9a-fA-F]+$/;

function isHexList(value: unknown): value is Hex[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && HEX.test(v));
}

function isHexMap(value: unknown): value is Record<string, Hex> {
  return Boolean(value) && typeof value === "object" && Object.values(value as object).every((v) => typeof v === "string" && HEX.test(v));
}

function parseBaseline(value: unknown): PendingSellBaseline | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Partial<PendingSellBaseline>;
  if (typeof b.nonce !== "number" || !Number.isSafeInteger(b.nonce) || b.nonce < 0) return null;
  if (typeof b.isContract !== "boolean" || typeof b.usdcBalance !== "string" || !/^\d+$/.test(b.usdcBalance)) return null;
  return { nonce: b.nonce, isContract: b.isContract, usdcBalance: b.usdcBalance };
}

/**
 * A malformed optional field is dropped rather than the record: losing the
 * record would lose its duplicate protection, while a missing field only
 * makes recovery more conservative.
 */
function sanitizeOptional(r: PendingSellRecord): PendingSellRecord {
  const { baseline, pendingPolicyTxHashes, policyVerified, ...rest } = r;
  return {
    ...rest,
    baseline: parseBaseline(baseline),
    ...(isHexMap(pendingPolicyTxHashes) ? { pendingPolicyTxHashes } : {}),
    ...(isHexList(policyVerified) ? { policyVerified } : {}),
  };
}

function parsePending(raw: string, owner: string): PendingSellRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const r = data as Partial<PendingSellRecord>;
  if (r.v !== 1 || r.owner !== owner.toLowerCase()) return null;
  if (r.stage !== "sending" && r.stage !== "deposited") return null;
  if (typeof r.startedAt !== "number" || typeof r.amount !== "string" || !/^\d+$/.test(r.amount)) return null;
  if (!Array.isArray(r.legs) || !isHexList(r.accessPolicyPaymentMethods)) return null;
  if (r.knownDepositIds !== null && !Array.isArray(r.knownDepositIds)) return null;
  if (!r.policyTxHashes || typeof r.policyTxHashes !== "object") return null;
  if (r.stage === "deposited" && typeof r.depositId !== "string") return null;
  // Storage is untrusted: a spread outside Peer's range is dropped (the record itself still recovers).
  if (r.spreadBps !== undefined && !(Number.isInteger(r.spreadBps) && Math.abs(r.spreadBps) <= 500)) delete r.spreadBps;
  return sanitizeOptional(r as PendingSellRecord);
}

export function createPendingSellStore(storage: KeyValueStorage = browserStorage()): PendingSellStore {
  return {
    read(owner) {
      let raw: string | null = null;
      try {
        raw = storage.getItem(pendingKey(owner));
      } catch {
        return null;
      }
      return raw ? parsePending(raw, owner) : null;
    },
    write(record) {
      // A failed write must surface: without the record a refresh could not recover the deposit.
      storage.setItem(pendingKey(record.owner), JSON.stringify({ ...record, owner: record.owner.toLowerCase() }));
    },
    clear(owner) {
      try {
        storage.removeItem(pendingKey(owner));
      } catch {
        // Nothing to clear.
      }
    },
  };
}

let defaultStore: PendingSellStore | null = null;

export function defaultPendingSellStore(): PendingSellStore {
  defaultStore ??= createPendingSellStore();
  return defaultStore;
}

export interface LastSellDeposit {
  depositId: string;
  txHash: Hex | null;
  /** ms since epoch. */
  at: number;
}

/** Remembers the most recent deposit this wallet created here, for resuming its live view after a reload. */
export function rememberLastSellDeposit(owner: string, value: LastSellDeposit, storage: KeyValueStorage = browserStorage()): void {
  try {
    storage.setItem(lastKey(owner), JSON.stringify(value));
  } catch {
    // Best effort: the order itself is always recoverable from the chain.
  }
}

export function readLastSellDeposit(owner: string, storage: KeyValueStorage = browserStorage()): LastSellDeposit | null {
  try {
    const raw = storage.getItem(lastKey(owner));
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<LastSellDeposit>;
    if (typeof data.depositId !== "string" || typeof data.at !== "number") return null;
    return { depositId: data.depositId, txHash: typeof data.txHash === "string" ? (data.txHash as Hex) : null, at: data.at };
  } catch {
    return null;
  }
}
