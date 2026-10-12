import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, erc20Abi, stringToHex, toHex, type Address, type Hash } from "viem";
import { UserRejectedError, toWalletError } from "./errors";
import { createRoutedProvider, personalSignPayload, walletClientFor, type RoutedProviderHandlers } from "./provider";

const ACCOUNT: Address = "0x1111111111111111111111111111111111111111";
const OTHER: Address = "0x2222222222222222222222222222222222222222";
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TX_HASH = `0x${"cd".repeat(32)}` as Hash;
const SIGNATURE = `0x${"ee".repeat(65)}` as const;

function handlers(overrides: Partial<RoutedProviderHandlers> = {}): RoutedProviderHandlers {
  return {
    address: ACCOUNT,
    signMessage: vi.fn(async () => SIGNATURE),
    signTypedData: vi.fn(async () => SIGNATURE),
    sendTransaction: vi.fn(async () => TX_HASH),
    read: vi.fn(async () => "0x1"),
    ...overrides,
  };
}

describe("createRoutedProvider", () => {
  it("reports the sender as the only account, on Base", async () => {
    const provider = createRoutedProvider(handlers());
    await expect(provider.request({ method: "eth_accounts" })).resolves.toEqual([ACCOUNT]);
    await expect(provider.request({ method: "eth_requestAccounts" })).resolves.toEqual([ACCOUNT]);
    await expect(provider.request({ method: "eth_chainId" })).resolves.toBe("0x2105");
    await expect(
      provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] }),
    ).resolves.toBeNull();
    await expect(
      provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }),
    ).rejects.toMatchObject({ code: 4902 });
  });

  it("routes personal_sign in either parameter order and refuses other signers", async () => {
    const h = handlers();
    const provider = createRoutedProvider(h);
    const message = stringToHex("hello");
    await provider.request({ method: "personal_sign", params: [message, ACCOUNT] });
    await provider.request({ method: "personal_sign", params: [ACCOUNT, message] });
    expect(h.signMessage).toHaveBeenNthCalledWith(1, message);
    expect(h.signMessage).toHaveBeenNthCalledWith(2, message);
    await expect(provider.request({ method: "personal_sign", params: [message, OTHER] })).rejects.toMatchObject({
      code: 4100,
    });
  });

  it("parses eth_sendTransaction into a call", async () => {
    const h = handlers();
    const provider = createRoutedProvider(h);
    await expect(
      provider.request({
        method: "eth_sendTransaction",
        params: [{ from: ACCOUNT, to: USDC, data: "0xabcd", value: "0x10", chainId: "0x2105" }],
      }),
    ).resolves.toBe(TX_HASH);
    expect(h.sendTransaction).toHaveBeenCalledWith({ to: USDC, data: "0xabcd", value: 16n });
  });

  it("rejects transactions from another account, another chain or without a recipient", async () => {
    const provider = createRoutedProvider(handlers());
    await expect(
      provider.request({ method: "eth_sendTransaction", params: [{ from: OTHER, to: USDC }] }),
    ).rejects.toMatchObject({ code: 4100 });
    await expect(
      provider.request({ method: "eth_sendTransaction", params: [{ from: ACCOUNT, to: USDC, chainId: "0x1" }] }),
    ).rejects.toMatchObject({ code: 4901 });
    await expect(
      provider.request({ method: "eth_sendTransaction", params: [{ from: ACCOUNT, data: "0x60806040" }] }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("moves EIP712Domain out of the message types and keeps it for raw signers", async () => {
    const h = handlers();
    const provider = createRoutedProvider(h);
    const typed = {
      domain: { name: "Peer", chainId: 8453 },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "chainId", type: "uint256" },
        ],
        Intent: [{ name: "amount", type: "uint256" }],
      },
      primaryType: "Intent",
      message: { amount: "5" },
    };
    await provider.request({ method: "eth_signTypedData_v4", params: [ACCOUNT, JSON.stringify(typed)] });
    expect(h.signTypedData).toHaveBeenCalledWith({
      domain: typed.domain,
      types: { Intent: typed.types.Intent },
      primaryType: "Intent",
      message: typed.message,
      domainType: typed.types.EIP712Domain,
    });
  });

  it("restores a numeric chainId that JSON turned into a string", async () => {
    const h = handlers();
    const provider = createRoutedProvider(h);
    const typed = {
      domain: { name: "Peer", chainId: "8453" },
      types: { Intent: [{ name: "amount", type: "uint256" }] },
      primaryType: "Intent",
      message: { amount: "5" },
    };
    await provider.request({ method: "eth_signTypedData_v4", params: [ACCOUNT, JSON.stringify(typed)] });
    expect(h.signTypedData).toHaveBeenCalledWith(expect.objectContaining({ domain: { name: "Peer", chainId: 8453 } }));
  });

  it("refuses raw signing methods and forwards reads", async () => {
    const h = handlers();
    const provider = createRoutedProvider(h);
    await expect(provider.request({ method: "eth_sign", params: [ACCOUNT, "0x00"] })).rejects.toMatchObject({
      code: 4200,
    });
    await provider.request({ method: "eth_blockNumber" });
    expect(h.read).toHaveBeenCalledWith("eth_blockNumber", undefined);
  });
});

describe("walletClientFor + routed provider", () => {
  it("sends viem transactions through the sender with the encoded call", async () => {
    const h = handlers();
    const client = walletClientFor(ACCOUNT, createRoutedProvider(h));
    expect(client.account?.address).toBe(ACCOUNT);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OTHER, 5n] });
    const sent = await client.sendTransaction({ account: ACCOUNT, chain: client.chain, to: USDC, data });
    expect(sent).toBe(TX_HASH);
    expect(h.sendTransaction).toHaveBeenCalledWith({ to: USDC, data, value: 0n });
  });

  it("signs messages as EIP-191 hex", async () => {
    const h = handlers();
    const client = walletClientFor(ACCOUNT, createRoutedProvider(h));
    await expect(client.signMessage({ account: ACCOUNT, message: "Enter RampRidge" })).resolves.toBe(SIGNATURE);
    expect(h.signMessage).toHaveBeenCalledWith(stringToHex("Enter RampRidge"));
  });

  it("keeps typed wallet errors recoverable through viem's wrapping, without retrying", async () => {
    const sendTransaction = vi.fn(async (): Promise<Hash> => {
      throw new UserRejectedError();
    });
    const client = walletClientFor(ACCOUNT, createRoutedProvider(handlers({ sendTransaction })));
    const error = await client
      .sendTransaction({ account: ACCOUNT, chain: client.chain, to: USDC, value: 1n })
      .catch((e: unknown) => e);
    expect(toWalletError(error)).toBeInstanceOf(UserRejectedError);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("personalSignPayload", () => {
  it("decodes UTF-8 text and keeps binary payloads as raw hex", () => {
    expect(personalSignPayload(stringToHex("café gm"))).toBe("café gm");
    const binary = toHex(new Uint8Array([0xff, 0xfe, 0x00]));
    expect(personalSignPayload(binary)).toEqual({ raw: binary });
  });
});
