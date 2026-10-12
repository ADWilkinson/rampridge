import { getContracts, resolveFiatCurrencyBytes32, resolvePaymentMethodHash } from "@zkp2p/sdk";
import { erc20Abi, getAddress } from "viem";
import type { Abi, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ANNOUNCE_MAX_AGE_MS, verifyBought, verifyListed } from "./announce";
import { peerContracts } from "./chain";
import type { ReceiptLog, ReceiptRead } from "./chain";
import { encodeLog } from "./testing";

const { abis } = getContracts(8453, "production");
const contracts = peerContracts();
const now = 1_800_000_000_000;
const wallet = "0x4068d180e4051c7abc91bc17b897738622f1cbbb";
const other = "0x00000000000000000000000000000000000000aa";
const intentHash = `0x${"11".repeat(32)}` as Hex;
const revolut = resolvePaymentMethodHash("revolut", { env: "production" });
const gbp = resolveFiatCurrencyBytes32("GBP");

function receipt(logs: ReceiptLog[], overrides: Partial<ReceiptRead> = {}): ReceiptRead {
  return { status: "success", blockTimestampMs: now - 60_000, logs, ...overrides };
}

const amount = 125_400_000n;

function fulfilled(
  to: string,
  logIndex: number,
  options: { orchestrator?: string; hash?: Hex; manual?: boolean; value?: bigint } = {},
): ReceiptLog {
  return encodeLog(
    abis.orchestratorV3 as Abi,
    "IntentFulfilled",
    {
      intentHash: options.hash ?? intentHash,
      fundsTransferredTo: to,
      amount: options.value ?? amount,
      isManualRelease: options.manual ?? false,
    },
    options.orchestrator ?? contracts.orchestrators[0]!,
    logIndex,
  );
}

function transfer(
  to: string,
  logIndex: number,
  options: { token?: string; from?: string; value?: bigint } = {},
): ReceiptLog {
  return encodeLog(
    erc20Abi,
    "Transfer",
    { from: options.from ?? contracts.orchestrators[0]!, to, value: options.value ?? amount },
    options.token ?? contracts.usdc,
    logIndex,
  );
}

function paymentVerified(options: { verifier?: string; hash?: Hex; logIndex?: number } = {}): ReceiptLog {
  return encodeLog(
    abis.unifiedPaymentVerifier as Abi,
    "PaymentVerified",
    {
      intentHash: options.hash ?? intentHash,
      method: revolut,
      currency: gbp,
      amount: 9_915n,
      timestamp: 0n,
      paymentId: `0x${"22".repeat(32)}`,
      payeeId: `0x${"33".repeat(32)}`,
    },
    options.verifier ?? contracts.verifiers[0]!,
    options.logIndex ?? 1,
  );
}

/** A fulfilIntent receipt in the order OrchestratorV3 emits it: verify, fees, payout, event. */
function purchase(overrides: { payout?: ReceiptLog | null; fulfil?: ReceiptLog; payment?: ReceiptLog | null } = {}) {
  const logs = [
    overrides.payment === undefined ? paymentVerified() : overrides.payment,
    transfer(other, 2, { value: 59_650n }),
    overrides.payout === undefined ? transfer(wallet, 3) : overrides.payout,
    overrides.fulfil ?? fulfilled(wallet, 4),
  ];
  return receipt(logs.filter((log): log is ReceiptLog => log !== null));
}

describe("verifyBought", () => {
  it("reads the USDC payout and the verified fiat payment", () => {
    expect(verifyBought(purchase(), wallet, contracts, now)).toEqual({
      kind: "bought",
      logIndex: 4,
      usdc: "125.4",
      fiat: "99.15",
      currency: "GBP",
      platform: "revolut",
    });
  });

  it("accepts a payout whose checksummed addresses differ only in case", () => {
    const checksummed = getAddress(wallet);
    expect(verifyBought(purchase({ payout: transfer(checksummed, 3) }), checksummed, contracts, now).usdc).toBe("125.4");
  });

  it("rejects a release of some other token", () => {
    const junk = "0x00000000000000000000000000000000000000bb";
    expect(() => verifyBought(purchase({ payout: transfer(wallet, 3, { token: junk }) }), wallet, contracts, now)).toThrow(
      /didn't pay USDC/,
    );
    expect(() => verifyBought(purchase({ payout: null }), wallet, contracts, now)).toThrow(/didn't pay USDC/);
  });

  it("rejects a USDC transfer that is not this intent's payout", () => {
    const short = transfer(wallet, 3, { value: amount - 1n });
    expect(() => verifyBought(purchase({ payout: short }), wallet, contracts, now)).toThrow(/didn't pay USDC/);
    const fromElsewhere = transfer(wallet, 3, { from: other });
    expect(() => verifyBought(purchase({ payout: fromElsewhere }), wallet, contracts, now)).toThrow(/didn't pay USDC/);
    const after = receipt([paymentVerified(), fulfilled(wallet, 3), transfer(wallet, 4)]);
    expect(() => verifyBought(after, wallet, contracts, now)).toThrow(/didn't pay USDC/);
  });

  it("does not let one payout prove two purchases", () => {
    const second = `0x${"55".repeat(32)}` as Hex;
    const bundle = receipt([
      paymentVerified(),
      paymentVerified({ hash: second, logIndex: 2 }),
      transfer(wallet, 3),
      fulfilled(wallet, 4),
      fulfilled(wallet, 5, { hash: second }),
    ]);
    expect(verifyBought(bundle, wallet, contracts, now).logIndex).toBe(4);
    expect(() => verifyBought(bundle, wallet, contracts, now, new Set([4]))).toThrow(/already/);
  });

  it("rejects manual releases and purchases without a verified payment", () => {
    const manual = purchase({ payment: null, fulfil: fulfilled(wallet, 4, { manual: true }) });
    expect(() => verifyBought(manual, wallet, contracts, now)).toThrow(/verified payment/);
    expect(() => verifyBought(purchase({ payment: null }), wallet, contracts, now)).toThrow(/verified payment/);
    const fakeVerifier = purchase({ payment: paymentVerified({ verifier: other }) });
    expect(() => verifyBought(fakeVerifier, wallet, contracts, now)).toThrow(/verified payment/);
    const otherIntent = purchase({ payment: paymentVerified({ hash: `0x${"66".repeat(32)}` }) });
    expect(() => verifyBought(otherIntent, wallet, contracts, now)).toThrow(/verified payment/);
  });

  it("rejects payouts to someone else or from a fake orchestrator", () => {
    expect(() => verifyBought(purchase({ fulfil: fulfilled(other, 4) }), wallet, contracts, now)).toThrow(/verified wallet/);
    const fake = fulfilled(wallet, 4, { orchestrator: other });
    expect(() => verifyBought(purchase({ fulfil: fake }), wallet, contracts, now)).toThrow(/verified wallet/);
  });

  it("rejects pending, failed, stale and already-claimed transactions", () => {
    expect(() => verifyBought(null, wallet, contracts, now)).toThrow(/confirmed/);
    const failed = { ...purchase(), status: "reverted" as const };
    expect(() => verifyBought(failed, wallet, contracts, now)).toThrow(/failed/);
    const stale = { ...purchase(), blockTimestampMs: now - ANNOUNCE_MAX_AGE_MS - 1 };
    expect(() => verifyBought(stale, wallet, contracts, now)).toThrow(/too old/);
    expect(() => verifyBought(purchase(), wallet, contracts, now, new Set([4]))).toThrow(/already/);
  });
});

describe("verifyListed", () => {
  const escrow = contracts.escrow;
  const escrowAbi = abis.escrowV2 as Abi;
  const depositLogs = (depositor: string, token = contracts.usdc) => [
    encodeLog(
      escrowAbi,
      "DepositReceived",
      {
        depositId: 77n,
        depositor,
        token,
        amount: 250_000_000n,
        intentAmountRange: { min: 1_000_000n, max: 250_000_000n },
        delegate: other,
        intentGuardian: other,
      },
      escrow,
      3,
    ),
    encodeLog(
      escrowAbi,
      "DepositPaymentMethodAdded",
      { depositId: 77n, paymentMethod: revolut, payeeDetails: `0x${"44".repeat(32)}`, intentGatingService: other },
      escrow,
      4,
    ),
    encodeLog(
      escrowAbi,
      "DepositCurrencyAdded",
      { depositId: 77n, paymentMethod: revolut, currency: gbp, minConversionRate: 790_000_000_000_000_000n },
      escrow,
      5,
    ),
  ];

  it("reads the deposit amount, platform and currency", () => {
    expect(verifyListed(receipt(depositLogs(wallet)), wallet, contracts, now)).toEqual({
      kind: "listed",
      logIndex: 3,
      usdc: "250",
      fiat: null,
      currency: "GBP",
      platform: "revolut",
    });
  });

  it("rejects deposits from another wallet or in another token", () => {
    expect(() => verifyListed(receipt(depositLogs(other)), wallet, contracts, now)).toThrow(/deposit/);
    expect(() => verifyListed(receipt(depositLogs(wallet, other)), wallet, contracts, now)).toThrow(/deposit/);
  });
});
