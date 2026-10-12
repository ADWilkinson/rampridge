import { beforeEach, describe, expect, it } from "vitest";
import { sellError } from "../errors";
import { initialSteps } from "../machine";
import { useSellStore } from "../store";
import { OWNER } from "./helpers";

const store = () => useSellStore.getState();

beforeEach(() => {
  store().setSubmission(null);
  store().setOwner(null);
  store().reset();
});

describe("useSellStore", () => {
  it("starts with one empty leg and edits legs by id", () => {
    expect(store().legs).toHaveLength(1);
    const id = store().addLeg("revolut", ["GBP"]);
    store().updateLeg(id, { payee: "zezima1abc" });
    expect(store().legs.find((l) => l.id === id)).toMatchObject({ platform: "revolut", currencies: ["GBP"], payee: "zezima1abc" });
    store().setCheck(id, { status: "checking", key: "k" });
    store().removeLeg(id);
    expect(store().legs.find((l) => l.id === id)).toBeUndefined();
    expect(store().checks[id]).toBeUndefined();
  });

  it("ignores edits while a deposit is being submitted or is listed", () => {
    store().setAmount("10");
    store().setSubmission({ status: "submitting", steps: initialSteps() });
    store().setAmount("20");
    store().reset();
    expect(store().amount).toBe("10");
    store().setSubmission({
      status: "listed",
      steps: initialSteps(),
      listed: { depositId: "d", amount: 1n, legs: [], txHashes: { createDeposit: null, accessPolicy: [] } },
    });
    store().setAmount("30");
    expect(store().amount).toBe("10");
  });

  it("clears a nothing-on-chain error on the next edit", () => {
    store().setSubmission({ status: "error", steps: initialSteps(), error: sellError("USER_REJECTED") });
    store().setAmount("15");
    expect(store().amount).toBe("15");
    expect(store().submission).toBeNull();
  });

  it("keeps a possibly-on-chain error and blocks edits until it is resolved", () => {
    const error = sellError("SUBMISSION_UNKNOWN");
    store().setAmount("10");
    store().setSubmission({ status: "error", steps: initialSteps(), error });
    store().setAmount("99");
    expect(store().amount).toBe("10");
    store().reset();
    expect(store().submission).toMatchObject({ status: "error", error });
  });

  it("resets the draft when the wallet changes", () => {
    store().setOwner(OWNER);
    store().setAmount("12");
    store().setOwner(OWNER.toUpperCase().replace("0X", "0x"));
    expect(store().amount).toBe("12");
    store().setOwner("0x9999999999999999999999999999999999999999");
    expect(store().amount).toBe("");
  });
});
