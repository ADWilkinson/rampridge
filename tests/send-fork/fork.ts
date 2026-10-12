/**
 * The anvil Base fork: clients, funding, snapshots, and a minimal ERC-4337
 * bundler that submits user operations through the real EntryPoint v0.6.
 */

import { createServer } from "node:http";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  numberToHex,
  pad,
  parseEther,
  toEventSelector,
  toHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";
import {
  entryPoint06Abi,
  entryPoint06Address,
  formatUserOperation,
  getUserOperationHash,
  type UserOperation,
} from "viem/account-abstraction";
import { base } from "viem/chains";
import { USDC_ADDRESS } from "@/config";
import type { Eip1193Like } from "@/wallet/provider";
import type { ChainReader } from "@/wallet/senders";

export const FORK_RPC_URL = process.env.SEND_FORK_RPC_URL ?? "http://127.0.0.1:8560";

const transport = http(FORK_RPC_URL, { retryCount: 0, timeout: 60_000 });

/** Reads against the fork (no multicall batching, so revert data stays per call). */
export const forkClient: PublicClient = createPublicClient({ chain: base, transport }) as unknown as PublicClient;
export const testClient = createTestClient({ chain: base, mode: "anvil", transport });
export const reader = forkClient as unknown as ChainReader;

/** EIP-1193 straight onto the fork; anvil runs with --auto-impersonate, so any address can send. */
export const forkProvider: Eip1193Like = {
  request: ({ method, params }) => forkClient.request({ method: method as never, params: params as never }),
};

export function impersonatedWallet(address: Address) {
  return createWalletClient({ account: address, chain: base, transport });
}

export async function setEthBalance(address: Address, ether = "1"): Promise<void> {
  await testClient.setBalance({ address, value: parseEther(ether) });
}

export function usdcBalance(owner: Address): Promise<bigint> {
  return forkClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

/** FiatToken v2.2 keeps balances (with the blacklist flag in the top bit) in the mapping at slot 9. */
const USDC_BALANCE_SLOT = 9n;

/** Gives `owner` exactly `amount` USDC by writing its balance slot, then checks balanceOf agrees. */
export async function setUsdcBalance(owner: Address, amount: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, USDC_BALANCE_SLOT]));
  await testClient.setStorageAt({ address: USDC_ADDRESS, index: slot, value: pad(toHex(amount), { size: 32 }) });
  const read = await usdcBalance(owner);
  if (read !== amount) throw new Error(`USDC balance slot write did not take (read ${read}, wanted ${amount})`);
}

export function randomAddress(): Address {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Address;
}

// ---------------------------------------------------------------------------
// A minimal bundler for the fork

/** An ERC-4337 v0.6 user operation with every field filled, as `EntryPoint.handleOps` takes it. */
export interface UserOperationV06 {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: Hex;
  signature: Hex;
}

/** One user operation the bundler took, as the EntryPoint ran it. */
export interface BundledOperation {
  userOperation: UserOperationV06;
  userOpHash: Hash;
  /** The account had no code yet: the operation's initCode deploys it. */
  deploying: boolean;
  /** `eth_call` from the EntryPoint to the account with the operation's callData, before handleOps. */
  executeFromEntryPoint: "ok" | { reverted: Hex };
  bundleTx: Hash;
}

const USER_OPERATION_EVENT = toEventSelector(
  "UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);

/** An impersonated bundler EOA, also the handleOps beneficiary. */
const BUNDLER: Address = "0x00000000000000000000000000000000000b0d1e";

function revertData(error: unknown): Hex {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const data = (current as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x")) return data as Hex;
    if (data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string") return (data as { data: Hex }).data;
    current = (current as { cause?: unknown }).cause;
  }
  return "0x";
}

function entryPointFailure(data: Hex): string {
  try {
    const decoded = decodeErrorResult({ abi: entryPoint06Abi, data });
    return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
  } catch {
    return data;
  }
}

/** Runs the operation's callData from the EntryPoint (deploying the account inside a snapshot first if needed). */
async function checkExecute(userOperation: UserOperationV06, deploying: boolean): Promise<BundledOperation["executeFromEntryPoint"]> {
  const snapshot = deploying ? await testClient.snapshot() : null;
  try {
    if (deploying) {
      const factory = userOperation.initCode.slice(0, 42) as Address;
      const factoryData = `0x${userOperation.initCode.slice(42)}` as Hex;
      await setEthBalance(BUNDLER, "10");
      const hash = await impersonatedWallet(BUNDLER).sendTransaction({ to: factory, data: factoryData });
      await forkClient.waitForTransactionReceipt({ hash });
    }
    await forkClient.call({ account: entryPoint06Address, to: userOperation.sender, data: userOperation.callData });
    return "ok";
  } catch (error) {
    return { reverted: revertData(error) };
  } finally {
    if (snapshot) await testClient.revert({ id: snapshot });
  }
}

/**
 * A bundler JSON-RPC transport for permissionless's smart account client:
 * gas estimates, `eth_sendUserOperation` (checked from the EntryPoint, then
 * submitted with `EntryPoint.handleOps` by an impersonated bundler) and
 * `eth_getUserOperationReceipt`. There is no paymaster on the fork, so the
 * account prefunds the EntryPoint itself.
 */
export function createForkBundler() {
  const operations: BundledOperation[] = [];

  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const args = (params ?? []) as unknown[];
    switch (method) {
      case "eth_chainId":
        return numberToHex(base.id);
      case "eth_supportedEntryPoints":
        return [entryPoint06Address];
      case "eth_estimateUserOperationGas": {
        const op = args[0] as { initCode?: Hex };
        const deploying = Boolean(op.initCode && op.initCode !== "0x");
        return {
          preVerificationGas: numberToHex(100_000),
          verificationGasLimit: numberToHex(deploying ? 1_500_000 : 400_000),
          callGasLimit: numberToHex(300_000),
        };
      }
      case "eth_sendUserOperation": {
        const formatted = formatUserOperation(args[0] as never) as UserOperation<"0.6">;
        const userOperation: UserOperationV06 = {
          sender: formatted.sender,
          nonce: formatted.nonce,
          initCode: formatted.initCode ?? "0x",
          callData: formatted.callData,
          callGasLimit: formatted.callGasLimit,
          verificationGasLimit: formatted.verificationGasLimit,
          preVerificationGas: formatted.preVerificationGas,
          maxFeePerGas: formatted.maxFeePerGas,
          maxPriorityFeePerGas: formatted.maxPriorityFeePerGas,
          paymasterAndData: formatted.paymasterAndData ?? "0x",
          signature: formatted.signature,
        };
        const entryPoint = args[1] as Address;
        if (entryPoint.toLowerCase() !== entryPoint06Address.toLowerCase()) throw new Error(`unexpected EntryPoint ${entryPoint}`);
        const deploying = userOperation.initCode !== "0x";
        const executeFromEntryPoint = await checkExecute(userOperation, deploying);
        const userOpHash = getUserOperationHash({ userOperation, entryPointAddress: entryPoint06Address, entryPointVersion: "0.6", chainId: base.id });
        await setEthBalance(userOperation.sender, "1");
        await setEthBalance(BUNDLER, "10");
        const data = encodeFunctionData({ abi: entryPoint06Abi, functionName: "handleOps", args: [[userOperation], BUNDLER] });
        // A bundler never submits an operation that fails validation: simulate first.
        try {
          await forkClient.call({ account: BUNDLER, to: entryPoint06Address, data, gas: 10_000_000n });
        } catch (error) {
          throw new Error(`handleOps would revert: ${entryPointFailure(revertData(error))}`);
        }
        const bundleTx = await impersonatedWallet(BUNDLER).sendTransaction({ to: entryPoint06Address, data, gas: 10_000_000n });
        await forkClient.waitForTransactionReceipt({ hash: bundleTx });
        operations.push({ userOperation, userOpHash, deploying, executeFromEntryPoint, bundleTx });
        return userOpHash;
      }
      case "eth_getUserOperationReceipt": {
        const op = operations.find((o) => o.userOpHash === args[0]);
        if (!op) return null;
        const receipt = (await forkClient.request({ method: "eth_getTransactionReceipt", params: [op.bundleTx] })) as {
          logs: { address: Address; topics: Hex[]; data: Hex }[];
        } & Record<string, unknown>;
        // UserOperationEvent, not AccountDeployed (which a deploying operation emits first, with the same indexed hash).
        const event = receipt.logs.find(
          (log) =>
            log.address.toLowerCase() === entryPoint06Address.toLowerCase() && log.topics[0] === USER_OPERATION_EVENT && log.topics[1] === op.userOpHash,
        );
        if (!event) throw new Error("no UserOperationEvent for the operation");
        const words = event.data.slice(2).match(/.{64}/g) ?? [];
        return {
          userOpHash: op.userOpHash,
          entryPoint: entryPoint06Address,
          sender: op.userOperation.sender,
          nonce: numberToHex(op.userOperation.nonce),
          paymaster: `0x${(event.topics[3] ?? "").slice(26)}`,
          actualGasCost: `0x${words[2] ?? "0"}`,
          actualGasUsed: `0x${words[3] ?? "0"}`,
          success: BigInt(`0x${words[1] ?? "0"}`) === 1n,
          logs: receipt.logs,
          receipt,
        };
      }
      case "eth_getUserOperationByHash":
        return null;
      default:
        throw new Error(`fork bundler: unsupported method ${method}`);
    }
  };

  return { transport: custom({ request }), request, operations };
}

export type ForkBundler = ReturnType<typeof createForkBundler>;

/** The fork bundler's HTTP port (kept in 8560-8569, beside anvil's). */
export const BUNDLER_PORT = Number(process.env.SEND_FORK_BUNDLER_PORT ?? "8561");

/**
 * The fork bundler behind a real HTTP JSON-RPC endpoint, so the smart account
 * client meets genuine viem HTTP errors (which carry the request body), as
 * with Privy's CDP bundler. `loseNextSendAnswer()` makes the next
 * `eth_sendUserOperation` land on the fork and then answer HTTP 502, as a
 * bundler or proxy failing after accepting the operation would.
 */
export async function serveForkBundler(bundler: ForkBundler, port = BUNDLER_PORT) {
  let loseNext = false;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      void (async () => {
        const body = JSON.parse(raw) as { id: number; method: string; params?: unknown[] };
        const lose = body.method === "eth_sendUserOperation" && loseNext;
        if (lose) loseNext = false;
        let reply: unknown;
        try {
          reply = { jsonrpc: "2.0", id: body.id, result: await bundler.request({ method: body.method, params: body.params }) };
        } catch (error) {
          reply = { jsonrpc: "2.0", id: body.id, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } };
        }
        if (lose) {
          res.writeHead(502, { "content-type": "text/plain" }).end("Bad Gateway");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port}`,
    loseNextSendAnswer: () => {
      loseNext = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Coinbase Smart Wallet `execute` / `executeBatch`, to read back what an operation runs. */
export const coinbaseSmartWalletAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;
