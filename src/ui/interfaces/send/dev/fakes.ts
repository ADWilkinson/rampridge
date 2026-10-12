/**
 * Dev-harness fakes (never imported by the app): an in-memory "chain" behind
 * the SendChain the interface reads, and a TxSender that resolves a canned
 * receipt (or fails the way a real wallet does) after a delay. The real Send
 * interface and the real `sendUsdc` run on top.
 */

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { USDC_ADDRESS } from "@/config";
import {
  ChainSwitchError,
  InsufficientGasError,
  SponsorshipError,
  TransactionPendingError,
  TransactionRevertedError,
  UserRejectedError,
  WalletError,
} from "@/wallet/errors";
import type { FoundTransfer, SendChain } from "@/wallet/send";
import type { TxSender, UserOperationStatus, WalletCall, WalletKind } from "@/wallet/types";

export const USDC = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

/** A recipient that is a contract (a Safe, say): the interface notes it. */
export const CONTRACT_RECIPIENT: Address = getAddress("0x41675c099f32341bf84bfc5382af534df5c7461a");

export type SendFault = "rejected" | "gas" | "sponsorship" | "pending" | "reverted" | "chain" | "unknown";

export interface WorldOptions {
  address: Address;
  kind: WalletKind;
  sponsored: boolean;
  usdc: bigint;
  eth: bigint;
  /** The balance the chain returns when the send re-reads it (default: `usdc`). */
  chainUsdc?: bigint;
  sendDelayMs: number;
  fault: SendFault | null;
  /** Transfers already on the chain (for settling an unconfirmed send). */
  landed?: { to: Address; value: bigint; hash: Hash }[];
  /** eth_getLogs fails, as on Base's public RPC. */
  historyDown?: boolean;
  /** What a smart wallet's bundler says about any user operation (default: no record of it). */
  bundler?: UserOperationStatus;
}

const hashOf = (seed: string): Hash => keccak256(stringToHex(seed));

export class FakeWorld {
  readonly address: Address;
  readonly kind: WalletKind;
  readonly sponsored: boolean;
  usdc: bigint;
  chainUsdc: bigint;
  eth: bigint;
  block = 41_000_000n;
  readonly sendDelayMs: number;
  readonly fault: SendFault | null;
  readonly historyDown: boolean;
  readonly bundler: UserOperationStatus;
  private readonly landed: { to: Address; value: bigint; hash: Hash; block: bigint }[];
  private readonly listeners = new Set<() => void>();
  private sends = 0;

  constructor(opts: WorldOptions) {
    this.address = opts.address;
    this.kind = opts.kind;
    this.sponsored = opts.sponsored;
    this.usdc = opts.usdc;
    this.chainUsdc = opts.chainUsdc ?? opts.usdc;
    this.eth = opts.eth;
    this.sendDelayMs = opts.sendDelayMs;
    this.fault = opts.fault;
    this.historyDown = opts.historyDown ?? false;
    this.bundler = opts.bundler ?? { status: "absent" };
    this.landed = (opts.landed ?? []).map((t) => ({ ...t, block: this.block - 2n }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** What the wallet does with a USDC transfer: moves the balance and returns a receipt with the Transfer log. */
  async send(calls: WalletCall[], label: string | undefined): Promise<TransactionReceipt> {
    console.debug(`[wallet] ${label ?? "transaction"}`);
    await new Promise((resolve) => setTimeout(resolve, this.sendDelayMs));
    this.sends += 1;
    const call = calls[0];
    if (!call?.data || call.to.toLowerCase() !== USDC_ADDRESS.toLowerCase()) throw new WalletError("invalid_request", "Unexpected call.");
    const { args } = decodeFunctionData({ abi: erc20Abi, data: call.data });
    const [to, value] = args as readonly [Address, bigint];
    const hash = hashOf(`send-${this.sends}-${Date.now()}`);
    switch (this.fault) {
      case "rejected":
        throw new UserRejectedError();
      case "gas":
        throw new InsufficientGasError(this.address);
      case "sponsorship":
        throw new SponsorshipError({ reason: "request denied - policy rejected: max spend per user reached" });
      case "pending":
        throw new TransactionPendingError(hash);
      case "reverted":
        throw new TransactionRevertedError(hash, null);
      case "chain":
        throw new ChainSwitchError();
      case "unknown":
        throw new WalletError("unknown", "Your wallet ran into a problem it couldn't explain.", { mayHaveLanded: false });
      case null:
        break;
    }
    this.block += 3n;
    this.usdc -= value;
    this.chainUsdc -= value;
    this.landed.push({ to, value, hash, block: this.block });
    this.emit();
    return {
      transactionHash: hash,
      status: "success",
      blockNumber: this.block,
      logs: [
        {
          address: USDC_ADDRESS,
          topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: this.address, to } }),
          data: encodeAbiParameters([{ type: "uint256" }], [value]),
        },
      ],
    } as unknown as TransactionReceipt;
  }

  transfersTo(to: Address, fromBlock: bigint, toBlock: bigint): FoundTransfer[] {
    return this.landed
      .filter((t) => t.to.toLowerCase() === to.toLowerCase() && t.block >= fromBlock && t.block <= toBlock)
      .map((t) => ({ hash: t.hash, value: t.value }));
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFakeChain(world: FakeWorld): SendChain {
  return {
    usdcBalance: async () => {
      await sleep(80);
      return world.chainUsdc;
    },
    ethBalance: async () => {
      await sleep(250);
      return world.eth;
    },
    blockNumber: async () => world.block,
    code: async (address) => {
      await sleep(150);
      // A Safe proxy's runtime code starts like this; any non-empty code is a contract.
      return address.toLowerCase() === CONTRACT_RECIPIENT.toLowerCase() ? ("0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e" as Hex) : "0x";
    },
    simulate: async () => {
      await sleep(120);
    },
    estimateFee: async () => {
      await sleep(400);
      if (world.eth === 0n) throw new InsufficientGasError(world.address);
      return 4_200_000_000_000n;
    },
    receipt: async () => null,
    transfers: async ({ to, fromBlock, toBlock }) => {
      await sleep(200);
      if (world.historyDown) throw new Error("request limit reached");
      return world.transfersTo(to, fromBlock, toBlock);
    },
  };
}

export function createFakeSender(world: FakeWorld): TxSender {
  return {
    address: world.address,
    kind: world.kind,
    sponsored: world.sponsored,
    sendCalls: (calls, opts) => world.send(calls, opts?.label),
    ...(world.kind === "smart" ? { userOperationStatus: async () => world.bundler } : {}),
    signMessage: async () => "0x" as Hex,
    walletClient: {} as WalletClient,
  };
}
