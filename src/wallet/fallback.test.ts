import { getAttributionDataSuffix } from "@zkp2p/sdk";
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, hexToString, type Address, type Hash, type TransactionReceipt } from "viem";
import { USDC_ADDRESS } from "@/config";
import { WalletError } from "./errors";
import { readEmbeddedPin, sweepUsdc, writeEmbeddedPin } from "./fallback";
import type { TxSender, WalletCall } from "./types";

const EOA: Address = "0x6666666666666666666666666666666666666666";
const SMART: Address = "0x5555555555555555555555555555555555555555";
const TX = `0x${"12".repeat(32)}` as Hash;

function fakeSender() {
  const sendCalls = vi.fn(async (_calls: WalletCall[], _opts?: { label?: string }) => ({ transactionHash: TX }) as TransactionReceipt);
  const sender = { address: EOA, kind: "embedded", sponsored: true, sendCalls } as unknown as TxSender;
  return { sender, sendCalls };
}

describe("sweepUsdc", () => {
  it("transfers the whole balance, read right before sending", async () => {
    const { sender, sendCalls } = fakeSender();
    const readBalance = vi.fn(async () => 12_345_678n);
    await expect(sweepUsdc(sender, SMART, readBalance)).resolves.toMatchObject({ transactionHash: TX });
    expect(readBalance).toHaveBeenCalledWith(EOA);
    const [calls, opts] = sendCalls.mock.calls[0] ?? [];
    expect(calls).toHaveLength(1);
    expect(calls?.[0]?.to).toBe(USDC_ADDRESS);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calls?.[0]?.data ?? "0x" });
    expect(decoded).toEqual({ functionName: "transfer", args: [SMART, 12_345_678n] });
    expect(opts?.label).toBe("Move 12.34 USDC to your smart wallet");
  });

  it("carries the same ERC-8021 attribution as every other transaction", async () => {
    const { sender, sendCalls } = fakeSender();
    await sweepUsdc(sender, SMART, async () => 5n);
    const data = sendCalls.mock.calls[0]?.[0]?.[0]?.data ?? "0x";
    const suffix = getAttributionDataSuffix(["rampridge", "peer-ref-TOFIAT"]);
    expect(data.endsWith(suffix.slice(2))).toBe(true);
    expect(hexToString(suffix)).toContain("rampridge,peer-ref-TOFIAT");
    // 4-byte selector + two 32-byte words, then the suffix.
    expect((data.length - 2) / 2).toBe(4 + 64 + (suffix.length - 2) / 2);
  });

  it("does nothing when the EOA is empty", async () => {
    const { sender, sendCalls } = fakeSender();
    await expect(sweepUsdc(sender, SMART, async () => 0n)).resolves.toBeNull();
    expect(sendCalls).not.toHaveBeenCalled();
  });

  it("refuses to send to itself", async () => {
    const { sender } = fakeSender();
    await expect(sweepUsdc(sender, EOA, async () => 1n)).rejects.toBeInstanceOf(WalletError);
  });
});

describe("embedded pin storage", () => {
  it("survives blocked storage", () => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked });
    try {
      expect(() => writeEmbeddedPin("did:privy:1", EOA)).not.toThrow();
      expect(readEmbeddedPin("did:privy:1")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("round-trips per user when storage exists", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    try {
      writeEmbeddedPin("did:privy:1", EOA);
      expect(readEmbeddedPin("did:privy:1")).toBe(EOA);
      expect(readEmbeddedPin("did:privy:2")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
