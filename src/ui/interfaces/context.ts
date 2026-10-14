import { createContext, useContext, type ComponentType } from "react";
import type { PublicClient } from "viem";
import type { StallSummary } from "@shared/protocol";
import type { TxSender } from "@/wallet/types";

/**
 * Contract between the game shell (src/app) and the trading interfaces
 * (src/ui/interfaces). The shell owns networking, the engine and the wallet;
 * interfaces get everything they need through `useGame()` and never import
 * the engine or the realtime client directly.
 */

export type SoundName = "click" | "offer" | "collect" | "coins" | "levelup" | "trade" | "error" | "open" | "close";

/** A merchant NPC represents the live order book for one platform and currency. */
export interface MerchantTarget {
  kind: "merchant";
  merchantId: string;
  name: string;
  platform: string;
  currency: string;
  /**
   * The fiat amount (display units of `currency`, e.g. 102 for 102 GBP) the
   * merchant's shout was quoted at. The trade window opens at it so the first
   * quote matches the advertised rate. Absent when the shell has no quote.
   */
  fiatAmount?: number;
}

/** A player in the room advertising one of their live deposits. */
export interface StallTarget {
  kind: "stall";
  pid: string;
  name: string;
  stall: StallSummary;
}

export type TradeTarget = MerchantTarget | StallTarget;

export type OpenInterface =
  /** Your sell orders (deposits) as bank items, plus Deposit to start a sale. */
  | { id: "bank" }
  /** Grand Exchange-style offers: buy (and links to sell). */
  | { id: "exchange"; side?: "buy" | "sell"; platform?: string; currency?: string }
  /** Two-screen trade window against a merchant or a player's stall. */
  | { id: "trade"; target: TradeTarget }
  /** Instructions for the active buy order (the practice order's with `practice`). */
  | { id: "payment"; practice?: true }
  /** Peer extension verification of the active buy order (the practice order's with `practice`). */
  | { id: "verify"; practice?: true }
  /**
   * A practice trade: the trade window, Payment scroll and Verify on a
   * simulated seller, wallet and extension. No money moves, nothing reaches
   * the chain and nothing is written to the world.
   */
  | { id: "practice" }
  /** Create a sell order (deposit). */
  | { id: "sell"; platform?: string; currency?: string }
  /** Completed and cancelled orders. */
  | { id: "collection" }
  /** Send USDC from the wallet to any address on Base. */
  | { id: "send" }
  /** The wallet's address (with a QR code) for receiving USDC on Base. */
  | { id: "receive" }
  /** Banker chat-head dialogue. */
  | { id: "dialogue"; npc: "banker" | "merchant"; name: string; merchant?: MerchantTarget }
  /** First-visit welcome from the door banker, explaining buying and selling. */
  | { id: "intro" }
  | { id: "how-it-works" }
  | { id: "terms" };

export type InterfaceId = OpenInterface["id"];

/**
 * Whose chathead a dialogue line shows: the banker the player is talking to
 * (the shell knows which booth), a cache NPC by id, a player in the room by
 * pid (the local player's own look for their lines), or a hall merchant.
 */
export type ChatheadSubject = { npc: "banker" } | { npcId: number } | { pid: string } | { merchantId: string };

/** A chathead drawn into a container; dispose() frees it (its GL work is shared with every other preview). */
export interface ChatheadHandle {
  dispose(): void;
}

export interface ChatheadOptions {
  /** Called if the head can't be drawn after all (no WebGL, or the model failed); the container stays empty. */
  onFail?: () => void;
}

export interface GameMe {
  pid: string;
  name: string;
  /** Wallet proven to the game server (needed for stalls and announcements). */
  verifiedWallet: string | null;
}

export interface GameContextValue {
  /** Wallet that will send transactions, once logged in and ready. */
  sender: TxSender | null;
  walletReady: boolean;
  /** Opens the Privy login. */
  login(): void;
  publicClient: PublicClient;
  me: GameMe | null;

  open(target: OpenInterface): void;
  close(): void;

  /** Black game message in the chatbox ("Your offer has been placed."). */
  message(text: string): void;
  playSound(name: SoundName): void;
  /** Fireworks around the local player. */
  celebrate(): void;

  /**
   * Proves wallet ownership to the game server if needed (signs a message),
   * then broadcasts a verified world event for this transaction.
   */
  announce(kind: "bought" | "listed", txHash: string): Promise<void>;
  /** Advertise (or clear) one of your deposits as a stall in the room. */
  setStall(depositId: string | null): Promise<void>;
  /** Currently advertised deposit id, if any. */
  stallDepositId: string | null;
  /**
   * Upper-case fiat codes with live liquidity on a payment method the buy
   * flow can trade, from the latest market book (GET /api/market). Null until
   * the market has loaded; undefined where no shell provides it (dev
   * harnesses). Either way, treat every currency as possibly liquid. A
   * currency missing from a partial market response is also absent here.
   */
  liquidCurrencies?: ReadonlySet<string> | null;
  /**
   * Draws `who`'s chathead (head and shoulders, facing front) into
   * `container`, filling it, through the character runtime's one shared
   * preview context. Returns null when it can't (the runtime isn't loaded,
   * or the player's look is unknown); absent where no shell provides it.
   */
  renderChathead?(container: HTMLElement, who: ChatheadSubject, options?: ChatheadOptions): ChatheadHandle | null;
}

export const GameContext = createContext<GameContextValue | null>(null);

export function useGame(): GameContextValue {
  const value = useContext(GameContext);
  if (!value) throw new Error("useGame() must be used inside <GameContext.Provider>");
  return value;
}

/** Props every interface component receives: its own open descriptor. */
export interface InterfaceProps<I extends InterfaceId = InterfaceId> {
  open: Extract<OpenInterface, { id: I }>;
}

export type InterfaceComponent<I extends InterfaceId = InterfaceId> = ComponentType<InterfaceProps<I>>;

/**
 * Each folder under src/ui/interfaces/ (buy, bank, dialogue, ...) has an
 * index.ts exporting `interfaces`. The shell discovers them with
 * import.meta.glob and renders the component registered for the open id, so
 * interface folders never import each other or the shell.
 */
export interface InterfaceModule {
  interfaces: { [K in InterfaceId]?: InterfaceComponent<K> };
}
