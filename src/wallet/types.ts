import type { Address, Hash, Hex, PublicClient, TransactionReceipt, WalletClient } from "viem";

/** One call in a transaction batch. */
export interface WalletCall {
  to: Address;
  data?: Hex;
  value?: bigint;
}

export type WalletKind = "smart" | "embedded" | "external";

/** What a smart wallet's bundler says about one of its user operations. */
export type UserOperationStatus =
  /** On Base, in `transactionHash`; `success` false means it reverted and its calls did nothing. */
  | { status: "included"; success: boolean; transactionHash: Hash }
  /** Accepted and not on Base yet: it can still go through. */
  | { status: "queued" }
  /** The bundler has no record of it (dropped, or never accepted). */
  | { status: "absent" }
  /** The lookup failed. */
  | { status: "unknown" };

/**
 * What the Peer flows need from whichever wallet the player logged in with.
 * Implemented by `src/wallet` for Privy smart wallets (batched, gas
 * sponsored), Privy embedded EOAs and external injected/WalletConnect wallets.
 */
export interface TxSender {
  /** The address that will be `msg.sender` for every call. */
  address: Address;
  kind: WalletKind;
  /** True when the app pays gas for this wallet. */
  sponsored: boolean;
  /**
   * Sends the calls (atomically as one user operation when the wallet supports
   * batching, otherwise sequentially) and resolves with the receipt of the
   * transaction that contains the final call, only once that call succeeded.
   *
   * When that transaction is an ERC-4337 bundle (smart wallet, Privy-sponsored
   * embedded wallet, smart-contract external wallet), `transactionHash` and
   * `status` are the bundle's but `logs` are narrowed to the caller's own user
   * operation, so other accounts' events in the same bundle never appear. A
   * user operation that reverted inside a successful bundle rejects with
   * `TransactionRevertedError`, never resolves.
   */
  sendCalls(calls: WalletCall[], opts?: { label?: string }): Promise<TransactionReceipt>;
  /**
   * Smart wallets only: asks the wallet's bundler about a user operation, to
   * settle a send whose outcome was lost (see `userOperationHashIn`).
   */
  userOperationStatus?(hash: Hash): Promise<UserOperationStatus>;
  /** Signs an EIP-191 message (used to prove wallet ownership to the game API). */
  signMessage(message: string): Promise<Hex>;
  /**
   * A viem WalletClient whose `account.address` equals `address`. The Peer
   * SDK reads the account address (for example as the `/v3/sign` caller) but
   * this app always submits through `sendCalls`, never through this client.
   */
  walletClient: WalletClient;
}

export interface WalletState {
  ready: boolean;
  authenticated: boolean;
  sender: TxSender | null;
  publicClient: PublicClient;
  login(): void;
  logout(): Promise<void>;
}
