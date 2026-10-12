import { describe, expect, it } from "vitest";
import { buildCapabilities } from "@zkp2p/cash";
import { sellCapabilities } from "../cash";
import { sellError } from "../errors";
import { createLeg, evaluateSell, initialSteps, legCheckKey, toReceive, type SellContext, type SellDraftState } from "../machine";
import { payeeCheckKey, type PayeeCheck } from "../validatePayee";

const caps = sellCapabilities({ capabilities: () => buildCapabilities("production") });
const BALANCE = 500_000_000n;

function ctx(over: Partial<SellContext> = {}): SellContext {
  return { caps, walletConnected: true, balance: BALANCE, gas: "sponsored", ...over };
}

function draft(over: Partial<SellDraftState> = {}): SellDraftState {
  return { amount: "", legs: [createLeg()], checks: {}, submission: null, ...over };
}

function revolutLeg(payee = "zezima1abc") {
  return { ...createLeg("revolut", ["GBP"]), payee };
}

function checked(legId: string, platform: string, offchainId: string, result: PayeeCheck): SellDraftState["checks"] {
  return { [legId]: { status: "done", key: payeeCheckKey(platform, offchainId), result } };
}

describe("evaluateSell", () => {
  it("is idle until the player types something", () => {
    expect(evaluateSell(draft(), ctx()).phase).toBe("idle");
  });

  it("is editing with friendly issues for a bad amount", () => {
    const leg = revolutLeg();
    const below = evaluateSell(draft({ amount: "0.5", legs: [leg] }), ctx());
    expect(below.phase).toBe("editing");
    expect(below.issues.find((i) => i.code === "AMOUNT_BELOW_MIN")?.message).toBe("The minimum is 1 USDC.");

    const over = evaluateSell(draft({ amount: "600", legs: [leg] }), ctx());
    expect(over.issues.find((i) => i.code === "AMOUNT_ABOVE_BALANCE")?.message).toBe("You only have 500.00 USDC.");
  });

  it("is validating while a payee check is pending, then ready once it is valid", () => {
    const leg = revolutLeg();
    const pending = evaluateSell(draft({ amount: "100", legs: [leg] }), ctx());
    expect(pending.phase).toBe("validating");
    expect(pending.canSubmit).toBe(false);

    const ready = evaluateSell(
      draft({
        amount: "100",
        legs: [leg],
        checks: checked(leg.id, "revolut", "zezima1abc", { kind: "valid", offchainId: "zezima1abc", payeeHash: null, confirmed: true }),
      }),
      ctx(),
    );
    expect(ready.phase).toBe("ready");
    expect(ready.canSubmit).toBe(true);
    expect(ready.amount).toBe(100_000_000n);
    expect(ready.legs).toEqual([{ platform: "revolut", currencies: ["GBP"], offchainId: "zezima1abc" }]);
  });

  it("treats a stale check (handle changed since) as pending", () => {
    const leg = revolutLeg("newtag");
    const state = draft({
      amount: "100",
      legs: [leg],
      checks: checked(leg.id, "revolut", "oldtag", { kind: "valid", offchainId: "oldtag", payeeHash: null, confirmed: true }),
    });
    expect(evaluateSell(state, ctx()).phase).toBe("validating");
  });

  it("blocks on notFound and registration results", () => {
    const leg = revolutLeg();
    const notFound = evaluateSell(
      draft({
        amount: "100",
        legs: [leg],
        checks: checked(leg.id, "revolut", "zezima1abc", {
          kind: "notFound",
          offchainId: "zezima1abc",
          registration: null,
          message: "We couldn't find @zezima1abc on Revolut.",
        }),
      }),
      ctx(),
    );
    expect(notFound.phase).toBe("editing");
    expect(notFound.issues).toContainEqual(expect.objectContaining({ code: "PAYEE_NOT_FOUND", legId: leg.id }));
  });

  it("waits for the balance and blocks a wallet with no gas", () => {
    const leg = revolutLeg();
    const checks = checked(leg.id, "revolut", "zezima1abc", { kind: "valid", offchainId: "zezima1abc", payeeHash: null, confirmed: true });
    expect(evaluateSell(draft({ amount: "100", legs: [leg], checks }), ctx({ balance: null })).phase).toBe("validating");
    const noGas = evaluateSell(draft({ amount: "100", legs: [leg], checks }), ctx({ gas: "empty" }));
    expect(noGas.phase).toBe("editing");
    expect(noGas.issues.map((i) => i.code)).toContain("NO_GAS");
    expect(evaluateSell(draft({ amount: "100", legs: [leg], checks }), ctx({ walletConnected: false })).issues[0]?.code).toBe(
      "WALLET_REQUIRED",
    );
  });

  it("rejects duplicate platforms and unsupported currencies", () => {
    const a = revolutLeg();
    const b = revolutLeg("other1");
    const venmoEur = { ...createLeg("venmo", ["EUR"]), payee: "zezima" };
    const result = evaluateSell(draft({ amount: "100", legs: [a, b, venmoEur] }), ctx());
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("PLATFORM_DUPLICATE");
    expect(codes).toContain("CURRENCY_UNSUPPORTED");
  });

  it("reports stored submission phases verbatim", () => {
    const steps = initialSteps();
    expect(evaluateSell(draft({ submission: { status: "submitting", steps } }), ctx()).phase).toBe("submitting");
    const error = sellError("SUBMISSION_UNKNOWN");
    expect(evaluateSell(draft({ submission: { status: "error", steps, error } }), ctx()).phase).toBe("error");
  });

  it("only keys a payee check once the platform and handle are valid", () => {
    expect(legCheckKey(createLeg(), caps)).toBeNull();
    expect(legCheckKey({ ...createLeg("revolut"), payee: "bad tag" }, caps)).toBeNull();
    expect(legCheckKey({ ...createLeg("revolut"), payee: "@good1" }, caps)).toBe(payeeCheckKey("revolut", "good1"));
  });
});

describe("toReceive", () => {
  it("builds one leg, a multi-currency leg, or an array", () => {
    expect(toReceive([{ platform: "venmo", currencies: ["USD"], offchainId: "a" }])).toEqual({
      platform: "venmo",
      currency: "USD",
      payee: "a",
    });
    expect(toReceive([{ platform: "revolut", currencies: ["EUR", "GBP"], offchainId: "b" }])).toEqual({
      platform: "revolut",
      currencies: ["EUR", "GBP"],
      payee: "b",
    });
    expect(
      toReceive([
        { platform: "venmo", currencies: ["USD"], offchainId: "a" },
        { platform: "revolut", currencies: ["EUR"], offchainId: "b" },
      ]),
    ).toHaveLength(2);
    expect(() => toReceive([])).toThrow();
  });
});
