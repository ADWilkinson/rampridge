/**
 * Harness scenarios: a fixture wallet, a fake chain, the interface that opens
 * and the state it opens in, plus optional clicks, so every Send and Receive
 * state can be reached from a URL (`/dev/send.html?state=<id>`). Dev only.
 */

import type { Address, Hash } from "viem";
import { PEER_CONTRACTS } from "@/config";
import type { PendingSend } from "@/wallet/send";
import type { UserOperationStatus, WalletKind } from "@/wallet/types";
import type { OpenInterface } from "../../context";
import { initialSendState, type SendState } from "../model";
import { CONTRACT_RECIPIENT, USDC, type SendFault } from "./fakes";

export const PLAYER: Address = "0x2a9e8fa175F45b235efDdD97d2727741EF4Eee63";
export const FRIEND: Address = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

export interface ScenarioWallet {
  kind: WalletKind;
  sponsored: boolean;
  usdc: bigint;
  eth: bigint;
  /** The chain's balance when the send re-reads it, when it differs from what the window shows. */
  chainUsdc?: bigint;
}

export interface Scenario {
  id: string;
  group: "Form" | "Review" | "Send" | "Receive" | "Panels";
  label: string;
  open: OpenInterface | null;
  /** Null starts logged out. */
  wallet: ScenarioWallet | null;
  initial?: SendState;
  fault?: SendFault;
  sendDelayMs?: number;
  /** An unconfirmed send from an earlier session. */
  pending?: (now: number) => PendingSend;
  /** Transfers already on the chain. */
  landed?: { to: Address; value: bigint; hash: Hash }[];
  /** eth_getLogs fails (Base's public RPC). */
  historyDown?: boolean;
  /** What the smart wallet's bundler says about the pending user operation. */
  bundler?: UserOperationStatus;
  /** CSS selectors clicked in order once each is enabled. */
  autoClick?: string[];
  /** Side tab shown open (desktop) or as the sheet (phones). */
  side?: "inventory" | "account";
  /** Show the coins' Choose Option menu. */
  itemMenu?: boolean;
}

const SMART: ScenarioWallet = { kind: "smart", sponsored: true, usdc: USDC(125.4), eth: 0n };
const EXTERNAL: ScenarioWallet = { kind: "external", sponsored: false, usdc: USDC(830.25), eth: 2_000_000_000_000_000n };
const EXTERNAL_NO_GAS: ScenarioWallet = { kind: "external", sponsored: false, usdc: USDC(830.25), eth: 0n };
const EXTERNAL_LOW_GAS: ScenarioWallet = { kind: "external", sponsored: false, usdc: USDC(830.25), eth: 1_000_000_000_000n };

const SEND: OpenInterface = { id: "send" };
const draft = (amount: string, to: string) => initialSendState({ amount, to });
const review = (amount: bigint, to: Address = FRIEND): SendState => ({ amountText: "", toText: to, screen: { step: "review", amount, to } });
const CONFIRM = ["[data-send-confirm]"];
const PENDING_HASH = "0x7c1d2a1f0bd95e1b8f6e4c3a29d7c0f1e2b3a4958677889900aabbccddeeff00" as Hash;
const USER_OP_HASH = "0x5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a392817060" as Hash;
/** A smart-wallet send whose user operation timed out 12 minutes ago, before any transaction hash. */
const lostUserOp = (balanceBefore: bigint) => (now: number): PendingSend => ({
  from: PLAYER,
  to: FRIEND,
  amount: USDC(25),
  startedAt: now - 12 * 60_000,
  fromBlock: 40_999_000n,
  balanceBefore,
  hash: null,
  userOpHash: USER_OP_HASH,
});

export const SCENARIOS: Scenario[] = [
  { id: "form-empty", group: "Form", label: "Empty", open: SEND, wallet: SMART },
  { id: "form-filled", group: "Form", label: "Filled", open: SEND, wallet: SMART, initial: draft("25", FRIEND) },
  { id: "form-all", group: "Form", label: "All (exact balance)", open: SEND, wallet: { ...SMART, usdc: 125_401_999n }, initial: draft("125.401999", FRIEND) },
  { id: "form-checksum", group: "Form", label: "Bad checksum", open: SEND, wallet: SMART, initial: draft("25", FRIEND.replace("dA6", "da6")) },
  { id: "form-self", group: "Form", label: "Own address", open: SEND, wallet: SMART, initial: draft("25", PLAYER) },
  { id: "form-trap", group: "Form", label: "Escrow contract", open: SEND, wallet: SMART, initial: draft("25", PEER_CONTRACTS.EscrowV2) },
  { id: "form-name", group: "Form", label: ".eth name", open: SEND, wallet: SMART, initial: draft("25", "vitalik.eth") },
  { id: "form-too-much", group: "Form", label: "More than the balance", open: SEND, wallet: SMART, initial: draft("200", FRIEND) },
  { id: "form-contract", group: "Form", label: "Contract recipient", open: SEND, wallet: SMART, initial: draft("25", CONTRACT_RECIPIENT) },
  { id: "logged-out", group: "Form", label: "Logged out", open: SEND, wallet: null },

  { id: "review-smart", group: "Review", label: "Smart wallet (free)", open: SEND, wallet: SMART, initial: review(USDC(25)) },
  { id: "review-external", group: "Review", label: "External wallet (fee)", open: SEND, wallet: EXTERNAL, initial: review(USDC(25)) },
  { id: "review-no-gas", group: "Review", label: "External, no ETH", open: SEND, wallet: EXTERNAL_NO_GAS, initial: review(USDC(25)) },
  { id: "review-low-gas", group: "Review", label: "External, too little ETH", open: SEND, wallet: EXTERNAL_LOW_GAS, initial: review(USDC(25)) },
  { id: "review-contract", group: "Review", label: "Contract recipient", open: SEND, wallet: SMART, initial: review(USDC(25), CONTRACT_RECIPIENT) },

  { id: "sending", group: "Send", label: "Sending", open: SEND, wallet: SMART, initial: review(USDC(25)), sendDelayMs: 600_000, autoClick: CONFIRM },
  { id: "success", group: "Send", label: "Success", open: SEND, wallet: SMART, initial: review(USDC(25)), sendDelayMs: 1_200, autoClick: CONFIRM },
  { id: "rejected", group: "Send", label: "Rejected in wallet (back to review)", open: SEND, wallet: EXTERNAL, initial: review(USDC(25)), fault: "rejected", autoClick: CONFIRM },
  {
    id: "error-usdc",
    group: "Send",
    label: "Balance dropped before sending",
    open: SEND,
    wallet: { ...SMART, chainUsdc: USDC(10) },
    initial: review(USDC(25)),
    autoClick: CONFIRM,
  },
  { id: "error-gas", group: "Send", label: "No ETH for gas (wallet)", open: SEND, wallet: EXTERNAL, initial: review(USDC(25)), fault: "gas", autoClick: CONFIRM },
  { id: "error-sponsor", group: "Send", label: "Paymaster refused", open: SEND, wallet: SMART, initial: review(USDC(25)), fault: "sponsorship", autoClick: CONFIRM },
  { id: "error-reverted", group: "Send", label: "Reverted on-chain", open: SEND, wallet: EXTERNAL, initial: review(USDC(25)), fault: "reverted", autoClick: CONFIRM },
  { id: "error-chain", group: "Send", label: "Wrong network", open: SEND, wallet: EXTERNAL, initial: review(USDC(25)), fault: "chain", autoClick: CONFIRM },
  { id: "error-unknown", group: "Send", label: "Unknown error", open: SEND, wallet: SMART, initial: review(USDC(25)), fault: "unknown", autoClick: CONFIRM },
  { id: "unconfirmed", group: "Send", label: "Timed out (may have landed)", open: SEND, wallet: SMART, initial: review(USDC(25)), fault: "pending", autoClick: CONFIRM },
  {
    id: "unconfirmed-release",
    group: "Send",
    label: "Unconfirmed for 12 minutes",
    open: SEND,
    wallet: SMART,
    pending: (now) => ({ from: PLAYER, to: FRIEND, amount: USDC(25), startedAt: now - 12 * 60_000, fromBlock: 40_999_000n, balanceBefore: USDC(125.4), hash: PENDING_HASH, userOpHash: null }),
  },
  {
    id: "unconfirmed-dropped",
    group: "Send",
    label: "Unconfirmed, balance dropped (no resend)",
    open: SEND,
    wallet: SMART,
    pending: lostUserOp(USDC(150.4)),
  },
  {
    id: "unconfirmed-history-down",
    group: "Send",
    label: "Unconfirmed, history unreadable (no resend)",
    open: SEND,
    wallet: SMART,
    historyDown: true,
    pending: lostUserOp(USDC(125.4)),
  },
  {
    id: "unconfirmed-queued",
    group: "Send",
    label: "Unconfirmed, still queued at the bundler",
    open: SEND,
    wallet: SMART,
    bundler: { status: "queued" },
    pending: lostUserOp(USDC(125.4)),
  },
  {
    id: "unconfirmed-userop-landed",
    group: "Send",
    label: "Unconfirmed, the bundler has it landed",
    open: SEND,
    wallet: SMART,
    bundler: { status: "included", success: true, transactionHash: PENDING_HASH },
    pending: lostUserOp(USDC(150.4)),
  },
  {
    id: "unconfirmed-landed",
    group: "Send",
    label: "Unconfirmed, found on-chain",
    open: SEND,
    wallet: SMART,
    pending: (now) => ({ from: PLAYER, to: FRIEND, amount: USDC(25), startedAt: now - 90_000, fromBlock: 40_999_990n, balanceBefore: USDC(150.4), hash: null, userOpHash: null }),
    landed: [{ to: FRIEND, value: USDC(25), hash: PENDING_HASH }],
  },

  { id: "receive-smart", group: "Receive", label: "Smart wallet", open: { id: "receive" }, wallet: SMART },
  { id: "receive-external", group: "Receive", label: "External wallet", open: { id: "receive" }, wallet: EXTERNAL },

  { id: "account", group: "Panels", label: "Account tab", open: null, wallet: SMART, side: "account" },
  { id: "account-unverified", group: "Panels", label: "Account tab, unverified external", open: null, wallet: EXTERNAL, side: "account" },
  { id: "account-logged-out", group: "Panels", label: "Account tab, logged out", open: null, wallet: null, side: "account" },
  { id: "inventory-menu", group: "Panels", label: "Coins options", open: null, wallet: SMART, side: "inventory", itemMenu: true },
];

export function findScenario(id: string | null): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? (SCENARIOS[0] as Scenario);
}
