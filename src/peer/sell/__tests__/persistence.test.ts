import { describe, expect, it } from "vitest";
import { createPendingSellStore, memoryStorage, type PendingSellRecord } from "../persistence";
import { hash, OWNER, VENMO_METHOD } from "./helpers";

const KEY = `rampridge:sell:pending:${OWNER.toLowerCase()}`;

function record(extra: Partial<PendingSellRecord> = {}): PendingSellRecord {
  return {
    v: 1,
    owner: OWNER.toLowerCase(),
    stage: "deposited",
    startedAt: 1_760_000_000_000,
    amount: "100000000",
    legs: [{ platform: "venmo", currencies: ["USD"] }],
    knownDepositIds: [],
    accessPolicyPaymentMethods: [VENMO_METHOD],
    policyTxHashes: {},
    depositId: "0x2222222222222222222222222222222222222222_7",
    ...extra,
  };
}

describe("pending sell store", () => {
  it("round-trips the baseline and policy progress", () => {
    const store = createPendingSellStore(memoryStorage());
    const full = record({
      baseline: { nonce: 12, isContract: false, usdcBalance: "200000000" },
      pendingPolicyTxHashes: { [VENMO_METHOD]: hash(4) },
      policyVerified: [VENMO_METHOD],
    });
    store.write(full);
    expect(store.read(OWNER)).toEqual(full);
  });

  it("drops malformed optional fields but keeps the record and its protection", () => {
    const storage = memoryStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        ...record(),
        baseline: { nonce: "12", isContract: false, usdcBalance: "1" },
        pendingPolicyTxHashes: { [VENMO_METHOD]: "not-a-hash" },
        policyVerified: "nope",
      }),
    );

    const read = createPendingSellStore(storage).read(OWNER);

    expect(read).not.toBeNull();
    expect(read?.depositId).toBe("0x2222222222222222222222222222222222222222_7");
    expect(read?.baseline).toBeNull();
    expect(read).not.toHaveProperty("pendingPolicyTxHashes");
    expect(read).not.toHaveProperty("policyVerified");
  });

  it("reads a record written before the baseline existed as having none", () => {
    const storage = memoryStorage();
    storage.setItem(KEY, JSON.stringify(record({ stage: "sending", depositId: undefined })));
    expect(createPendingSellStore(storage).read(OWNER)).toMatchObject({ stage: "sending", baseline: null });
  });
});
