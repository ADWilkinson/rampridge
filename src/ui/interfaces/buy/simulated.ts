/**
 * Simulated stand-ins for the buy interfaces: a Peer SDK client, wallet
 * sender, Peer extension, Curator market and Peer Cash client that answer
 * like the real ones (receipts carry real OrchestratorV3 / EscrowV2 events),
 * so the real buy store runs every step without a network, a wallet or the
 * chain. The dev harness and the capture harness drive them through every
 * scenario; in the app, only the practice trade (practiceRuntime.ts) uses them.
 */

import type { CashClient, CashOrder } from "@zkp2p/cash";
import {
  referrerFeeConfigToPreciseUnits,
  type GetQuoteSingleResponse,
  type PeerExtensionSdk,
  type PeerMetadataMessage,
  type PeerMetadataMessageCallback,
  type PeerMetadataRow,
  type ReferrerFeeConfig,
  type Zkp2pClient,
} from "@zkp2p/sdk";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeErrorResult,
  encodeEventTopics,
  zeroAddress,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { PEER_ABIS } from "@/peer/client";
import { RATE_ONE, tryParseAmount } from "@/peer/format";
import { normalizeQuote, type BuyQuote, type BuyQuoteResult, type GetBuyQuotesParams, type PlatformPrice } from "@/peer/market";
import { BUY_PLATFORMS, platformsForCurrency, type BuyPlatformId, type FiatCode } from "@/peer/platforms";
import type { TxSender, WalletCall } from "@/wallet/types";

export const BUYER: Address = "0xbE8bE9ff6ff098E28E21A698bEa44D4879cBB8A2";
export const ESCROW: Address = "0x777777779d229cdF3110e9de47943791c26300Ef";
export const ORCHESTRATOR: Address = "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7";
export const SELLER: Address = "0xD77e9879646be3307CA552441b14F4d6E79C8BBe";
export const INTENT_HASH: Hex = "0x20409e5bc7113053c4d2d58aca0707363459a3b19ef84c84d4de7dbc0df0f6e5";
/** An older open intent from elsewhere that blocks a new signal ("blocked"). */
export const OLDER_INTENT: Hex = `0x${"77".repeat(32)}`;
const PAYEE_HASH: Hex = "0x9a393c621a7c166df390b323a33adad8448852e55efe24ce276d6ce085ccfa98";
const METHOD_HASH: Hex = "0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d";
const CURRENCY_HASH: Hex = "0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e";
const FULFIL_TX: Hex = `0x${"f1".repeat(32)}`;

/** Fiat per USDC for the fixture market (18 decimals), by currency. */
const BASE_RATES: Partial<Record<FiatCode, string>> = {
  USD: "1.012",
  EUR: "0.931",
  GBP: "0.790",
  AUD: "1.540",
  CAD: "1.390",
  JPY: "149.80",
  MXN: "18.40",
  ARS: "1180",
  INR: "88.42",
  CNY: "7.124",
};

export const PAYEES: Partial<Record<BuyPlatformId, string>> = {
  revolut: "revtag",
  wise: "goldfarmer",
  venmo: "zezima-pays",
  cashapp: "$runecrafter",
  zelle: "seller@example.com",
  paypal: "paypal.me/bankstander",
  monzo: "varrockbank",
  chime: "$lumbridge",
  alipay: "zezima.trader@example.com",
  upi: "bankstander@okaxis",
};

/** The 16-digit Alipay PID Curator keeps in the maker's metadata (the QR and app link pay this account). */
export const ALIPAY_PID = "2088702512345678";

export interface Timing {
  /** Wallet confirmation delay. */
  txMs: number;
  /** Curator quote delay. */
  quoteMs: number;
  /** Extension capture delay; null never answers (stays capturing). */
  captureMs: number | null;
}

export interface MarketOptions {
  /** "ok" quotes, "none" (empty with nearby amounts), "error" or "hang". */
  quotes: "ok" | "none" | "error" | "hang";
  /** Quotes price RampRidge's 50 bps referrer fee, as live Curator does; false is the no-referrer fallback. */
  referrerFee: boolean;
  /** A seller's rate-manager fee on every quote, in basis points (0 for none). */
  managerFeeBps: number;
  /** Multiplies every quote's rate (to show a worse-than-market stall). */
  stallRateFactor: number;
  /** The stall's deposit cannot fill (getDepositQuote returns null). */
  stallMissing: boolean;
  pricesError: boolean;
  /**
   * Per-method overrides of the fixture market: a factor on the method's rate,
   * or null for a method nobody sells on (no quotes, unavailable on the price
   * board). Methods not named keep the fixture behaviour.
   */
  rateFactors?: Partial<Record<BuyPlatformId, number | null>>;
}

export const STALL_DEPOSIT = { depositId: `${ESCROW}_7001`, escrow: ESCROW, platform: "revolut", currency: "GBP", available: "640.00", rate: "0.8200" };

function rateFor(currency: FiatCode, platform: BuyPlatformId, factor = 1): bigint {
  const base = Number(BASE_RATES[currency] ?? "1.000");
  const index = platformsForCurrency(currency).findIndex((p) => p.id === platform);
  const value = base * (1 + Math.max(0, index) * 0.0035) * factor;
  return (BigInt(Math.round(value * 1e6)) * RATE_ONE) / 1_000_000n;
}

/** RampRidge's referrer fee as live Curator prices it (BUY_REFERRER_FEE). */
const REFERRER_BPS = 50n;

export interface FixtureFees {
  /** Price the 50 bps referrer leg (default true). */
  referrer?: boolean;
  /** Rate-manager fee in basis points (default 0). */
  managerBps?: number;
}

/** A Curator quote shaped like a live one, normalised by the real market code. */
export function fixtureQuote(opts: {
  fiat: bigint;
  currency: FiatCode;
  platform: BuyPlatformId;
  depositId?: string;
  rate?: bigint;
  expiresAt?: number;
  successBps?: number;
  fees?: FixtureFees;
}): BuyQuote {
  const rate = opts.rate ?? rateFor(opts.currency, opts.platform);
  const gross = (opts.fiat * RATE_ONE) / rate;
  const service = (gross * 95n) / 10_000n;
  const manager = (gross * BigInt(opts.fees?.managerBps ?? 0)) / 10_000n;
  const withReferrer = opts.fees?.referrer ?? true;
  const referrer = withReferrer ? (gross * REFERRER_BPS) / 10_000n : 0n;
  const net = gross - service - manager - referrer;
  const raw = {
    fiatAmount: opts.fiat.toString(),
    fiatAmountFormatted: "",
    tokenAmount: net.toString(),
    tokenAmountFormatted: "",
    signalIntentAmount: gross.toString(),
    signalIntentAmountFormatted: "",
    zkp2pFeeAmount: service.toString(),
    managerFeeAmount: manager.toString(),
    totalFeeAmount: (service + manager + referrer).toString(),
    serviceFeeBps: 95,
    takerReferralFeeBps: 0,
    takerReferralFeeAmount: "0",
    ...(withReferrer ? { referrerFeeAmount: referrer.toString(), referrerFeeBps: Number(REFERRER_BPS) } : {}),
    paymentMethod: opts.platform,
    payeeAddress: SELLER,
    conversionRate: rate.toString(),
    takerConversionRate: rate.toString(),
    sellerAutomatedReleaseAvailable: false,
    whitelistEnabled: false,
    allowedGroupIds: [],
    disputeProtectionOptedOut: false,
    disputeProtectionRequiresStake: false,
    depositSuccessRateBps: opts.successBps ?? 9_840,
    intent: {
      depositId: Number(opts.depositId ?? "6528"),
      processorName: opts.platform,
      amount: gross.toString(),
      toAddress: BUYER,
      payeeDetails: PAYEE_HASH,
      processorIntentData: {},
      fiatCurrencyCode: opts.currency,
      chainId: "8453",
      escrowAddress: ESCROW.toLowerCase(),
    },
    maker: { offchainId: PAYEES[opts.platform] ?? "seller" },
    payeeData: { offchainId: PAYEES[opts.platform] ?? "seller" },
  } as unknown as GetQuoteSingleResponse;
  const quote = normalizeQuote(raw, opts.currency, opts.expiresAt ?? Date.now() + 90_000);
  if (!quote) throw new Error(`fixture quote for ${opts.platform} ${opts.currency} did not normalise`);
  return quote;
}

const never = <T>() => new Promise<T>(() => undefined);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function fakeMarket(options: MarketOptions, timing: Timing) {
  const fees: FixtureFees = { referrer: options.referrerFee, managerBps: options.managerFeeBps };
  const fiatOf = (amount: string | bigint) => (typeof amount === "bigint" ? amount : (tryParseAmount(amount, 6) ?? 0n));
  const quotes = async (params: GetBuyQuotesParams): Promise<BuyQuoteResult> => {
    if (options.quotes === "hang") return never();
    await wait(timing.quoteMs);
    if (options.quotes === "error") throw new Error("Curator request failed: 503 Service Unavailable");
    const fiat = fiatOf(params.fiatAmount);
    const platforms = params.platforms ?? platformsForCurrency(params.currency).map((p) => p.id);
    const expiresAt = Date.now() + 90_000;
    if (options.quotes === "none") {
      const platform = platforms[0] ?? "revolut";
      return {
        fiatAmount: fiat,
        currency: params.currency,
        quotes: [],
        nearby: {
          below: [{ fiatAmount: (fiat * 6n) / 10n, percentDifference: "-40.0%", quote: fixtureQuote({ fiat: (fiat * 6n) / 10n, currency: params.currency, platform, expiresAt, fees }) }],
          above: [],
        },
        expiresAt,
      };
    }
    const factor = (platform: BuyPlatformId) => options.rateFactors?.[platform];
    const list = platforms
      .filter((platform) => factor(platform) !== null)
      .flatMap((platform, i) => [
        fixtureQuote({ fiat, currency: params.currency, platform, depositId: String(6528 + i), rate: rateFor(params.currency, platform, factor(platform) ?? 1), expiresAt, fees }),
        fixtureQuote({ fiat, currency: params.currency, platform, depositId: String(6600 + i), rate: rateFor(params.currency, platform, (factor(platform) ?? 1) * 1.006), expiresAt, successBps: 9_120, fees }),
      ]);
    list.sort((a, b) => (a.usdcAmount > b.usdcAmount ? -1 : 1));
    return { fiatAmount: fiat, currency: params.currency, quotes: list.slice(0, params.quotesToReturn ?? 5), nearby: { below: [], above: [] }, expiresAt };
  };

  const getBestPricesByPlatform = async (params: { currency: FiatCode; fiatAmount: string | bigint }): Promise<PlatformPrice[]> => {
    await wait(timing.quoteMs);
    if (options.pricesError) throw new Error("Curator request failed");
    const fiat = fiatOf(params.fiatAmount);
    return platformsForCurrency(params.currency).map((p, i) => {
      const factor = options.rateFactors?.[p.id];
      const available = options.quotes !== "none" && (factor === undefined ? i !== 3 : factor !== null);
      const rate = rateFor(params.currency, p.id, factor ?? 1);
      return { platform: p.id, available, quote: available ? fixtureQuote({ fiat, currency: params.currency, platform: p.id, depositId: String(6528 + i), rate, fees }) : null };
    });
  };

  const getDepositQuote = async (params: GetBuyQuotesParams & { platform: BuyPlatformId; depositId: string; escrow: Address }): Promise<BuyQuote | null> => {
    await wait(timing.quoteMs);
    if (options.stallMissing) return null;
    return fixtureQuote({
      fiat: fiatOf(params.fiatAmount),
      currency: params.currency,
      platform: params.platform,
      depositId: params.depositId,
      rate: rateFor(params.currency, params.platform, options.stallRateFactor),
      successBps: 10_000,
      fees,
    });
  };

  return { quotes, getBestPricesByPlatform, getDepositQuote };
}

// ---------------------------------------------------------------------------
// Chain

function eventAbi(abi: readonly unknown[], name: string): AbiEvent {
  const item = (abi as AbiEvent[]).find((x) => x.type === "event" && x.name === name);
  if (!item) throw new Error(`No ${name} event in ABI`);
  return item;
}

function log(address: Address, event: AbiEvent, args: Record<string, unknown>): Log<bigint, number, false> {
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args } as never) as [Hex, ...Hex[]];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    nonIndexed,
    nonIndexed.map((i) => args[i.name ?? ""]),
  );
  return {
    address,
    topics,
    data,
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: `0x${"22".repeat(32)}`,
    transactionIndex: 0,
    removed: false,
  };
}

function receipt(logs: Log<bigint, number, false>[], hash: Hex): TransactionReceipt {
  return {
    status: "success",
    logs,
    transactionHash: hash,
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: 1n,
    contractAddress: null,
    cumulativeGasUsed: 0n,
    effectiveGasPrice: 0n,
    from: BUYER,
    gasUsed: 0n,
    logsBloom: "0x",
    to: ORCHESTRATOR,
    transactionIndex: 0,
    type: "eip1559",
  };
}

export interface ChainOptions {
  /** Expiry written into FundsLocked, ms from the signal. */
  lockMs: number;
  /** Fulfil outcome: "ok", "payee" (attestation rejects the payee), "network" (the release request fails) or "hang" (stays fulfilling). */
  fulfil: "ok" | "payee" | "network" | "hang";
  /**
   * Signal outcome: "ok", "rejected" (wallet refusal), "pending" (wallet timed out after sending) or
   * "blocked" (the contract names an older open intent, one this app can't show, as blocking).
   */
  signal: "ok" | "rejected" | "pending" | "blocked";
  /** Delay on chain reads used by recovery. */
  readMs: number;
}

/** The signal parameters the fake client prepared, for the receipt the fake wallet returns. */
interface PreparedSignal {
  depositId: bigint;
  amount: bigint;
  conversionRate: bigint;
}

interface SignalPrepareParams extends PreparedSignal {
  toAddress?: Address;
  referrerFeeConfig?: ReferrerFeeConfig;
}

/**
 * Real OrchestratorV3 signalIntent calldata, as the SDK prepares it after
 * Curator's /v3/sign: the referrer leg the quote asked for, at the precise
 * fee Curator signs, so the store's pre-send fee check runs on what it would
 * in production.
 */
function signalCalldata(params: SignalPrepareParams, now: number): Hex {
  const referralFees = params.referrerFeeConfig
    ? [{ recipient: params.referrerFeeConfig.recipient as Address, fee: referrerFeeConfigToPreciseUnits(params.referrerFeeConfig) }]
    : [];
  return encodeFunctionData({
    abi: PEER_ABIS.orchestrator,
    functionName: "signalIntent",
    args: [
      {
        escrow: ESCROW,
        depositId: params.depositId,
        amount: params.amount,
        to: params.toAddress ?? BUYER,
        paymentMethod: METHOD_HASH,
        fiatCurrency: CURRENCY_HASH,
        conversionRate: params.conversionRate,
        referralFees,
        gatingServiceSignature: "0x",
        signatureExpiration: BigInt(Math.floor(now / 1000) + 300),
        postIntentHook: zeroAddress,
        preIntentHookData: "0x",
        data: "0x",
      },
    ],
  } as never);
}

function isSignalCall(data: Hex | undefined): boolean {
  if (!data) return false;
  try {
    return decodeFunctionData({ abi: PEER_ABIS.orchestrator, data }).functionName === "signalIntent";
  } catch {
    return false;
  }
}

/** Who the simulated chain signals for: defaults to the harness buyer and intent. */
export interface ChainIds {
  buyer?: Address;
  intentHash?: Hex;
}

export function fakeChain(options: ChainOptions, timing: Timing, now: () => number, ids: ChainIds = {}) {
  const buyer = ids.buyer ?? BUYER;
  const intentHash = ids.intentHash ?? INTENT_HASH;
  let lastSignal: PreparedSignal | null = null;
  let lockExpiry = 0n;
  let fulfilled = false;
  let cancelled = false;
  const prepared = (data: Hex) => ({ to: ORCHESTRATOR, data, value: 0n, chainId: 8453 });

  const client = {
    signalIntent: {
      prepare: async (params: SignalPrepareParams) => {
        if (options.signal === "blocked") {
          const data = encodeErrorResult({ abi: PEER_ABIS.orchestrator, errorName: "AccountHasActiveIntent", args: [buyer, OLDER_INTENT] } as never);
          throw Object.assign(new Error("execution reverted"), { data });
        }
        lastSignal = { depositId: params.depositId, amount: params.amount, conversionRate: params.conversionRate };
        return prepared(signalCalldata(params, now()));
      },
    },
    fulfillIntent: {
      prepare: async () => {
        await wait(400);
        if (options.fulfil === "payee") throw new Error("Attestation failed: payee mismatch for the selected payment");
        if (options.fulfil === "network") throw new Error("network request failed");
        return prepared("0xf0f0");
      },
    },
    cancelIntent: { prepare: async () => prepared("0xcace") },
    getPvAccountIntents: async () => [],
    getPvDepositById: async () => ({ availableLiquidity: 50_000_000_000n }),
    getFulfillIntentInputs: async () => {
      throw new Error("not found");
    },
    publicClient: {
      request: async () => "0x",
      getBalance: async () => 10n ** 18n,
      readContract: async (req: { functionName: string; args?: readonly unknown[] }) => {
        await wait(options.readMs);
        if (req.functionName === "getDepositIntent") {
          if (cancelled || fulfilled) return { intentHash: `0x${"00".repeat(32)}`, amount: 0n, timestamp: 0n, expiryTime: 0n };
          return { intentHash: req.args?.[1], amount: 1n, timestamp: 1n, expiryTime: lockExpiry || BigInt(Math.floor((now() + options.lockMs) / 1000)) };
        }
        if (req.functionName === "getAccountIntents") return [];
        throw new Error(`Unexpected read ${req.functionName}`);
      },
      waitForTransactionReceipt: async () => {
        throw new Error("timeout");
      },
    },
    indexer: {
      getIntentByHash: async () => (fulfilled ? { status: "FULFILLED", takerAmountNetFees: null, fulfillTxHash: FULFIL_TX } : null),
      getOwnerIntents: async () => [],
    },
  } as unknown as Zkp2pClient;

  const sendCalls = async (calls: WalletCall[]): Promise<TransactionReceipt> => {
    const data = calls[0]?.data;
    if (isSignalCall(data)) {
      if (options.signal === "pending") {
        await wait(timing.txMs);
        throw Object.assign(new Error("Your wallet did not confirm whether the transaction was sent."), { code: "receipt_timeout", hash: null, completedHashes: [] });
      }
      if (options.signal === "rejected") {
        await wait(timing.txMs);
        throw Object.assign(new Error("You rejected the request in your wallet."), { code: "user_rejected", completedHashes: [] });
      }
      await wait(timing.txMs);
      const signal = lastSignal ?? { depositId: 6528n, amount: 128_000_000n, conversionRate: RATE_ONE };
      const signaledAt = BigInt(Math.floor(now() / 1000));
      lockExpiry = signaledAt + BigInt(Math.floor(options.lockMs / 1000));
      return receipt(
        [
          log(ORCHESTRATOR, eventAbi(PEER_ABIS.orchestrator, "IntentSignaled"), {
            intentHash,
            escrow: ESCROW,
            depositId: signal.depositId,
            paymentMethod: METHOD_HASH,
            owner: buyer,
            to: buyer,
            amount: signal.amount,
            fiatCurrency: CURRENCY_HASH,
            conversionRate: signal.conversionRate,
            timestamp: signaledAt,
          }),
          log(ESCROW, eventAbi(PEER_ABIS.escrow, "FundsLocked"), { depositId: signal.depositId, intentHash, amount: signal.amount, expiryTime: lockExpiry }),
        ],
        `0x${"5a".repeat(32)}`,
      );
    }
    if (data === "0xf0f0") {
      if (options.fulfil === "hang") return never();
      await wait(timing.txMs);
      fulfilled = true;
      // Peer's 0.95% and RampRidge's 0.5% (the fixtures' default fees) come off the gross.
      const net = lastSignal ? (lastSignal.amount * 9_855n) / 10_000n : 125_400_000n;
      return receipt(
        [log(ORCHESTRATOR, eventAbi(PEER_ABIS.orchestrator, "IntentFulfilled"), { intentHash, fundsTransferredTo: buyer, amount: net, isManualRelease: false })],
        FULFIL_TX,
      );
    }
    if (data === "0xcace") {
      await wait(timing.txMs);
      cancelled = true;
      return receipt([], `0x${"ca".repeat(32)}`);
    }
    throw new Error("Unexpected call");
  };

  const sender: TxSender = {
    address: buyer,
    kind: "smart",
    sponsored: true,
    sendCalls,
    signMessage: async () => "0x",
    walletClient: { account: { address: buyer } } as unknown as WalletClient,
  };

  return { client, sender, zero: zeroAddress };
}

// ---------------------------------------------------------------------------
// Extension

export interface ExtensionOptions {
  installed: boolean;
  state: "ready" | "needs_connection" | "hang";
  /** The PeerAuth build it reports (default 0.7.2, new enough for every platform). */
  version?: string;
  /**
   * ms after the store page opens until the extension appears, as a fresh
   * install injects itself into open tabs (unconnected, like any new install);
   * null or absent: opening the store page installs nothing.
   */
  installAfterMs?: number | null;
}

/** Captured Revolut payments (minor units, outgoing), one matching `amountText`. */
export function revolutRows(amountText: string, currency: FiatCode): PeerMetadataRow[] {
  const minor = Math.round(Number(amountText) * 100);
  const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
  return [
    { originalIndex: 0, amount: String(-minor), currency, state: "COMPLETED", recipient: "revtag", date: day(0), params: { TRANSACTION_ID: "tx-0" } },
    { originalIndex: 1, amount: "-2500", currency, state: "COMPLETED", recipient: "Varrock Pizza", date: day(1), params: { TRANSACTION_ID: "tx-1" } },
    { originalIndex: 2, amount: String(-minor), currency, state: "COMPLETED", recipient: "Bob the Banker", date: day(4), params: { TRANSACTION_ID: "tx-2" } },
    { originalIndex: 3, amount: "-12000", currency, state: "COMPLETED", recipient: "Lumbridge Rent", date: day(6), params: { TRANSACTION_ID: "tx-3" } },
  ] as unknown as PeerMetadataRow[];
}

/** Captured Alipay payments: outgoing ones start "- ", one matching `amountText`, plus an incoming one. */
export function alipayRows(amountText: string): PeerMetadataRow[] {
  const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
  return [
    { originalIndex: 0, amount: `- ${amountText}`, currency: "CNY", recipient: "\\u5f20\\u4e09 (zezima.trader@example.com)", date: day(0), params: { TRADE_NO: "ali-0" } },
    { originalIndex: 1, amount: "+ 50.00", currency: "CNY", recipient: "Varrock Teahouse", date: day(1), params: { TRADE_NO: "ali-1" } },
    { originalIndex: 2, amount: "- 120.00", currency: "CNY", recipient: "Lumbridge Rent", date: day(3), params: { TRADE_NO: "ali-2" } },
  ] as unknown as PeerMetadataRow[];
}

/** Captured Amazon Pay history: person-to-person UPI debits (one matching `amountText`) and rows Peer filters out. */
export function upiRows(amountText: string): PeerMetadataRow[] {
  const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const url = (useCase: string, id: string) => `https://www.amazon.in/pay/transaction-details?useCase=${useCase}&transactionId=${id}`;
  const row = (i: number, amount: string, description: string, useCase: string, d: number, status = "SUCCESS", direction = "DEBIT") => ({
    originalIndex: i,
    amount,
    description,
    status,
    direction,
    date: day(d),
    params: { TRANSACTION_URL: url(useCase, `upi-${i}`) },
  });
  return [
    row(0, amountText, "Paid to bankstander@okaxis", "p2p_outgoing_pay", 0),
    row(1, "499.00", "Paid to Varrock Electricity", "merchant_pay", 1),
    row(2, "2500.00", "Paid to edgeville.rent@oksbi", "p2p_outgoing_scan_pay", 2),
    row(3, "800.00", "Received from lumbridge@ybl", "p2p_incoming", 3, "SUCCESS", "CREDIT"),
  ] as unknown as PeerMetadataRow[];
}

/** The capture a platform's extension flow returns for an order of `amountText`. */
export function capturedRows(platform: BuyPlatformId, amountText: string, currency: FiatCode): PeerMetadataRow[] {
  if (platform === "alipay") return alipayRows(amountText);
  if (platform === "upi") return upiRows(amountText);
  return revolutRows(amountText, currency);
}

export function fakeExtension(options: ExtensionOptions, timing: Timing, rows: () => { platform: string; rows: PeerMetadataRow[] }) {
  const listeners = new Set<PeerMetadataMessageCallback>();
  let connected = options.state === "ready";
  const sdk: PeerExtensionSdk = {
    // Read live: fakeInstallPage flips it when the "install" lands.
    isAvailable: () => options.installed,
    getState: async () => {
      if (options.state === "hang") return never();
      await wait(250);
      return connected ? "ready" : "needs_connection";
    },
    checkConnectionStatus: async () => (connected ? "connected" : "disconnected"),
    requestConnection: async () => {
      await wait(800);
      connected = true;
      return true;
    },
    getVersion: async () => options.version ?? "0.7.2",
    authenticate: () => {
      if (timing.captureMs === null) return;
      setTimeout(() => {
        const { platform, rows: metadata } = rows();
        const message: PeerMetadataMessage = {
          platform,
          requestId: "dev",
          expiresAt: Date.now() + 10 * 60_000,
          metadata,
          buyerTeeCapture: { encryptedSessionMaterial: "dev" },
        } as PeerMetadataMessage;
        [...listeners].forEach((cb) => cb(message));
      }, timing.captureMs);
    },
    onMetadataMessage: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    openInstallPage: () => window.open("https://chromewebstore.google.com/", "_blank", "noopener"),
  } as PeerExtensionSdk;
  return sdk;
}

/**
 * The store's `openInstallPage` for the harness: opens nothing (screenshots
 * stay on the page) and, with `installAfterMs`, has the fake extension appear
 * that long after, unconnected, as a fresh PeerAuth install does.
 */
export function fakeInstallPage(options: ExtensionOptions): () => void {
  return () => {
    console.info("[harness] PeerAuth store page opened");
    if (options.installAfterMs == null) return;
    setTimeout(() => {
      options.installed = true;
    }, options.installAfterMs);
  };
}

// ---------------------------------------------------------------------------
// Peer Cash sell orders

function cashOrder(depositId: string, state: CashOrder["state"], total: bigint, filled: bigint, pending: bigint, platform: string, explanation: string): CashOrder {
  return {
    depositId,
    state,
    fills: [],
    totalAmount: total,
    filledAmount: filled,
    pendingAmount: pending,
    returnedAmount: 0n,
    nextActions: ["wait"],
    isInFlight: state === "awaiting-buyer" || state === "matched" || state === "delivering",
    updatedAt: Math.floor(Date.now() / 1000),
    payouts: [{ platform, platformHash: METHOD_HASH, payeeHash: PAYEE_HASH, active: true, pricing: { marketRate: true } }],
    explain: () => explanation,
  };
}

export type SellMode = "none" | "some" | "many" | "loading" | "error";

export function fakeCash(mode: SellMode): CashClient {
  const orders: CashOrder[] = [
    cashOrder(`${ESCROW}_9101`, "awaiting-buyer", 250_000_000n, 0n, 0n, "wise", "Waiting for a buyer. 250.00 USDC is for sale."),
    cashOrder(`${ESCROW}_9102`, "delivering", 1_200_000_000n, 480_000_000n, 120_000_000n, "venmo", "480.00 USDC sold so far; a buyer is paying for 120.00 more."),
    cashOrder(`${ESCROW}_9103`, "matched", 75_500_000n, 0n, 75_500_000n, "revolut", "A buyer is paying for 75.50 USDC."),
  ];
  const extra = Array.from({ length: 7 }, (_, i) => cashOrder(`${ESCROW}_92${i}`, "awaiting-buyer", BigInt(40 + i * 15) * 1_000_000n, 0n, 0n, i % 2 ? "paypal" : "cashapp", "Waiting for a buyer."));
  const list = mode === "many" ? [...orders, ...extra] : mode === "some" ? orders : [];
  return {
    orders: async () => {
      if (mode === "loading") return never();
      await wait(200);
      if (mode === "error") throw Object.assign(new Error("Indexer unavailable"), { code: "INDEXER_UNAVAILABLE", retryable: false });
      return list.map((o) => ({ ...o, payouts: undefined }));
    },
    order: async (id: string) => {
      await wait(150);
      const found = list.find((o) => o.depositId === id);
      if (!found) throw new Error("not found");
      return found;
    },
  } as unknown as CashClient;
}

export function platformName(id: BuyPlatformId): string {
  return BUY_PLATFORMS[id].name;
}
