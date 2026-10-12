import { getAddress, isAddress, type Address } from "viem";
import { addressesEqual, shortAddress } from "./format";

/**
 * Structural subsets of Privy's `User`, linked accounts and `ConnectedWallet`,
 * so selection stays a pure function that tests can drive with plain objects.
 */
export interface LinkedAccountLike {
  type: string;
  address?: string;
  chainType?: string;
  walletClientType?: string;
  connectorType?: string;
  imported?: boolean;
  walletIndex?: number | null;
  id?: string | null;
  recoveryMethod?: string;
  embeddedWallets?: readonly { address: string }[];
  providerApp?: { id: string; name?: string };
  latestVerifiedAt?: Date | null;
  email?: string | null;
  username?: string | null;
  name?: string | null;
}

export interface UserLike {
  id: string;
  linkedAccounts: readonly LinkedAccountLike[];
  smartWallet?: { address: string };
  wallet?: { address: string };
  email?: { address: string };
}

export interface ConnectedWalletLike {
  address: string;
  walletClientType: string;
  meta?: { name?: string };
}

export type WalletSource = "smart" | "embedded" | "cross_app" | "external";

export type WalletSelection<W extends ConnectedWalletLike = ConnectedWalletLike> =
  /** Not logged in. */
  | { status: "none" }
  /** Logged in, signer not usable yet. `address` is known when the wallet is. */
  | { status: "preparing"; source: WalletSource | null; address: Address | null }
  /** Logged in with an external wallet that is no longer connected in this browser. */
  | { status: "reconnect"; source: "external"; address: Address }
  /** Logged in without any wallet (e.g. embedded wallet creation was declined). */
  | { status: "no_wallet" }
  | { status: "ready"; source: "smart"; address: Address }
  | { status: "ready"; source: "embedded"; address: Address; sponsored: boolean; wallet: W }
  | { status: "ready"; source: "cross_app"; address: Address }
  | { status: "ready"; source: "external"; address: Address; wallet: W };

export interface SelectionInput<W extends ConnectedWalletLike> {
  user: UserLike | null;
  wallets: readonly W[];
  walletsReady: boolean;
  /** `useSmartWallets().client?.account.address`. */
  smartClientAddress: string | null | undefined;
  /** True once an embedded user has waited `SMART_WALLET_GRACE_MS` without a smart wallet. */
  smartGraceExpired: boolean;
  peerAppId: string;
  /**
   * The embedded EOA this browser tab already presented as the player's
   * wallet (the grace fallback). While it matches the user's embedded wallet
   * it stays selected even after the smart wallet links, so the address never
   * changes under a flow that is already using it.
   */
  pinnedEmbeddedAddress?: string | null;
}

function toAddress(value: string | null | undefined): Address | null {
  return value && isAddress(value, { strict: false }) ? getAddress(value) : null;
}

export function isPrivyWalletType(walletClientType: string | undefined): boolean {
  return typeof walletClientType === "string" && walletClientType.toLowerCase().startsWith("privy");
}

function isEthereumWalletAccount(account: LinkedAccountLike): boolean {
  return account.type === "wallet" && (account.chainType === undefined || account.chainType === "ethereum");
}

/** The embedded EOA that owns the smart wallet: Privy's non-imported HD wallet at index 0. */
export function embeddedWalletAccount(user: UserLike): LinkedAccountLike | null {
  const embedded = user.linkedAccounts.filter(
    (account) => isEthereumWalletAccount(account) && isPrivyWalletType(account.walletClientType) && !account.imported,
  );
  return embedded.find((account) => account.walletIndex === 0) ?? embedded[0] ?? null;
}

export function smartWalletAddress(user: UserLike): Address | null {
  return (
    toAddress(user.smartWallet?.address) ??
    toAddress(user.linkedAccounts.find((account) => account.type === "smart_wallet")?.address)
  );
}

export function peerCrossAppAddress(user: UserLike, peerAppId: string): Address | null {
  const account = user.linkedAccounts.find(
    (entry) => entry.type === "cross_app" && (entry.providerApp?.id ?? "").trim() === peerAppId,
  );
  return toAddress(account?.embeddedWallets?.[0]?.address);
}

/** Privy only sponsors gas for embedded wallets on its TEE stack. */
export function isSponsorableEmbeddedWallet(account: LinkedAccountLike): boolean {
  return Boolean(account.id) && account.recoveryMethod === "privy-v2";
}

/** True while an embedded user has no smart wallet yet (the window `smartGraceExpired` times). */
export function awaitingSmartWallet(user: UserLike | null): boolean {
  return Boolean(user && !smartWalletAddress(user) && embeddedWalletAccount(user));
}

/**
 * Picks the wallet that will be `msg.sender`, in priority order:
 * smart wallet > embedded EOA > Peer cross-app wallet > external wallet.
 *
 * Never falls through to a different wallet while the preferred one is still
 * loading: that would sign with an address the player did not expect and that
 * the game session may already be bound to.
 */
export function selectWallet<W extends ConnectedWalletLike>(input: SelectionInput<W>): WalletSelection<W> {
  const { user, wallets, walletsReady } = input;
  if (!user) return { status: "none" };

  const embedded = embeddedWalletAccount(user);
  const embeddedAddress = toAddress(embedded?.address);
  const selectEmbedded = (account: LinkedAccountLike, address: Address): WalletSelection<W> => {
    const wallet = wallets.find(
      (entry) => isPrivyWalletType(entry.walletClientType) && addressesEqual(entry.address, address),
    );
    if (!wallet) return { status: "preparing", source: "embedded", address };
    return { status: "ready", source: "embedded", address, sponsored: isSponsorableEmbeddedWallet(account), wallet };
  };
  if (embedded && embeddedAddress && addressesEqual(input.pinnedEmbeddedAddress, embeddedAddress)) {
    return selectEmbedded(embedded, embeddedAddress);
  }

  const smartAddress = smartWalletAddress(user);
  if (smartAddress) {
    return addressesEqual(input.smartClientAddress, smartAddress)
      ? { status: "ready", source: "smart", address: smartAddress }
      : { status: "preparing", source: "smart", address: smartAddress };
  }

  if (embedded && embeddedAddress) {
    if (!input.smartGraceExpired) return { status: "preparing", source: "smart", address: null };
    return selectEmbedded(embedded, embeddedAddress);
  }

  const crossAddress = peerCrossAppAddress(user, input.peerAppId);
  if (crossAddress) return { status: "ready", source: "cross_app", address: crossAddress };

  const linkedExternal = user.linkedAccounts
    .filter((account) => isEthereumWalletAccount(account) && !isPrivyWalletType(account.walletClientType))
    .map((account) => toAddress(account.address))
    .filter((address): address is Address => address !== null);
  if (linkedExternal.length > 0) {
    const preferred = toAddress(user.wallet?.address);
    const connected = wallets.filter(
      (entry) =>
        !isPrivyWalletType(entry.walletClientType) &&
        linkedExternal.some((address) => addressesEqual(address, entry.address)),
    );
    const wallet = connected.find((entry) => addressesEqual(entry.address, preferred)) ?? connected[0];
    const walletAddress = toAddress(wallet?.address);
    if (wallet && walletAddress) return { status: "ready", source: "external", address: walletAddress, wallet };
    const expected = linkedExternal.find((address) => addressesEqual(address, preferred)) ?? linkedExternal[0];
    if (!expected) return { status: "no_wallet" };
    return walletsReady
      ? { status: "reconnect", source: "external", address: expected }
      : { status: "preparing", source: "external", address: expected };
  }

  return walletsReady ? { status: "no_wallet" } : { status: "preparing", source: null, address: null };
}

/**
 * The embedded EOA behind a selected smart wallet. A player who used the
 * grace fallback in an earlier session may have funds or open intents there,
 * and nothing else in the app reads that address once the smart wallet wins.
 */
export function fallbackEoaAddress(user: UserLike | null, selection: WalletSelection): Address | null {
  if (!user || (selection.status !== "ready" && selection.status !== "preparing") || selection.source !== "smart") {
    return null;
  }
  const smartAddress = smartWalletAddress(user);
  const eoa = toAddress(embeddedWalletAccount(user)?.address);
  return smartAddress && eoa && !addressesEqual(eoa, smartAddress) ? eoa : null;
}

export type LoginMethod = "email" | "google" | "twitter" | "apple" | "peer" | "wallet" | "other";

export interface AccountInfo {
  /** Privy DID. */
  userId: string;
  /** Email from email login, Google or Apple, when known. */
  email: string | null;
  /** Short human label for the account tab: email, @handle, "Peer account" or a short address. */
  displayName: string;
  /** How the player logged in most recently. */
  loginMethod: LoginMethod;
}

const LOGIN_METHOD_BY_TYPE: Record<string, LoginMethod> = {
  email: "email",
  google_oauth: "google",
  twitter_oauth: "twitter",
  apple_oauth: "apple",
  cross_app: "peer",
  wallet: "wallet",
};

function verifiedAt(account: LinkedAccountLike): number {
  return account.latestVerifiedAt instanceof Date ? account.latestVerifiedAt.getTime() : 0;
}

/** Account details for display. Embedded and smart wallets are never a login method. */
export function describeAccount(user: UserLike): AccountInfo {
  const loginAccounts = user.linkedAccounts
    .filter((account) => account.type !== "smart_wallet")
    .filter((account) => !(account.type === "wallet" && isPrivyWalletType(account.walletClientType)));
  const latest = [...loginAccounts].sort((a, b) => verifiedAt(b) - verifiedAt(a))[0];
  const loginMethod = (latest && LOGIN_METHOD_BY_TYPE[latest.type]) ?? "other";

  const google = user.linkedAccounts.find((account) => account.type === "google_oauth");
  const apple = user.linkedAccounts.find((account) => account.type === "apple_oauth");
  const email = user.email?.address ?? google?.email ?? apple?.email ?? null;

  let displayName: string;
  switch (loginMethod) {
    case "twitter":
      displayName = latest?.username ? `@${latest.username}` : (latest?.name ?? "X account");
      break;
    case "peer":
      displayName = "Peer account";
      break;
    case "wallet":
      displayName = shortAddress(latest?.address);
      break;
    default:
      displayName = email ?? shortAddress(user.wallet?.address);
  }
  return { userId: user.id, email, displayName, loginMethod };
}
