import { isHash, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";
import { report, track } from "@/lib/telemetry";
import { RECEIPT_TIMEOUT_MS, WALLET_CHAIN } from "./constants";
import {
  ChainSwitchError,
  InsufficientGasError,
  PopupBlockedError,
  SponsorshipError,
  TransactionPendingError,
  UserRejectedError,
  WalletBusyError,
  WalletError,
  isSponsorshipUnavailable,
  stackFrames,
  toWalletError,
  userOperationSubmission,
} from "./errors";
import {
  createRoutedProvider,
  personalSignPayload,
  signTypedDataWith,
  walletClientFor,
  type Eip1193Like,
  type TypedDataPayload,
} from "./provider";
import {
  assertHash,
  normalizeCalls,
  sendSequentially,
  waitForSuccessfulReceipt,
  type NormalizedCall,
  type ReceiptSource,
} from "./sequence";
import type { TxSender, UserOperationStatus, WalletCall, WalletKind } from "./types";

/** Chain reads every sender needs. `publicClient` satisfies it. */
export interface ChainReader extends ReceiptSource {
  getBalance(args: { address: Address }): Promise<bigint>;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export interface SenderEnvironment {
  reader: ChainReader;
  /** Called after every sendCalls attempt (success or failure), e.g. to refresh balances. */
  onSettled?: () => void;
  receiptTimeoutMs?: number;
}

/** A JSON-RPC request to the smart wallet's bundler. */
export type BundlerRequest = (args: { method: "eth_getUserOperationReceipt" | "eth_getUserOperationByHash"; params: [Hash] }) => Promise<unknown>;

/** Privy smart wallet (Coinbase Smart Wallet on Base) with paymaster-sponsored gas. */
export interface SmartWalletAdapter {
  /** Submits all calls as ONE user operation and resolves with the bundle transaction hash. */
  sendBatch(calls: NormalizedCall[], label: string | undefined): Promise<Hash>;
  signMessage(message: string | { raw: Hex }): Promise<Hex>;
  signTypedData(payload: TypedDataPayload): Promise<Hex>;
  /** The wallet's bundler, for looking up a user operation whose outcome was lost. */
  bundlerRequest?: BundlerRequest;
}

/** Privy embedded EOA, sent through Privy's `useSendTransaction`. */
export interface EmbeddedWalletAdapter {
  send(call: NormalizedCall, options: { sponsor: boolean; label: string | undefined }): Promise<Hash>;
  /** The embedded wallet's EIP-1193 provider, used for signing. */
  getProvider(): Promise<Eip1193Like>;
}

/** An external wallet (injected, WalletConnect, Coinbase/Base Account) connected through Privy. */
export interface ExternalWalletAdapter {
  getProvider(): Promise<Eip1193Like>;
  /** Asks the wallet to switch to Base (Privy's `ConnectedWallet.switchChain`). */
  switchToBase(): Promise<void>;
}

/** A Peer account wallet reached through Privy cross-app requests (each request opens a Peer window). */
export interface CrossAppWalletAdapter {
  send(call: NormalizedCall): Promise<Hash>;
  signMessage(message: string): Promise<Hex>;
  signTypedData(payload: TypedDataPayload): Promise<Hex>;
}

export type GestureRequester = <T>(label: string, run: () => Promise<T>) => Promise<T>;

interface SenderCore {
  address: Address;
  kind: WalletKind;
  sponsored: boolean;
  sendCalls(calls: NormalizedCall[], label: string | undefined): Promise<TransactionReceipt>;
  userOperationStatus?(hash: Hash): Promise<UserOperationStatus>;
  signMessage(message: SignableText): Promise<Hex>;
  signTypedData(payload: TypedDataPayload): Promise<Hex>;
}

/** Text, or raw bytes as hex (EIP-191 `personal_sign` payload). */
type SignableText = string | { raw: Hex };

const inFlight = new Set<string>();

/**
 * One wallet interaction per address at a time. A double click or a second
 * flow starting while a prompt is open would otherwise queue a duplicate
 * transaction behind the first.
 */
async function exclusive<T>(address: Address, run: () => Promise<T>): Promise<T> {
  const key = address.toLowerCase();
  if (inFlight.has(key)) throw new WalletBusyError();
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Counts a sponsored send the paymaster refused for launch telemetry, and
 * reports what it said (`SponsorshipError.reason`, URLs already removed),
 * which tells a policy or allowlist refusal from an outage.
 */
function reportSponsorshipFailure(error: SponsorshipError): void {
  track("gas_fail");
  report({ name: error.name, message: error.reason ?? error.message, stack: stackFrames(error.cause) ?? stackFrames(error) }, "sponsorship");
}

function finishSender(core: SenderCore, env: SenderEnvironment): TxSender {
  const sendCalls = async (calls: WalletCall[], opts?: { label?: string }): Promise<TransactionReceipt> => {
    const normalized = normalizeCalls(calls);
    try {
      return await exclusive(core.address, () => core.sendCalls(normalized, opts?.label));
    } catch (error) {
      const mapped = toWalletError(error, { sending: true });
      if (core.sponsored && mapped instanceof SponsorshipError) reportSponsorshipFailure(mapped);
      throw mapped;
    } finally {
      env.onSettled?.();
    }
  };
  const signMessage = async (message: SignableText): Promise<Hex> => {
    try {
      return await exclusive(core.address, () => core.signMessage(message));
    } catch (error) {
      throw toWalletError(error);
    }
  };
  const signTypedData = async (payload: TypedDataPayload): Promise<Hex> => {
    try {
      return await exclusive(core.address, () => core.signTypedData(payload));
    } catch (error) {
      throw toWalletError(error);
    }
  };
  const provider = createRoutedProvider({
    address: core.address,
    signMessage: (hex) => signMessage(personalSignPayload(hex)),
    signTypedData,
    sendTransaction: async (call) => (await sendCalls([call])).transactionHash,
    read: (method, params) => env.reader.request({ method, params }),
  });
  return {
    address: core.address,
    kind: core.kind,
    sponsored: core.sponsored,
    sendCalls,
    ...(core.userOperationStatus ? { userOperationStatus: core.userOperationStatus } : {}),
    signMessage,
    walletClient: walletClientFor(core.address, provider),
  };
}

/**
 * Asks a bundler how a user operation ended (ERC-4337 JSON-RPC): its receipt
 * once it is on Base, otherwise whether the bundler still holds it. Never
 * throws: a failed lookup is `unknown`, which counts as possibly queued.
 */
export async function userOperationStatus(request: BundlerRequest, hash: Hash): Promise<UserOperationStatus> {
  try {
    const receipt = (await request({ method: "eth_getUserOperationReceipt", params: [hash] })) as {
      success?: unknown;
      receipt?: { transactionHash?: unknown };
    } | null;
    const transactionHash = receipt?.receipt?.transactionHash;
    if (receipt && typeof transactionHash === "string" && isHash(transactionHash)) {
      return { status: "included", success: receipt.success === true, transactionHash };
    }
    const operation = await request({ method: "eth_getUserOperationByHash", params: [hash] });
    return operation ? { status: "queued" } : { status: "absent" };
  } catch {
    return { status: "unknown" };
  }
}

/**
 * Every sender checks the EntryPoint outcome, not only `receipt.status`: a
 * Privy-sponsored embedded send is an EIP-7702 user operation and a Coinbase
 * Smart Wallet or Base Account connected as an external wallet bundles too, so
 * an inner revert can sit inside a successful transaction. A plain EOA
 * transaction has no UserOperationEvent for the sender and is judged by status.
 */
function receiptWaiter(env: SenderEnvironment, sender: Address, requireUserOperation = false) {
  return (hash: Hash) =>
    waitForSuccessfulReceipt(env.reader, hash, {
      sender,
      requireUserOperation,
      timeoutMs: env.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS,
    });
}

async function assertHasGas(reader: ChainReader, address: Address): Promise<void> {
  let balance: bigint;
  try {
    balance = await reader.getBalance({ address });
  } catch (error) {
    // Raised before anything is sent; kept typed so it is not mistaken for a wallet timeout mid-send.
    throw new WalletError("unknown", "Could not check your ETH balance on Base. Try again in a moment.", {
      cause: error,
      mayHaveLanded: false,
    });
  }
  if (balance === 0n) throw new InsufficientGasError(address);
}

/**
 * Maps a failed smart-wallet send by how far it got (`userOperationSubmission`).
 * Before the bundler accepted the user operation nothing exists that could
 * land, so the real reason is reported (`mayHaveLanded` false) and the request
 * can be retried at once. Once it was submitted, or when the submission's
 * answer was lost, only the chain can tell, so the outcome stays unknown.
 *
 * The EntryPoint nonce cannot settle this instead: viem picks a fresh nonce
 * key (Date.now()) for every user operation, so no fixed key's nonce moves.
 * Relies on Privy's headless smart-wallet send passing permissionless/viem
 * errors through with their cause chain (true of @privy-io/react-auth 3.48).
 */
function smartSendError(error: unknown): WalletError {
  if (userOperationSubmission(error) !== "not_submitted") {
    const walletError = toWalletError(error, { sending: true });
    return walletError.mayHaveLanded ? walletError : new TransactionPendingError(null, { cause: error });
  }
  const walletError = toWalletError(error);
  // A smart account never holds gas money here: "insufficient funds" means the paymaster declined.
  if (walletError instanceof InsufficientGasError) return new SponsorshipError({ cause: error });
  return walletError;
}

export function createSmartSender(address: Address, adapter: SmartWalletAdapter, env: SenderEnvironment): TxSender {
  const waitForReceipt = receiptWaiter(env, address, true);
  const bundler = adapter.bundlerRequest;
  return finishSender(
    {
      address,
      kind: "smart",
      sponsored: true,
      async sendCalls(calls, label) {
        let submitted: Hash;
        try {
          submitted = await adapter.sendBatch(calls, label);
        } catch (error) {
          throw smartSendError(error);
        }
        // The user operation was submitted, so a missing hash is an unknown outcome (assertHash says so).
        return waitForReceipt(assertHash(submitted));
      },
      ...(bundler ? { userOperationStatus: (hash: Hash) => userOperationStatus(bundler, hash) } : {}),
      signMessage: (message) => adapter.signMessage(message),
      signTypedData: (payload) => adapter.signTypedData(payload),
    },
    env,
  );
}

export function createEmbeddedSender(
  address: Address,
  adapter: EmbeddedWalletAdapter,
  options: { sponsored: boolean },
  env: SenderEnvironment,
): TxSender {
  const waitForReceipt = receiptWaiter(env, address);
  const signer = async () => walletClientFor(address, await adapter.getProvider());
  return finishSender(
    {
      address,
      kind: "embedded",
      sponsored: options.sponsored,
      async sendCalls(calls, label) {
        let sponsor = options.sponsored;
        if (!sponsor) await assertHasGas(env.reader, address);
        return sendSequentially({
          calls,
          waitForReceipt,
          sendOne: async (call) => {
            if (!sponsor) return assertHash(await adapter.send(call, { sponsor: false, label }));
            try {
              return assertHash(await adapter.send(call, { sponsor: true, label }));
            } catch (error) {
              // Privy refuses sponsorship for this wallet before anything is broadcast;
              // fall back to the wallet paying its own gas when it can.
              if (!isSponsorshipUnavailable(error)) throw error;
              sponsor = false;
              await assertHasGas(env.reader, address);
              return assertHash(await adapter.send(call, { sponsor: false, label }));
            }
          },
        });
      },
      signMessage: async (message) => (await signer()).signMessage({ account: address, message }),
      signTypedData: async (payload) => signTypedDataWith(await signer(), address, payload),
    },
    env,
  );
}

async function readChainId(provider: Eip1193Like): Promise<number> {
  const raw = await provider.request({ method: "eth_chainId" });
  return typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
}

/** Returns a provider that is on Base, switching the wallet first if needed. */
export async function ensureBaseProvider(adapter: ExternalWalletAdapter): Promise<Eip1193Like> {
  const provider = await adapter.getProvider();
  if ((await readChainId(provider)) === WALLET_CHAIN.id) return provider;
  try {
    await adapter.switchToBase();
  } catch (error) {
    const walletError = toWalletError(error);
    if (walletError instanceof UserRejectedError) throw walletError;
    throw new ChainSwitchError({ cause: error });
  }
  // Privy hands out a fresh provider after a switch; the old instance can keep the old chain.
  const switched = await adapter.getProvider();
  if ((await readChainId(switched)) !== WALLET_CHAIN.id) throw new ChainSwitchError();
  return switched;
}

export function createExternalSender(address: Address, adapter: ExternalWalletAdapter, env: SenderEnvironment): TxSender {
  const waitForReceipt = receiptWaiter(env, address);
  return finishSender(
    {
      address,
      kind: "external",
      sponsored: false,
      async sendCalls(calls) {
        await assertHasGas(env.reader, address);
        return sendSequentially({
          calls,
          waitForReceipt,
          sendOne: async (call) => {
            const client = walletClientFor(address, await ensureBaseProvider(adapter));
            return assertHash(
              await client.sendTransaction({
                account: address,
                chain: WALLET_CHAIN,
                to: call.to,
                data: call.data,
                value: call.value,
              }),
            );
          },
        });
      },
      signMessage: async (message) => walletClientFor(address, await adapter.getProvider()).signMessage({ account: address, message }),
      signTypedData: async (payload) =>
        // Wallets such as MetaMask refuse typed data whose domain chain is not the active chain.
        signTypedDataWith(walletClientFor(address, await ensureBaseProvider(adapter)), address, payload),
    },
    env,
  );
}

/**
 * Retries a cross-app request inside a fresh click when the browser blocked
 * its window. Only a blocked window is retried: it never reached the provider,
 * so the retry cannot duplicate a transaction.
 */
async function withGesture<T>(
  requestGesture: GestureRequester,
  label: string,
  sending: boolean,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(toWalletError(error, { sending }) instanceof PopupBlockedError)) throw error;
    return requestGesture(label, async () => {
      try {
        return await run();
      } catch (retryError) {
        throw toWalletError(retryError, { sending });
      }
    });
  }
}

export function createCrossAppSender(
  address: Address,
  adapter: CrossAppWalletAdapter,
  requestGesture: GestureRequester,
  env: SenderEnvironment,
): TxSender {
  const waitForReceipt = receiptWaiter(env, address);
  return finishSender(
    {
      address,
      kind: "external",
      sponsored: false,
      async sendCalls(calls, label) {
        await assertHasGas(env.reader, address);
        return sendSequentially({
          calls,
          waitForReceipt,
          sendOne: (call, index) =>
            withGesture(requestGesture, stepLabel(label, index, calls.length), true, async () =>
              assertHash(await adapter.send(call)),
            ),
        });
      },
      signMessage: (message) =>
        withGesture(requestGesture, "Sign with your Peer wallet", false, () =>
          adapter.signMessage(typeof message === "string" ? message : message.raw),
        ),
      signTypedData: (payload) =>
        withGesture(requestGesture, "Sign with your Peer wallet", false, () => adapter.signTypedData(payload)),
    },
    env,
  );
}

function stepLabel(label: string | undefined, index: number, total: number): string {
  const base = label ?? "Confirm the transaction";
  return total > 1 ? `${base} (step ${index + 1} of ${total})` : base;
}
