import { useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { BuyCompletion, BuyFlowState, BuyFlowStore } from "@/peer/buy";
import { formatUsdc } from "@/peer/format";
import { useGame, type GameContextValue } from "../context";
import { useBuyDeps } from "./deps";
import { watchErrorOrigin } from "./origin";
import { usePractice } from "./practiceContext";

/**
 * Game-world side effects of the buy flow, fired once per order however many
 * interfaces (or the shell) mount this hook:
 * - an offer lands: "Your offer has been placed." and the offer sound;
 * - a purchase completes: fireworks, the coins sound, "You bought X USDC."
 *   and the verified "bought" world announcement;
 * - an older order that blocked a new one (one this app can't show) is
 *   cancelled: "Your older order has been cancelled."
 * Completions are remembered in localStorage so a refresh never repeats them.
 * A practice trade celebrates in the player's own view only: no
 * announcement, nothing remembered.
 */
export function useBuyOrderEvents(store?: StoreApi<BuyFlowStore>): void {
  const deps = useBuyDeps();
  const api = store ?? deps.store;
  const game = useGame();
  const practice = usePractice();
  const gameRef = useRef(game);
  gameRef.current = game;

  useEffect(() => {
    // Mounted by the shell for the whole session, so every error's origin is seen (origin.ts).
    watchErrorOrigin(api);
    const onCompleted = (state: BuyFlowState) => {
      if (state.step === "completed" && state.completion) celebrateOnce(state.completion, gameRef.current, practice);
    };
    onCompleted(api.getState());
    return api.subscribe((state, prev) => {
      if (placedNow(state, prev)) {
        const hash = state.order?.intentHash.toLowerCase();
        if (hash && !placed.has(hash)) {
          placed.add(hash);
          gameRef.current.message("Your offer has been placed.");
          gameRef.current.playSound("offer");
        }
      }
      if (olderCancelledNow(state, prev)) gameRef.current.message("Your older order has been cancelled.");
      if (prev.step !== "completed") onCompleted(state);
    });
  }, [api, practice]);
}

/** A signal this session sent just landed (not an adopted or resumed order, which carry a notice). */
export function placedNow(state: Pick<BuyFlowState, "step" | "order" | "notice">, prev: Pick<BuyFlowState, "step">): boolean {
  return prev.step === "signaling" && state.step === "awaitingPayment" && state.order?.status === "active" && state.notice === null;
}

/** A cancel of the older order that blocked a new one just landed (no order of this app's was in view). */
export function olderCancelledNow(state: Pick<BuyFlowState, "step" | "order">, prev: Pick<BuyFlowState, "step" | "pending" | "order">): boolean {
  return prev.pending === "cancel" && prev.order === null && prev.step !== "cancelled" && state.step === "cancelled" && state.order === null;
}

const placed = new Set<string>();
const celebrated = new Set<string>();
const STORAGE_KEY = "rampridge:buy-ui:celebrated";

function readCelebrated(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function remember(key: string): void {
  try {
    const next = [...readCelebrated().filter((k) => k !== key), key].slice(-50);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode): the in-memory set still prevents repeats this session.
  }
}

function celebrateOnce(completion: BuyCompletion, game: GameContextValue, practice: boolean): void {
  const key = completion.intentHash.toLowerCase();
  if (celebrated.has(key) || readCelebrated().includes(key)) return;
  celebrated.add(key);
  if (!practice) remember(key);
  game.celebrate();
  game.playSound("coins");
  if (practice) {
    game.message("Trade complete. No money moved.");
    return;
  }
  game.message(`You bought ${formatUsdc(completion.usdcReceived)} USDC.`);
  // Without the release transaction (only the intent hash was recoverable) there is nothing to verify.
  if (completion.fulfillTxHash.toLowerCase() === key) return;
  game.announce("bought", completion.fulfillTxHash).catch(() => {
    game.message("Your purchase is complete, but the bank couldn't announce it.");
  });
}
