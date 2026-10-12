import { describe, expect, it, vi } from "vitest";
import { HttpRequestError, TimeoutError, getTypesForEIP712Domain, type Address, type Hash, type TransactionReceipt } from "viem";
import { WaitForUserOperationReceiptTimeoutError } from "viem/account-abstraction";
import { CDP_URL, beforeExecution, cdpPolicyRefusal, receiptWith, transferLog, userOpEvent } from "./__tests__/userOps";
import {
  ChainSwitchError,
  InsufficientGasError,
  SponsorshipError,
  TransactionPendingError,
  TransactionRevertedError,
  UserRejectedError,
  WalletBusyError,
  WalletTimeoutError,
} from "./errors";
import type { Eip1193Like } from "./provider";
import {
  createCrossAppSender,
  createEmbeddedSender,
  createExternalSender,
  createSmartSender,
  type ChainReader,
  type GestureRequester,
  type SenderEnvironment,
} from "./senders";
import type { WalletCall } from "./types";

const ACCOUNT: Address = "0x1111111111111111111111111111111111111111";
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ESCROW: Address = "0x2f121CDDCA6d652f35e8B3E560f9760898888888";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;

const approveAndDeposit: WalletCall[] = [
  { to: USDC, data: "0x095ea7b3" },
  { to: ESCROW, data: "0xabcdef01" },
];

type ReceiptLogs = TransactionReceipt["logs"];

function fakeReader(
  options: {
    ethBalance?: bigint;
    reverted?: Set<Hash>;
    /** Logs of each mined transaction (default none: a plain EOA transaction). */
    logs?: (h: Hash) => ReceiptLogs;
    /** Makes the receipt wait fail for this hash, e.g. an RPC outage after broadcast. */
    waitError?: (h: Hash) => Error | undefined;
  } = {},
) {
  const reader = {
    getBalance: vi.fn(async () => options.ethBalance ?? 10n ** 15n),
    request: vi.fn(async () => null),
    waitForTransactionReceipt: vi.fn(async ({ hash: h }: { hash: Hash }) => {
      const failure = options.waitError?.(h);
      if (failure) throw failure;
      return receiptWith(h, options.logs?.(h) ?? [], options.reverted?.has(h) ? "reverted" : "success");
    }),
  } satisfies ChainReader;
  return reader;
}

/** A bundle in which the given sender's user operation ran with `success`. */
const bundleFor = (sender: Address, success = true) => () => [beforeExecution(), userOpEvent(sender, success)];

const SIGNATURE = `0x${"ab".repeat(65)}` as const;

/** Records eth_signTypedData_v4 requests the way an injected or embedded EOA wallet receives them. */
function typedDataRecorder() {
  const requests: { address: unknown; typed: Record<string, unknown> }[] = [];
  const provider: Eip1193Like = {
    async request({ method, params }) {
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_signTypedData_v4" && Array.isArray(params)) {
        requests.push({ address: params[0], typed: JSON.parse(String(params[1])) as Record<string, unknown> });
        return SIGNATURE;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, requests };
}

const REFERRAL = {
  domain: { name: "ZKP2PReferral", version: "1" },
  types: {
    CreateCode: [
      { name: "wallet", type: "address" },
      { name: "audience", type: "string" },
      { name: "issuedAt", type: "uint256" },
    ],
  },
  primaryType: "CreateCode",
  message: { wallet: ACCOUNT, audience: "rampridge", issuedAt: 1_728_600_000n },
} as const;

function env(reader: ChainReader, onSettled = vi.fn()): SenderEnvironment {
  return { reader, onSettled, receiptTimeoutMs: 1000 };
}

/** An EIP-1193 wallet that starts on `chainId`, switches on request and records transactions. */
function fakeExternalWallet(chainId: number, opts: { rejectSendIndex?: number; refuseSwitch?: boolean } = {}) {
  const state = { chainId, sent: [] as unknown[], switches: 0, typed: [] as Record<string, unknown>[] };
  const provider: Eip1193Like = {
    async request({ method, params }) {
      if (method === "eth_chainId") return `0x${state.chainId.toString(16)}`;
      if (method === "eth_sendTransaction") {
        const index = state.sent.length;
        state.sent.push(Array.isArray(params) ? params[0] : params);
        if (opts.rejectSendIndex === index) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return hash(index + 1);
      }
      if (method === "personal_sign") return SIGNATURE;
      if (method === "eth_signTypedData_v4" && Array.isArray(params)) {
        state.typed.push(JSON.parse(String(params[1])) as Record<string, unknown>);
        return SIGNATURE;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const adapter = {
    getProvider: vi.fn(async () => provider),
    switchToBase: vi.fn(async () => {
      state.switches += 1;
      if (opts.refuseSwitch) throw new Error("Unrecognized chain");
      state.chainId = 8453;
    }),
  };
  return { state, adapter };
}

describe("createSmartSender", () => {
  it("submits every call in ONE user operation and returns the bundle receipt", async () => {
    const reader = fakeReader({ logs: bundleFor(ACCOUNT) });
    const sendBatch = vi.fn(async () => hash(42));
    const sender = createSmartSender(
      ACCOUNT,
      { sendBatch, signMessage: vi.fn(), signTypedData: vi.fn() },
      env(reader),
    );
    expect(sender).toMatchObject({ address: ACCOUNT, kind: "smart", sponsored: true });
    expect(sender.walletClient.account?.address).toBe(ACCOUNT);
    const receipt = await sender.sendCalls(approveAndDeposit, { label: "Deposit 50 USDC" });
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledWith(
      [
        { to: USDC, data: "0x095ea7b3", value: 0n },
        { to: ESCROW, data: "0xabcdef01", value: 0n },
      ],
      "Deposit 50 USDC",
    );
    expect(receipt.transactionHash).toBe(hash(42));
  });

  it("reports a paymaster refusal as a sponsorship problem, not missing ETH", async () => {
    const sender = createSmartSender(
      ACCOUNT,
      {
        sendBatch: async () => {
          throw new Error("UserOperation reverted during simulation with reason: AA21 didn't pay prefund");
        },
        signMessage: vi.fn(),
        signTypedData: vi.fn(),
      },
      env(fakeReader()),
    );
    await expect(sender.sendCalls(approveAndDeposit)).rejects.toBeInstanceOf(SponsorshipError);
  });

  describe("tells a send that never reached the bundler from one that did", () => {
    const failingWith = (failure: unknown, reader = fakeReader()) =>
      createSmartSender(
        ACCOUNT,
        {
          sendBatch: async () => {
            throw failure;
          },
          signMessage: vi.fn(),
          signTypedData: vi.fn(),
        },
        env(reader),
      );

    it("reports the paymaster's policy refusal as nothing sent, with its reason", async () => {
      const reader = fakeReader();
      const error = await failingWith(cdpPolicyRefusal(), reader).sendCalls(approveAndDeposit).catch((e) => e);
      expect(error).toBeInstanceOf(SponsorshipError);
      expect(error.mayHaveLanded).toBe(false);
      expect(error.reason).toMatch(/called address not in allowlist/);
      expect(reader.waitForTransactionReceipt).not.toHaveBeenCalled();
    });

    it("lets a timeout before submission be retried, not treated as broadcast", async () => {
      const failure = new TimeoutError({ body: { method: "eth_estimateUserOperationGas" }, url: CDP_URL });
      const error = await failingWith(failure).sendCalls(approveAndDeposit).catch((e) => e);
      expect(error).toBeInstanceOf(WalletTimeoutError);
      expect(error.mayHaveLanded).toBe(false);
    });

    it("keeps a submitted user operation whose receipt wait timed out as pending", async () => {
      const failure = new WaitForUserOperationReceiptTimeoutError({ hash: hash(7) });
      const error = await failingWith(failure).sendCalls(approveAndDeposit).catch((e) => e);
      expect(error).toBeInstanceOf(TransactionPendingError);
      expect(error.mayHaveLanded).toBe(true);
    });

    it("keeps a submission whose answer was lost as pending", async () => {
      const failure = new TimeoutError({ body: { method: "eth_sendUserOperation" }, url: CDP_URL });
      const error = await failingWith(failure).sendCalls(approveAndDeposit).catch((e) => e);
      expect(error).toBeInstanceOf(TransactionPendingError);
      expect(error.mayHaveLanded).toBe(true);
    });

    it("keeps a send that returned without a hash as possibly landed", async () => {
      const sender = createSmartSender(
        ACCOUNT,
        { sendBatch: async () => undefined as unknown as Hash, signMessage: vi.fn(), signTypedData: vi.fn() },
        env(fakeReader()),
      );
      const error = await sender.sendCalls(approveAndDeposit).catch((e) => e);
      expect(error.mayHaveLanded).toBe(true);
    });
  });

  it("refuses a second request while one is open", async () => {
    let release: (value: Hash) => void = () => {};
    const sender = createSmartSender(
      ACCOUNT,
      {
        sendBatch: () => new Promise<Hash>((resolve) => (release = resolve)),
        signMessage: vi.fn(),
        signTypedData: vi.fn(),
      },
      env(fakeReader({ logs: bundleFor(ACCOUNT) })),
    );
    const first = sender.sendCalls(approveAndDeposit);
    await expect(sender.sendCalls(approveAndDeposit)).rejects.toBeInstanceOf(WalletBusyError);
    release(hash(1));
    await expect(first).resolves.toMatchObject({ transactionHash: hash(1) });
  });

  it("returns only this account's logs from a shared bundle", async () => {
    const OTHER: Address = "0x9999999999999999999999999999999999999999";
    const theirDeposit = transferLog(USDC, OTHER, ESCROW, 5n);
    const ourDeposit = transferLog(USDC, ACCOUNT, ESCROW, 50n);
    const ourEvent = userOpEvent(ACCOUNT, true);
    const reader = fakeReader({
      logs: () => [beforeExecution(), theirDeposit, userOpEvent(OTHER, true), ourDeposit, ourEvent],
    });
    const sender = createSmartSender(
      ACCOUNT,
      { sendBatch: async () => hash(42), signMessage: vi.fn(), signTypedData: vi.fn() },
      env(reader),
    );
    const receipt = await sender.sendCalls(approveAndDeposit);
    expect(receipt.transactionHash).toBe(hash(42));
    expect(receipt.logs).toEqual([ourDeposit, ourEvent]);
  });

  it("rejects when the user operation reverted inside a successful bundle", async () => {
    const sender = createSmartSender(
      ACCOUNT,
      { sendBatch: async () => hash(42), signMessage: vi.fn(), signTypedData: vi.fn() },
      env(fakeReader({ logs: bundleFor(ACCOUNT, false) })),
    );
    const error = await sender.sendCalls(approveAndDeposit).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionRevertedError);
    expect(error.hash).toBe(hash(42));
  });

  it("never reports success when the bundle has no operation for this account", async () => {
    const sender = createSmartSender(
      ACCOUNT,
      { sendBatch: async () => hash(42), signMessage: vi.fn(), signTypedData: vi.fn() },
      env(fakeReader()),
    );
    const error = await sender.sendCalls(approveAndDeposit).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionPendingError);
    expect(error.hash).toBe(hash(42));
  });

  it("signs messages through the smart wallet", async () => {
    const signMessage = vi.fn(async () => `0x${"12".repeat(65)}` as const);
    const sender = createSmartSender(ACCOUNT, { sendBatch: vi.fn(), signMessage, signTypedData: vi.fn() }, env(fakeReader()));
    await sender.signMessage("Enter RampRidge");
    expect(signMessage).toHaveBeenCalledWith("Enter RampRidge");
  });
});

describe("createExternalSender", () => {
  it("throws InsufficientGasError before prompting when the wallet has no ETH on Base", async () => {
    const reader = fakeReader({ ethBalance: 0n });
    const { state, adapter } = fakeExternalWallet(8453);
    const sender = createExternalSender(ACCOUNT, adapter, env(reader));
    const error = await sender.sendCalls(approveAndDeposit).catch((e) => e);
    expect(error).toBeInstanceOf(InsufficientGasError);
    expect(error.address).toBe(ACCOUNT);
    expect(state.sent).toHaveLength(0);
  });

  it("switches to Base, then sends each call after the previous one confirms", async () => {
    const reader = fakeReader();
    const { state, adapter } = fakeExternalWallet(1);
    const onSettled = vi.fn();
    const sender = createExternalSender(ACCOUNT, adapter, env(reader, onSettled));
    const receipt = await sender.sendCalls(approveAndDeposit);
    expect(state.switches).toBe(1);
    expect(state.sent).toHaveLength(2);
    expect(state.sent[0]).toMatchObject({ from: ACCOUNT, to: USDC, data: "0x095ea7b3" });
    expect(reader.waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(receipt.transactionHash).toBe(hash(2));
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("reports a refused chain switch", async () => {
    const { adapter } = fakeExternalWallet(1, { refuseSwitch: true });
    const sender = createExternalSender(ACCOUNT, adapter, env(fakeReader()));
    await expect(sender.sendCalls(approveAndDeposit)).rejects.toBeInstanceOf(ChainSwitchError);
  });

  it("keeps the confirmed approval on the error when the deposit is rejected", async () => {
    const { adapter } = fakeExternalWallet(8453, { rejectSendIndex: 1 });
    const sender = createExternalSender(ACCOUNT, adapter, env(fakeReader()));
    const error = await sender.sendCalls(approveAndDeposit).catch((e) => e);
    expect(error).toBeInstanceOf(UserRejectedError);
    expect(error.completedHashes).toEqual([hash(1)]);
  });

  it("rejects a smart-contract wallet's inner revert even though its bundle succeeded", async () => {
    const { adapter } = fakeExternalWallet(8453);
    const sender = createExternalSender(ACCOUNT, adapter, env(fakeReader({ logs: bundleFor(ACCOUNT, false) })));
    const error = await sender.sendCalls([{ to: ESCROW, data: "0xabcdef01" }]).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionRevertedError);
  });

  it("keeps the hash when the receipt cannot be read after broadcast", async () => {
    const { adapter } = fakeExternalWallet(8453);
    const reader = fakeReader({
      waitError: (h) => (h === hash(2) ? new HttpRequestError({ status: 429, url: "https://rpc" }) : undefined),
    });
    const sender = createExternalSender(ACCOUNT, adapter, env(reader));
    const error = await sender.sendCalls(approveAndDeposit).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionPendingError);
    expect(error.hash).toBe(hash(2));
    expect(error.completedHashes).toEqual([hash(1)]);
  });

  it("signs typed data with the EIP712Domain type the wallet needs for the domain separator", async () => {
    const { state, adapter } = fakeExternalWallet(8453);
    const sender = createExternalSender(ACCOUNT, adapter, env(fakeReader()));
    await expect(sender.walletClient.signTypedData({ account: ACCOUNT, ...REFERRAL })).resolves.toBe(SIGNATURE);
    expect(state.typed).toHaveLength(1);
    expect(state.typed[0]).toMatchObject({
      primaryType: "CreateCode",
      domain: REFERRAL.domain,
      types: { EIP712Domain: getTypesForEIP712Domain({ domain: REFERRAL.domain }), CreateCode: REFERRAL.types.CreateCode },
    });
  });

  it("keeps the chain in the domain when the caller's chainId is a bigint", async () => {
    const { state, adapter } = fakeExternalWallet(8453);
    const sender = createExternalSender(ACCOUNT, adapter, env(fakeReader()));
    const domain = { ...REFERRAL.domain, chainId: 8453n, verifyingContract: ESCROW };
    await sender.walletClient.signTypedData({ account: ACCOUNT, ...REFERRAL, domain });
    const types = state.typed[0]?.types as Record<string, unknown>;
    expect(types.EIP712Domain).toEqual(getTypesForEIP712Domain({ domain }));
  });

  it("surfaces an on-chain revert", async () => {
    const { adapter } = fakeExternalWallet(8453);
    const sender = createExternalSender(ACCOUNT, adapter, env(fakeReader({ reverted: new Set([hash(1)]) })));
    const error = await sender.sendCalls(approveAndDeposit).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionRevertedError);
    expect(error.hash).toBe(hash(1));
  });
});

describe("createEmbeddedSender", () => {
  it("sends each call sponsored", async () => {
    const send = vi.fn(async () => hash(7));
    const sender = createEmbeddedSender(
      ACCOUNT,
      { send, getProvider: vi.fn() },
      { sponsored: true },
      env(fakeReader({ ethBalance: 0n })),
    );
    await sender.sendCalls(approveAndDeposit, { label: "Sell USDC" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, { to: USDC, data: "0x095ea7b3", value: 0n }, { sponsor: true, label: "Sell USDC" });
  });

  it("falls back to self-paid gas when Privy cannot sponsor this wallet", async () => {
    const send = vi
      .fn<(call: unknown, options: { sponsor: boolean }) => Promise<Hash>>()
      .mockRejectedValueOnce(new Error("Sponsoring is only supported for wallets on the TEE stack"))
      .mockResolvedValue(hash(8));
    const sender = createEmbeddedSender(ACCOUNT, { send, getProvider: vi.fn() }, { sponsored: true }, env(fakeReader()));
    await sender.sendCalls(approveAndDeposit);
    expect(send.mock.calls.map(([, options]) => options.sponsor)).toEqual([true, false, false]);
  });

  it("rejects a sponsored (EIP-7702 user operation) call that reverted inside its bundle", async () => {
    const send = vi.fn(async () => hash(7));
    const sender = createEmbeddedSender(
      ACCOUNT,
      { send, getProvider: vi.fn() },
      { sponsored: true },
      env(fakeReader({ ethBalance: 0n, logs: bundleFor(ACCOUNT, false) })),
    );
    const error = await sender
      .sendCalls([{ to: ESCROW, data: "0xabcdef01" }], { label: "Complete purchase" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TransactionRevertedError);
    expect(error.hash).toBe(hash(7));
    expect(error.completedHashes).toEqual([]);
  });

  it("signs typed data with EIP712Domain through the embedded provider", async () => {
    const { provider, requests } = typedDataRecorder();
    const sender = createEmbeddedSender(
      ACCOUNT,
      { send: vi.fn(), getProvider: async () => provider },
      { sponsored: true },
      env(fakeReader()),
    );
    await sender.walletClient.signTypedData({ account: ACCOUNT, ...REFERRAL });
    expect(requests).toEqual([
      expect.objectContaining({
        address: ACCOUNT,
        typed: expect.objectContaining({
          types: expect.objectContaining({
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
            ],
          }),
        }),
      }),
    ]);
  });

  it("requires ETH when sponsorship is unavailable", async () => {
    const send = vi.fn(async () => {
      throw new Error("Sponsoring is only supported for wallets on the TEE stack");
    });
    const sender = createEmbeddedSender(
      ACCOUNT,
      { send, getProvider: vi.fn() },
      { sponsored: true },
      env(fakeReader({ ethBalance: 0n })),
    );
    await expect(sender.sendCalls(approveAndDeposit)).rejects.toBeInstanceOf(InsufficientGasError);
  });
});

describe("createCrossAppSender", () => {
  it("re-runs a blocked request inside a player gesture", async () => {
    const send = vi
      .fn<(call: unknown) => Promise<Hash>>()
      .mockResolvedValueOnce(hash(1))
      .mockRejectedValueOnce(new Error("Failed to initialize signature request"))
      .mockResolvedValueOnce(hash(2));
    const gestureLabels: string[] = [];
    const requestGesture: GestureRequester = (label, run) => {
      gestureLabels.push(label);
      return run();
    };
    const sender = createCrossAppSender(
      ACCOUNT,
      { send, signMessage: vi.fn(), signTypedData: vi.fn() },
      requestGesture,
      env(fakeReader()),
    );
    expect(sender).toMatchObject({ kind: "external", sponsored: false });
    const receipt = await sender.sendCalls(approveAndDeposit, { label: "Deposit 50 USDC" });
    expect(gestureLabels).toEqual(["Deposit 50 USDC (step 2 of 2)"]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(receipt.transactionHash).toBe(hash(2));
  });

  it("treats a Peer window that timed out mid-send as possibly sent", async () => {
    const send = vi.fn(async (): Promise<Hash> => {
      throw new Error("Request timeout");
    });
    let gestures = 0;
    const sender = createCrossAppSender(
      ACCOUNT,
      { send, signMessage: vi.fn(), signTypedData: vi.fn() },
      (_label, run) => {
        gestures += 1;
        return run();
      },
      env(fakeReader()),
    );
    const error = await sender.sendCalls(approveAndDeposit).catch((e) => e);
    expect(error).toBeInstanceOf(TransactionPendingError);
    expect(error.hash).toBeNull();
    expect(gestures).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not retry anything other than a blocked window", async () => {
    const send = vi.fn(async (): Promise<Hash> => {
      throw new Error("User rejected request");
    });
    let gestures = 0;
    const requestGesture: GestureRequester = (_label, run) => {
      gestures += 1;
      return run();
    };
    const sender = createCrossAppSender(
      ACCOUNT,
      { send, signMessage: vi.fn(), signTypedData: vi.fn() },
      requestGesture,
      env(fakeReader()),
    );
    await expect(sender.sendCalls(approveAndDeposit)).rejects.toBeInstanceOf(UserRejectedError);
    expect(gestures).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
