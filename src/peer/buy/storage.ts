/**
 * Per-wallet persistence of the open buy order so a refresh or a closed tab
 * never loses it. The chain stays the source of truth (recovery re-reads it);
 * storage only keeps what the chain cannot give back cheaply, like the memo
 * and the chosen verify method. Every access tolerates blocked storage.
 */

import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import type { BuyQuoteFees } from "../market";
import { isBuyPlatformId, isFiatCode, recipientIdFor } from "../platforms";
import type { BuyOrder, OrderStatus } from "./types";

export interface OrderStorage {
  load(owner: Address): BuyOrder | null;
  save(order: BuyOrder): void;
  clear(owner: Address): void;
  /** Records that the player dismissed an expired order, so recovery never adopts it again. */
  dismiss(owner: Address, intentHash: Hex): void;
  /** Lowercase intent hashes the player dismissed on this device. */
  dismissed(owner: Address): ReadonlySet<string>;
}

const VERSION = 1;
const PREFIX = "rampridge:buy-order:";
const DISMISSED_PREFIX = "rampridge:buy-dismissed:";
/** Dismissals kept per wallet; an intent stops being adoptable a day after it was signalled, so a short list suffices. */
const MAX_DISMISSED = 50;

export function storageKey(owner: Address): string {
  return `${PREFIX}${owner.toLowerCase()}`;
}

export function dismissedKey(owner: Address): string {
  return `${DISMISSED_PREFIX}${owner.toLowerCase()}`;
}

type SerializedFees = Omit<BuyQuoteFees, "service" | "manager" | "referrer" | "total"> & {
  service: string;
  manager: string;
  referrer: string;
  total: string;
};

type Serialized = Omit<BuyOrder, "usdcGross" | "usdcExpected" | "rate" | "fiatToSend" | "fees"> & {
  v: number;
  usdcGross: string;
  usdcExpected: string;
  rate: string;
  fiatToSend: string;
  fees: SerializedFees | null;
};

function serializeFees(fees: BuyQuoteFees | null): SerializedFees | null {
  if (!fees) return null;
  return {
    ...fees,
    service: fees.service.toString(),
    manager: fees.manager.toString(),
    referrer: fees.referrer.toString(),
    total: fees.total.toString(),
  };
}

export function serializeOrder(order: BuyOrder): string {
  const data: Serialized = {
    ...order,
    v: VERSION,
    usdcGross: order.usdcGross.toString(),
    usdcExpected: order.usdcExpected.toString(),
    rate: order.rate.toString(),
    fiatToSend: order.fiatToSend.toString(),
    fees: serializeFees(order.fees),
  };
  return JSON.stringify(data);
}

function bigintField(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function bpsField(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Fees from a stored order; null when absent (orders saved before fees were kept) or malformed. */
function feesField(value: unknown): BuyQuoteFees | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const service = bigintField(data.service);
  const manager = bigintField(data.manager);
  const referrer = bigintField(data.referrer);
  const total = bigintField(data.total);
  const serviceBps = bpsField(data.serviceBps);
  const referrerBps = bpsField(data.referrerBps);
  if (
    service === null ||
    manager === null ||
    referrer === null ||
    total === null ||
    serviceBps === undefined ||
    referrerBps === undefined
  ) {
    return null;
  }
  return { serviceBps, service, manager, referrer, referrerBps, total };
}

function hexField(value: unknown): Hex | null {
  return typeof value === "string" && isHex(value) ? value : null;
}

function addressField(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value, { strict: false }) ? getAddress(value) : null;
}

const STATUSES: readonly OrderStatus[] = ["active", "fulfilled", "cancelled"];

/** A stored payment-link account id, kept only when it is valid for the order's platform. */
function recipientIdField(platform: BuyOrder["platform"], value: unknown): { recipientId?: string } {
  const recipientId = recipientIdFor(platform, value);
  return recipientId ? { recipientId } : {};
}

/** Parses a stored order, returning null for anything malformed or from another version. */
export function deserializeOrder(text: string): BuyOrder | null {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data.v !== VERSION) return null;
  const owner = addressField(data.owner);
  const escrow = addressField(data.escrow);
  const intentHash = hexField(data.intentHash);
  const payeeDetailsHash = hexField(data.payeeDetailsHash);
  const usdcGross = bigintField(data.usdcGross);
  const usdcExpected = bigintField(data.usdcExpected);
  const rate = bigintField(data.rate);
  const fiatToSend = bigintField(data.fiatToSend);
  const platform = typeof data.platform === "string" && isBuyPlatformId(data.platform) ? data.platform : null;
  const currency = typeof data.currency === "string" && isFiatCode(data.currency) ? data.currency : null;
  const status = STATUSES.find((s) => s === data.status) ?? null;
  if (
    !owner ||
    !escrow ||
    !intentHash ||
    !payeeDetailsHash ||
    usdcGross === null ||
    usdcExpected === null ||
    rate === null ||
    fiatToSend === null ||
    !platform ||
    !currency ||
    !status ||
    typeof data.depositId !== "string" ||
    typeof data.fiatToSendText !== "string" ||
    typeof data.signaledAt !== "number" ||
    typeof data.expiresAt !== "number"
  ) {
    return null;
  }
  return {
    owner,
    intentHash,
    depositId: data.depositId,
    escrow,
    orchestrator: addressField(data.orchestrator),
    platform,
    currency,
    usdcGross,
    usdcExpected,
    rate,
    fiatToSend,
    fiatToSendText: data.fiatToSendText,
    payeeHandle: typeof data.payeeHandle === "string" ? data.payeeHandle : null,
    ...(data.payeeBusiness === true ? { payeeBusiness: true } : {}),
    ...recipientIdField(platform, data.recipientId),
    payeeDetailsHash,
    signalTxHash: hexField(data.signalTxHash),
    signaledAt: data.signaledAt,
    expiresAt: data.expiresAt,
    verifyMethodId: typeof data.verifyMethodId === "string" ? data.verifyMethodId : null,
    memo: typeof data.memo === "string" ? data.memo : null,
    status,
    fees: feesField(data.fees),
    paidClaimedAt: typeof data.paidClaimedAt === "number" && Number.isFinite(data.paidClaimedAt) ? data.paidClaimedAt : null,
  };
}

/** Parses a stored dismissal list, ignoring anything that is not an intent hash. */
export function deserializeDismissed(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((h): h is string => typeof h === "string" && isHex(h) && h.length === 66).map((h) => h.toLowerCase());
  } catch {
    return [];
  }
}

/** The dismissal list with `intentHash` appended (once), newest last, capped. */
export function withDismissed(list: readonly string[], intentHash: Hex): string[] {
  const hash = intentHash.toLowerCase();
  return [...list.filter((h) => h !== hash), hash].slice(-MAX_DISMISSED);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** localStorage-backed order storage; silently no-ops when storage is unavailable. */
export const localOrderStorage: OrderStorage = {
  load(owner) {
    try {
      const text = safeStorage()?.getItem(storageKey(owner));
      if (!text) return null;
      const order = deserializeOrder(text);
      return order && order.owner.toLowerCase() === owner.toLowerCase() ? order : null;
    } catch {
      return null;
    }
  },
  save(order) {
    try {
      safeStorage()?.setItem(storageKey(order.owner), serializeOrder(order));
    } catch {
      // Storage full or blocked: recovery falls back to the chain.
    }
  },
  clear(owner) {
    try {
      safeStorage()?.removeItem(storageKey(owner));
    } catch {
      // Nothing to clear.
    }
  },
  dismiss(owner, intentHash) {
    try {
      const storage = safeStorage();
      const list = withDismissed(deserializeDismissed(storage?.getItem(dismissedKey(owner))), intentHash);
      storage?.setItem(dismissedKey(owner), JSON.stringify(list));
    } catch {
      // Storage blocked: the order may be offered again after a reload, where it can be dismissed again.
    }
  },
  dismissed(owner) {
    try {
      return new Set(deserializeDismissed(safeStorage()?.getItem(dismissedKey(owner))));
    } catch {
      return new Set();
    }
  },
};

/** In-memory storage for tests and storage-less environments. */
export function memoryOrderStorage(): OrderStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    load: (owner) => {
      const text = entries.get(storageKey(owner));
      return text ? deserializeOrder(text) : null;
    },
    save: (order) => {
      entries.set(storageKey(order.owner), serializeOrder(order));
    },
    clear: (owner) => {
      entries.delete(storageKey(owner));
    },
    dismiss: (owner, intentHash) => {
      entries.set(dismissedKey(owner), JSON.stringify(withDismissed(deserializeDismissed(entries.get(dismissedKey(owner))), intentHash)));
    },
    dismissed: (owner) => new Set(deserializeDismissed(entries.get(dismissedKey(owner)))),
  };
}
