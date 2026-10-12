import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { BuyOrder } from "@/peer/buy";
import {
  blockedEarlierOrder,
  buyOrderReminder,
  canAdoptEarlierOrder,
  canReleaseEarlierOrder,
  nextEarlierLatch,
  paymentScrollExamine,
  signalLanded,
  type EarlierLatch,
  type FlowView,
  type LatchInput,
} from "./buyOrders";

const SMART = "0x1111111111111111111111111111111111111111" as Address;
const EOA = "0x2222222222222222222222222222222222222222" as Address;
const HASH = "0xAbC0000000000000000000000000000000000000000000000000000000000001" as Hex;
const OTHER = "0xdef0000000000000000000000000000000000000000000000000000000000002" as Hex;

function order(partial: Partial<BuyOrder> = {}): BuyOrder {
  return {
    owner: EOA,
    intentHash: HASH,
    depositId: "1",
    escrow: SMART,
    orchestrator: null,
    platform: "revolut",
    currency: "GBP",
    usdcGross: 100_000_000n,
    usdcExpected: 99_000_000n,
    rate: 10n ** 18n,
    fiatToSend: 101_500_000n,
    fiatToSendText: "101.50",
    payeeHandle: "revtag",
    payeeDetailsHash: OTHER,
    signalTxHash: null,
    signaledAt: 0,
    expiresAt: 10_000,
    verifyMethodId: null,
    memo: null,
    status: "active",
    fees: null,
    paidClaimedAt: null,
    ...partial,
  };
}

function flow(partial: Partial<FlowView> = {}): FlowView {
  return { owner: SMART.toLowerCase() as Address, step: "idle", order: null, pending: null, recovering: false, ...partial };
}

function input(partial: Partial<LatchInput> = {}): LatchInput {
  return {
    flow: flow(),
    main: SMART,
    eoa: EOA,
    earlierReady: true,
    found: { intentHash: HASH, at: 100 },
    staleBefore: 0,
    released: new Set(),
    buyInterfaceOpen: false,
    ...partial,
  };
}

const pay = { amountText: "£101.50", payeeDisplay: "@revtag", platformName: "Revolut" };

describe("paymentScrollExamine", () => {
  it("states the exact amount, payee and platform, and warns against paying twice", () => {
    expect(paymentScrollExamine(pay, "awaitingPayment", false)).toBe(
      "Pay £101.50 to @revtag on Revolut once, then verify it with Peer. If you have already paid, don't pay again.",
    );
  });

  it("leaves the payee out when it is unknown", () => {
    expect(paymentScrollExamine({ ...pay, payeeDisplay: null }, null, false)).toBe(
      "Pay £101.50 on Revolut once, then verify it with Peer. If you have already paid, don't pay again.",
    );
  });

  it("never asks for payment once the player is verifying", () => {
    for (const step of ["verifying", "selectPayment", "fulfilling"] as const) {
      expect(paymentScrollExamine(pay, step, false)).toBe("Your payment is being verified.");
      expect(paymentScrollExamine(pay, step, true)).toBe("Your payment is being verified.");
    }
  });

  it("tells an expired order's payer to verify and everyone else not to pay", () => {
    expect(paymentScrollExamine(pay, "awaitingPayment", true)).toBe(
      "This offer has expired. If you already paid, read this scroll and verify it now. Otherwise don't pay it.",
    );
  });
});

describe("buyOrderReminder", () => {
  it("matches the buy flow's own expired-order advice", () => {
    expect(buyOrderReminder(true, false)).toContain("If you already paid");
    expect(buyOrderReminder(true, false)).toContain("Otherwise don't pay it.");
  });

  it("names the earlier wallet when the order is there", () => {
    expect(buyOrderReminder(false, true)).toContain("from your earlier wallet");
    expect(buyOrderReminder(false, false)).not.toContain("earlier");
  });
});

describe("signalLanded", () => {
  it("is true only for a signal finishing in this session", () => {
    expect(signalLanded({ step: "awaitingPayment", order: order() }, { step: "signaling" })).toBe(true);
    expect(signalLanded({ step: "awaitingPayment", order: order() }, { step: "idle" })).toBe(false);
    expect(signalLanded({ step: "error", order: null }, { step: "signaling" })).toBe(false);
  });
});

describe("canAdoptEarlierOrder", () => {
  it("adopts when the player's wallet has no open order and nothing in flight", () => {
    expect(canAdoptEarlierOrder(flow(), SMART)).toBe(true);
    expect(canAdoptEarlierOrder(flow({ step: "completed", order: order({ owner: SMART, status: "fulfilled" }) }), SMART)).toBe(true);
  });

  it("never interrupts an open order, a transaction, a recovery or an offer being put together", () => {
    expect(canAdoptEarlierOrder(flow({ step: "quoted" }), SMART)).toBe(false);
    expect(canAdoptEarlierOrder(flow({ step: "awaitingPayment", order: order({ owner: SMART }) }), SMART)).toBe(false);
    expect(canAdoptEarlierOrder(flow({ step: "signaling", pending: "signal" }), SMART)).toBe(false);
    expect(canAdoptEarlierOrder(flow({ recovering: true }), SMART)).toBe(false);
    expect(canAdoptEarlierOrder(flow({ step: "confirming" }), SMART)).toBe(false);
    expect(canAdoptEarlierOrder(flow({ owner: null }), SMART)).toBe(false);
  });
});

describe("canReleaseEarlierOrder", () => {
  const onEoa = (partial: Partial<FlowView>) => flow({ owner: EOA.toLowerCase() as Address, ...partial });

  it("holds an open order, whatever the player is looking at", () => {
    expect(canReleaseEarlierOrder(onEoa({ step: "awaitingPayment", order: order() }), false)).toBe(false);
    expect(canReleaseEarlierOrder(onEoa({ step: "error", order: order() }), false)).toBe(false);
    expect(canReleaseEarlierOrder(onEoa({ step: "fulfilling", order: order(), pending: "fulfill" }), false)).toBe(false);
  });

  it("keeps a finished order's screen until the buy interface closes", () => {
    const done = onEoa({ step: "completed", order: order({ status: "fulfilled" }) });
    expect(canReleaseEarlierOrder(done, true)).toBe(false);
    expect(canReleaseEarlierOrder(done, false)).toBe(true);
  });

  it("goes back at once when a new offer is quoted, so it is never placed from the earlier wallet", () => {
    expect(canReleaseEarlierOrder(onEoa({ step: "quoted" }), true)).toBe(true);
    expect(canReleaseEarlierOrder(onEoa({ step: "confirming" }), true)).toBe(true);
  });
});

describe("nextEarlierLatch", () => {
  it("adopts a found order when the player's wallet is free", () => {
    expect(nextEarlierLatch(null, input())).toEqual({
      latch: { eoa: EOA.toLowerCase(), intentHash: HASH.toLowerCase(), seen: false, shown: false },
      forget: null,
      recheck: false,
    });
  });

  it("does not adopt without both wallets, a stale lookup or a released order", () => {
    expect(nextEarlierLatch(null, input({ main: null })).latch).toBeNull();
    expect(nextEarlierLatch(null, input({ earlierReady: false })).latch).toBeNull();
    expect(nextEarlierLatch(null, input({ staleBefore: 100 })).latch).toBeNull();
    expect(nextEarlierLatch(null, input({ released: new Set([HASH.toLowerCase()]) })).latch).toBeNull();
  });

  const latched: EarlierLatch = { eoa: EOA.toLowerCase(), intentHash: HASH.toLowerCase(), seen: false, shown: false };
  const onEoa = (partial: Partial<FlowView>) => flow({ owner: EOA.toLowerCase() as Address, ...partial });

  it("does not let go while switching over, even though the fresh flow looks empty", () => {
    expect(nextEarlierLatch(latched, input({ flow: flow() })).latch).toBe(latched);
    expect(nextEarlierLatch(latched, input({ flow: onEoa({}) })).latch).toBe(latched);
  });

  it("forgets an order it showed once that order is finished and closed", () => {
    const shown = nextEarlierLatch(latched, input({ flow: onEoa({ step: "awaitingPayment", order: order() }) })).latch;
    expect(shown).toEqual({ ...latched, seen: true, shown: true });
    const done = nextEarlierLatch(shown, input({ flow: onEoa({ step: "completed", order: order({ status: "fulfilled" }) }) }));
    expect(done).toEqual({ latch: null, forget: HASH.toLowerCase(), recheck: false });
  });

  it("looks again instead of forgetting when the flow found nothing", () => {
    const looked = nextEarlierLatch(latched, input({ flow: onEoa({ recovering: true }) })).latch;
    expect(looked).toEqual({ ...latched, seen: true });
    expect(nextEarlierLatch(looked, input({ flow: onEoa({}) }))).toEqual({ latch: null, forget: null, recheck: true });
  });

  it("must look again after the flow briefly left the earlier wallet", () => {
    const seen: EarlierLatch = { ...latched, seen: true, shown: true };
    const away = nextEarlierLatch(seen, input({ flow: flow() })).latch;
    expect(away).toEqual({ ...seen, seen: false });
    expect(nextEarlierLatch(away, input({ flow: onEoa({}) })).latch).toBe(away);
  });

  it("drops the binding without forgetting the order on logout", () => {
    expect(nextEarlierLatch(latched, input({ eoa: null }))).toEqual({ latch: null, forget: null, recheck: false });
  });
});

describe("blockedEarlierOrder", () => {
  it("reports an earlier order waiting behind the player's own open order", () => {
    const busy = input({ flow: flow({ step: "awaitingPayment", order: order({ owner: SMART, intentHash: OTHER }) }) });
    expect(blockedEarlierOrder(busy, false)).toBe(HASH.toLowerCase());
    expect(blockedEarlierOrder(busy, true)).toBeNull();
    expect(blockedEarlierOrder(input(), false)).toBeNull();
  });
});
