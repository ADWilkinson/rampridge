import type { Zkp2pClient } from "@zkp2p/sdk";
import { describe, expect, it, vi } from "vitest";
import type { TxSender } from "@/wallet";
import { cancelBuyIntent, NO_GAS_NEW_ORDER, signalBuyIntent } from "../chain";
import { BuyFlowError } from "../errors";
import type { BuyQuote } from "../../market";

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const INTENT = `0x${"11".repeat(32)}` as const;

function clientWithEth(balance: bigint) {
  const getBalance = vi.fn(async () => balance);
  return { client: { publicClient: { getBalance } } as unknown as Zkp2pClient, getBalance };
}

function ownWallet(): TxSender {
  return { address: ADDRESS, kind: "external", sponsored: false } as unknown as TxSender;
}

describe("gas check before a buy transaction", () => {
  it("stops a new order from a wallet with no ETH and points to a sponsored login", async () => {
    const { client } = clientWithEth(0n);
    const failure = await signalBuyIntent(client, ownWallet(), {} as BuyQuote).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BuyFlowError);
    expect((failure as BuyFlowError).code).toBe("insufficient_gas");
    expect((failure as BuyFlowError).recoverable).toBe(true);
    expect((failure as BuyFlowError).message).toBe(NO_GAS_NEW_ORDER);
    expect(NO_GAS_NEW_ORDER).toMatch(/email or Google/);
  });

  it("keeps the plain message once an order exists (another login can't act on it)", async () => {
    const { client } = clientWithEth(0n);
    const failure = await cancelBuyIntent(client, ownWallet(), INTENT, null).catch((e: unknown) => e);
    expect((failure as BuyFlowError).code).toBe("insufficient_gas");
    expect((failure as BuyFlowError).message).toBe("Your wallet needs a little ETH on Base to pay gas.");
  });
});
