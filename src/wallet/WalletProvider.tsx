import {
  useCrossAppAccounts,
  useLogin,
  usePrivy,
  useSendTransaction,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isHex, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";
import { track } from "@/lib/telemetry";
import { walletQueryKeys } from "./balances";
import { PEER_PRIVY_APP_ID, SMART_WALLET_GRACE_MS, WALLET_CHAIN } from "./constants";
import { WalletError, WalletNotReadyError } from "./errors";
import { readEmbeddedPin, sweepUsdc, writeEmbeddedPin } from "./fallback";
import { addressesEqual } from "./format";
import { requestWalletGesture } from "./gesture";
import { publicClient } from "./publicClient";
import {
  awaitingSmartWallet,
  describeAccount,
  embeddedWalletAccount,
  fallbackEoaAddress,
  isPrivyWalletType,
  isSponsorableEmbeddedWallet,
  selectWallet,
  type AccountInfo,
  type UserLike,
  type WalletSource,
} from "./selection";
import {
  createCrossAppSender,
  createEmbeddedSender,
  createExternalSender,
  createSmartSender,
  type SenderEnvironment,
} from "./senders";
import type { TxSender, WalletKind, WalletState } from "./types";

export type WalletStatus =
  /** Privy is still initialising. */
  | "loading"
  | "logged_out"
  /** Logged in; the signer is still loading (smart wallet creation, wallet iframe, connectors). */
  | "preparing"
  /** `sender` is set and can transact. */
  | "ready"
  /** Logged in with an external wallet that is not connected in this browser; call `reconnect()`. */
  | "reconnect"
  /** Logged in without any wallet. */
  | "no_wallet";

export interface WalletContextValue extends WalletState {
  status: WalletStatus;
  /** The address that is (or will be, once ready) `msg.sender`. Null when unknown. */
  address: Address | null;
  source: WalletSource | null;
  kind: WalletKind | null;
  /** True when the app pays gas for the selected wallet. */
  sponsored: boolean;
  /** "Smart wallet", "Embedded wallet", "Peer wallet" or the external wallet's name. */
  walletName: string | null;
  account: AccountInfo | null;
  /** Opens Privy's connect modal so an external-wallet player can reconnect. */
  reconnect(): void;
  /** Privy access token for the logged-in user, or null when logged out. */
  getAccessToken(): Promise<string | null>;
  /**
   * The player's Privy embedded EOA while the smart wallet is the selected
   * wallet (source "smart"), otherwise null. A player who transacted during
   * the smart-wallet grace fallback in an earlier tab may hold USDC, ETH or
   * open intents here. Show its balance (`useUsdcBalance(fallbackEoa)`) and
   * offer `sweepFallbackUsdc()` when it is non-zero.
   */
  fallbackEoa: Address | null;
  /**
   * A TxSender for `fallbackEoa` (kind "embedded", sponsored when Privy can
   * sponsor that wallet), or null until that wallet is connected. Use it to
   * cancel or fulfil intents the EOA signalled; it never changes `sender`.
   */
  fallbackSender: TxSender | null;
  /**
   * Moves the full USDC balance of `fallbackEoa` to `address` (the smart
   * wallet) in one transfer. Resolves null when there is nothing to move.
   * Rejects with WalletNotReadyError unless the smart wallet is ready and the
   * EOA is connected, and with WalletError like any `sendCalls` otherwise.
   */
  sweepFallbackUsdc(): Promise<TransactionReceipt | null>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

type SmartClient = NonNullable<ReturnType<typeof useSmartWallets>["client"]>;

interface LivePrivy {
  wallets: ConnectedWallet[];
  smartClient: SmartClient | undefined;
  sendTransaction: ReturnType<typeof useSendTransaction>["sendTransaction"];
  crossApp: ReturnType<typeof useCrossAppAccounts>;
}

// The game's own screens (trade second screen, sell review) are the confirmation, so embedded
// and smart-wallet prompts stay headless. External wallets keep their own prompts.
const SIGN_UI = { description: "Signing is free and does not move any funds.", showWalletUIs: false } as const;

function asHex(value: unknown): Hex {
  if (typeof value === "string" && isHex(value)) return value;
  throw new WalletError("unknown", "Your wallet returned an invalid signature.");
}

function useSmartWalletGrace(user: UserLike | null): boolean {
  const userId = user?.id ?? null;
  const waiting = awaitingSmartWallet(user);
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  useEffect(() => {
    if (!userId || !waiting) return;
    const timer = setTimeout(() => setExpiredFor(userId), SMART_WALLET_GRACE_MS);
    return () => clearTimeout(timer);
  }, [userId, waiting]);
  return userId !== null && expiredFor === userId;
}

/**
 * Keeps the embedded-EOA fallback for the rest of this tab once the player
 * has seen it, so a smart wallet that links late cannot swap the address under
 * a flow (or a deposit address) that already uses the EOA.
 */
function useEmbeddedPin(userId: string | null): { pinned: string | null; pin(address: Address): void } {
  const [memory, setMemory] = useState<{ userId: string; address: string } | null>(null);
  const stored = useMemo(() => (userId ? readEmbeddedPin(userId) : null), [userId]);
  const pinned = memory && memory.userId === userId ? memory.address : stored;
  const pin = useCallback(
    (address: Address) => {
      if (!userId) return;
      writeEmbeddedPin(userId, address);
      setMemory({ userId, address });
    },
    [userId],
  );
  return { pinned, pin };
}

function walletNameFor(source: WalletSource, wallet: ConnectedWallet | null): string {
  switch (source) {
    case "smart":
      return "Smart wallet";
    case "embedded":
      return "Embedded wallet";
    case "cross_app":
      return "Peer wallet";
    case "external":
      return wallet?.meta.name || "Wallet";
  }
}

function kindFor(source: WalletSource): WalletKind {
  return source === "smart" || source === "embedded" ? source : "external";
}

function buildSender(
  source: WalletSource,
  address: Address,
  sponsored: boolean,
  live: { readonly current: LivePrivy },
  env: SenderEnvironment,
): TxSender {
  switch (source) {
    case "smart": {
      const client = (): SmartClient => {
        const current = live.current.smartClient;
        if (!current || !addressesEqual(current.account?.address, address)) {
          throw new WalletNotReadyError("Your smart wallet is still being set up. Try again in a moment.");
        }
        return current;
      };
      return createSmartSender(
        address,
        {
          async sendBatch(calls, label) {
            const current = client();
            // Privy keeps one client per chain; this selects Base (a no-op when it already is).
            await current.switchChain({ id: WALLET_CHAIN.id });
            return current.sendTransaction({ calls }, { uiOptions: { showWalletUIs: false, ...(label ? { description: label } : {}) } });
          },
          // Privy's client is permissionless's smart account client: its transport is the bundler.
          async bundlerRequest({ method, params }) {
            const current = client();
            await current.switchChain({ id: WALLET_CHAIN.id });
            return current.request({ method, params });
          },
          signMessage: async (message) => asHex(await client().signMessage({ message }, { uiOptions: SIGN_UI })),
          signTypedData: async (payload) => {
            const current = client();
            return asHex(
              await current.signTypedData(
                {
                  account: current.account,
                  domain: payload.domain,
                  types: payload.types,
                  primaryType: payload.primaryType,
                  message: payload.message,
                },
                { uiOptions: SIGN_UI },
              ),
            );
          },
        },
        env,
      );
    }
    case "embedded": {
      const wallet = (): ConnectedWallet => {
        const found = live.current.wallets.find(
          (entry) => isPrivyWalletType(entry.walletClientType) && addressesEqual(entry.address, address),
        );
        if (!found) throw new WalletNotReadyError();
        return found;
      };
      return createEmbeddedSender(
        address,
        {
          async send(call, { sponsor, label }) {
            const { hash } = await live.current.sendTransaction(
              // Privy hex-encodes `value` itself: pass a bigint, never a pre-encoded string.
              { to: call.to, data: call.data, value: call.value, chainId: WALLET_CHAIN.id },
              { sponsor, address, uiOptions: { showWalletUIs: false, ...(label ? { description: label } : {}) } },
            );
            return hash;
          },
          getProvider: () => wallet().getEthereumProvider(),
        },
        { sponsored },
        env,
      );
    }
    case "external": {
      const wallet = (): ConnectedWallet => {
        const found = live.current.wallets.find(
          (entry) => !isPrivyWalletType(entry.walletClientType) && addressesEqual(entry.address, address),
        );
        if (!found) throw new WalletNotReadyError("Reconnect your wallet to continue.");
        return found;
      };
      return createExternalSender(
        address,
        {
          getProvider: () => wallet().getEthereumProvider(),
          switchToBase: () => wallet().switchChain(WALLET_CHAIN.id),
        },
        env,
      );
    }
    case "cross_app":
      return createCrossAppSender(
        address,
        {
          async send(call) {
            const hash = await live.current.crossApp.sendTransaction(
              {
                to: call.to,
                data: call.data,
                chainId: WALLET_CHAIN.id,
                ...(call.value > 0n ? { value: call.value } : {}),
              },
              { address },
            );
            return hash as Hash;
          },
          signMessage: async (message) =>
            asHex(await live.current.crossApp.signMessage(message, { address, chainId: WALLET_CHAIN.id })),
          signTypedData: async (payload) =>
            asHex(
              await live.current.crossApp.signTypedData(
                {
                  domain: payload.domain,
                  types: payload.types,
                  primaryType: payload.primaryType,
                  message: payload.message,
                },
                { address, chainId: WALLET_CHAIN.id },
              ),
            ),
        },
        requestWalletGesture,
        env,
      );
  }
}

/**
 * Counts completed logins for launch telemetry. Privy runs these callbacks for
 * every login flow (including `usePrivy().login`, which `login` below calls),
 * and once on load for a session that was already signed in, which is not a
 * login. Module-level so Privy subscribes once rather than on every render.
 */
const LOGIN_EVENTS = {
  onComplete: ({ wasAlreadyAuthenticated }: { wasAlreadyAuthenticated: boolean }) => {
    if (!wasAlreadyAuthenticated) track("login", { once: true });
  },
};

/**
 * Resolves the player's wallet from Privy once for the whole app and exposes
 * it through `useWallet()`. Must sit inside PrivyProvider, SmartWalletsProvider
 * and QueryClientProvider (AppProviders does this).
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  useLogin(LOGIN_EVENTS);
  const { wallets, ready: walletsReady } = useWallets();
  const { client: smartClient } = useSmartWallets();
  const { sendTransaction } = useSendTransaction();
  const crossApp = useCrossAppAccounts();
  const queryClient = useQueryClient();

  const live = useRef<LivePrivy>({ wallets, smartClient, sendTransaction, crossApp });
  useEffect(() => {
    live.current = { wallets, smartClient, sendTransaction, crossApp };
  });

  const user = privy.authenticated ? privy.user : null;
  const smartGraceExpired = useSmartWalletGrace(user);
  const { pinned, pin } = useEmbeddedPin(user?.id ?? null);
  const selection = useMemo(
    () =>
      selectWallet({
        user,
        wallets,
        walletsReady,
        smartClientAddress: smartClient?.account?.address,
        smartGraceExpired,
        peerAppId: PEER_PRIVY_APP_ID,
        pinnedEmbeddedAddress: pinned,
      }),
    [user, wallets, walletsReady, smartClient, smartGraceExpired, pinned],
  );
  useEffect(() => {
    if (selection.status === "ready" && selection.source === "embedded" && !addressesEqual(pinned, selection.address)) {
      pin(selection.address);
    }
  }, [selection, pinned, pin]);

  const readySource = selection.status === "ready" ? selection.source : null;
  const readyAddress = selection.status === "ready" ? selection.address : null;
  const readySponsored = selection.status === "ready" && selection.source === "embedded" ? selection.sponsored : false;
  const selectedWallet =
    selection.status === "ready" && (selection.source === "embedded" || selection.source === "external")
      ? selection.wallet
      : null;

  const env = useMemo<SenderEnvironment>(
    () => ({
      reader: publicClient,
      onSettled: () => void queryClient.invalidateQueries({ queryKey: walletQueryKeys.all }),
    }),
    [queryClient],
  );
  const sender = useMemo<TxSender | null>(() => {
    if (!readySource || !readyAddress) return null;
    return buildSender(readySource, readyAddress, readySponsored, live, env);
  }, [readySource, readyAddress, readySponsored, env]);

  const fallbackEoa = useMemo(() => fallbackEoaAddress(user, selection), [user, selection]);
  const fallbackConnected = Boolean(
    fallbackEoa &&
      wallets.some((entry) => isPrivyWalletType(entry.walletClientType) && addressesEqual(entry.address, fallbackEoa)),
  );
  const embeddedAccount = user ? embeddedWalletAccount(user) : null;
  const fallbackSponsored = embeddedAccount ? isSponsorableEmbeddedWallet(embeddedAccount) : false;
  const fallbackSender = useMemo<TxSender | null>(
    () => (fallbackEoa && fallbackConnected ? buildSender("embedded", fallbackEoa, fallbackSponsored, live, env) : null),
    [fallbackEoa, fallbackConnected, fallbackSponsored, env],
  );
  const sweepFallbackUsdc = useCallback(async (): Promise<TransactionReceipt | null> => {
    if (!fallbackSender || readySource !== "smart" || !readyAddress || !sender) {
      throw new WalletNotReadyError("Your wallets are still loading. Try again in a moment.");
    }
    return sweepUsdc(fallbackSender, readyAddress);
  }, [fallbackSender, readySource, readyAddress, sender]);

  const account = useMemo(() => (user ? describeAccount(user) : null), [user]);

  const { login: privyLogin, logout, connectWallet, getAccessToken, authenticated, ready } = privy;
  const login = useCallback(() => {
    // Privy ignores (and warns about) login before it is ready or while already logged in.
    if (ready && !authenticated) privyLogin();
  }, [ready, authenticated, privyLogin]);
  const reconnect = useCallback(() => {
    connectWallet({ description: "Reconnect the wallet you logged in with.", walletChainType: "ethereum-only" });
  }, [connectWallet]);

  const value = useMemo<WalletContextValue>(() => {
    const source = selection.status === "ready" || selection.status === "preparing" || selection.status === "reconnect"
      ? selection.source
      : null;
    const address =
      selection.status === "ready" || selection.status === "preparing" || selection.status === "reconnect"
        ? selection.address
        : null;
    let status: WalletStatus;
    if (!ready) status = "loading";
    else if (!authenticated) status = "logged_out";
    else if (selection.status === "ready") status = sender ? "ready" : "preparing";
    else if (selection.status === "none") status = "preparing";
    else status = selection.status;
    return {
      ready,
      authenticated,
      sender: status === "ready" ? sender : null,
      publicClient,
      login,
      logout,
      status,
      address,
      source,
      kind: source ? kindFor(source) : null,
      sponsored: sender?.sponsored ?? (source === "smart"),
      walletName: source ? walletNameFor(source, selectedWallet) : null,
      account,
      reconnect,
      getAccessToken,
      fallbackEoa,
      fallbackSender,
      sweepFallbackUsdc,
    };
  }, [
    ready,
    authenticated,
    selection,
    sender,
    selectedWallet,
    login,
    logout,
    account,
    reconnect,
    getAccessToken,
    fallbackEoa,
    fallbackSender,
    sweepFallbackUsdc,
  ]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** The player's wallet. Must be called under `<AppProviders>`. */
export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside <AppProviders>");
  return value;
}
