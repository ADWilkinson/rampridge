import type { ComponentType } from "react";
import type { PublicClient } from "viem";
import { create } from "zustand";
import type { WalletContextValue } from "@/wallet";
import { WalletNotReadyError } from "@/wallet/errors";
import { cacheBusted, failedModuleUrl } from "./interfaceLoader";
import { noteChunkFailure } from "./update";

/**
 * The player's wallet for the shell, kept out of the first download. Privy,
 * its smart wallets and WalletConnect are over a megabyte of code, so the
 * wallet stack (`./walletStack`) loads as its own chunk: once the world has
 * painted (Game: once the title has, for a returning player who is logged
 * in), or straight away when the player logs in, and publishes the wallet
 * here. Until then the wallet reads as "loading", as it does while Privy
 * initialises, and a login asked for meanwhile opens once Privy is ready.
 */

export type WalletStackState = "idle" | "loading" | "ready" | "failed";

interface WalletBridgeState {
  /** `useWallet()` from the wallet stack once it has loaded; the loading wallet until then. */
  wallet: WalletContextValue;
  /** Privy's login modal is open. */
  modalOpen: boolean;
  stack: WalletStackState;
  /** The wallet stack's root, rendered by AppProviders once its chunk has loaded. */
  Stack: ComponentType | null;
  /** A login asked for before Privy was ready; the wallet stack opens it once Privy is. */
  loginQueued: boolean;
}

/** The wallet before the wallet stack has loaded: not ready, logged out, nothing to sign with. */
let loadedPublicClient: PublicClient | null = null;

/** Loads the read-only Base client (most of viem, which the title doesn't need). */
function loadPublicClient(): Promise<PublicClient> {
  return import("@/wallet/publicClient").then(({ publicClient }) => {
    loadedPublicClient = publicClient;
    return publicClient;
  });
}

/** Starts loading the read-only Base client (the shell calls it once the title is up). */
export function preloadPublicClient(): void {
  void loadPublicClient().catch(() => undefined);
}

/**
 * The loading wallet's read-only Base client. Once the real client has loaded
 * (preloadPublicClient) this is it in every respect; before then a method
 * call loads it and forwards. Only the trading interfaces read the chain, and
 * only with a wallet, by which time the wallet stack's own value has replaced
 * this one.
 */
const deferredPublicClient = new Proxy({} as PublicClient, {
  get(_target, prop) {
    const client = loadedPublicClient;
    if (client) {
      const value: unknown = Reflect.get(client, prop);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
    }
    if (typeof prop === "symbol" || prop === "then") return undefined;
    return (...args: unknown[]) =>
      loadPublicClient().then((real) => (Reflect.get(real, prop) as (...a: unknown[]) => unknown).apply(real, args));
  },
});

export const LOADING_WALLET: WalletContextValue = {
  ready: false,
  authenticated: false,
  sender: null,
  publicClient: deferredPublicClient,
  login: () => void requestWalletLogin().catch(() => undefined),
  logout: () => Promise.resolve(),
  status: "loading",
  address: null,
  source: null,
  kind: null,
  sponsored: false,
  walletName: null,
  account: null,
  reconnect: () => void loadWalletStack().catch(() => undefined),
  getAccessToken: () => Promise.resolve(null),
  fallbackEoa: null,
  fallbackSender: null,
  sweepFallbackUsdc: () => Promise.reject(new WalletNotReadyError("Your wallets are still loading. Try again in a moment.")),
};

export const useWalletBridge = create<WalletBridgeState>(() => ({
  wallet: LOADING_WALLET,
  modalOpen: false,
  stack: "idle",
  Stack: null,
  loginQueued: false,
}));

/** The player's wallet (what `useWallet()` returns inside the wallet stack). */
export function useAppWallet(): WalletContextValue {
  return useWalletBridge((s) => s.wallet);
}

type StackModule = typeof import("./walletStack");

const importStack = (): Promise<StackModule> => import("./walletStack");

let loading: Promise<void> | null = null;
/** The wallet stack chunk's own URL after it failed to load: the browser remembers the failure, so a retry busts it. */
let failedStackUrl: string | null = null;

/**
 * Loads the wallet stack now unless it has loaded or is loading. Resolves once
 * it is mounted; rejects when its code could not be downloaded (a later call
 * tries again).
 */
export function loadWalletStack(): Promise<void> {
  if (useWalletBridge.getState().stack === "ready") return Promise.resolve();
  if (loading) return loading;
  useWalletBridge.setState({ stack: "loading" });
  const busted = failedStackUrl;
  const attempt: Promise<StackModule> = busted
    ? (import(/* @vite-ignore */ cacheBusted(busted, Date.now())) as Promise<StackModule>)
    : importStack();
  loading = attempt.then(
    (mod) => {
      loading = null;
      failedStackUrl = null;
      useWalletBridge.setState({ stack: "ready", Stack: mod.WalletStack });
    },
    (err: unknown) => {
      loading = null;
      const url = failedModuleUrl(err);
      // Keep the first failed URL: a failed retry names the busted one, and busting that again would stack queries.
      if (!failedStackUrl) failedStackUrl = url && /\/walletStack[^/]*$/.test(url) ? url : null;
      console.warn("[wallet] the wallet service did not load", err);
      void noteChunkFailure();
      useWalletBridge.setState({ stack: "failed", loginQueued: false });
      throw err;
    },
  );
  return loading;
}

/**
 * Opens Privy's login as soon as it can: once the wallet stack has loaded and
 * Privy is ready (the stack opens it). Rejects when the stack could not load.
 */
export function requestWalletLogin(): Promise<void> {
  useWalletBridge.setState({ loginQueued: true });
  return loadWalletStack();
}

/** A login opened at OAuth return (Google, Apple, X on a phone) must finish without waiting for the title. */
const OAUTH_RETURN = /[?&]privy_oauth_/;

export function isOAuthReturn(): boolean {
  return OAUTH_RETURN.test(window.location.search);
}

/**
 * True when this browser holds a Privy login (a returning player who logged
 * in before). Only decides how early the wallet stack downloads: a wrong
 * answer costs time, never correctness.
 */
export function hasPrivySession(storage: Pick<Storage, "length" | "key"> | null = safeLocalStorage()): boolean {
  if (!storage) return false;
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && /^privy[:-].*token$/.test(key)) return true;
    }
  } catch {
    // Storage blocked: treat as a new visitor.
  }
  return false;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
