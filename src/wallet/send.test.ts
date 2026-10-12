import { getAttributionDataSuffix } from "@zkp2p/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Address,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { WaitForUserOperationReceiptTimeoutError } from "viem/account-abstraction";
import { USDC_ADDRESS } from "@/config";
import {
  InsufficientGasError,
  SponsorshipError,
  TransactionPendingError,
  TransactionRevertedError,
  UserRejectedError,
  WalletBusyError,
  WalletError,
} from "./errors";
import {
  InsufficientUsdcError,
  PENDING_SEND_MAX_AGE_MS,
  SendUnconfirmedError,
  checkPendingSend,
  createPendingSendStore,
  formatSendAmount,
  isSendInFlight,
  sendLabel,
  sendUsdc,
  sentMessage,
  usdcTransferCall,
  LOG_CHUNK_BLOCKS,
  MAX_LOG_REQUESTS_PER_CHECK,
  RELEASE_PENDING_AFTER_MS,
  canReleasePending,
  type FoundTransfer,
  type KeyValueStorage,
  type PendingCheck,
  type PendingSend,
  type SendChain,
} from "./send";
import type { TxSender, UserOperationStatus, WalletCall } from "./types";

const FROM: Address = "0x5555555555555555555555555555555555555555";
const TO: Address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TX = `0x${"12".repeat(32)}` as Hash;
const OTHER_TX = `0x${"34".repeat(32)}` as Hash;

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function fakeSender(send: (calls: WalletCall[], opts?: { label?: string }) => Promise<TransactionReceipt>) {
  const sendCalls = vi.fn(send);
  const sender = { address: FROM, kind: "smart", sponsored: true, sendCalls } as unknown as TxSender;
  return { sender, sendCalls };
}

const okReceipt = (hash: Hash = TX) => ({ transactionHash: hash, status: "success", logs: [] }) as unknown as TransactionReceipt;

function chainWith(balance: bigint, block = 1_000n) {
  return { usdcBalance: vi.fn(async () => balance), blockNumber: vi.fn(async () => block) };
}

describe("usdcTransferCall", () => {
  it("is USDC.transfer(to, amount) with the ERC-8021 attribution suffix", () => {
    const call = usdcTransferCall(TO, 25_000_000n);
    expect(call.to).toBe(USDC_ADDRESS);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data })).toEqual({ functionName: "transfer", args: [TO, 25_000_000n] });
    const suffix = getAttributionDataSuffix(["rampridge", "peer-ref-TOFIAT"]);
    expect(call.data.endsWith(suffix.slice(2))).toBe(true);
    expect((call.data.length - 2) / 2).toBe(4 + 64 + (suffix.length - 2) / 2);
  });
});

describe("send copy", () => {
  it("shows cents and every significant decimal, never rounding up", () => {
    expect(formatSendAmount(25_000_000n)).toBe("25.00");
    expect(formatSendAmount(1_250_500_000n)).toBe("1,250.50");
    expect(formatSendAmount(1_234n)).toBe("0.001234");
    expect(formatSendAmount(125_401_999n)).toBe("125.401999");
    expect(sendLabel(25_000_000n, TO)).toBe("Send 25.00 USDC to 0xd8dA…6045");
    expect(sentMessage(25_000_000n, TO)).toBe("You sent 25.00 USDC to 0xd8dA…6045.");
  });
});

describe("sendUsdc", () => {
  it("re-reads the balance, sends one attributed transfer with a clear label and clears its record", async () => {
    const { sender, sendCalls } = fakeSender(async () => okReceipt());
    const chain = chainWith(30_000_000n);
    const pending = createPendingSendStore(memoryStorage());
    const sent = await sendUsdc({ sender, to: TO, amount: 25_000_000n, chain, pending });
    expect(sent).toMatchObject({ hash: TX, amount: 25_000_000n, to: TO });
    expect(chain.usdcBalance).toHaveBeenCalledWith(FROM);
    expect(sendCalls).toHaveBeenCalledTimes(1);
    const [calls, opts] = sendCalls.mock.calls[0] ?? [];
    expect(calls).toEqual([usdcTransferCall(TO, 25_000_000n)]);
    expect(opts).toEqual({ label: "Send 25.00 USDC to 0xd8dA…6045" });
    expect(pending.read(FROM)).toBeNull();
  });

  it("sends the exact balance for All, with no rounding", async () => {
    const { sender, sendCalls } = fakeSender(async () => okReceipt());
    await sendUsdc({ sender, to: TO, amount: 125_401_999n, chain: chainWith(125_401_999n), pending: createPendingSendStore(null) });
    const data = sendCalls.mock.calls[0]?.[0]?.[0]?.data ?? "0x";
    expect(decodeFunctionData({ abi: erc20Abi, data }).args).toEqual([TO, 125_401_999n]);
  });

  it("refuses when the balance read right before sending is lower than the amount", async () => {
    const { sender, sendCalls } = fakeSender(async () => okReceipt());
    const pending = createPendingSendStore(null);
    const error = await sendUsdc({ sender, to: TO, amount: 25_000_000n, chain: chainWith(24_999_999n), pending }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InsufficientUsdcError);
    expect((error as InsufficientUsdcError).message).toBe("You only have 24.999999 USDC now, less than this send.");
    expect((error as WalletError).mayHaveLanded).toBe(false);
    expect(sendCalls).not.toHaveBeenCalled();
    expect(pending.read(FROM)).toBeNull();
  });

  it("refuses bad requests before touching the wallet", async () => {
    const { sender, sendCalls } = fakeSender(async () => okReceipt());
    const pending = createPendingSendStore(null);
    const chain = chainWith(100_000_000n);
    await expect(sendUsdc({ sender, to: TO, amount: 0n, chain, pending })).rejects.toThrow("Enter an amount above zero.");
    await expect(sendUsdc({ sender, to: FROM, amount: 1n, chain, pending })).rejects.toThrow(/your own wallet/);
    await expect(sendUsdc({ sender, to: USDC_ADDRESS, amount: 1n, chain, pending })).rejects.toThrow(/would be stuck/);
    expect(sendCalls).not.toHaveBeenCalled();
  });

  it("runs one send at a time per wallet", async () => {
    let release: (receipt: TransactionReceipt) => void = () => undefined;
    const { sender, sendCalls } = fakeSender(() => new Promise((resolve) => (release = resolve)));
    const pending = createPendingSendStore(null);
    const chain = chainWith(100_000_000n);
    const first = sendUsdc({ sender, to: TO, amount: 1_000_000n, chain, pending });
    expect(isSendInFlight(FROM)).toBe(true);
    await expect(sendUsdc({ sender, to: TO, amount: 1_000_000n, chain, pending })).rejects.toBeInstanceOf(WalletBusyError);
    await vi.waitFor(() => expect(sendCalls).toHaveBeenCalledTimes(1));
    release(okReceipt());
    await expect(first).resolves.toMatchObject({ hash: TX });
    expect(sendCalls).toHaveBeenCalledTimes(1);
    expect(isSendInFlight(FROM)).toBe(false);
  });

  it("keeps the record when the outcome is unknown, and refuses every later send until it is settled", async () => {
    const storage = memoryStorage();
    const pending = createPendingSendStore(storage, () => 5_000);
    const { sender, sendCalls } = fakeSender(async () => {
      throw new TransactionPendingError(TX);
    });
    const chain = chainWith(100_000_000n, 777n);
    const error = await sendUsdc({ sender, to: TO, amount: 25_000_000n, chain, pending, now: () => 5_000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionPendingError);
    const record = pending.read(FROM);
    expect(record).toEqual({ from: FROM, to: TO, amount: 25_000_000n, startedAt: 5_000, fromBlock: 777n, balanceBefore: 100_000_000n, hash: TX, userOpHash: null });
    // It survives a reload (a fresh store over the same storage).
    expect(createPendingSendStore(storage, () => 5_000).read(FROM)).toEqual(record);

    const retry = await sendUsdc({ sender, to: TO, amount: 25_000_000n, chain, pending }).catch((e: unknown) => e);
    expect(retry).toBeInstanceOf(SendUnconfirmedError);
    expect(sendCalls).toHaveBeenCalledTimes(1);
  });

  it("keeps the user operation a timed-out smart-wallet send left, so its bundler can settle it", async () => {
    const pending = createPendingSendStore(null);
    const { sender } = fakeSender(async () => {
      throw new TransactionPendingError(null, { cause: new WaitForUserOperationReceiptTimeoutError({ hash: OTHER_TX }) });
    });
    await sendUsdc({ sender, to: TO, amount: 1_000_000n, chain: chainWith(5_000_000n), pending }).catch(() => undefined);
    expect(pending.read(FROM)).toMatchObject({ hash: null, userOpHash: OTHER_TX });
  });

  it("keeps the record for an unknown wallet error raised while sending", async () => {
    const pending = createPendingSendStore(null);
    const { sender } = fakeSender(async () => {
      throw new Error("socket hang up");
    });
    const error = await sendUsdc({ sender, to: TO, amount: 1_000_000n, chain: chainWith(5_000_000n), pending }).catch((e: unknown) => e);
    expect((error as WalletError).mayHaveLanded).toBe(true);
    expect(pending.read(FROM)?.hash).toBeNull();
  });

  it.each([
    ["a wallet rejection", new UserRejectedError()],
    ["no ETH for gas", new InsufficientGasError(FROM)],
    ["a paymaster refusal", new SponsorshipError({ reason: "policy rejected: spend limit" })],
    ["a mined revert", new TransactionRevertedError(TX, null)],
  ])("clears the record after %s, so the player can try again", async (_name, thrown) => {
    const pending = createPendingSendStore(null);
    const { sender } = fakeSender(async () => {
      throw thrown;
    });
    await expect(sendUsdc({ sender, to: TO, amount: 1_000_000n, chain: chainWith(5_000_000n), pending })).rejects.toBe(thrown);
    expect(pending.read(FROM)).toBeNull();
  });

  it("writes the record before the wallet is asked, so a reload mid-prompt still knows", async () => {
    const pending = createPendingSendStore(null);
    let seen: PendingSend | null = null;
    const { sender } = fakeSender(async () => {
      seen = pending.read(FROM);
      return okReceipt();
    });
    await sendUsdc({ sender, to: TO, amount: 1_000_000n, chain: chainWith(5_000_000n), pending });
    expect(seen).toMatchObject({ from: FROM, to: TO, amount: 1_000_000n, hash: null });
  });

  it("says plainly when the balance can't be read, without sending", async () => {
    const { sender, sendCalls } = fakeSender(async () => okReceipt());
    const chain = { usdcBalance: async () => Promise.reject(new Error("rpc down")), blockNumber: async () => 1n };
    const error = await sendUsdc({ sender, to: TO, amount: 1n, chain, pending: createPendingSendStore(null) }).catch((e: unknown) => e);
    expect((error as WalletError).message).toBe("Couldn't check your USDC balance on Base. Try again in a moment.");
    expect((error as WalletError).mayHaveLanded).toBe(false);
    expect(sendCalls).not.toHaveBeenCalled();
  });
});

describe("pending send store", () => {
  it("works with storage that throws, and drops records older than a week", () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };
    let now = 0;
    const store = createPendingSendStore(throwing, () => now);
    const record: PendingSend = { from: FROM, to: TO, amount: 1n, startedAt: 0, fromBlock: null, balanceBefore: 2n, hash: null, userOpHash: null };
    store.write(record);
    expect(store.read(FROM)).toEqual(record);
    now = PENDING_SEND_MAX_AGE_MS + 1;
    expect(store.read(FROM)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function transferLog(from: Address, to: Address, value: bigint) {
  return {
    address: USDC_ADDRESS,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

const RECORD: PendingSend = { from: FROM, to: TO, amount: 25_000_000n, startedAt: 0, fromBlock: 1_000n, balanceBefore: 100_000_000n, hash: null, userOpHash: null };

function fakeChain(overrides: Partial<SendChain>): SendChain {
  return {
    usdcBalance: async () => 100_000_000n,
    ethBalance: async () => 0n,
    blockNumber: async () => 1_010n,
    code: async () => "0x",
    simulate: async () => undefined,
    estimateFee: async () => 0n,
    receipt: async () => null,
    transfers: async () => [],
    ...overrides,
  };
}

describe("checkPendingSend", () => {
  it("settles from the reported transaction's receipt", async () => {
    const landed = { transactionHash: TX, status: "success", logs: [transferLog(FROM, TO, 25_000_000n)] } as unknown as TransactionReceipt;
    await expect(checkPendingSend({ ...RECORD, hash: TX }, fakeChain({ receipt: async () => landed }))).resolves.toEqual({ status: "landed", hash: TX });
    const reverted = { transactionHash: TX, status: "reverted", logs: [] } as unknown as TransactionReceipt;
    await expect(checkPendingSend({ ...RECORD, hash: TX }, fakeChain({ receipt: async () => reverted }))).resolves.toEqual({ status: "failed", hash: TX });
    // A bundle that mined without this transfer (its user operation reverted) moved nothing.
    const otherTransfer = { transactionHash: TX, status: "success", logs: [transferLog(FROM, TO, 1n)] } as unknown as TransactionReceipt;
    await expect(checkPendingSend({ ...RECORD, hash: TX }, fakeChain({ receipt: async () => otherTransfer }))).resolves.toEqual({ status: "failed", hash: TX });
  });

  it("finds a Transfer of exactly the amount since the send started, in bounded log requests", async () => {
    const transfers = vi.fn(async ({ fromBlock }: { fromBlock: bigint }) =>
      fromBlock === 1_450n ? [{ hash: OTHER_TX, value: 1n }, { hash: TX, value: 25_000_000n }] : [],
    );
    const result = await checkPendingSend(RECORD, fakeChain({ blockNumber: async () => 2_000n, transfers }));
    expect(result).toEqual({ status: "landed", hash: TX });
    expect(transfers.mock.calls.map(([args]) => args)).toEqual([
      { from: FROM, to: TO, fromBlock: 1_000n, toBlock: 1_449n },
      { from: FROM, to: TO, fromBlock: 1_450n, toBlock: 1_899n },
    ]);
  });

  it("stays pending while there is no sign of it, noting a dropped or unread balance", async () => {
    const idle = { status: "pending", scanned: true, scannedThrough: 1_010n, balanceDropped: false, queued: false };
    await expect(checkPendingSend(RECORD, fakeChain({}))).resolves.toEqual(idle);
    await expect(checkPendingSend(RECORD, fakeChain({ usdcBalance: async () => 75_000_000n }))).resolves.toEqual({ ...idle, balanceDropped: true });
    await expect(checkPendingSend(RECORD, fakeChain({ usdcBalance: async () => Promise.reject(new Error("rpc down")) }))).resolves.toEqual({
      ...idle,
      balanceDropped: null,
    });
    await expect(
      checkPendingSend(RECORD, fakeChain({ transfers: async () => Promise.reject(new Error("request limit reached")) })),
    ).resolves.toEqual({ ...idle, scanned: false, scannedThrough: null });
  });

  it("carries the history search on from where the last check stopped, a bounded number of requests at a time", async () => {
    const transfers = vi.fn(async (_args: { from: Address; to: Address; fromBlock: bigint; toBlock: bigint }): Promise<FoundTransfer[]> => []);
    // Exactly 20 requests' worth of blocks since the send's block.
    const latest = 1_000n + LOG_CHUNK_BLOCKS * 20n - 1n;
    const chain = fakeChain({ blockNumber: async () => latest, transfers });
    const first = await checkPendingSend(RECORD, chain);
    expect(transfers).toHaveBeenCalledTimes(MAX_LOG_REQUESTS_PER_CHECK);
    // Not through the latest block yet, so not "scanned".
    expect(first).toMatchObject({ status: "pending", scanned: false, scannedThrough: 1_000n + LOG_CHUNK_BLOCKS * 16n - 1n });
    transfers.mockClear();
    const second = await checkPendingSend(RECORD, chain, { scannedThrough: first.status === "pending" ? first.scannedThrough : null });
    expect(transfers).toHaveBeenCalledTimes(4);
    expect(transfers.mock.calls[0]).toEqual([{ from: FROM, to: TO, fromBlock: 1_000n + LOG_CHUNK_BLOCKS * 16n, toBlock: 1_000n + LOG_CHUNK_BLOCKS * 17n - 1n }]);
    expect(second).toMatchObject({ status: "pending", scanned: true, scannedThrough: latest });
    // Nothing new since: no request, still scanned.
    transfers.mockClear();
    await expect(checkPendingSend(RECORD, chain, { scannedThrough: latest })).resolves.toMatchObject({ scanned: true });
    expect(transfers).not.toHaveBeenCalled();
  });

  it("without a recorded block, starts searching safely before the send's start time", async () => {
    const transfers = vi.fn(async (_args: { from: Address; to: Address; fromBlock: bigint; toBlock: bigint }): Promise<FoundTransfer[]> => []);
    // Started 10 minutes ago: 300 blocks of 2 s, plus a 300-block margin.
    await checkPendingSend({ ...RECORD, fromBlock: null, startedAt: 0 }, fakeChain({ blockNumber: async () => 10_000n, transfers }), { now: 600_000 });
    expect(transfers.mock.calls[0]?.[0]).toMatchObject({ fromBlock: 9_400n });
  });

  it("asks a smart wallet's bundler about the user operation the send left", async () => {
    const op = { ...RECORD, userOpHash: OTHER_TX };
    const status = (result: UserOperationStatus) => async () => result;
    await expect(checkPendingSend(op, fakeChain({}), { userOperationStatus: status({ status: "included", success: true, transactionHash: TX }) })).resolves.toEqual({
      status: "landed",
      hash: TX,
    });
    await expect(checkPendingSend(op, fakeChain({}), { userOperationStatus: status({ status: "included", success: false, transactionHash: TX }) })).resolves.toEqual({
      status: "failed",
      hash: TX,
    });
    await expect(checkPendingSend(op, fakeChain({}), { userOperationStatus: status({ status: "queued" }) })).resolves.toMatchObject({ queued: true });
    await expect(checkPendingSend(op, fakeChain({}), { userOperationStatus: status({ status: "unknown" }) })).resolves.toMatchObject({ queued: true });
    await expect(checkPendingSend(op, fakeChain({}), { userOperationStatus: status({ status: "absent" }) })).resolves.toMatchObject({ queued: false, scanned: true });
    await expect(
      checkPendingSend(op, fakeChain({}), { userOperationStatus: async () => Promise.reject(new Error("bundler down")) }),
    ).resolves.toMatchObject({ queued: true });
  });

  it("falls back to the history when the hash has no receipt yet, or the bundler has no record", async () => {
    const viaHistory = await checkPendingSend(
      { ...RECORD, userOpHash: OTHER_TX },
      fakeChain({ transfers: async () => [{ hash: TX, value: 25_000_000n }] }),
      { userOperationStatus: async () => ({ status: "absent" }) },
    );
    expect(viaHistory).toEqual({ status: "landed", hash: TX });
    const result = await checkPendingSend(
      { ...RECORD, hash: OTHER_TX },
      fakeChain({ receipt: async () => null, transfers: async () => [{ hash: TX, value: 25_000_000n }] }),
    );
    expect(result).toEqual({ status: "landed", hash: TX });
  });
});

describe("canReleasePending", () => {
  const AFTER = RELEASE_PENDING_AFTER_MS;
  const quiet: PendingCheck = { status: "pending", scanned: true, scannedThrough: 2_000n, balanceDropped: false, queued: false };

  it("allows another send only on evidence, once the wait is over", () => {
    expect(canReleasePending(RECORD, quiet, AFTER, false)).toBe(true);
    expect(canReleasePending(RECORD, quiet, AFTER - 1, false)).toBe(false);
    expect(canReleasePending(RECORD, null, AFTER, false)).toBe(false);
    expect(canReleasePending(RECORD, quiet, AFTER, true)).toBe(false);
    expect(canReleasePending(RECORD, { ...quiet, scanned: false }, AFTER, false)).toBe(false);
    expect(canReleasePending(RECORD, { ...quiet, balanceDropped: true }, AFTER, false)).toBe(false);
    expect(canReleasePending(RECORD, { ...quiet, balanceDropped: null }, AFTER, false)).toBe(false);
    expect(canReleasePending(RECORD, { ...quiet, queued: true }, AFTER, false)).toBe(false);
  });

  it("never offers a resend when the history can't be read and the balance dropped (the send may have landed)", async () => {
    const check = await checkPendingSend(
      RECORD,
      fakeChain({ transfers: async () => Promise.reject(new Error("request limit reached")), usdcBalance: async () => 75_000_000n }),
    );
    expect(check).toMatchObject({ status: "pending", scanned: false, balanceDropped: true });
    expect(canReleasePending(RECORD, check.status === "pending" ? check : null, 24 * 60 * 60_000, false)).toBe(false);
  });
});
