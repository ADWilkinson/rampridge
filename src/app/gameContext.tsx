import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { create } from "zustand";
import type { PlayerRecord } from "@shared/protocol";
import type { Engine } from "@/game";
import { postAct } from "@/net/actions";
import { ApiError } from "@/net/http";
import { getSession, proveWallet } from "@/net/session";
import { useMe, useWorldStore } from "@/net/store";
import { Dialogue, useEscapeLayer } from "@/ui/kit";
import {
  GameContext,
  type ChatheadHandle,
  type ChatheadOptions,
  type ChatheadSubject,
  type GameContextValue,
  type OpenInterface,
  type SoundName,
} from "@/ui/interfaces/context";
// Deep imports, not the "@/wallet" barrel: the barrel re-exports the Privy wallet stack, which loads later (./wallet).
import type { TxSender, WalletContextValue, WalletStatus } from "@/wallet";
import { WalletError, walletErrorMessage } from "@/wallet/errors";
import { bootStore, type GameRuntime } from "./boot";
import type { BuyBinding } from "./earlierWallet";
import { useMarketStore } from "./marketStore";
import { placementOf, useOpenInterface } from "./openInterface";
import { useSettingsStore } from "./settings";
import { uiSounds } from "./sound";
import { requestWalletLogin, useAppWallet } from "./wallet";

/**
 * The shell's implementation of the interface contract (useGame()):
 * wallet, identity, the one open interface, chatbox messages, sounds,
 * fireworks, verified world announcements and stalls.
 */

const SERVER_UNREACHABLE = "The RampRidge server isn't responding. Try again in a moment.";

/** Plain-English text for anything the network or wallet layers throw. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message === "Request failed." ? SERVER_UNREACHABLE : err.message;
  if (err instanceof WalletError) return walletErrorMessage(err);
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Try again.";
}

function isUserRejection(err: unknown): boolean {
  return err instanceof WalletError && err.code === "user_rejected";
}

export function gameMessage(text: string): void {
  useWorldStore.getState().addGameMessage(text);
}

export function playSound(name: SoundName): void {
  uiSounds.play(name);
}

/** Opens an interface in place of any other; the open sound plays only when a window appears over the world. */
export function openInterface(target: OpenInterface): void {
  const current = useOpenInterface.getState().current;
  if (placementOf(target.id) === "window" && (!current || placementOf(current.id) !== "window")) uiSounds.play("open");
  useOpenInterface.getState().set(target);
}

export function closeInterface(): void {
  const current = useOpenInterface.getState().current;
  if (!current) return;
  if (placementOf(current.id) === "window") uiSounds.play("close");
  useOpenInterface.getState().set(null);
}

// ---------------------------------------------------------------------------
// Yes/no questions asked in the chatbox (shown by the world screen).

export interface ConfirmRequest {
  question: string;
  yes: string;
  no: string;
  answer(ok: boolean): void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  /** Mounted screens able to show the question; with none, questions answer "no". */
  hosts: number;
}

export const useConfirm = create<ConfirmState>(() => ({ request: null, hosts: 0 }));

export function askConfirm(question: string, yes: string, no: string): Promise<boolean> {
  if (useConfirm.getState().hosts === 0) return Promise.resolve(false);
  useConfirm.getState().request?.answer(false);
  return new Promise((resolve) => {
    const request: ConfirmRequest = {
      question,
      yes,
      no,
      answer(ok) {
        if (useConfirm.getState().request === request) useConfirm.setState({ request: null });
        resolve(ok);
      },
    };
    useConfirm.setState({ request });
  });
}

/** Registers a screen that can show confirmation questions while mounted. */
export function useConfirmHost(): void {
  useEffect(() => {
    useConfirm.setState((s) => ({ hosts: s.hosts + 1 }));
    return () => {
      const { hosts, request } = useConfirm.getState();
      useConfirm.setState({ hosts: Math.max(0, hosts - 1) });
      if (hosts <= 1) request?.answer(false);
    };
  }, []);
}

/** The pending question as the original's "Select an Option" chat dialogue. Esc answers no. */
export function ConfirmDialogue() {
  const request = useConfirm((s) => s.request);
  useEscapeLayer(() => request?.answer(false), request !== null);
  if (!request) return null;
  return (
    <Dialogue
      kind="options"
      title={request.question}
      options={[
        { label: request.yes, onSelect: () => request.answer(true) },
        { label: request.no, onSelect: () => request.answer(false) },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Wallet verification, announcements and stalls.

/**
 * Proves the sender's wallet to the game server unless this session already
 * carries it. External wallets are asked first when the proof is only for a
 * room announcement. Resolves false when the player declines.
 */
async function ensureVerified(sender: TxSender | null, reason: "announce" | "stall"): Promise<boolean> {
  if (!sender) throw new Error("You need to log in to trade.");
  const verified = getSession()?.wallet ?? null;
  if (verified && verified === sender.address.toLowerCase()) return true;
  if (reason === "announce" && sender.kind === "external") {
    const ok = await askConfirm("Prove your wallet to share this trade with the room?", "Yes, sign and share it.", "No, keep it private.");
    if (!ok) return false;
  }
  await proveWallet(sender);
  return true;
}

const ANNOUNCE_RETRIES = 3;
const ANNOUNCE_RETRY_MS = 4_000;

async function announce(kind: "bought" | "listed", tx: string, sender: TxSender | null): Promise<void> {
  try {
    if (!(await ensureVerified(sender, "announce"))) return;
    for (let attempt = 0; ; attempt++) {
      try {
        await postAct({ type: "announce", kind, tx });
        return;
      } catch (err) {
        // 409: the transaction is not indexed by the RPC yet (or was already announced).
        if (err instanceof ApiError && err.code === "conflict" && attempt < ANNOUNCE_RETRIES) {
          await new Promise((r) => setTimeout(r, ANNOUNCE_RETRY_MS));
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (isUserRejection(err) || (err instanceof ApiError && err.code === "conflict")) return;
    console.warn("[announce]", err);
    gameMessage(`Your trade could not be shared with the room. ${describeError(err)}`);
  }
}

async function setStall(depositId: string | null, sender: TxSender | null): Promise<void> {
  try {
    if (depositId !== null) await ensureVerified(sender, "stall");
    await postAct({ type: "stall", depositId });
  } catch (err) {
    throw new Error(describeError(err), { cause: err });
  }
}

// ---------------------------------------------------------------------------
// Login, including an account that logged in without a wallet.

/**
 * The wallet can read "no_wallet" for a moment while Privy is still creating
 * a new player's embedded wallet (createOnLogin), so the state only counts
 * once it has lasted this long.
 */
const NO_WALLET_SETTLE_MS = 6_000;
/** A log-in-again only opens the login if the logout finishes within this time. */
const RELOGIN_WINDOW_MS = 15_000;

export const NO_WALLET_TEXT = "Your account has no wallet. Log in again to set one up.";
const WALLET_SETTING_UP = "Your wallet is still being set up. It will be ready in a moment.";
const WALLET_LOADING = "The login is still loading. It will open in a moment.";
const WALLET_NOT_LOADED = "The login didn't load. Check your connection and try again.";

/** True once a logged-in account has stayed without any wallet (see NO_WALLET_SETTLE_MS). */
export const useNoWallet = create<{ settled: boolean }>(() => ({ settled: false }));

function useNoWalletWatch(status: WalletStatus): void {
  useEffect(() => {
    if (status !== "no_wallet") {
      useNoWallet.setState({ settled: false });
      return;
    }
    const timer = window.setTimeout(() => useNoWallet.setState({ settled: true }), NO_WALLET_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);
}

let reloginAt = 0;

/** Logs the walletless account out; GameProvider opens the login again once it has. */
async function relogin(wallet: WalletContextValue): Promise<void> {
  if (Date.now() - reloginAt < RELOGIN_WINDOW_MS) return;
  reloginAt = Date.now();
  try {
    await wallet.logout();
  } catch (err) {
    reloginAt = 0;
    gameMessage(describeError(err));
  }
}

/** Opens Privy login, or explains why it can't right now. */
export function loginWallet(wallet: WalletContextValue): void {
  if (!wallet.ready) {
    // Privy is still downloading or starting up: the login opens by itself once it is ready.
    gameMessage(WALLET_LOADING);
    requestWalletLogin().catch(() => gameMessage(WALLET_NOT_LOADED));
    return;
  }
  if (wallet.status === "reconnect") {
    wallet.reconnect();
    return;
  }
  if (wallet.status === "no_wallet") {
    if (!useNoWallet.getState().settled) {
      gameMessage(WALLET_SETTING_UP);
      return;
    }
    gameMessage(NO_WALLET_TEXT);
    void relogin(wallet);
    return;
  }
  if (wallet.authenticated) {
    if (wallet.status === "preparing") gameMessage(WALLET_SETTING_UP);
    return;
  }
  wallet.login();
}

/** Finishes a log-in-again: opens the login once the walletless account has logged out. */
function useReloginWatch(wallet: WalletContextValue): void {
  const { status, login } = wallet;
  useEffect(() => {
    if (status !== "logged_out" || reloginAt === 0) return;
    const recent = Date.now() - reloginAt < RELOGIN_WINDOW_MS;
    reloginAt = 0;
    if (recent) login();
  }, [status, login]);
}

// ---------------------------------------------------------------------------
// Dialogue chatheads, drawn by the character runtime's shared preview context.

/** Shown for "the banker" until the world meta has loaded (a Varrock West booth banker). */
const DEFAULT_BANKER_NPC = 2897;
/** Each banker's cache NPC id by banker index, from the world meta (read once, from the engine's own chunk). */
let bankerNpcIds: readonly number[] | null = null;
let bankerNpcIdsLoad: Promise<void> | null = null;
/** The banker the player last used, so their dialogue shows that banker's face. */
let lastBankerIndex: number | null = null;

function loadBankerNpcIds(): void {
  bankerNpcIdsLoad ??= import("@/game/world/worldMeta")
    .then(({ bundledWorldMeta, parseWorldMeta }) => {
      bankerNpcIds = parseWorldMeta(bundledWorldMeta()).bankers.map((b) => b.npcId);
    })
    .catch((err: unknown) => console.warn("[chathead] world meta", err));
}

/** The cache NPC id of the banker at `index` (the one last used), else the first banker's. */
export function bankerNpcIdFor(ids: readonly number[] | null, index: number | null): number {
  if (!ids) return DEFAULT_BANKER_NPC;
  return (index !== null ? ids[index] : undefined) ?? ids[0] ?? DEFAULT_BANKER_NPC;
}

export type ChatheadSource = Parameters<GameRuntime["renderPreview"]>[1];

/**
 * Who is speaking, as a look the preview can draw: a player's appearance from
 * the world (null when unknown or invalid), a merchant's look from its id (as
 * the engine seeds it: buildMerchants sets seed = id), a cache NPC, or the
 * banker last used.
 */
export function chatheadSource(
  who: ChatheadSubject,
  looks: Pick<GameRuntime["factory"], "isValidAppearance" | "randomAppearance">,
  players: Readonly<Record<string, Pick<PlayerRecord, "a"> | undefined>>,
  bankerNpc: number,
): ChatheadSource | null {
  if ("pid" in who) {
    const look = players[who.pid]?.a;
    return look && looks.isValidAppearance(look) ? look : null;
  }
  if ("merchantId" in who) return looks.randomAppearance(who.merchantId);
  if ("npcId" in who) return { npcId: who.npcId };
  return { npcId: bankerNpc };
}

/**
 * The shell's `renderChathead`: frames the speaker's head through the
 * runtime's preview, which shares one WebGL context with every other preview.
 */
export function renderChathead(container: HTMLElement, who: ChatheadSubject, options: ChatheadOptions = {}): ChatheadHandle | null {
  const runtime = bootStore.getState().runtime;
  if (!runtime?.factory.isLoaded) return null;
  const { factory } = runtime;
  const source = chatheadSource(who, factory, useWorldStore.getState().players, bankerNpcIdFor(bankerNpcIds, lastBankerIndex));
  if (!source) return null;
  return runtime.renderPreview(container, source, { factory, framing: "head", label: "Chathead", onError: () => options.onFail?.() });
}

/** Remembers which banker the player uses, for that banker's chathead. */
function useBankerWatch(engine: Engine): void {
  useEffect(() => {
    loadBankerNpcIds();
    return engine.on("interact", ({ target }) => {
      if (target.kind === "banker") lastBankerIndex = target.npcIndex;
    });
  }, [engine]);
}

function celebrate(engine: Engine): void {
  const pid = useWorldStore.getState().me?.pid;
  if (!pid) return;
  // Reduced motion: no fireworks. The interface that completed the trade plays the coins sound.
  if (useSettingsStore.getState().settings.reducedMotion) return;
  engine.celebrate(pid);
}

/**
 * The buy interfaces' view of the game: the same as `useGame()`, except that
 * `sender` is the buy binding's (the earlier wallet while it holds the open
 * order). The shell wraps the buy interfaces (BUY_INTERFACES) in it.
 */
const BuyGameContext = createContext<GameContextValue | null>(null);

export function BuyInterfaceContext({ children }: { children: ReactNode }) {
  const value = useContext(BuyGameContext);
  return value ? <GameContext.Provider value={value}>{children}</GameContext.Provider> : children;
}

export function GameProvider({ engine, buy, children }: { engine: Engine; buy: BuyBinding; children: ReactNode }) {
  const wallet = useAppWallet();
  const me = useMe();
  const stallDepositId = useWorldStore((s) => (s.me ? (s.players[s.me.pid]?.s?.depositId ?? null) : null));
  const liquidCurrencies = useMarketStore((s) => s.liquidCurrencies);
  const walletRef = useRef(wallet);
  const buyRef = useRef(buy);
  useEffect(() => {
    walletRef.current = wallet;
    buyRef.current = buy;
  });
  useNoWalletWatch(wallet.status);
  useReloginWatch(wallet);
  useBankerWatch(engine);

  const value = useMemo<GameContextValue>(
    () => ({
      sender: wallet.sender,
      // The wallet service (Privy) has loaded, so login() works; `sender` says whether the player can trade.
      walletReady: wallet.ready,
      login: () => loginWallet(walletRef.current),
      publicClient: wallet.publicClient,
      me: me ? { pid: me.pid, name: me.name, verifiedWallet: me.wallet } : null,
      open: openInterface,
      close: closeInterface,
      message: gameMessage,
      playSound,
      celebrate: () => celebrate(engine),
      // A purchase settled by the earlier wallet isn't announced: proving that wallet would replace the
      // player's verified wallet on the game server.
      announce: (kind, tx) =>
        kind === "bought" && buyRef.current.earlier ? Promise.resolve() : announce(kind, tx, walletRef.current.sender),
      setStall: (depositId) => setStall(depositId, walletRef.current.sender),
      stallDepositId,
      liquidCurrencies,
      renderChathead,
    }),
    [wallet.sender, wallet.ready, wallet.publicClient, me, stallDepositId, liquidCurrencies, engine],
  );
  const buyValue = useMemo<GameContextValue>(() => ({ ...value, sender: buy.sender }), [value, buy.sender]);

  return (
    <GameContext.Provider value={value}>
      <BuyGameContext.Provider value={buyValue}>{children}</BuyGameContext.Provider>
    </GameContext.Provider>
  );
}
