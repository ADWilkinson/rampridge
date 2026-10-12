/**
 * Test fixtures for the buy flow: Curator quotes shaped like live responses,
 * receipts carrying real OrchestratorV3 / EscrowV2 events, and fakes for the
 * SDK client, wallet sender and Peer extension.
 */

import {
  appendAttributionToCalldata,
  type GetQuoteSingleResponse,
  type PeerExtensionSdk,
  type PeerMetadataMessage,
  type PeerMetadataMessageCallback,
  type Zkp2pClient,
} from "@zkp2p/sdk";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  zeroAddress,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { vi } from "vitest";
import { PEER_ABIS } from "../../client";
import type { BuyQuoteFees } from "../../market";
import type { BuyOrder } from "../types";
import type { TxSender, WalletCall } from "@/wallet/types";

export const BUYER: Address = "0xbE8bE9ff6ff098E28E21A698bEa44D4879cBB8A2";
export const ESCROW: Address = "0x777777779d229cdF3110e9de47943791c26300Ef";
export const ORCHESTRATOR: Address = "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7";
export const INTENT_HASH: Hex = "0x20409e5bc7113053c4d2d58aca0707363459a3b19ef84c84d4de7dbc0df0f6e5";
export const PAYEE_HASH: Hex = "0x9a393c621a7c166df390b323a33adad8448852e55efe24ce276d6ce085ccfa98";
export const USD_HASH: Hex = "0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e";
export const REVOLUT_HASH: Hex = "0x617f88ab82b5c1b014c539f7e75121427f0bb50a4c58b187a238531e7d58605d";
export const FEE_WALLET: Address = "0xC141Cbe4f4a9CAbc3cc78159a9268a4e008922CD";
/** RampRidge's 50 bps leg as the orchestrator stores it (18-decimal fraction). */
export const RAMPRIDGE_LEG = { recipient: FEE_WALLET, fee: 5_000_000_000_000_000n } as const;
/** The fees the default quote prices in (rawQuote()). */
export const QUOTE_FEES: BuyQuoteFees = {
  serviceBps: 95,
  service: 466_134n,
  manager: 49_116n,
  referrer: 0n,
  referrerBps: null,
  total: 515_250n,
};

/**
 * Calldata of a prepared OrchestratorV3 signalIntent, as the SDK builds it
 * (with the ERC-8021 suffix), carrying the legs and signature expiry given.
 */
export function signalCalldata(opts: {
  referralFees?: ReadonlyArray<{ recipient: Address; fee: bigint }>;
  /** Seconds since epoch. */
  signatureExpiration?: bigint;
} = {}): Hex {
  const data = encodeFunctionData({
    abi: PEER_ABIS.orchestrator,
    functionName: "signalIntent",
    args: [
      {
        escrow: ESCROW,
        depositId: 6528n,
        amount: 49_066_797n,
        to: BUYER,
        paymentMethod: REVOLUT_HASH,
        fiatCurrency: USD_HASH,
        conversionRate: 1_019_019_019_019_019_035n,
        referralFees: [...(opts.referralFees ?? [])],
        gatingServiceSignature: "0x1234",
        signatureExpiration: opts.signatureExpiration ?? 1_791_711_500n,
        postIntentHook: zeroAddress,
        preIntentHookData: "0x",
        data: "0x",
      },
    ],
  } as never);
  return appendAttributionToCalldata(data, ["rampridge", "peer-ref-TOFIAT"]);
}

/** True for the fake signal calldata the default prepare returns or a real encoded signalIntent. */
export function isSignalCall(data: Hex | undefined): boolean {
  return data === "0x5149" || (data?.startsWith(signalCalldata().slice(0, 10)) ?? false);
}

/** A Curator exact-fiat quote, as returned live for 50 USD on Revolut. */
export function rawQuote(overrides: Partial<GetQuoteSingleResponse> = {}): GetQuoteSingleResponse {
  return {
    fiatAmount: "50000000",
    fiatAmountFormatted: "50.00 USD",
    tokenAmount: "48600663",
    tokenAmountFormatted: "48.60 USDC",
    signalIntentAmount: "49066797",
    signalIntentAmountFormatted: "49.06 USDC",
    zkp2pFeeAmount: "466134",
    managerFeeAmount: "49116",
    totalFeeAmount: "515250",
    serviceFeeBps: 95,
    takerReferralFeeBps: 0,
    takerReferralFeeAmount: "0",
    paymentMethod: "revolut",
    payeeAddress: "0xD77e9879646be3307CA552441b14F4d6E79C8BBe",
    conversionRate: "1019019019019019035",
    sellerAutomatedReleaseAvailable: false,
    whitelistEnabled: false,
    allowedGroupIds: [],
    disputeProtectionOptedOut: false,
    disputeProtectionRequiresStake: false,
    intent: {
      depositId: 6528,
      processorName: "revolut",
      amount: "49066797",
      toAddress: BUYER,
      payeeDetails: PAYEE_HASH,
      processorIntentData: {},
      fiatCurrencyCode: USD_HASH,
      chainId: "8453",
      escrowAddress: ESCROW.toLowerCase(),
    },
    maker: { offchainId: "madouche" },
    payeeData: { offchainId: "madouche" },
    ...overrides,
  };
}

function eventAbi(abi: readonly unknown[], name: string): AbiEvent {
  const item = (abi as AbiEvent[]).find((x) => x.type === "event" && x.name === name);
  if (!item) throw new Error(`No ${name} event in ABI`);
  return item;
}

type MinedLog = Log<bigint, number, false>;

function log(address: Address, event: AbiEvent, args: Record<string, unknown>): MinedLog {
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
    blockHash: "0x".padEnd(66, "1") as Hex,
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: "0x".padEnd(66, "2") as Hex,
    transactionIndex: 0,
    removed: false,
  };
}

export function intentSignaledLog(opts: {
  intentHash?: Hex;
  owner?: Address;
  depositId?: bigint;
  amount?: bigint;
  rate?: bigint;
  timestamp?: bigint;
  orchestrator?: Address;
} = {}): MinedLog {
  return log(opts.orchestrator ?? ORCHESTRATOR, eventAbi(PEER_ABIS.orchestrator, "IntentSignaled"), {
    intentHash: opts.intentHash ?? INTENT_HASH,
    escrow: ESCROW,
    depositId: opts.depositId ?? 6528n,
    paymentMethod: REVOLUT_HASH,
    owner: opts.owner ?? BUYER,
    to: opts.owner ?? BUYER,
    amount: opts.amount ?? 49_066_797n,
    fiatCurrency: USD_HASH,
    conversionRate: opts.rate ?? 1_019_019_019_019_019_035n,
    timestamp: opts.timestamp ?? 1_791_711_141n,
  });
}

export function fundsLockedLog(opts: { intentHash?: Hex; expiry?: bigint } = {}): MinedLog {
  return log(ESCROW, eventAbi(PEER_ABIS.escrow, "FundsLocked"), {
    depositId: 6528n,
    intentHash: opts.intentHash ?? INTENT_HASH,
    amount: 49_066_797n,
    expiryTime: opts.expiry ?? 1_791_732_741n,
  });
}

export function intentFulfilledLog(opts: { intentHash?: Hex; amount?: bigint } = {}): MinedLog {
  return log(ORCHESTRATOR, eventAbi(PEER_ABIS.orchestrator, "IntentFulfilled"), {
    intentHash: opts.intentHash ?? INTENT_HASH,
    fundsTransferredTo: BUYER,
    amount: opts.amount ?? 48_600_663n,
    isManualRelease: false,
  });
}

export function receipt(logs: MinedLog[], status: "success" | "reverted" = "success"): TransactionReceipt {
  return {
    status,
    logs,
    transactionHash: `0x${"ab".repeat(32)}` as Hex,
    blockHash: `0x${"11".repeat(32)}` as Hex,
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

export function fakeSender(sendCalls: (calls: WalletCall[]) => Promise<TransactionReceipt>, address = BUYER): TxSender {
  return {
    address,
    kind: "smart",
    sponsored: true,
    sendCalls: vi.fn(sendCalls),
    signMessage: vi.fn(async () => "0x" as Hex),
    walletClient: { account: { address } } as unknown as WalletClient,
  };
}

/** An OrchestratorV3 `getIntent` record. */
export interface OrchestratorIntent {
  intentHash: Hex;
  owner: Address;
  to: Address;
  escrow: Address;
  depositId: bigint;
  amount: bigint;
  timestamp: bigint;
  conversionRate: bigint;
}

export function orchestratorIntent(overrides: Partial<OrchestratorIntent> = {}): OrchestratorIntent {
  return {
    intentHash: INTENT_HASH,
    owner: BUYER,
    to: BUYER,
    escrow: ESCROW,
    depositId: 6528n,
    amount: 49_066_797n,
    timestamp: 1_791_711_141n,
    conversionRate: 1_019_019_019_019_019_035n,
    ...overrides,
  };
}

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

/**
 * On-chain state the fake client's contract reads serve: EscrowV2 locks
 * (every intent is locked unless listed in `gone`), the deposit's rate
 * manager fee (none by default) and the buyer's open intents on
 * OrchestratorV3.
 */
export interface FakeChain {
  gone: Set<string>;
  orchestratorIntents: OrchestratorIntent[];
  /** EscrowV2.getManagerFee: an 18-decimal fraction of the release, paid to `recipient`. */
  managerFee: { recipient: Address; fee: bigint };
}

export interface FakeClient {
  client: Zkp2pClient;
  chain: FakeChain;
  signalPrepare: ReturnType<typeof vi.fn>;
  fulfillPrepare: ReturnType<typeof vi.fn>;
  cancelPrepare: ReturnType<typeof vi.fn>;
  accountIntents: ReturnType<typeof vi.fn>;
  intentByHash: ReturnType<typeof vi.fn>;
  ownerIntents: ReturnType<typeof vi.fn>;
  ethCall: ReturnType<typeof vi.fn>;
  readContract: ReturnType<typeof vi.fn>;
  waitForReceipt: ReturnType<typeof vi.fn>;
}

export function fakeClient(): FakeClient {
  const prepared = (data: Hex) => ({ to: ORCHESTRATOR, data, value: 0n, chainId: 8453 });
  const chain: FakeChain = { gone: new Set(), orchestratorIntents: [], managerFee: { recipient: zeroAddress, fee: 0n } };
  const signalPrepare = vi.fn(async () => prepared("0x5149"));
  const fulfillPrepare = vi.fn(async () => prepared("0xf0f0"));
  const cancelPrepare = vi.fn(async () => prepared("0xcace"));
  const accountIntents = vi.fn(async (): Promise<unknown[]> => []);
  const intentByHash = vi.fn(async (): Promise<unknown> => null);
  const ownerIntents = vi.fn(async (): Promise<unknown[]> => []);
  const ethCall = vi.fn(async () => "0x");
  const readContract = vi.fn(async (req: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    const args = req.args ?? [];
    switch (req.functionName) {
      case "getDepositIntent": {
        const hash = String(args[1]).toLowerCase();
        return chain.gone.has(hash)
          ? { intentHash: ZERO_HASH, amount: 0n, timestamp: 0n, expiryTime: 0n }
          : { intentHash: args[1], amount: 49_066_797n, timestamp: 1_791_711_141n, expiryTime: 1_791_732_741n };
      }
      case "getAccountIntents":
        return chain.orchestratorIntents.map((i) => i.intentHash);
      case "getManagerFee":
        return [chain.managerFee.recipient, chain.managerFee.fee];
      case "getIntent": {
        const found = chain.orchestratorIntents.find((i) => i.intentHash.toLowerCase() === String(args[0]).toLowerCase());
        return found ?? orchestratorIntent({ intentHash: ZERO_HASH, owner: zeroAddress, to: zeroAddress, escrow: zeroAddress, depositId: 0n, amount: 0n, timestamp: 0n, conversionRate: 0n });
      }
      default:
        throw new Error(`Unexpected contract read ${req.functionName}`);
    }
  });
  const waitForReceipt = vi.fn(async (): Promise<TransactionReceipt> => {
    throw new Error("Timed out while waiting for transaction");
  });
  const client = {
    signalIntent: Object.assign(vi.fn(), { prepare: signalPrepare }),
    fulfillIntent: Object.assign(vi.fn(), { prepare: fulfillPrepare }),
    cancelIntent: Object.assign(vi.fn(), { prepare: cancelPrepare }),
    getPvAccountIntents: accountIntents,
    getPvDepositById: vi.fn(async () => ({ availableLiquidity: 1_000_000_000n })),
    getFulfillIntentInputs: vi.fn(async () => {
      throw new Error("not found");
    }),
    publicClient: {
      request: ethCall,
      getBalance: vi.fn(async () => 10n ** 18n),
      readContract,
      waitForTransactionReceipt: waitForReceipt,
    },
    indexer: { getIntentByHash: intentByHash, getOwnerIntents: ownerIntents },
  } as unknown as Zkp2pClient;
  return {
    client,
    chain,
    signalPrepare,
    fulfillPrepare,
    cancelPrepare,
    accountIntents,
    intentByHash,
    ownerIntents,
    ethCall,
    readContract,
    waitForReceipt,
  };
}

/** A promise the test settles by hand, to hold an async step mid-flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function fakeExtension(overrides: Partial<PeerExtensionSdk> = {}) {
  const listeners = new Set<PeerMetadataMessageCallback>();
  const sdk: PeerExtensionSdk = {
    isAvailable: () => true,
    getState: async () => "ready",
    checkConnectionStatus: async () => "connected",
    requestConnection: async () => true,
    getVersion: async () => "0.7.2",
    authenticate: vi.fn(),
    onMetadataMessage: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    openInstallPage: vi.fn(),
    ...overrides,
  };
  return { sdk, listeners, emit: (m: PeerMetadataMessage) => [...listeners].forEach((cb) => cb(m)) };
}

export function captureMessage(platform = "revolut", rows: PeerMetadataMessage["metadata"] = []): PeerMetadataMessage {
  return {
    platform,
    requestId: "req",
    expiresAt: 2_000_000_000_000,
    metadata: rows,
    buyerTeeCapture: { encryptedSessionMaterial: "enc" },
  };
}

/** Lets queued promise callbacks run. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** The order the store persists after signalling the default Revolut quote. */
export function storedOrder(overrides: Partial<BuyOrder> = {}): BuyOrder {
  return {
    owner: BUYER,
    intentHash: INTENT_HASH,
    depositId: "6528",
    escrow: ESCROW,
    orchestrator: ORCHESTRATOR,
    platform: "revolut",
    currency: "USD",
    usdcGross: 49_066_797n,
    usdcExpected: 48_600_663n,
    rate: 1_019_019_019_019_019_035n,
    fiatToSend: 50_000_000n,
    fiatToSendText: "50.00",
    payeeHandle: "stored-handle",
    payeeDetailsHash: PAYEE_HASH,
    signalTxHash: null,
    signaledAt: 1_791_711_141_000,
    expiresAt: 1_791_732_741_000,
    verifyMethodId: null,
    memo: null,
    status: "active",
    fees: QUOTE_FEES,
    paidClaimedAt: null,
    ...overrides,
  };
}

/** A ProtocolViewer intent view for an open Revolut order owned by BUYER. */
export function pvIntentView(overrides: { intentHash?: Hex; paymentMethod?: Hex } = {}) {
  return {
    intentHash: overrides.intentHash ?? INTENT_HASH,
    intent: {
      owner: BUYER,
      to: BUYER,
      escrow: ESCROW,
      depositId: 6528n,
      amount: 49_066_797n,
      timestamp: 1_791_711_141n,
      paymentMethod: overrides.paymentMethod ?? REVOLUT_HASH,
      fiatCurrency: USD_HASH,
      conversionRate: 1_019_019_019_019_019_035n,
      referralFees: [{ recipient: "0x0000000000000000000000000000000000000fee" as Address, fee: 9_500_000_000_000_000n }],
      postIntentHook: "0x0000000000000000000000000000000000000000",
      data: "0x",
    },
    deposit: {
      depositId: 6528n,
      availableLiquidity: 0n,
      paymentMethods: [
        {
          paymentMethod: overrides.paymentMethod ?? REVOLUT_HASH,
          verificationData: { intentGatingService: "0x", payeeDetails: PAYEE_HASH, data: "0x" },
          currencies: [],
        },
      ],
    },
  };
}
