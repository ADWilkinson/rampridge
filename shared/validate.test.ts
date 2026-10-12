import { describe, expect, it } from "vitest";
import { MAX_PATH_STEPS } from "./protocol";
import {
  CHAT_INPUT_MAX_LENGTH,
  parseChatRecord,
  parseDepositId,
  parsePlayerRecord,
  parseWorldEventRecord,
  validateActRequest,
  validateAppearance,
  validateSessionRequest,
  validateWalletProofRequest,
} from "./validate";
import { DEFAULT_APPEARANCE } from "./world";

const appearance = { body: 1, kits: [72, 14, 19, 16, 1, 21, 1], colors: [24, 28, 28, 5, 7] };

describe("validateAppearance", () => {
  it("accepts every index the character designer offers", () => {
    expect(validateAppearance(appearance)).toEqual({ ok: true, value: appearance });
    expect(validateAppearance(DEFAULT_APPEARANCE).ok).toBe(true);
    expect(validateAppearance({ body: 1, kits: [0, 0, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] }).ok).toBe(true);
    expect(validateAppearance({ body: 0, kits: [70, 15, 19, 16, 1, 21, 1], colors: [24, 28, 28, 5, 7] }).ok).toBe(true);
  });

  it("applies each body's own kit ranges", () => {
    // Female hair has 73 styles, male hair 71; male jaws 16, female 15.
    expect(validateAppearance({ ...appearance, body: 0 }).ok).toBe(false);
    expect(validateAppearance({ ...appearance, kits: [0, 15, 0, 0, 0, 0, 0] }).ok).toBe(false);
    expect(validateAppearance({ ...appearance, body: 0, kits: [0, 15, 0, 0, 0, 0, 0] }).ok).toBe(true);
  });

  it("rejects out-of-range, missing or wrong-shaped choices", () => {
    expect(validateAppearance({ ...appearance, body: 2 }).ok).toBe(false);
    expect(validateAppearance({ ...appearance, kits: [73, 0, 0, 0, 0, 0, 0] }).ok).toBe(false);
    expect(validateAppearance({ ...appearance, kits: [0, -1, 0, 0, 0, 0, 0] }).ok).toBe(false);
    expect(validateAppearance({ ...appearance, colors: [25, 0, 0, 0, 0] }).ok).toBe(false);
    expect(validateAppearance({ ...appearance, colors: [0, 0, 0, 0, 8] }).ok).toBe(false);
    expect(validateAppearance({ ...appearance, kits: [1, 2] }).ok).toBe(false);
    expect(validateAppearance({ ...appearance, colors: [0.5, 0, 0, 0, 0] }).ok).toBe(false);
    expect(validateAppearance(null).ok).toBe(false);
  });

  it("accepts arrays the database returned as index-keyed objects", () => {
    const kits = Object.fromEntries(appearance.kits.map((v, i) => [String(i), v]));
    expect(validateAppearance({ ...appearance, kits }).ok).toBe(true);
  });
});

describe("validateActRequest", () => {
  it("accepts every action type", () => {
    const valid = [
      { type: "join", appearance },
      { type: "appearance", appearance },
      { type: "move", path: [{ x: 3185, y: 3438 }, { x: 3186, y: 3438 }], run: true },
      { type: "chat", text: "red:wave:hello" },
      { type: "emote", emote: "dance" },
      { type: "heartbeat" },
      { type: "leave" },
      { type: "stall", depositId: "5559" },
      { type: "stall", depositId: "0x777777779d229cdF3110e9de47943791c26300Ef_5559" },
      { type: "stall", depositId: null },
      { type: "announce", kind: "bought", tx: `0x${"ab".repeat(32)}` },
    ];
    for (const body of valid) expect(validateActRequest(body)).toMatchObject({ ok: true });
  });

  it("returns a clean value without unknown fields and lowercases tx hashes", () => {
    const result = validateActRequest({ type: "announce", kind: "listed", tx: `0x${"AB".repeat(32)}`, extra: 1 });
    expect(result).toEqual({ ok: true, value: { type: "announce", kind: "listed", tx: `0x${"ab".repeat(32)}` } });
  });

  it("rejects malformed actions", () => {
    const invalid = [
      null,
      "join",
      { type: "fly" },
      { type: "move", path: [], run: false },
      { type: "move", path: [{ x: 1.5, y: 2 }], run: false },
      { type: "move", path: [{ x: -1, y: 2 }], run: false },
      { type: "move", path: [{ x: 1, y: 2 }], run: "yes" },
      { type: "move", path: Array.from({ length: MAX_PATH_STEPS + 1 }, (_, i) => ({ x: i, y: 0 })), run: false },
      { type: "chat", text: 5 },
      { type: "chat", text: "x".repeat(CHAT_INPUT_MAX_LENGTH + 1) },
      { type: "emote", emote: "moonwalk" },
      { type: "stall", depositId: "abc" },
      { type: "stall", depositId: 5559 },
      { type: "announce", kind: "sold", tx: `0x${"ab".repeat(32)}` },
      { type: "announce", kind: "bought", tx: "0x1234" },
      { type: "join", appearance: { body: 0 } },
    ];
    for (const body of invalid) expect(validateActRequest(body).ok).toBe(false);
  });
});

describe("parseDepositId", () => {
  it("parses plain and composite ids", () => {
    expect(parseDepositId("5559")).toEqual({ escrow: null, id: "5559" });
    expect(parseDepositId("007")).toEqual({ escrow: null, id: "7" });
    expect(parseDepositId("0x777777779D229cdF3110e9de47943791c26300Ef_12")).toEqual({
      escrow: "0x777777779d229cdf3110e9de47943791c26300ef",
      id: "12",
    });
    expect(parseDepositId("0x1234_12")).toBeNull();
    expect(parseDepositId("-1")).toBeNull();
    expect(parseDepositId("")).toBeNull();
  });
});

describe("session and wallet requests", () => {
  it("validates session bodies", () => {
    expect(validateSessionRequest(null)).toEqual({ ok: true, value: {} });
    expect(validateSessionRequest({ token: "t", name: "Bob" })).toEqual({ ok: true, value: { token: "t", name: "Bob" } });
    expect(validateSessionRequest({ name: 5 }).ok).toBe(false);
    expect(validateSessionRequest([]).ok).toBe(false);
  });

  it("accepts check-only name requests", () => {
    expect(validateSessionRequest({ token: "t", name: "Bob", check: true })).toEqual({
      ok: true,
      value: { token: "t", name: "Bob", check: true },
    });
    expect(validateSessionRequest({ token: "t", name: "Bob", check: false })).toEqual({ ok: true, value: { token: "t", name: "Bob" } });
    expect(validateSessionRequest({ token: "t", check: true }).ok).toBe(false);
    expect(validateSessionRequest({ token: "t", name: "Bob", check: "yes" }).ok).toBe(false);
  });

  it("validates wallet proofs", () => {
    const proof = {
      token: "t",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      message: "hello",
      signature: `0x${"1b".repeat(65)}`,
    };
    expect(validateWalletProofRequest(proof).ok).toBe(true);
    expect(validateWalletProofRequest({ ...proof, address: "0x1" }).ok).toBe(false);
    expect(validateWalletProofRequest({ ...proof, signature: "0x12" }).ok).toBe(false);
    expect(validateWalletProofRequest({ ...proof, message: "" }).ok).toBe(false);
  });
});

describe("record parsers", () => {
  const player = { n: "Bob", a: appearance, p: "3185,3438", t: 10, r: false, ls: 10, j: 10 };

  it("parses a player and fills optional fields", () => {
    expect(parsePlayerRecord(player)).toEqual({ ...player, e: null, et: null, w: null, s: null });
    expect(parsePlayerRecord({ ...player, e: "wave", et: 12, w: "0xabc" })).toMatchObject({ e: "wave", et: 12, w: "0xabc" });
  });

  it("drops partial or malformed players", () => {
    expect(parsePlayerRecord({ ls: 10 })).toBeNull();
    expect(parsePlayerRecord({ ...player, a: { body: 7 } })).toBeNull();
    expect(parsePlayerRecord({ ...player, e: "moonwalk" })).toMatchObject({ e: null });
  });

  it("parses chat and world events", () => {
    expect(parseChatRecord({ pid: "p", n: "Bob", m: "hi", t: 1 })).toEqual({ pid: "p", n: "Bob", m: "hi", fx: null, t: 1 });
    expect(parseChatRecord({ pid: "p", n: "Bob", t: 1 })).toBeNull();
    const event = { kind: "bought", pid: "p", n: "Bob", usdc: "10", platform: "revolut", tx: "0x1", t: 1 };
    expect(parseWorldEventRecord(event)).toEqual({ ...event, fiat: null, currency: null });
    expect(parseWorldEventRecord({ ...event, kind: "stolen" })).toBeNull();
  });
});
