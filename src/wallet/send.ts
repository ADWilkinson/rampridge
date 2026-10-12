/**
 * Sending USDC from the player's wallet to any address on Base: the transfer
 * call, the send itself (balance re-read, one at a time, never twice while an
 * earlier send's outcome is unknown) and the check that settles an unknown
 * outcome from the chain.
 */
import {
  decodeEventLog,
  erc20Abi,
  getAbiItem,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { estimateL1Fee } from "viem/op-stack";
import { USDC_ADDRESS, USDC_DECIMALS } from "@/config";
import { WALLET_CHAIN } from "./constants";
import { TransactionPendingError, WalletBusyError, WalletError, toWalletError } from "./errors";
import { addressesEqual, formatUnitsTruncated, shortAddress } from "./format";
import { checkRecipient } from "./recipient";
import { usdcTransferCall } from "./transfer";
import type { TxSender, UserOperationStatus } from "./types";
import { userOperationHashIn } from "./userOperation";

export { usdcTransferCall };

/** "25.00", "1,250.50", "0.001234": at least cents, every significant digit up to 6, never rounded up. */
export function formatSendAmount(amount: bigint): string {
  return formatUnitsTruncated(amount, USDC_DECIMALS, { minFractionDigits: 2, maxFractionDigits: USDC_DECIMALS });
}

/** The wallet prompt label, e.g. "Send 25.00 USDC to 0x1234…abcd". */
export function sendLabel(amount: bigint, to: Address): string {
  return `Send ${formatSendAmount(amount)} USDC to ${shortAddress(to)}`;
}

/** "You sent 25.00 USDC to 0x1234…abcd." for the chatbox. */
export function sentMessage(amount: bigint, to: Address): string {
  return `You sent ${formatSendAmount(amount)} USDC to ${shortAddress(to)}.`;
}

/** The wallet holds less USDC than the send, read right before sending. Nothing was sent. */
export class InsufficientUsdcError extends WalletError {
  readonly balance: bigint;
  readonly amount: bigint;

  constructor(balance: bigint, amount: bigint) {
    super(
      "invalid_request",
      balance === 0n
        ? "Your wallet has no USDC to send."
        : `You only have ${formatSendAmount(balance)} USDC now, less than this send.`,
      { mayHaveLanded: false },
    );
    this.name = "InsufficientUsdcError";
    this.balance = balance;
    this.amount = amount;
  }
}

/** An earlier send from this wallet has an unknown outcome; it must be checked before another one. */
export class SendUnconfirmedError extends WalletError {
  readonly record: PendingSend;

  constructor(record: PendingSend) {
    super("busy", "Your last send hasn't been confirmed yet. Check it before sending again.", { mayHaveLanded: false });
    this.name = "SendUnconfirmedError";
    this.record = record;
  }
}

// ---------------------------------------------------------------------------
// The send whose outcome is not known yet

/**
 * A send that was handed to the wallet and has not settled. Written before
 * the wallet is asked, so a reload mid-prompt still knows about it; cleared
 * when the send confirms or provably did not happen. While it exists no
 * other send starts from that wallet.
 */
export interface PendingSend {
  from: Address;
  to: Address;
  amount: bigint;
  /** Wall-clock ms when the send started. */
  startedAt: number;
  /** Latest block before the send: its Transfer can only be at or after this one. */
  fromBlock: bigint | null;
  /** USDC balance read right before sending. */
  balanceBefore: bigint;
  /** The transaction the wallet reported, when it reported one. */
  hash: Hash | null;
  /** A smart wallet's user operation, when the send got that far: its bundler can say how it ended. */
  userOpHash: Hash | null;
}

export interface PendingSendStore {
  read(from: Address): PendingSend | null;
  write(record: PendingSend): void;
  clear(from: Address): void;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PENDING_KEY_PREFIX = "rampridge:send:pending:";
/** A record this old is dropped on read: whatever happened to it is long visible in the wallet. */
export const PENDING_SEND_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

function encodeRecord(record: PendingSend): string {
  return JSON.stringify({
    ...record,
    amount: record.amount.toString(),
    balanceBefore: record.balanceBefore.toString(),
    fromBlock: record.fromBlock === null ? null : record.fromBlock.toString(),
  });
}

function decodeRecord(text: string): PendingSend | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw.from !== "string" || typeof raw.to !== "string" || typeof raw.amount !== "string") return null;
    if (typeof raw.startedAt !== "number" || typeof raw.balanceBefore !== "string") return null;
    return {
      from: raw.from as Address,
      to: raw.to as Address,
      amount: BigInt(raw.amount),
      startedAt: raw.startedAt,
      fromBlock: typeof raw.fromBlock === "string" ? BigInt(raw.fromBlock) : null,
      balanceBefore: BigInt(raw.balanceBefore),
      hash: typeof raw.hash === "string" ? (raw.hash as Hash) : null,
      userOpHash: typeof raw.userOpHash === "string" ? (raw.userOpHash as Hash) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Pending sends by wallet, in memory and (best effort) in `storage`, so a
 * reload or a second tab still refuses to send again. Storage can be missing
 * or throw (private mode, blocked site data); memory then carries it.
 */
export function createPendingSendStore(storage: KeyValueStorage | null, now: () => number = Date.now): PendingSendStore {
  const memory = new Map<string, PendingSend>();
  const key = (from: Address) => PENDING_KEY_PREFIX + from.toLowerCase();
  return {
    read(from) {
      let record = memory.get(from.toLowerCase()) ?? null;
      if (!record) {
        try {
          const text = storage?.getItem(key(from));
          record = text ? decodeRecord(text) : null;
        } catch {
          record = null;
        }
      }
      if (record && now() - record.startedAt > PENDING_SEND_MAX_AGE_MS) {
        this.clear(from);
        return null;
      }
      return record;
    },
    write(record) {
      memory.set(record.from.toLowerCase(), record);
      try {
        storage?.setItem(key(record.from), encodeRecord(record));
      } catch {
        // Memory keeps it for this page load.
      }
    },
    clear(from) {
      memory.delete(from.toLowerCase());
      try {
        storage?.removeItem(key(from));
      } catch {
        // Nothing stored.
      }
    },
  };
}

function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let defaultStore: PendingSendStore | null = null;

/** The app's pending sends (localStorage, shared by every tab of this browser). */
export function defaultPendingSends(): PendingSendStore {
  defaultStore ??= createPendingSendStore(browserStorage());
  return defaultStore;
}

// ---------------------------------------------------------------------------
// Chain reads

/** A USDC Transfer found on-chain. */
export interface FoundTransfer {
  hash: Hash;
  value: bigint;
}

/** The chain reads a send needs. `createSendChain(publicClient)` is the real one. */
export interface SendChain {
  usdcBalance(address: Address): Promise<bigint>;
  ethBalance(address: Address): Promise<bigint>;
  /** The latest block of the history `transfers` searches (so a search never runs past what it can see). */
  blockNumber(): Promise<bigint>;
  /** Contract code at the address ("0x" or undefined for none). */
  code(address: Address): Promise<Hex | undefined>;
  /** Runs the call as `from` (eth_call); rejects when it would revert. */
  simulate(from: Address, call: { to: Address; data: Hex }): Promise<void>;
  /** Network fee in wei for `from` to send the call itself (L2 execution plus L1 data). */
  estimateFee(from: Address, call: { to: Address; data: Hex }): Promise<bigint>;
  /** The mined receipt, or null while there is none. */
  receipt(hash: Hash): Promise<TransactionReceipt | null>;
  /** USDC Transfer logs `from` -> `to` in the inclusive block range. */
  transfers(args: { from: Address; to: Address; fromBlock: bigint; toBlock: bigint }): Promise<FoundTransfer[]>;
}

const TRANSFER_EVENT = getAbiItem({ abi: erc20Abi, name: "Transfer" });

/** L2 gas is estimated without fees; this covers fee movement between the estimate and the send. */
const FEE_MARGIN_PERCENT = 120n;

/**
 * The real chain reads. `history` serves the Transfer search and the block
 * number it runs to: Base's public RPC refuses eth_getLogs, so production
 * passes a client that answers it (`historyClient`).
 */
export function createSendChain(client: PublicClient, history: PublicClient = client): SendChain {
  return {
    usdcBalance: (address) =>
      client.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    ethBalance: (address) => client.getBalance({ address }),
    blockNumber: () => history.getBlockNumber({ cacheTime: 0 }),
    code: (address) => client.getCode({ address }),
    async simulate(from, call) {
      await client.call({ account: from, to: call.to, data: call.data });
    },
    async estimateFee(from, call) {
      const [gas, fees] = await Promise.all([
        client.estimateGas({ account: from, to: call.to, data: call.data }),
        client.estimateFeesPerGas(),
      ]);
      // Base charges an L1 data fee on top; it is small, and an estimate failure must not block a send.
      const l1 = await estimateL1Fee(client as never, { account: from, to: call.to, data: call.data, chain: WALLET_CHAIN }).catch(
        () => 0n,
      );
      return (gas * fees.maxFeePerGas * FEE_MARGIN_PERCENT) / 100n + l1;
    },
    async receipt(hash) {
      try {
        return await client.getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      }
    },
    async transfers({ from, to, fromBlock, toBlock }) {
      const logs = await history.getLogs({ address: USDC_ADDRESS, event: TRANSFER_EVENT, args: { from, to }, fromBlock, toBlock });
      return logs.flatMap((log) => (log.transactionHash && log.args.value !== undefined ? [{ hash: log.transactionHash, value: log.args.value }] : []));
    },
  };
}

// ---------------------------------------------------------------------------
// The send

export interface SendUsdcOptions {
  sender: TxSender;
  to: Address;
  amount: bigint;
  chain: Pick<SendChain, "usdcBalance" | "blockNumber">;
  pending: PendingSendStore;
  now?: () => number;
}

export interface SentUsdc {
  /** The transaction that carried the transfer (the bundle transaction for a smart wallet). */
  hash: Hash;
  amount: bigint;
  to: Address;
  receipt: TransactionReceipt;
}

const sending = new Set<string>();

/** True while a `sendUsdc` from this wallet is running in this page (its wallet prompt may still be open). */
export function isSendInFlight(address: Address): boolean {
  return sending.has(address.toLowerCase());
}

/**
 * Sends `amount` USDC (base units) from the sender's wallet to `to`.
 *
 * - Refuses (nothing sent) an invalid recipient, a zero amount, a wallet
 *   already sending, a wallet with an earlier send still unconfirmed
 *   (`SendUnconfirmedError`), and an amount above the balance read right
 *   before sending (`InsufficientUsdcError`).
 * - Goes through `TxSender.sendCalls`, so smart wallets are sponsored and the
 *   wallet's own errors arrive as `WalletError`s.
 * - When the wallet error says the send may have landed (`mayHaveLanded`), the
 *   pending record stays (with the hash when known) and blocks another send
 *   until `checkPendingSend` settles it. Any other failure clears it.
 */
export async function sendUsdc({ sender, to, amount, chain, pending, now = Date.now }: SendUsdcOptions): Promise<SentUsdc> {
  if (amount <= 0n) throw new WalletError("invalid_request", "Enter an amount above zero.", { mayHaveLanded: false });
  const recipient = checkRecipient(to, { self: sender.address });
  if (recipient.status !== "ok") {
    throw new WalletError("invalid_request", recipient.status === "invalid" ? recipient.message : "Enter a 0x address on Base.", {
      mayHaveLanded: false,
    });
  }
  const from = sender.address;
  const key = from.toLowerCase();
  if (sending.has(key)) throw new WalletBusyError();
  const earlier = pending.read(from);
  if (earlier) throw new SendUnconfirmedError(earlier);
  sending.add(key);
  try {
    let balance: bigint;
    try {
      balance = await chain.usdcBalance(from);
    } catch (error) {
      throw new WalletError("unknown", "Couldn't check your USDC balance on Base. Try again in a moment.", {
        cause: error,
        mayHaveLanded: false,
      });
    }
    if (balance < amount) throw new InsufficientUsdcError(balance, amount);
    const fromBlock = await chain.blockNumber().catch(() => null);
    const record: PendingSend = {
      from,
      to: recipient.address,
      amount,
      startedAt: now(),
      fromBlock,
      balanceBefore: balance,
      hash: null,
      userOpHash: null,
    };
    pending.write(record);
    let receipt: TransactionReceipt;
    try {
      receipt = await sender.sendCalls([usdcTransferCall(recipient.address, amount)], { label: sendLabel(amount, recipient.address) });
    } catch (error) {
      const walletError = toWalletError(error, { sending: true });
      if (walletError.mayHaveLanded) {
        pending.write({
          ...record,
          hash: walletError instanceof TransactionPendingError ? walletError.hash : null,
          userOpHash: userOperationHashIn(error),
        });
      } else {
        pending.clear(from);
      }
      throw walletError;
    }
    pending.clear(from);
    return { hash: receipt.transactionHash, amount, to: recipient.address, receipt };
  } finally {
    sending.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Settling a send whose outcome is unknown

export type SendCheck =
  /** The transfer is on Base. */
  | { status: "landed"; hash: Hash }
  /** Its transaction mined and reverted (or dropped the transfer): no USDC moved. */
  | { status: "failed"; hash: Hash }
  /** No sign of it yet. See `PendingCheck`. */
  | PendingCheck;

export interface PendingCheck {
  status: "pending";
  /**
   * The whole Transfer history from the send's start to the latest block was
   * searched and holds no such transfer. False while the search could not run
   * or has not reached the latest block yet.
   */
  scanned: boolean;
  /** The last block searched so far; the next check goes on from the block after it. Null when none was. */
  scannedThrough: bigint | null;
  /**
   * The balance is at least the amount lower than before the send, so it may
   * have gone through anyway (or something else spent it). Null when the
   * balance could not be read.
   */
  balanceDropped: boolean | null;
  /** The wallet's bundler still holds the user operation, so it can still go through. */
  queued: boolean;
}

export interface CheckPendingOptions {
  /** The wallet's bundler lookup (`TxSender.userOperationStatus`), for a smart wallet's user operation. */
  userOperationStatus?: (hash: Hash) => Promise<UserOperationStatus>;
  /** Where an earlier check's search stopped (`PendingCheck.scannedThrough`): this one continues from there. */
  scannedThrough?: bigint | null;
  /** Wall-clock ms, for placing a send with no recorded block. */
  now?: number;
}

/** Blocks per eth_getLogs request (some RPC plans cap a request at 500). */
export const LOG_CHUNK_BLOCKS = 450n;
/** Requests one check makes at most (about 4 hours of Base blocks); the next check carries on. */
export const MAX_LOG_REQUESTS_PER_CHECK = 16;
/** Base makes a block every 2 seconds. */
const BASE_BLOCK_MS = 2_000;
/** Without a recorded block, the search starts this far before the block the start time points to (10 minutes). */
const START_MARGIN_BLOCKS = 300n;

function transferInReceipt(receipt: TransactionReceipt, record: PendingSend): boolean {
  return receipt.logs.some((log) => {
    if (!addressesEqual(log.address, USDC_ADDRESS)) return false;
    try {
      const { args } = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics, strict: true });
      return addressesEqual(args.from, record.from) && addressesEqual(args.to, record.to) && args.value === record.amount;
    } catch {
      return false;
    }
  });
}

/** The first block the send's Transfer could be in: the recorded one, or one safely before its start time. */
function searchStart(record: PendingSend, latest: bigint, now: number): bigint {
  if (record.fromBlock !== null) return record.fromBlock;
  const elapsed = BigInt(Math.max(0, Math.ceil((now - record.startedAt) / BASE_BLOCK_MS)));
  const back = elapsed + START_MARGIN_BLOCKS;
  return latest > back ? latest - back : 0n;
}

/**
 * Looks for the pending send on Base, in order: the receipt of the
 * transaction the wallet reported; for a smart wallet, what its bundler says
 * about the user operation; then the history, for a USDC Transfer of exactly
 * the amount from the wallet to the recipient since the send started. The
 * history search runs in bounded requests and carries on where the previous
 * check stopped (`scannedThrough`), so repeated checks only read new blocks.
 */
export async function checkPendingSend(record: PendingSend, chain: SendChain, options: CheckPendingOptions = {}): Promise<SendCheck> {
  if (record.hash) {
    const receipt = await chain.receipt(record.hash).catch(() => null);
    if (receipt) {
      if (receipt.status === "success" && transferInReceipt(receipt, record)) return { status: "landed", hash: receipt.transactionHash };
      return { status: "failed", hash: receipt.transactionHash };
    }
  }
  let queued = false;
  if (record.userOpHash && options.userOperationStatus) {
    const operation = await options.userOperationStatus(record.userOpHash).catch((): UserOperationStatus => ({ status: "unknown" }));
    if (operation.status === "included") {
      // A user operation that ran without reverting made the transfer, its only call.
      return operation.success ? { status: "landed", hash: operation.transactionHash } : { status: "failed", hash: operation.transactionHash };
    }
    // Only "not found" counts as gone: a lookup that failed leaves it possibly queued.
    queued = operation.status !== "absent";
  }
  let scanned = false;
  let scannedThrough = options.scannedThrough ?? null;
  try {
    const latest = await chain.blockNumber();
    const start = searchStart(record, latest, options.now ?? Date.now());
    let next = scannedThrough !== null && scannedThrough >= start ? scannedThrough + 1n : start;
    for (let requests = 0; next <= latest && requests < MAX_LOG_REQUESTS_PER_CHECK; requests += 1) {
      const to = next + LOG_CHUNK_BLOCKS - 1n < latest ? next + LOG_CHUNK_BLOCKS - 1n : latest;
      const found = (await chain.transfers({ from: record.from, to: record.to, fromBlock: next, toBlock: to })).find(
        (transfer) => transfer.value === record.amount,
      );
      if (found) return { status: "landed", hash: found.hash };
      scannedThrough = to;
      next = to + 1n;
    }
    scanned = next > latest;
  } catch {
    scanned = false;
  }
  const balance = await chain.usdcBalance(record.from).catch(() => null);
  const balanceDropped = balance === null ? null : balance + record.amount <= record.balanceBefore;
  return { status: "pending", scanned, scannedThrough, balanceDropped, queued };
}

/** After this long without a sign of it, the player may say it didn't go through. */
export const RELEASE_PENDING_AFTER_MS = 10 * 60_000;

/**
 * Whether the player may give up on a pending send and send again. Only on
 * evidence: RELEASE_PENDING_AFTER_MS have passed, the latest check searched
 * the whole history since the send without finding it, the balance has not
 * dropped by the amount, the wallet's bundler no longer holds it, and the
 * send is not still running in this page.
 */
export function canReleasePending(record: PendingSend, check: PendingCheck | null, now: number, inFlight: boolean): boolean {
  if (inFlight || check === null) return false;
  if (!check.scanned || check.balanceDropped !== false || check.queued) return false;
  return now - record.startedAt >= RELEASE_PENDING_AFTER_MS;
}
