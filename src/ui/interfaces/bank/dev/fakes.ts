/**
 * Dev-harness fakes (never imported by the app): a tiny in-memory "chain"
 * behind a fake Peer Cash client, a fake TxSender that resolves canned
 * receipts after a delay, and the real Base public client with its account
 * reads answered from the same state. The real sell hooks run on top, so
 * every state the harness shows is one the sell module itself produced.
 */

import {
  CashError,
  RECOMMENDED_MIN_CASHOUT_AMOUNT,
  buildCapabilities,
  isFillLive,
  withExplain,
  type CashClient,
  type CashFill,
  type CashOrder,
  type CashOrderState,
  type CashPayoutInfo,
  type CashReceiveLeg,
  type CashoutInput,
  type CurrencyType,
  type PrepareResult,
} from "@zkp2p/cash";
import { bytesToHex, hexToString, keccak256, stringToHex, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";
import { USDC_ADDRESS } from "@/config";
import { InsufficientGasError, TransactionPendingError, UserRejectedError, WalletBusyError } from "@/wallet/errors";
import type { TxSender, WalletCall, WalletKind } from "@/wallet/types";

export const FAKE_ESCROW = "0x2f121cddca6d652f35e8b3e560f9760898888888" as Address;
const FAKE_POLICY = "0x7e57000000000000000000000000000000000001" as Address;
const CHAIN_ID = 8453;

/** Oracle-ish rates for the harness (fiat per USDC). */
export const FAKE_RATES: Readonly<Record<string, number>> = {
  USD: 1,
  GBP: 0.786,
  EUR: 0.9213,
  AUD: 1.5312,
  CAD: 1.3874,
  CHF: 0.8012,
  CNY: 7.1088,
  INR: 85.402,
  MXN: 18.214,
  NZD: 1.6821,
  SGD: 1.2903,
  TRY: 41.207,
  ZAR: 17.623,
  IDR: 16288.5,
  PHP: 57.12,
};

/**
 * Keeps the harness off Curator: makers/create (the payee registration a
 * spread order's deposit is built with) answers with a made-up payee hash and
 * registers nothing, and any other Curator call is refused. Dev only.
 */
export function installNetworkGuard(): void {
  const host = window as typeof window & { __bankFetchGuard?: boolean };
  if (host.__bankFetchGuard) return;
  host.__bankFetchGuard = true;
  const real = window.fetch.bind(window);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.zkp2p.xyz/")) {
      await sleep(600);
      if (url.endsWith("/v2/makers/create")) {
        const body = typeof init?.body === "string" ? init.body : "";
        if (body.toLowerCase().includes("error")) return json({ success: false, message: "Curator unavailable" }, 503);
        return json({ success: true, message: "Payee registered (harness)", responseObject: { hashedOnchainId: keccak256(stringToHex(`payee:${body}`)) } });
      }
      return json({ success: false, message: "The bank harness never calls Curator." }, 503);
    }
    return real(input, init);
  };
}

const FILL_STATS = {
  "revolut:GBP": { fills: 64, medianFillSeconds: 1_520 },
  "revolut:EUR+GBP": { fills: 22, medianFillSeconds: 2_400 },
  "revolut:EUR+GBP+USD": { fills: 18, medianFillSeconds: 1_900 },
  "revolut:EUR": { fills: 31, medianFillSeconds: 3_100 },
  "venmo:USD": { fills: 212, medianFillSeconds: 640 },
  "cashapp:USD": { fills: 95, medianFillSeconds: 900 },
  "wise:EUR": { fills: 12, medianFillSeconds: 7_200 },
  "wise:EUR+GBP+USD": { fills: 4, medianFillSeconds: 21_000 },
  "zelle:USD": { fills: 40, medianFillSeconds: 1_100 },
  "paypal:USD": { fills: 6, medianFillSeconds: 86_000 },
};

export interface FakeLeg {
  platform: string;
  currencies: CurrencyType[];
  /** The seller's spread on the oracle rate, basis points (default 0, Peer Cash's market rate). */
  spreadBps?: number;
}

export interface FakeOrderSpec {
  /** On-chain deposit number; the deposit id is `${FAKE_ESCROW}_${id}`. */
  id: number;
  total: bigint;
  filled?: bigint;
  pending?: bigint;
  returned?: bigint;
  state: CashOrderState;
  withdrawn?: boolean;
  legs: FakeLeg[];
  fills?: CashFill[];
  /** Seconds before "now" the order last changed. */
  ageSeconds?: number;
}

export type OrdersMode = "ok" | "loading" | "error";
/**
 * How the wallet answers: "unknown" never confirms (and never lands),
 * "unknown-lands" lands but the wallet loses track of it, "unknown-reverts"
 * reverts on-chain but the wallet loses track of it.
 */
export type SendFailure = null | "reject" | "unknown" | "unknown-lands" | "unknown-reverts";

export interface FakeWorldOptions {
  address: Address;
  kind: WalletKind;
  sponsored: boolean;
  usdc: bigint;
  eth: bigint;
  orders: FakeOrderSpec[];
  ordersMode: OrdersMode;
  sendDelayMs: number;
  sendFailure: SendFailure;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const never = <T,>() => new Promise<T>(() => undefined);

function randomHash(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function tag(text: string): Hex {
  return stringToHex(`rr:${text}`);
}

function readTag(data: Hex | undefined): string | null {
  if (!data) return null;
  try {
    const text = hexToString(data);
    return text.startsWith("rr:") ? text.slice(3) : null;
  } catch {
    return null;
  }
}

export function depositIdOf(id: number): string {
  return `${FAKE_ESCROW}_${id}`;
}

export function methodHash(platform: string): Hex {
  return keccak256(stringToHex(`method:${platform}`));
}

function legsOf(receive: CashoutInput["receive"]): { platform: string; currencies: CurrencyType[]; payee: string }[] {
  const list: readonly CashReceiveLeg[] = Array.isArray(receive) ? receive : [receive as CashReceiveLeg];
  return list.map((leg) => ({
    platform: leg.platform,
    currencies: leg.currencies ? [...leg.currencies] : leg.currency ? [leg.currency] : [],
    payee: typeof leg.payee === "string" ? leg.payee : String((leg.payee as { offchainId?: string }).offchainId ?? ""),
  }));
}

const RESTRICTED = new Set(["venmo", "paypal"]);
const IDENTITY = new Set(["wise", "paypal", "alipay"]);

/** A curator 404, as the payee check sees it for an unknown handle. */
function notFoundError(): CashError {
  return new CashError(
    { code: "PAYEE_REGISTRATION_FAILED", message: "Payee registration failed", retryable: false, remediation: "Check the handle." },
    { cause: Object.assign(new Error("User not found"), { status: 404 }) },
  );
}

/**
 * Shared mutable state behind the fake client, sender and public client.
 * Handles in the harness behave by name: anything containing "unknown" is not
 * found, Wise/PayPal/Alipay handles starting "new" need verification,
 * "slow" never answers and "error" fails the check.
 */
export class FakeWorld {
  readonly opts: FakeWorldOptions;
  usdc: bigint;
  eth: bigint;
  nonce = 41;
  ordersMode: OrdersMode;
  sendDelayMs: number;
  sendFailure: SendFailure;
  private readonly specs = new Map<number, FakeOrderSpec & { updatedAt: number }>();
  private readonly prepared = new Map<number, { amount: bigint; legs: FakeLeg[] }>();
  private readonly receipts = new Map<Hex, { receipt: TransactionReceipt; createSeq: number | null }>();
  private seq = 0;
  private nextId = 1300;
  private busy = false;
  private readonly listeners = new Set<() => void>();

  constructor(opts: FakeWorldOptions) {
    this.opts = opts;
    this.usdc = opts.usdc;
    this.eth = opts.eth;
    this.ordersMode = opts.ordersMode;
    this.sendDelayMs = opts.sendDelayMs;
    this.sendFailure = opts.sendFailure;
    const now = Math.floor(Date.now() / 1000);
    for (const spec of opts.orders) this.specs.set(spec.id, { ...spec, updatedAt: now - (spec.ageSeconds ?? 600) });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** Adds an order directly (used to seed recoveries). */
  addOrder(spec: FakeOrderSpec): string {
    this.specs.set(spec.id, { ...spec, updatedAt: Math.floor(Date.now() / 1000) - (spec.ageSeconds ?? 60) });
    return depositIdOf(spec.id);
  }

  order(depositId: string, withFills: boolean): CashOrder | null {
    const id = Number(depositId.split("_")[1]);
    const spec = this.specs.get(id);
    return spec ? this.toOrder(spec, withFills) : null;
  }

  orders(): CashOrder[] {
    return [...this.specs.values()].map((spec) => this.toOrder(spec, false));
  }

  /**
   * The SDK's rule: list rows carry no fills, so any held amount counts as a
   * live buyer; a single-order read checks each buyer's time limit.
   */
  private hasLiveIntent(spec: FakeOrderSpec, withFills: boolean): boolean {
    const pending = spec.pending ?? 0n;
    const fills = spec.fills ?? [];
    if (!withFills || fills.length === 0) return pending > 0n;
    const now = Math.floor(Date.now() / 1000);
    return fills.some((f) => isFillLive(f, now));
  }

  private toOrder(spec: FakeOrderSpec & { updatedAt: number }, withFills: boolean): CashOrder {
    const filled = spec.filled ?? 0n;
    const pending = spec.pending ?? 0n;
    const returned = spec.returned ?? 0n;
    const remaining = spec.total - filled - returned;
    const liveIntent = this.hasLiveIntent(spec, withFills);
    const live = !spec.withdrawn && (spec.state === "awaiting-buyer" || spec.state === "matched" || spec.state === "delivering");
    const payouts: CashPayoutInfo[] = spec.legs.flatMap((leg) =>
      leg.currencies.map((currency) => ({
        platform: leg.platform,
        platformHash: methodHash(leg.platform),
        currency,
        currencyHash: keccak256(stringToHex(currency)),
        payeeHash: keccak256(stringToHex(`${leg.platform}:payee`)),
        active: live,
        pricing: {
          marketRate: !leg.spreadBps,
          kind: "oracle_chainlink",
          rateSource: "ORACLE",
          spreadBps: leg.spreadBps ?? 0,
          oracleRate: FAKE_RATES[currency] ?? 1,
        },
      })),
    );
    return withExplain({
      depositId: depositIdOf(spec.id),
      state: spec.state,
      fills: withFills ? (spec.fills ?? []) : [],
      totalAmount: spec.total,
      filledAmount: filled,
      pendingAmount: pending,
      returnedAmount: returned,
      nextActions: spec.withdrawn || remaining <= 0n ? [] : liveIntent ? ["wait"] : live ? ["wait", "withdraw"] : ["withdraw"],
      updatedAt: spec.updatedAt,
      intentCount: spec.fills?.length ?? 0,
      payouts,
      successRateBps: 10_000,
      isInFlight: live,
      withdrawn: spec.withdrawn ?? false,
    });
  }

  prepare(input: CashoutInput): PrepareResult {
    const legs = legsOf(input.receive);
    const seq = ++this.seq;
    this.prepared.set(seq, { amount: input.amount, legs: legs.map(({ platform, currencies }) => ({ platform, currencies })) });
    return {
      txs: [
        { to: USDC_ADDRESS, data: tag("approve"), value: 0n, chainId: CHAIN_ID },
        { to: FAKE_ESCROW, data: tag(`create:${seq}`), value: 0n, chainId: CHAIN_ID },
      ],
      steps: [
        { kind: "approve", description: "Approve USDC" },
        { kind: "createDeposit", description: "Create the cash-out deposit" },
      ],
      register: { hashedOnchainIds: legs.map((l) => keccak256(stringToHex(`${l.platform}:${l.payee}`))) },
      accessPolicyRequired: legs.some((l) => RESTRICTED.has(l.platform)),
      accessPolicyPaymentMethods: legs.filter((l) => RESTRICTED.has(l.platform)).map((l) => methodHash(l.platform)),
    };
  }

  async checkPayees(input: CashoutInput): Promise<void> {
    for (const leg of legsOf(input.receive)) {
      const payee = leg.payee.toLowerCase();
      if (payee.includes("slow")) await never();
      if (payee.includes("error")) throw new CashError({ code: "INDEXER_UNAVAILABLE", message: "Curator unavailable", retryable: true, remediation: "" });
      if (IDENTITY.has(leg.platform) && payee.startsWith("new")) {
        throw new CashError({ code: "PAYEE_VERIFICATION_REQUIRED", message: "identityAttestation is required", retryable: false, remediation: "" });
      }
      if (payee.includes("unknown")) throw notFoundError();
    }
  }

  finalize(receipt: { transactionHash: Hex }): { depositId: string; onchainId: number } {
    const record = this.receipts.get(receipt.transactionHash);
    const prepared = record?.createSeq ? this.prepared.get(record.createSeq) : undefined;
    if (!prepared) throw new CashError({ code: "DEPOSIT_RESOLUTION_FAILED", message: "No deposit event", retryable: false, remediation: "" });
    const id = this.nextId++;
    this.specs.set(id, { id, total: prepared.amount, state: "awaiting-buyer", legs: prepared.legs, updatedAt: Math.floor(Date.now() / 1000) });
    this.changed();
    return { depositId: depositIdOf(id), onchainId: id };
  }

  receipt(hash: Hex): TransactionReceipt | null {
    return this.receipts.get(hash)?.receipt ?? null;
  }

  /** What prepareWithdraw checks before building a plan (the SDK's withdraw context). */
  checkWithdraw(depositId: string, amount: bigint | undefined): void {
    const id = Number(depositId.split("_")[1]);
    const spec = this.specs.get(id);
    if (!spec) throw new CashError({ code: "ORDER_NOT_FOUND", message: "Order not found", retryable: true, remediation: "" });
    const pending = spec.pending ?? 0n;
    const available = spec.total - (spec.filled ?? 0n) - (spec.returned ?? 0n) - pending;
    if (amount !== undefined) {
      if (amount > available) throw new CashError({ code: "INSUFFICIENT_AVAILABLE_FUNDS", message: "Insufficient available funds", retryable: false, remediation: "" });
      return;
    }
    if (this.hasLiveIntent(spec, true)) throw new CashError({ code: "ACTIVE_INTENT_BLOCKS_WITHDRAWAL", message: "Active intent", retryable: false, remediation: "" });
    if (available <= 0n && pending === 0n) throw new CashError({ code: "NOTHING_TO_WITHDRAW", message: "Nothing to withdraw", retryable: false, remediation: "" });
  }

  /** The wallet: one request at a time, canned receipts after `sendDelayMs`. */
  async send(calls: WalletCall[]): Promise<TransactionReceipt> {
    if (this.busy) throw new WalletBusyError();
    this.busy = true;
    try {
      if (!this.opts.sponsored && this.eth === 0n) throw new InsufficientGasError(this.opts.address);
      await sleep(this.sendDelayMs);
      if (this.sendFailure === "reject") throw new UserRejectedError();
      const hash = randomHash();
      if (this.sendFailure === "unknown") throw new TransactionPendingError(hash);
      if (this.sendFailure === "unknown-reverts") {
        const reverted = { transactionHash: hash, status: "reverted", logs: [], blockNumber: 1n } as unknown as TransactionReceipt;
        this.receipts.set(hash, { receipt: reverted, createSeq: null });
        throw new TransactionPendingError(hash);
      }
      let createSeq: number | null = null;
      for (const call of calls) {
        const t = readTag(call.data);
        if (!t) continue;
        const [verb, a, b] = t.split(":");
        if (verb === "create") {
          createSeq = Number(a);
          const prepared = this.prepared.get(createSeq);
          if (prepared) this.usdc -= prepared.amount;
        } else if (verb === "withdraw") {
          this.applyWithdraw(Number(a), b === "all" ? null : BigInt(b ?? "0"));
        } else if (verb === "topup") {
          const spec = this.specs.get(Number(a));
          const amount = BigInt(b ?? "0");
          if (spec) spec.total += amount;
          this.usdc -= amount;
        }
      }
      this.nonce += 1;
      const receipt = { transactionHash: hash, status: "success", logs: [], blockNumber: 1n } as unknown as TransactionReceipt;
      this.receipts.set(hash, { receipt, createSeq });
      this.changed();
      if (this.sendFailure === "unknown-lands") throw new TransactionPendingError(hash);
      return receipt;
    } finally {
      this.busy = false;
    }
  }

  private applyWithdraw(id: number, amount: bigint | null): void {
    const spec = this.specs.get(id);
    if (!spec) return;
    if (amount === null) {
      // Withdraw-All prunes expired buyers first, so what they held comes back too.
      const now = Math.floor(Date.now() / 1000);
      spec.fills = (spec.fills ?? []).map((f) => (f.status === "SIGNALED" && !isFillLive(f, now) ? { ...f, status: "PRUNED" as CashFill["status"], prunedAt: now } : f));
      spec.pending = 0n;
    }
    const remaining = spec.total - (spec.filled ?? 0n) - (spec.returned ?? 0n) - (spec.pending ?? 0n);
    const out = amount === null ? remaining : amount;
    spec.returned = (spec.returned ?? 0n) + out;
    this.usdc += out;
    if (amount === null) {
      spec.withdrawn = true;
      spec.state = "returned";
    }
    spec.updatedAt = Math.floor(Date.now() / 1000);
  }
}

/** A Peer Cash client over the fake world: the methods the sell module uses. */
export function createFakeCashClient(world: FakeWorld): CashClient {
  const caps = buildCapabilities("production");
  const client = {
    capabilities: () => caps,
    fillStats: async () => {
      await sleep(500);
      return FILL_STATS;
    },
    estimate: async (input: { amount: bigint; currency: CurrencyType }) => {
      await sleep(350);
      const rate = FAKE_RATES[input.currency] ?? 1;
      return {
        kind: "oracle-estimate" as const,
        currency: input.currency,
        amount: input.amount,
        rate,
        receiveAmount: (Number(input.amount) / 1e6) * rate,
        asOf: Math.floor(Date.now() / 1000),
        stale: false,
      };
    },
    prepare: async (input: CashoutInput) => {
      await sleep(input.amount === RECOMMENDED_MIN_CASHOUT_AMOUNT ? 600 : 300);
      await world.checkPayees(input);
      return world.prepare(input);
    },
    finalizePreparedCashout: (receipt: { transactionHash: Hex }) => {
      const { depositId, onchainId } = world.finalize(receipt);
      return { depositId, txHash: receipt.transactionHash, escrowAddress: FAKE_ESCROW, onchainDepositId: BigInt(onchainId), order: world.order(depositId, false)! };
    },
    prepareAccessPolicy: (depositId: string) => ({ to: FAKE_POLICY, data: tag(`policy:${depositId}`), value: 0n, chainId: CHAIN_ID }),
    orders: async () => {
      if (world.ordersMode === "loading") return never<CashOrder[]>();
      await sleep(400);
      if (world.ordersMode === "error") throw new CashError({ code: "INDEXER_UNAVAILABLE", message: "Indexer unavailable", retryable: false, remediation: "" });
      return world.orders();
    },
    order: async (depositId: string) => {
      await sleep(450);
      const order = world.order(depositId, true);
      if (!order) throw new CashError({ code: "ORDER_NOT_FOUND", message: "Order not found", retryable: true, remediation: "" });
      return order;
    },
    watch: async function* (depositId: string, opts: { signal?: AbortSignal } = {}) {
      while (!opts.signal?.aborted) {
        const order = world.order(depositId, true);
        if (order) {
          yield order;
          if (!order.isInFlight) return;
        }
        await sleep(5_000);
      }
    },
    prepareWithdraw: async (depositId: string, opts: { amount?: bigint } = {}) => {
      await sleep(300);
      world.checkWithdraw(depositId, opts.amount);
      const id = depositId.split("_")[1];
      return {
        txs: [{ to: FAKE_ESCROW, data: tag(`withdraw:${id}:${opts.amount ?? "all"}`), value: 0n, chainId: CHAIN_ID }],
        steps: [{ kind: "withdrawDeposit" as const, description: "Withdraw from the deposit" }],
      };
    },
    prepareTopUp: async (depositId: string, amount: bigint) => {
      await sleep(300);
      const id = depositId.split("_")[1];
      return {
        txs: [
          { to: USDC_ADDRESS, data: tag("approve"), value: 0n, chainId: CHAIN_ID },
          { to: FAKE_ESCROW, data: tag(`topup:${id}:${amount}`), value: 0n, chainId: CHAIN_ID },
        ],
        steps: [
          { kind: "approve" as const, description: "Approve USDC" },
          { kind: "addFunds" as const, description: "Add funds" },
        ],
      };
    },
    buyer: async (address: string) => ({ address, totalIntents: 14, fulfilled: 13, pruned: 1, signaled: 0, successRateBps: 9_285 }),
  };
  return client as unknown as CashClient;
}

/** The fake wallet: `sendCalls` resolves a canned receipt after the world's delay. */
export function createFakeSender(world: FakeWorld): TxSender {
  const { address, kind, sponsored } = world.opts;
  return {
    address,
    kind,
    sponsored,
    sendCalls: (calls) => world.send(calls),
    signMessage: async () => "0x" as Hex,
    walletClient: { account: { address, type: "json-rpc" }, chain: { id: CHAIN_ID } } as unknown as WalletClient,
  };
}

/**
 * The real Base public client from src/wallet with the fixture wallet's reads
 * (USDC, ETH, nonce, code, receipts) answered from the fake world.
 */
export function createFakePublicClient(world: FakeWorld, real: PublicClient): PublicClient {
  const overrides: Record<string, unknown> = {
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === "balanceOf") return world.usdc;
      if (args.functionName === "enabled") return false;
      if (args.functionName === "getAllowedGroups") return [];
      throw new Error(`readContract ${args.functionName} is not faked`);
    },
    getBalance: async () => world.eth,
    getTransactionCount: async () => world.nonce,
    getCode: async () => (world.opts.kind === "smart" ? ("0xef0100" as Hex) : undefined),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const receipt = world.receipt(hash);
      if (!receipt) throw new Error("Transaction receipt not found");
      return receipt;
    },
  };
  return new Proxy(real, {
    get(target, key, receiver) {
      if (typeof key === "string" && key in overrides) return overrides[key];
      return Reflect.get(target, key, receiver);
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture builders

export const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

export function fakeFill(opts: {
  n: number;
  amount: number;
  status: "SIGNALED" | "FULFILLED" | "PRUNED";
  currency: CurrencyType;
  ageSeconds: number;
  /** SIGNALED only: seconds until the buyer's time runs out (negative: already ran out). */
  expiresInSeconds?: number;
}): CashFill {
  const now = Math.floor(Date.now() / 1000);
  const rate = FAKE_RATES[opts.currency] ?? 1;
  const buyer = `0x${opts.n.toString(16).padStart(4, "0")}b7e4c2a91d55f0e3c8a6b2d4e1f7a9c3b5d8e0a2`.slice(0, 42);
  const owed = Math.ceil(opts.amount * rate * 100) / 100;
  return {
    intentHash: keccak256(stringToHex(`intent:${opts.n}`)),
    status: opts.status as CashFill["status"],
    amount: USDC(opts.amount),
    buyer,
    currency: opts.currency,
    rate,
    fiatOwed: owed,
    ...(opts.status === "FULFILLED" ? { fiatPaid: owed, paidCurrency: opts.currency, releasedAmount: USDC(opts.amount), fulfilledAt: now - opts.ageSeconds + 900 } : {}),
    ...(opts.status === "PRUNED" ? { prunedAt: now - opts.ageSeconds + 7_200, isExpired: true } : {}),
    ...(opts.status === "SIGNALED" && opts.expiresInSeconds !== undefined
      ? { expiresAt: now + opts.expiresInSeconds, isExpired: opts.expiresInSeconds <= 0 }
      : {}),
    signaledAt: now - opts.ageSeconds,
  };
}
