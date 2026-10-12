import { describe, expect, it } from "vitest";
import type { BuyOrder } from "@/peer/buy";
import { olderCancelledNow, placedNow } from "./events";

const order = { status: "active" } as BuyOrder;

describe("placedNow", () => {
  it("fires when this session's signal lands", () => {
    expect(placedNow({ step: "awaitingPayment", order, notice: null }, { step: "signaling" })).toBe(true);
  });

  it("stays quiet for adopted, resumed or reconciled orders", () => {
    expect(placedNow({ step: "awaitingPayment", order, notice: "You already had an open order, so here it is." }, { step: "signaling" })).toBe(false);
    expect(placedNow({ step: "awaitingPayment", order, notice: null }, { step: "idle" })).toBe(false);
    expect(placedNow({ step: "error", order: null, notice: null }, { step: "signaling" })).toBe(false);
    expect(placedNow({ step: "awaitingPayment", order: { ...order, status: "cancelled" }, notice: null }, { step: "signaling" })).toBe(false);
  });
});

describe("olderCancelledNow", () => {
  it("fires when a cancel of an older, unseen order lands", () => {
    expect(olderCancelledNow({ step: "cancelled", order: null }, { step: "idle", pending: "cancel", order: null })).toBe(true);
  });

  it("stays quiet for this app's own order or anything else", () => {
    expect(olderCancelledNow({ step: "cancelled", order: { ...order, status: "cancelled" } }, { step: "awaitingPayment", pending: "cancel", order })).toBe(false);
    expect(olderCancelledNow({ step: "cancelled", order: null }, { step: "cancelled", pending: null, order: null })).toBe(false);
    expect(olderCancelledNow({ step: "error", order: null }, { step: "idle", pending: "cancel", order: null })).toBe(false);
  });
});
