/**
 * The anvil Base fork for the UI e2e: start/stop, reset to the latest block,
 * the fork-only witness registration, account funding, time travel and the
 * on-chain reads the scenarios assert against. Port 8551 by default (the
 * range 8550-8559 is reserved for this work; 8547 belongs to other suites).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getContracts } from "@zkp2p/sdk";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";

export const ORCHESTRATOR: Address = "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7";
export const ESCROW: Address = "0x777777779d229cdF3110e9de47943791c26300Ef";
export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const REFERRER: Address = "0xC141Cbe4f4a9CAbc3cc78159a9268a4e008922CD";
/** contracts-v2 addresses/base.json UnifiedPaymentVerifierV3; checked against the registry below. */
export const UPV3: Address = "0xC6F4a193576C60892a47e111Bb5706c30162502B";

const contracts = getContracts(8453, "production");
export const ABIS = {
  orchestrator: contracts.abis.orchestratorV3!,
  escrow: (contracts.abis.escrowV2 ?? contracts.abis.escrow)!,
};

const REGISTRY_ABI = parseAbi([
  "function paymentVerifierRegistry() view returns (address)",
  "function getVerifier(bytes32) view returns (address)",
]);
const VERIFIER_ABI = parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)", "function attestationVerifier() view returns (address)"]);
const ADD_FUNDS_ABI = parseAbi(["function addFunds(uint256 _depositId, uint256 _amount)"]);
/** Large Base USDC holders (EOAs and contracts) used to fund fork-only top-ups. */
const USDC_HOLDERS: readonly Address[] = [
  "0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A",
  "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A",
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
];
const MAV_ABI = parseAbi([
  "function owner() view returns (address)",
  "function addWitness(address)",
  "function isWitness(address) view returns (bool)",
  "function requiredSignatures() view returns (uint256)",
]);

/** The Base mainnet RPC the fork is taken from (archive-capable; usually carries an API key, so never printed). */
export function upstreamRpcUrl(): string {
  const url = process.env.FORK_UPSTREAM_RPC_URL?.trim();
  if (!url) throw new Error("No upstream Base RPC: set FORK_UPSTREAM_RPC_URL to an archive-capable Base mainnet RPC URL.");
  return url;
}

export class Fork {
  readonly url: string;
  readonly client;
  readonly test;
  private proc: ChildProcess | null = null;

  constructor(readonly port: number) {
    if (port < 8550 || port > 8559) throw new Error("fork port must be 8550-8559");
    this.url = `http://127.0.0.1:${port}`;
    const transport = http(this.url, { retryCount: 0, timeout: 120_000 });
    this.client = createPublicClient({ chain: base, transport });
    this.test = createTestClient({ chain: base, mode: "anvil", transport });
  }

  async start(): Promise<void> {
    const upstream = upstreamRpcUrl();
    const anvil = existsSync(join(homedir(), ".foundry/bin/anvil")) ? join(homedir(), ".foundry/bin/anvil") : "anvil";
    this.proc = spawn(anvil, ["--fork-url", upstream, "--port", String(this.port), "--auto-impersonate", "--silent", "--host", "127.0.0.1"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    this.proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) throw new Error(`anvil exited: ${stderr.split(upstream).join("<upstream>").slice(0, 400)}`);
      try {
        if ((await this.client.getChainId()) === 8453) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("anvil did not start within 90 s");
  }

  async stop(): Promise<void> {
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }

  /** Back to the live chain head, so Curator's quotes and signatures match the fork's deposits and clock. */
  async resetToLatest(): Promise<bigint> {
    await this.test.reset({ jsonRpcUrl: upstreamRpcUrl() });
    // A reset drops --auto-impersonate; the buyer and the verifier owner send unsigned.
    await this.client.request({ method: "anvil_autoImpersonateAccount" as never, params: [true] as never });
    return this.client.getBlockNumber();
  }

  async setEth(address: Address, ether = "1"): Promise<void> {
    await this.test.setBalance({ address, value: parseEther(ether) });
  }

  async send(from: Address, to: Address, data: Hex): Promise<TransactionReceipt> {
    await this.setEth(from, "1");
    const wallet = createWalletClient({ account: from, chain: base, transport: http(this.url) });
    const hash = await wallet.sendTransaction({ account: from, to, data, chain: base });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`fork tx ${hash} reverted`);
    return receipt;
  }

  /** The verifier and attestation verifier routing Revolut proofs on this fork. */
  async revolutVerifier(): Promise<{ verifier: Address; attestationVerifier: Address; domainSeparator: Hex }> {
    const registry = await this.client.readContract({ address: ORCHESTRATOR, abi: REGISTRY_ABI, functionName: "paymentVerifierRegistry" });
    const verifier = await this.client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "getVerifier", args: [keccak256(stringToHex("revolut"))] });
    const [attestationVerifier, domainSeparator] = await Promise.all([
      this.client.readContract({ address: verifier, abi: VERIFIER_ABI, functionName: "attestationVerifier" }),
      this.client.readContract({ address: verifier, abi: VERIFIER_ABI, functionName: "DOMAIN_SEPARATOR" }),
    ]);
    return { verifier, attestationVerifier, domainSeparator };
  }

  /**
   * FORK ONLY. Adds a local witness to the MultiAttestationVerifier by
   * impersonating its owner: the least invasive change that makes a locally
   * signed attestation acceptable (threshold stays as deployed).
   */
  async trustWitness(attestationVerifier: Address, witness: Address): Promise<{ owner: Address; threshold: bigint }> {
    const owner = await this.client.readContract({ address: attestationVerifier, abi: MAV_ABI, functionName: "owner" });
    const threshold = await this.client.readContract({ address: attestationVerifier, abi: MAV_ABI, functionName: "requiredSignatures" });
    const already = await this.client.readContract({ address: attestationVerifier, abi: MAV_ABI, functionName: "isWitness", args: [witness] });
    if (!already) {
      const { encodeFunctionData } = await import("viem");
      await this.send(owner, attestationVerifier, encodeFunctionData({ abi: MAV_ABI, functionName: "addWitness", args: [witness] }));
    }
    const trusted = await this.client.readContract({ address: attestationVerifier, abi: MAV_ABI, functionName: "isWitness", args: [witness] });
    if (!trusted) throw new Error("witness was not added on the fork");
    return { owner, threshold };
  }

  /**
   * FORK ONLY. Adds USDC to a seller's deposit from a USDC holder (EscrowV2.addFunds is open to
   * any payer), standing in for the seller topping up after a fill, so the fork's deposit again
   * matches the liquidity Curator still quotes from Base.
   */
  async topUpDeposit(depositId: bigint, amount: bigint): Promise<void> {
    for (const whale of USDC_HOLDERS) {
      if ((await this.usdc(whale)) < amount) continue;
      const { encodeFunctionData } = await import("viem");
      await this.send(whale, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ESCROW, amount] }));
      await this.send(whale, ESCROW, encodeFunctionData({ abi: ADD_FUNDS_ABI, functionName: "addFunds", args: [depositId, amount] }));
      return;
    }
    throw new Error("no USDC holder on the fork can fund the top-up");
  }

  async usdc(address: Address): Promise<bigint> {
    return this.client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  }

  async deposit(depositId: bigint): Promise<{ depositor: Address; remainingDeposits: bigint; outstandingIntentAmount: bigint }> {
    return (await this.client.readContract({ address: ESCROW, abi: ABIS.escrow, functionName: "getDeposit", args: [depositId] })) as {
      depositor: Address;
      remainingDeposits: bigint;
      outstandingIntentAmount: bigint;
    };
  }

  async intent(intentHash: Hex): Promise<{ owner: Address; to: Address; depositId: bigint; amount: bigint; timestamp: bigint; payeeId: Hex; referralFees: readonly { recipient: Address; fee: bigint }[] }> {
    return (await this.client.readContract({ address: ORCHESTRATOR, abi: ABIS.orchestrator, functionName: "getIntent", args: [intentHash] })) as never;
  }

  async lock(depositId: bigint, intentHash: Hex): Promise<{ intentHash: Hex; amount: bigint; expiryTime: bigint }> {
    return (await this.client.readContract({ address: ESCROW, abi: ABIS.escrow, functionName: "getDepositIntent", args: [depositId, intentHash] })) as never;
  }

  async receipt(hash: Hash): Promise<TransactionReceipt> {
    return this.client.getTransactionReceipt({ hash });
  }

  /**
   * USDC a signal returned to its deposit by pruning expired intents. EscrowV2.lockFunds
   * prunes them only when the deposit's remaining liquidity is short of the new intent, in
   * the same transaction (FundsUnlocked, plus IntentPruned from the orchestrator), and
   * Curator quotes that liquidity. A live deposit can hold an expired intent for hours
   * (deposit 4513 on 14 Oct 2026: 10 USDC, which broke every balance check by exactly that).
   */
  async prunedAtSignal(signalTx: Hash, depositId: bigint, intentHash: Hex): Promise<bigint> {
    const ev = events((await this.receipt(signalTx)).logs);
    const same = (h: Hex) => h.toLowerCase() === intentHash.toLowerCase();
    if (!ev.locked.some((e) => e.args.depositId === depositId && same(e.args.intentHash))) {
      throw new Error(`signal ${signalTx} did not lock ${intentHash} on deposit ${depositId}`);
    }
    const prunedHashes = new Set(ev.pruned.map((e) => e.args.intentHash.toLowerCase()));
    let pruned = 0n;
    for (const e of ev.released) {
      if (e.args.depositId !== depositId || same(e.args.intentHash)) continue;
      if (!prunedHashes.has(e.args.intentHash.toLowerCase())) throw new Error(`signal ${signalTx} unlocked ${e.args.intentHash} without pruning it`);
      pruned += e.args.amount;
    }
    return pruned;
  }

  async latestTimestamp(): Promise<number> {
    return Number((await this.client.getBlock({ blockTag: "latest" })).timestamp);
  }

  /** Moves the chain clock forward and mines, so block.timestamp follows. */
  async advance(seconds: number): Promise<void> {
    await this.test.increaseTime({ seconds });
    await this.test.mine({ blocks: 1 });
  }
}

/** The deployed OrchestratorV3 / EscrowV2 events the scenarios read (signatures as in the SDK's ABIs). */
const EVENTS = parseAbi([
  "event IntentSignaled(bytes32 indexed intentHash, address indexed escrow, uint256 indexed depositId, bytes32 paymentMethod, address owner, address to, uint256 amount, bytes32 fiatCurrency, uint256 conversionRate, uint256 timestamp)",
  "event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease)",
  "event IntentReferralFeeDistributed(bytes32 indexed intentHash, address indexed feeRecipient, uint256 feeAmount)",
  "event IntentPruned(bytes32 indexed intentHash)",
  "event FundsUnlockedAndTransferred(uint256 indexed depositId, bytes32 indexed intentHash, uint256 unlockedAmount, uint256 transferredAmount, address to)",
  "event FundsUnlocked(uint256 indexed depositId, bytes32 indexed intentHash, uint256 amount)",
  "event FundsLocked(uint256 indexed depositId, bytes32 indexed intentHash, uint256 amount, uint256 expiryTime)",
]);

export function events(logs: readonly Log[]) {
  const from = (address: Address) => [...logs].filter((l) => l.address.toLowerCase() === address.toLowerCase());
  return {
    signaled: parseEventLogs({ abi: EVENTS, logs: from(ORCHESTRATOR), eventName: "IntentSignaled" }),
    fulfilled: parseEventLogs({ abi: EVENTS, logs: from(ORCHESTRATOR), eventName: "IntentFulfilled" }),
    referral: parseEventLogs({ abi: EVENTS, logs: from(ORCHESTRATOR), eventName: "IntentReferralFeeDistributed" }),
    pruned: parseEventLogs({ abi: EVENTS, logs: from(ORCHESTRATOR), eventName: "IntentPruned" }),
    unlocked: parseEventLogs({ abi: EVENTS, logs: from(ESCROW), eventName: "FundsUnlockedAndTransferred" }),
    released: parseEventLogs({ abi: EVENTS, logs: from(ESCROW), eventName: "FundsUnlocked" }),
    locked: parseEventLogs({ abi: EVENTS, logs: from(ESCROW), eventName: "FundsLocked" }),
    transfers: parseEventLogs({ abi: erc20Abi, logs: from(USDC), eventName: "Transfer" }),
  };
}

/** A fresh random address (no key: anvil impersonates it). */
export function randomAddress(): Address {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Address;
}
