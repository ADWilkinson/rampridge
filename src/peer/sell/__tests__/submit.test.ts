import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CashoutResult } from "@zkp2p/cash";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { isSellFlowError, type SellFlowError } from "../errors";
import type { ResolvedLeg, SubmitSteps } from "../machine";
import { memoryStorage, readLastSellDeposit } from "../persistence";
import {
  discardPendingSell,
  reconcileError,
  reconcilePendingSell,
  retryAccessPolicy,
  submitSell,
  userOperationReverted,
  ABANDON_AFTER_MS,
  DISCARD_AFTER_MS,
  EOA_DISCARD_AFTER_MS,
  type SellDeps,
  type SellPublicClient,
} from "../submit";
import {
  cashError,
  ESCROW,
  hash,
  mockCashClient,
  mockSender,
  order,
  OWNER,
  PAYPAL_METHOD,
  pendingStore,
  plan,
  receipt,
  userRejection,
  VENMO_METHOD,
  type MockSender,
} from "./helpers";

const USER_OPERATION_EVENT = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

function userOperationLog(sender: Address, success: boolean): Log {
  return {
    address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    topics: encodeEventTopics({
      abi: USER_OPERATION_EVENT,
      eventName: "UserOperationEvent",
      args: { userOpHash: hash(77), sender, paymaster: ESCROW },
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
      [1n, success, 10n, 20n],
    ),
    blockHash: hash(1),
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: hash(1),
    transactionIndex: 0,
    removed: false,
  } as Log;
}

const AMOUNT = 100_000_000n;
const DEPOSIT = "0x2222222222222222222222222222222222222222_7";
const VENMO_LEG: ResolvedLeg = { platform: "venmo", currencies: ["USD"], offchainId: "zezima" };
const REVOLUT_LEG: ResolvedLeg = { platform: "revolut", currencies: ["EUR", "GBP"], offchainId: "zezima1abc" };
const T0 = 1_760_000_000_000;
const POLICY = "0x389Cd9bA91FfFcd83d267B241E975541892759Ce" as Address;
const PEER_PAY_GROUP = "0x174b8a29536721a3eae290bfd55651b85a53fc334b971d993fa93ed8dde15e48" as Hex;
const CONFIGURE_DEPOSIT = parseAbi([
  "function configureDeposit(address _escrow, uint256 _depositId, bytes32 _paymentMethod, bool _enabled, bytes32[] _groupIds, address[] _takers)",
]);

function finalized(txHash: Hex): CashoutResult {
  return { depositId: DEPOSIT, txHash } as unknown as CashoutResult;
}

/** The real calldata shape `prepareAccessPolicy` returns for the deposit. */
function policyTx(method: Hex) {
  return {
    to: POLICY,
    data: encodeFunctionData({ abi: CONFIGURE_DEPOSIT, args: [ESCROW, 7n, method, true, [PEER_PAY_GROUP], []] }),
    value: 0n,
    chainId: 8453,
  };
}

interface ChainState {
  nonce: number;
  pendingNonce?: number;
  code?: Hex;
  usdc: bigint;
  receipts: Record<string, TransactionReceipt>;
  /** Policy state per payment method. */
  policies: Record<string, { enabled: boolean; groups: Hex[] }>;
}

/** A Base public client over mutable state; unknown receipts throw like viem's TransactionReceiptNotFoundError. */
function chain(initial: Partial<ChainState> = {}) {
  const state: ChainState = { nonce: 12, usdc: AMOUNT * 2n, receipts: {}, policies: {}, ...initial };
  const mocks = {
    getTransactionCount: vi.fn(async ({ blockTag }: { blockTag?: string }) =>
      blockTag === "pending" ? (state.pendingNonce ?? state.nonce) : state.nonce,
    ),
    getCode: vi.fn(async () => state.code),
    getBalance: vi.fn(async () => 10n ** 15n),
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === "balanceOf") return state.usdc;
      const policy = state.policies[String(args[2])];
      if (functionName === "enabled") return policy?.enabled ?? false;
      if (functionName === "getAllowedGroups") return policy?.groups ?? [];
      throw new Error(`unexpected read ${functionName}`);
    }),
    getTransactionReceipt: vi.fn(async ({ hash: txHash }: { hash: Hex }) => {
      const found = state.receipts[txHash];
      if (!found) throw Object.assign(new Error("Transaction receipt not found"), { name: "TransactionReceiptNotFoundError" });
      return found;
    }),
  };
  return { state, mocks, client: mocks as unknown as SellPublicClient };
}

const walletError = (code: string, message: string, extra: object = {}) => Object.assign(new Error(message), { code, ...extra });

async function failure(promise: Promise<unknown>): Promise<SellFlowError> {
  try {
    await promise;
  } catch (err) {
    if (isSellFlowError(err)) return err;
    throw err;
  }
  throw new Error("expected a SellFlowError");
}

let client: ReturnType<typeof mockCashClient>;
let sender: MockSender;
let storage: ReturnType<typeof memoryStorage>;
let deps: SellDeps;
let now: number;

beforeEach(() => {
  client = mockCashClient();
  sender = mockSender("smart");
  storage = memoryStorage();
  now = T0;
  deps = { client, sender, pending: pendingStore(storage), storage, now: () => now };
});

describe("submitSell", () => {
  it("batches approve + createDeposit, finalizes from the receipt, then attaches each policy", async () => {
    client.prepare.mockResolvedValue(plan({ accessPolicyPaymentMethods: [VENMO_METHOD] }));
    client.finalizePreparedCashout.mockImplementation((r: { transactionHash: Hex }) => finalized(r.transactionHash));
    sender.sendCalls.mockResolvedValueOnce(receipt(hash(1))).mockResolvedValueOnce(receipt(hash(2)));
    const seen: SubmitSteps[] = [];

    const listed = await submitSell(deps, { amount: AMOUNT, legs: [VENMO_LEG] }, (s) => seen.push(s));

    expect(client.prepare).toHaveBeenCalledWith({
      amount: AMOUNT,
      receive: { platform: "venmo", currency: "USD", payee: "zezima" },
    });
    expect(sender.sendCalls).toHaveBeenCalledTimes(2);
    expect(sender.sendCalls.mock.calls[0]?.[0]).toHaveLength(2);
    expect(client.prepareAccessPolicy).toHaveBeenCalledWith(DEPOSIT, VENMO_METHOD);
    expect(listed).toEqual({
      depositId: DEPOSIT,
      amount: AMOUNT,
      legs: [{ platform: "venmo", currencies: ["USD"] }],
      txHashes: { createDeposit: hash(1), accessPolicy: [hash(2)] },
    });
    expect(seen.at(-1)).toEqual({ approve: "done", createDeposit: "done", accessPolicy: "done" });
    expect(seen.some((s) => s.approve === "active" && s.createDeposit === "active")).toBe(true);
    expect(deps.pending!.read(OWNER)).toBeNull();
    expect(readLastSellDeposit(OWNER, storage)?.depositId).toBe(DEPOSIT);
  });

  it("sends a multi-currency, multi-platform receive and skips policy when none is required", async () => {
    client.prepare.mockResolvedValue(plan());
    client.finalizePreparedCashout.mockImplementation((r: { transactionHash: Hex }) => finalized(r.transactionHash));
    sender.sendCalls.mockResolvedValue(receipt(hash(1)));
    const seen: SubmitSteps[] = [];

    await submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG, { platform: "wise", currencies: ["EUR"], offchainId: "w" }] }, (s) =>
      seen.push(s),
    );

    expect(client.prepare.mock.calls[0]?.[0].receive).toEqual([
      { platform: "revolut", currencies: ["EUR", "GBP"], payee: "zezima1abc" },
      { platform: "wise", currency: "EUR", payee: "w" },
    ]);
    expect(sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.accessPolicy).toBe("skipped");
  });

  it("clears the attempt when the player cancels in the wallet", async () => {
    client.prepare.mockResolvedValue(plan());
    sender.sendCalls.mockRejectedValue(userRejection());

    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));

    expect(err.code).toBe("USER_REJECTED");
    expect(err.recovery.action).toBe("retry");
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("clears the attempt when the wallet proves nothing was broadcast", async () => {
    client.prepare.mockResolvedValue(plan());
    const estimate = Object.assign(new Error("estimate failed"), { name: "EstimateGasExecutionError" });
    sender.sendCalls.mockRejectedValue(Object.assign(new Error("send failed"), { cause: estimate }));

    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));

    expect(err.recovery.action).toBe("retry");
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("keeps the attempt and refuses a second deposit when the send outcome is unknown", async () => {
    client.prepare.mockResolvedValue(plan());
    sender.sendCalls.mockRejectedValue(new Error("bundler timeout"));

    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(err.code).toBe("SUBMISSION_UNKNOWN");
    expect(err.recovery.action).toBe("reconcile");
    expect(deps.pending!.read(OWNER)?.stage).toBe("sending");

    client.prepare.mockClear();
    const again = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(again.code).toBe("PENDING_SUBMISSION_EXISTS");
    expect(client.prepare).not.toHaveBeenCalled();
    expect(sender.sendCalls).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent submissions from the same wallet", async () => {
    let release: (r: TransactionReceipt) => void = () => undefined;
    client.prepare.mockResolvedValue(plan());
    client.finalizePreparedCashout.mockImplementation((r: { transactionHash: Hex }) => finalized(r.transactionHash));
    sender.sendCalls.mockReturnValue(new Promise<TransactionReceipt>((resolve) => (release = resolve)));

    const first = submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] });
    await vi.waitFor(() => expect(sender.sendCalls).toHaveBeenCalled());
    const second = await failure(submitSell({ ...deps, pending: pendingStore(memoryStorage()) }, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(second.code).toBe("PENDING_SUBMISSION_EXISTS");
    release(receipt(hash(1)));
    await expect(first).resolves.toMatchObject({ depositId: DEPOSIT });
  });

  it("classifies the wallet's typed failures: never-sent and reverted clear, pending keeps its hash", async () => {
    client.prepare.mockResolvedValue(plan());

    sender.sendCalls.mockRejectedValueOnce(walletError("call_reverted", "The transaction would fail, so nothing was sent."));
    const notSent = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(notSent).toMatchObject({ code: "WALLET_NOT_SENT", message: "The transaction would fail, so nothing was sent." });
    expect(notSent.recovery.action).toBe("retry");
    expect(deps.pending!.read(OWNER)).toBeNull();

    sender.sendCalls.mockRejectedValueOnce(walletError("chain_switch_failed", "Switch your wallet to the Base network."));
    expect((await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }))).recovery.action).toBe("reconnectWallet");

    sender.sendCalls.mockRejectedValueOnce(walletError("reverted", "The transaction failed on Base.", { hash: hash(8) }));
    const reverted = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(reverted).toMatchObject({ code: "TRANSACTION_FAILED", transactionHash: hash(8) });
    expect(deps.pending!.read(OWNER)).toBeNull();

    sender.sendCalls.mockRejectedValueOnce(walletError("receipt_timeout", "Submitted but not confirmed.", { hash: hash(9) }));
    const pending = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(pending.code).toBe("SUBMISSION_UNKNOWN");
    expect(deps.pending!.read(OWNER)).toMatchObject({ stage: "sending", createTxHash: hash(9) });
  });

  it("never reconciles over a submission still running in this tab", async () => {
    let release: (r: TransactionReceipt) => void = () => undefined;
    client.prepare.mockResolvedValue(plan());
    client.finalizePreparedCashout.mockImplementation((r: { transactionHash: Hex }) => finalized(r.transactionHash));
    sender.sendCalls.mockReturnValue(new Promise<TransactionReceipt>((resolve) => (release = resolve)));

    const running = submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] });
    await vi.waitFor(() => expect(sender.sendCalls).toHaveBeenCalled());
    expect(await reconcilePendingSell(deps)).toEqual({ status: "inFlight" });
    expect(await discardPendingSell(deps)).toEqual({ status: "inFlight" });
    expect(deps.pending!.read(OWNER)?.stage).toBe("sending");
    release(receipt(hash(1)));
    await running;
    expect(await reconcilePendingSell(deps)).toEqual({ status: "none" });
  });

  it("treats a smart wallet's reverted user operation inside a successful bundle as nothing listed", async () => {
    client.prepare.mockResolvedValue(plan());
    const bundle = { ...receipt(hash(1)), logs: [userOperationLog(OWNER, false)] } as TransactionReceipt;
    sender.sendCalls.mockResolvedValue(bundle);
    client.finalizePreparedCashout.mockImplementation(() => {
      throw cashError("DEPOSIT_RESOLUTION_FAILED");
    });

    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));

    expect(err.code).toBe("TRANSACTION_FAILED");
    expect(err.recovery.action).toBe("retry");
    expect(deps.pending!.read(OWNER)).toBeNull();
    expect(userOperationReverted({ logs: [userOperationLog(OWNER, true)] }, OWNER)).toBe(false);
    expect(userOperationReverted({ logs: [userOperationLog(ESCROW, false)] }, OWNER)).toBe(false);
  });

  it("treats a reverted batch as nothing listed", async () => {
    client.prepare.mockResolvedValue(plan());
    sender.sendCalls.mockResolvedValue(receipt(hash(1), "reverted"));
    client.finalizePreparedCashout.mockImplementation(() => {
      throw cashError("TRANSACTION_FAILED");
    });

    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));

    expect(err.code).toBe("TRANSACTION_FAILED");
    expect(err.recovery.action).toBe("retry");
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("keeps the tx hash when the deposit cannot be decoded and reconciles it from the receipt", async () => {
    client.prepare.mockResolvedValue(plan());
    sender.sendCalls.mockResolvedValue(receipt(hash(1)));
    client.finalizePreparedCashout.mockImplementationOnce(() => {
      throw cashError("DEPOSIT_RESOLUTION_FAILED");
    });

    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(err.recovery.action).toBe("reconcile");
    expect(deps.pending!.read(OWNER)?.createTxHash).toBe(hash(1));

    client.finalizePreparedCashout.mockImplementation((r: { transactionHash: Hex }) => finalized(r.transactionHash));
    const publicClient = { getTransactionReceipt: vi.fn().mockResolvedValue(receipt(hash(1))) } as unknown as SellPublicClient;
    const result = await reconcilePendingSell({ ...deps, publicClient });
    expect(result).toMatchObject({ status: "listed", listed: { depositId: DEPOSIT, txHashes: { createDeposit: hash(1) } } });
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("records the wallet's nonce, code and USDC before anything is sent", async () => {
    const { client: publicClient, mocks } = chain({ nonce: 41, code: "0xef0100aa", usdc: AMOUNT * 3n });
    client.prepare.mockResolvedValue(plan());
    sender.sendCalls.mockRejectedValueOnce(new Error("bundler timeout"));

    await failure(submitSell({ ...deps, publicClient }, { amount: AMOUNT, legs: [REVOLUT_LEG] }));

    expect(deps.pending!.read(OWNER)?.baseline).toEqual({ nonce: 41, isContract: true, usdcBalance: (AMOUNT * 3n).toString() });
    const sentAt = sender.sendCalls.mock.invocationCallOrder[0]!;
    expect(mocks.getTransactionCount.mock.invocationCallOrder[0]).toBeLessThan(sentAt);
    expect(mocks.getCode.mock.invocationCallOrder[0]).toBeLessThan(sentAt);
  });

  it("stores no baseline when the chain cannot be read, and still sends", async () => {
    const { client: publicClient, mocks } = chain();
    mocks.getCode.mockRejectedValue(new Error("rpc down"));
    client.prepare.mockResolvedValue(plan());
    sender.sendCalls.mockRejectedValueOnce(new Error("bundler timeout"));

    await failure(submitSell({ ...deps, publicClient }, { amount: AMOUNT, legs: [REVOLUT_LEG] }));

    expect(sender.sendCalls).toHaveBeenCalledTimes(1);
    expect(deps.pending!.read(OWNER)?.baseline).toBeNull();
  });

  it("checks balance and gas before preparing anything", async () => {
    const publicClient = {
      readContract: vi.fn().mockResolvedValue(AMOUNT - 1n),
      getBalance: vi.fn().mockResolvedValue(0n),
    } as unknown as SellPublicClient;

    const err = await failure(submitSell({ ...deps, publicClient }, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(err.code).toBe("INSUFFICIENT_BALANCE");
    expect(client.prepare).not.toHaveBeenCalled();

    const eoa = mockSender("external", false);
    (publicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue(AMOUNT);
    const noGas = await failure(submitSell({ ...deps, sender: eoa, publicClient }, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(noGas.code).toBe("NO_GAS");
    expect(noGas.recovery.action).toBe("addGas");
  });

  it("maps payee problems found at prepare time without sending", async () => {
    client.prepare.mockRejectedValue(cashError("PAYEE_VERIFICATION_REQUIRED"));
    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [VENMO_LEG] }));
    expect(err.code).toBe("PAYEE_VERIFICATION_REQUIRED");
    expect(err.recovery.action).toBe("editForm");
    expect(sender.sendCalls).not.toHaveBeenCalled();
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("refuses a plan whose final call is not createDeposit", async () => {
    client.prepare.mockResolvedValue(
      plan({
        steps: [
          { kind: "createDeposit", description: "Create" },
          { kind: "approve", description: "Approve" },
        ],
      }),
    );
    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(err.code).toBe("INVALID_PLAN");
    expect(sender.sendCalls).not.toHaveBeenCalled();
  });
});

describe("access policy recovery", () => {
  beforeEach(() => {
    client.prepare.mockResolvedValue(plan({ accessPolicyPaymentMethods: [VENMO_METHOD, PAYPAL_METHOD] }));
    client.finalizePreparedCashout.mockImplementation((r: { transactionHash: Hex }) => finalized(r.transactionHash));
  });

  it("reports ACCESS_POLICY_CONFIGURATION_FAILED with the deposit id and finishes only what remains", async () => {
    sender.sendCalls
      .mockResolvedValueOnce(receipt(hash(1)))
      .mockResolvedValueOnce(receipt(hash(2)))
      .mockRejectedValueOnce(userRejection());

    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [VENMO_LEG] }));
    expect(err.code).toBe("ACCESS_POLICY_CONFIGURATION_FAILED");
    expect(err.recovery.action).toBe("retryAccessPolicy");
    expect(err.depositId).toBe(DEPOSIT);
    expect(err.paymentMethod).toBe(PAYPAL_METHOD);
    expect(deps.pending!.read(OWNER)).toMatchObject({ stage: "deposited", depositId: DEPOSIT });

    client.prepare.mockClear();
    client.prepareAccessPolicy.mockClear();
    sender.sendCalls.mockResolvedValueOnce(receipt(hash(3)));
    const listed = await retryAccessPolicy(deps);

    expect(client.prepare).not.toHaveBeenCalled();
    expect(client.prepareAccessPolicy).toHaveBeenCalledTimes(1);
    expect(client.prepareAccessPolicy).toHaveBeenCalledWith(DEPOSIT, PAYPAL_METHOD);
    expect(listed.txHashes.accessPolicy).toEqual([hash(2), hash(3)]);
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("treats a reverted policy transaction as a policy failure, not a new deposit", async () => {
    sender.sendCalls.mockResolvedValueOnce(receipt(hash(1))).mockResolvedValueOnce(receipt(hash(2), "reverted"));
    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [VENMO_LEG] }));
    expect(err.code).toBe("ACCESS_POLICY_CONFIGURATION_FAILED");
    expect(err.transactionHash).toBe(hash(2));
    const pending = await reconcilePendingSell(deps);
    expect(pending).toMatchObject({ status: "needsAccessPolicy", depositId: DEPOSIT, remaining: [VENMO_METHOD, PAYPAL_METHOD] });
    expect(reconcileError(pending)?.recovery.action).toBe("retryAccessPolicy");
  });

  it("can finish policies from the error alone if the pending record was lost", async () => {
    sender.sendCalls.mockResolvedValueOnce(receipt(hash(5)));
    const listed = await retryAccessPolicy(deps, undefined, {
      depositId: DEPOSIT,
      paymentMethods: [PAYPAL_METHOD],
      amount: AMOUNT,
      legs: [{ platform: "paypal", currencies: ["USD"] }],
    });
    expect(client.prepareAccessPolicy).toHaveBeenCalledWith(DEPOSIT, PAYPAL_METHOD);
    expect(listed.depositId).toBe(DEPOSIT);
  });

  /** Leaves a confirmed deposit whose Venmo policy was rejected in the wallet. */
  async function leavePolicyUnattached() {
    client.prepare.mockResolvedValue(plan({ accessPolicyPaymentMethods: [VENMO_METHOD] }));
    sender.sendCalls.mockResolvedValueOnce(receipt(hash(1))).mockRejectedValueOnce(userRejection());
    await failure(submitSell(deps, { amount: AMOUNT, legs: [VENMO_LEG] }));
    expect(deps.pending!.read(OWNER)).toMatchObject({ stage: "deposited", depositId: DEPOSIT });
  }

  it("clears the record and reports the order closed when it was withdrawn before the policy attached", async () => {
    await leavePolicyUnattached();
    client.order.mockResolvedValue(order(DEPOSIT, AMOUNT, T0 / 1000 + 60, { withdrawn: AMOUNT }));

    const result = await reconcilePendingSell(deps);

    expect(result).toEqual({ status: "closed", depositId: DEPOSIT, state: "returned" });
    expect(reconcileError(result)).toBeNull();
    expect(deps.pending!.read(OWNER)).toBeNull();
    sender.sendCalls.mockReset();
    client.finalizePreparedCashout.mockImplementation(() => finalized(hash(9)));
    client.prepare.mockResolvedValue(plan());
    sender.sendCalls.mockResolvedValue(receipt(hash(9)));
    await expect(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] })).resolves.toMatchObject({ depositId: DEPOSIT });
  });

  it("refuses to finish a policy on a closed order, clears the record and sends nothing", async () => {
    await leavePolicyUnattached();
    client.order.mockResolvedValue(order(DEPOSIT, AMOUNT, T0 / 1000 + 60, { taken: AMOUNT }));
    sender.sendCalls.mockClear();

    const err = await failure(retryAccessPolicy(deps));

    expect(err.code).toBe("ORDER_NOT_ACTIVE");
    expect(err.recovery.action).toBe("none");
    expect(err.depositId).toBe(DEPOSIT);
    expect(sender.sendCalls).not.toHaveBeenCalled();
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("keeps finishing the policy while the order is open or not indexed yet", async () => {
    await leavePolicyUnattached();
    client.order.mockRejectedValueOnce(cashError("ORDER_NOT_FOUND", undefined, true));
    expect(await reconcilePendingSell(deps)).toMatchObject({ status: "needsAccessPolicy", depositId: DEPOSIT });

    client.order.mockResolvedValue(order(DEPOSIT, AMOUNT, T0 / 1000 + 60));
    sender.sendCalls.mockResolvedValueOnce(receipt(hash(3)));
    const listed = await retryAccessPolicy(deps);
    expect(listed.txHashes.accessPolicy).toEqual([hash(3)]);
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("remembers a policy transaction that never confirmed and does not resend it once it has", async () => {
    const { client: publicClient, state } = chain();
    deps = { ...deps, publicClient };
    client.prepare.mockResolvedValue(plan({ accessPolicyPaymentMethods: [VENMO_METHOD] }));
    client.order.mockResolvedValue(order(DEPOSIT, AMOUNT, T0 / 1000 + 60));
    sender.sendCalls
      .mockResolvedValueOnce(receipt(hash(1)))
      .mockRejectedValueOnce(walletError("receipt_timeout", "Submitted but not confirmed.", { hash: hash(4) }));

    const err = await failure(submitSell(deps, { amount: AMOUNT, legs: [VENMO_LEG] }));
    expect(err).toMatchObject({ code: "ACCESS_POLICY_CONFIGURATION_FAILED", transactionHash: hash(4), depositId: DEPOSIT });
    expect(err.message).toMatch(/hasn't confirmed yet/);
    expect(err.recovery.action).toBe("retryAccessPolicy");
    expect(deps.pending!.read(OWNER)?.pendingPolicyTxHashes).toEqual({ [VENMO_METHOD]: hash(4) });

    // Still unconfirmed and not configured: reconcile reports it, without sending.
    expect(await reconcilePendingSell(deps)).toMatchObject({ status: "needsAccessPolicy", remaining: [VENMO_METHOD] });

    state.receipts[hash(4)] = receipt(hash(4));
    const listed = await retryAccessPolicy(deps);
    expect(sender.sendCalls).toHaveBeenCalledTimes(2);
    expect(listed.txHashes.accessPolicy).toEqual([hash(4)]);
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("sends the policy again when the remembered transaction reverted", async () => {
    const { client: publicClient, state } = chain();
    deps = { ...deps, publicClient };
    client.prepare.mockResolvedValue(plan({ accessPolicyPaymentMethods: [VENMO_METHOD] }));
    client.order.mockResolvedValue(order(DEPOSIT, AMOUNT, T0 / 1000 + 60));
    sender.sendCalls
      .mockResolvedValueOnce(receipt(hash(1)))
      .mockRejectedValueOnce(walletError("receipt_timeout", "Submitted but not confirmed.", { hash: hash(4) }));
    await failure(submitSell(deps, { amount: AMOUNT, legs: [VENMO_LEG] }));

    state.receipts[hash(4)] = receipt(hash(4), "reverted");
    sender.sendCalls.mockResolvedValueOnce(receipt(hash(5)));
    const listed = await retryAccessPolicy(deps);

    expect(sender.sendCalls).toHaveBeenCalledTimes(3);
    expect(listed.txHashes.accessPolicy).toEqual([hash(5)]);
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("does not send a policy the chain already shows configured", async () => {
    const { client: publicClient, state } = chain();
    deps = { ...deps, publicClient };
    client.prepareAccessPolicy.mockImplementation((_id: string, method: Hex) => policyTx(method));
    await leavePolicyUnattached();
    client.order.mockResolvedValue(order(DEPOSIT, AMOUNT, T0 / 1000 + 60));

    // Enabled without the Peer Pay group is not configured.
    state.policies[VENMO_METHOD] = { enabled: true, groups: [] };
    expect(await reconcilePendingSell(deps)).toMatchObject({ status: "needsAccessPolicy" });

    state.policies[VENMO_METHOD] = { enabled: true, groups: [PEER_PAY_GROUP] };
    sender.sendCalls.mockClear();
    const result = await reconcilePendingSell(deps);

    expect(result).toMatchObject({ status: "listed", listed: { depositId: DEPOSIT, txHashes: { accessPolicy: [] } } });
    expect(sender.sendCalls).not.toHaveBeenCalled();
    expect(deps.pending!.read(OWNER)).toBeNull();
  });
});

describe("reconcilePendingSell", () => {
  async function leaveUnknownAttempt(knownOrders: ReturnType<typeof order>[] = []) {
    client.orders.mockResolvedValueOnce(knownOrders);
    client.prepare.mockResolvedValue(plan({ accessPolicyPaymentMethods: [VENMO_METHOD] }));
    sender.sendCalls.mockRejectedValueOnce(new Error("connection lost"));
    await failure(submitSell(deps, { amount: AMOUNT, legs: [VENMO_LEG] }));
  }

  it("returns none when there is nothing pending", async () => {
    expect(await reconcilePendingSell(deps)).toEqual({ status: "none" });
  });

  it("finds the new deposit among the wallet's orders and asks to finish its policy", async () => {
    const old = order("0xold_1", AMOUNT, T0 / 1000 - 86_400);
    await leaveUnknownAttempt([old]);
    client.orders.mockResolvedValue([old, order(DEPOSIT, AMOUNT, T0 / 1000 + 30)]);

    const result = await reconcilePendingSell(deps);

    expect(result).toMatchObject({ status: "needsAccessPolicy", depositId: DEPOSIT, remaining: [VENMO_METHOD] });
    expect(deps.pending!.read(OWNER)).toMatchObject({ stage: "deposited", depositId: DEPOSIT });
  });

  it("does not mistake an existing deposit of the same size for the new one", async () => {
    const old = order("0xold_1", AMOUNT, T0 / 1000 + 10);
    await leaveUnknownAttempt([old]);
    client.orders.mockResolvedValue([old]);

    const result = await reconcilePendingSell(deps);
    expect(result).toMatchObject({ status: "notFound", canDiscard: false });
  });

  it("lets a smart wallet discard only after the safety window, while its USDC shows no deposit landed", async () => {
    const { client: publicClient, state } = chain();
    deps = { ...deps, publicClient };
    await leaveUnknownAttempt();
    client.orders.mockResolvedValue([]);

    now = T0 + EOA_DISCARD_AFTER_MS + 30_000;
    const early = await discardPendingSell(deps);
    expect(early).toMatchObject({ status: "notFound", canDiscard: false, unconfirmedTxHash: null });
    expect(deps.pending!.read(OWNER)).not.toBeNull();
    const copy = reconcileError(early);
    expect(copy?.code).toBe("SUBMISSION_UNKNOWN");
    expect(copy?.recovery.canDiscard).toBe(false);

    // The balance fell by the order amount: a deposit may have landed that the index has not caught up with.
    now = T0 + DISCARD_AFTER_MS + 1;
    state.usdc = AMOUNT;
    expect(await discardPendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false });

    state.usdc = AMOUNT * 2n;
    const ready = await reconcilePendingSell(deps);
    expect(ready).toMatchObject({ status: "notFound", canDiscard: true });
    expect(reconcileError(ready)?.recovery).toMatchObject({ canDiscard: true, hint: expect.stringMatching(/reject it/) });
    expect(await discardPendingSell(deps)).toEqual({ status: "none" });
    expect(deps.pending!.read(OWNER)).toBeNull();
  });

  it("without a pre-send baseline, waits for the last-resort window", async () => {
    await leaveUnknownAttempt();
    client.orders.mockResolvedValue([]);
    expect(deps.pending!.read(OWNER)?.baseline).toBeNull();

    now = T0 + DISCARD_AFTER_MS + 1;
    expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false });
    now = T0 + ABANDON_AFTER_MS;
    expect(await discardPendingSell(deps)).toEqual({ status: "none" });
  });

  describe("a plain EOA", () => {
    let eoa: MockSender;
    let evm: ReturnType<typeof chain>;

    beforeEach(async () => {
      eoa = mockSender("external", false);
      evm = chain({ nonce: 12 });
      deps = { ...deps, sender: eoa, publicClient: evm.client };
      client.orders.mockResolvedValue([]);
      client.prepare.mockResolvedValue(plan());
    });

    async function leaveDroppedAttempt(err: unknown = new Error("rpc dropped")) {
      eoa.sendCalls.mockRejectedValueOnce(err);
      await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
      expect(deps.pending!.read(OWNER)?.baseline).toEqual({ nonce: 12, isContract: false, usdcBalance: (AMOUNT * 2n).toString() });
    }

    it("may discard after a minute while its mined nonce shows nothing was sent since", async () => {
      await leaveDroppedAttempt();

      now = T0 + EOA_DISCARD_AFTER_MS - 1;
      expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false });
      now = T0 + 90_000;
      expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: true });
    });

    it("may not discard early once its nonce has advanced, since the deposit may be mined but not indexed", async () => {
      await leaveDroppedAttempt();
      evm.state.nonce = 14;

      now = T0 + 90_000;
      expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false });
      now = T0 + DISCARD_AFTER_MS + 1;
      evm.state.usdc = AMOUNT;
      expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false });
    });

    it("may not discard early while a transaction is queued", async () => {
      await leaveDroppedAttempt();
      evm.state.pendingNonce = 13;
      now = T0 + 90_000;
      expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false });
    });

    it("waits for a deposit transaction the wallet reported, however quiet the nonce", async () => {
      await leaveDroppedAttempt(walletError("receipt_timeout", "Submitted but not confirmed.", { hash: hash(9) }));

      now = T0 + DISCARD_AFTER_MS + 1;
      const waiting = await discardPendingSell(deps);
      expect(waiting).toMatchObject({ status: "notFound", canDiscard: false, unconfirmedTxHash: hash(9) });
      expect(deps.pending!.read(OWNER)).not.toBeNull();
      const copy = reconcileError(waiting);
      expect(copy).toMatchObject({ code: "SUBMISSION_UNKNOWN", transactionHash: hash(9) });
      expect(copy?.message).toMatch(/hasn't confirmed/);
      expect(copy?.recovery.action).toBe("reconcile");

      now = T0 + ABANDON_AFTER_MS;
      expect(await discardPendingSell(deps)).toEqual({ status: "none" });
    });

    it("decides from the index and balance when the reported hash was mined without a deposit", async () => {
      await leaveDroppedAttempt(walletError("receipt_timeout", "Submitted but not confirmed.", { hash: hash(9) }));
      // The hash was the approval's: it confirmed, consuming a nonce, and created no deposit.
      evm.state.receipts[hash(9)] = receipt(hash(9));
      evm.state.nonce = 13;
      client.finalizePreparedCashout.mockImplementation(() => {
        throw cashError("DEPOSIT_RESOLUTION_FAILED");
      });

      now = T0 + 90_000;
      expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false, unconfirmedTxHash: null });
      now = T0 + DISCARD_AFTER_MS + 1;
      expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: true });
    });
  });

  it("never uses the nonce shortcut for a contract wallet connected as an external wallet", async () => {
    const external = mockSender("external", false);
    const evm = chain({ nonce: 1, code: "0x363d3d373d3d3d363d73" });
    deps = { ...deps, sender: external, publicClient: evm.client };
    client.orders.mockResolvedValue([]);
    client.prepare.mockResolvedValue(plan());
    external.sendCalls.mockRejectedValueOnce(new Error("rpc dropped"));
    await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    expect(deps.pending!.read(OWNER)?.baseline?.isContract).toBe(true);

    now = T0 + 90_000;
    expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false });
    // Contract at sending is enough, even if the node no longer reports its code.
    evm.state.code = undefined;
    expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false });
    now = T0 + DISCARD_AFTER_MS + 1;
    expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: true });
  });

  it("does not trust a quiet nonce when the address has gained code since sending", async () => {
    const external = mockSender("external", false);
    const evm = chain({ nonce: 0 });
    deps = { ...deps, sender: external, publicClient: evm.client };
    client.orders.mockResolvedValue([]);
    client.prepare.mockResolvedValue(plan());
    external.sendCalls.mockRejectedValueOnce(new Error("rpc dropped"));
    await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));

    evm.state.code = "0xef0100deadbeef";
    now = T0 + 90_000;
    expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false });
  });

  it("does not discard over an unreadable receipt for the reported deposit transaction", async () => {
    const evm = chain();
    deps = { ...deps, publicClient: evm.client };
    client.prepare.mockResolvedValue(plan());
    sender.sendCalls.mockRejectedValueOnce(walletError("receipt_timeout", "Submitted but not confirmed.", { hash: hash(9) }));
    await failure(submitSell(deps, { amount: AMOUNT, legs: [REVOLUT_LEG] }));
    evm.mocks.getTransactionReceipt.mockRejectedValue(new Error("rpc 503"));
    client.orders.mockResolvedValue([]);

    now = T0 + DISCARD_AFTER_MS + 1;
    expect(await reconcilePendingSell(deps)).toMatchObject({ status: "notFound", canDiscard: false, unconfirmedTxHash: hash(9) });
  });

  it("reports an indexer outage without deciding anything", async () => {
    await leaveUnknownAttempt();
    client.orders.mockRejectedValue(cashError("INDEXER_UNAVAILABLE", undefined, true));
    const result = await reconcilePendingSell(deps);
    expect(result.status).toBe("unavailable");
    expect(deps.pending!.read(OWNER)).not.toBeNull();
    expect(reconcileError(result)?.recovery.action).toBe("reconcile");
  });
});
