import {
  ResourceUnavailableRpcError,
  RpcRequestError,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  parseAbi,
  toEventSelector,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { entryPoint06Address } from "viem/account-abstraction";

type ReceiptLog = TransactionReceipt["logs"][number];

export const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;

const entryPointAbi = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

function log(address: Address, topics: [Hex, ...Hex[]], data: Hex): ReceiptLog {
  return {
    address,
    topics,
    data,
    blockHash: hash(4),
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: hash(5),
    transactionIndex: 0,
    removed: false,
  };
}

/** A UserOperationEvent as the EntryPoint emits it at the end of each operation. */
export function userOpEvent(sender: Address, success: boolean, entryPoint: Address = entryPoint06Address): ReceiptLog {
  // All three indexed args are set, so every topic is a plain hash.
  const topics = encodeEventTopics({
    abi: entryPointAbi,
    eventName: "UserOperationEvent",
    args: { userOpHash: hash(3), sender, paymaster: "0x0000000000000000000000000000000000000000" },
  }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [1n, success, 100n, 200n],
  );
  return log(entryPoint, topics, data);
}

/** Emitted once by the EntryPoint after validation, before any operation executes. */
export function beforeExecution(entryPoint: Address = entryPoint06Address): ReceiptLog {
  return log(entryPoint, [toEventSelector("BeforeExecution()")], "0x");
}

/** Any event emitted by an operation's calls; an ERC-20 Transfer stands in for DepositReceived. */
export function transferLog(token: Address, from: Address, to: Address, amount: bigint): ReceiptLog {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as [Hex, ...Hex[]];
  return log(token, topics, encodeAbiParameters([{ type: "uint256" }], [amount]));
}

export function receiptWith(
  transactionHash: Hash,
  logs: ReceiptLog[],
  status: "success" | "reverted" = "success",
): TransactionReceipt {
  return { transactionHash, status, logs } as unknown as TransactionReceipt;
}

/** A Coinbase CDP bundler/paymaster URL; the path segment stands in for the project's API key. */
export const CDP_URL = "https://api.developer.coinbase.com/rpc/v1/base/SECRETKEY123";

/** Peer's OrchestratorV3 on Base, which the live CDP paymaster policy did not allowlist. */
export const ORCHESTRATOR_V3: Address = "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7";

/**
 * The error Privy's smart wallet threw on 2026-10-11 when CDP's paymaster
 * policy refused a signalIntent user operation, as viem builds it: the
 * pm_getPaymasterStubData JSON-RPC error inside RpcRequestError inside
 * ResourceUnavailableRpcError (captured from the live service).
 */
export function cdpPolicyRefusal(target: Address = ORCHESTRATOR_V3): ResourceUnavailableRpcError {
  return new ResourceUnavailableRpcError(
    new RpcRequestError({
      body: { method: "pm_getPaymasterStubData", params: [] },
      error: { code: -32002, message: `request denied - policy rejected: called address not in allowlist: ${target}` },
      url: CDP_URL,
    }),
  );
}
