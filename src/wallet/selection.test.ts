import { describe, expect, it } from "vitest";
import {
  describeAccount,
  fallbackEoaAddress,
  selectWallet,
  type ConnectedWalletLike,
  type SelectionInput,
  type UserLike,
} from "./selection";
import { PEER_PRIVY_APP_ID } from "./constants";

const SMART = "0x5555555555555555555555555555555555555555";
const EMBEDDED = "0x6666666666666666666666666666666666666666";
const METAMASK = "0x7777777777777777777777777777777777777777";
const PEER = "0x8888888888888888888888888888888888888888";

const embeddedAccount = {
  type: "wallet",
  address: EMBEDDED,
  chainType: "ethereum",
  walletClientType: "privy",
  imported: false,
  walletIndex: 0,
  id: "wallet-id",
  recoveryMethod: "privy-v2",
};
const embeddedConnected: ConnectedWalletLike = { address: EMBEDDED, walletClientType: "privy" };
const metamaskConnected: ConnectedWalletLike = { address: METAMASK, walletClientType: "metamask", meta: { name: "MetaMask" } };

function input(user: UserLike | null, overrides: Partial<SelectionInput<ConnectedWalletLike>> = {}) {
  return {
    user,
    wallets: [],
    walletsReady: true,
    smartClientAddress: null,
    smartGraceExpired: false,
    peerAppId: PEER_PRIVY_APP_ID,
    ...overrides,
  } satisfies SelectionInput<ConnectedWalletLike>;
}

describe("selectWallet", () => {
  it("is none when logged out", () => {
    expect(selectWallet(input(null))).toEqual({ status: "none" });
  });

  it("uses the smart wallet once its client matches the linked smart account", () => {
    const user: UserLike = {
      id: "did:privy:1",
      smartWallet: { address: SMART },
      linkedAccounts: [embeddedAccount, { type: "smart_wallet", address: SMART }],
    };
    expect(selectWallet(input(user, { wallets: [embeddedConnected] }))).toEqual({
      status: "preparing",
      source: "smart",
      address: SMART,
    });
    expect(selectWallet(input(user, { wallets: [embeddedConnected], smartClientAddress: SMART.toUpperCase() }))).toEqual(
      { status: "ready", source: "smart", address: SMART },
    );
  });

  it("waits for the smart wallet before falling back to the embedded EOA", () => {
    const user: UserLike = { id: "did:privy:2", linkedAccounts: [embeddedAccount] };
    expect(selectWallet(input(user, { wallets: [embeddedConnected] }))).toMatchObject({
      status: "preparing",
      source: "smart",
    });
    expect(selectWallet(input(user, { wallets: [embeddedConnected], smartGraceExpired: true }))).toMatchObject({
      status: "ready",
      source: "embedded",
      address: EMBEDDED,
      sponsored: true,
    });
  });

  it("keeps a pinned embedded fallback after the smart wallet links, so the address does not flip mid-session", () => {
    const user: UserLike = {
      id: "did:privy:2",
      smartWallet: { address: SMART },
      linkedAccounts: [embeddedAccount, { type: "smart_wallet", address: SMART }],
    };
    const linked = input(user, { wallets: [embeddedConnected], smartClientAddress: SMART });
    expect(selectWallet({ ...linked, pinnedEmbeddedAddress: EMBEDDED.toUpperCase() })).toMatchObject({
      status: "ready",
      source: "embedded",
      address: EMBEDDED,
    });
    expect(selectWallet({ ...linked, pinnedEmbeddedAddress: METAMASK })).toMatchObject({ source: "smart" });
    expect(selectWallet(linked)).toMatchObject({ source: "smart" });
  });

  it("exposes the embedded EOA behind a selected smart wallet", () => {
    const user: UserLike = {
      id: "did:privy:2",
      smartWallet: { address: SMART },
      linkedAccounts: [embeddedAccount, { type: "smart_wallet", address: SMART }],
    };
    const smart = selectWallet(input(user, { wallets: [embeddedConnected], smartClientAddress: SMART }));
    expect(fallbackEoaAddress(user, smart)).toBe(EMBEDDED);
    const pinned = selectWallet(input(user, { wallets: [embeddedConnected], pinnedEmbeddedAddress: EMBEDDED }));
    expect(fallbackEoaAddress(user, pinned)).toBeNull();
    const withoutSmart: UserLike = { id: "did:privy:2", linkedAccounts: [embeddedAccount] };
    expect(fallbackEoaAddress(withoutSmart, selectWallet(input(withoutSmart)))).toBeNull();
    expect(fallbackEoaAddress(null, { status: "none" })).toBeNull();
  });

  it("only sponsors embedded wallets on Privy's TEE stack", () => {
    const user: UserLike = {
      id: "did:privy:3",
      linkedAccounts: [{ ...embeddedAccount, recoveryMethod: "privy", id: null }],
    };
    expect(selectWallet(input(user, { wallets: [embeddedConnected], smartGraceExpired: true }))).toMatchObject({
      source: "embedded",
      sponsored: false,
    });
  });

  it("uses the Peer cross-app wallet for a Peer login without an embedded wallet", () => {
    const user: UserLike = {
      id: "did:privy:4",
      linkedAccounts: [
        { type: "cross_app", providerApp: { id: PEER_PRIVY_APP_ID }, embeddedWallets: [{ address: PEER }] },
      ],
    };
    expect(selectWallet(input(user))).toEqual({ status: "ready", source: "cross_app", address: PEER });
  });

  it("uses the linked external wallet, ignoring unlinked connected wallets", () => {
    const stranger: ConnectedWalletLike = {
      address: "0x9999999999999999999999999999999999999999",
      walletClientType: "rabby_wallet",
    };
    const user: UserLike = {
      id: "did:privy:5",
      wallet: { address: METAMASK },
      linkedAccounts: [{ type: "wallet", address: METAMASK, chainType: "ethereum", walletClientType: "metamask" }],
    };
    expect(selectWallet(input(user, { wallets: [stranger, metamaskConnected] }))).toMatchObject({
      status: "ready",
      source: "external",
      address: METAMASK,
      wallet: metamaskConnected,
    });
    expect(selectWallet(input(user, { wallets: [stranger] }))).toEqual({
      status: "reconnect",
      source: "external",
      address: METAMASK,
    });
    expect(selectWallet(input(user, { wallets: [], walletsReady: false }))).toMatchObject({ status: "preparing" });
  });

  it("reports no wallet once wallets are loaded", () => {
    const user: UserLike = { id: "did:privy:6", linkedAccounts: [{ type: "email", address: "a@b.co" }] };
    expect(selectWallet(input(user))).toEqual({ status: "no_wallet" });
    expect(selectWallet(input(user, { walletsReady: false }))).toMatchObject({ status: "preparing" });
  });
});

describe("describeAccount", () => {
  it("uses the most recent login method and never a wallet created by Privy", () => {
    const user: UserLike = {
      id: "did:privy:7",
      email: { address: "player@example.com" },
      linkedAccounts: [
        { type: "email", address: "player@example.com", latestVerifiedAt: new Date(1000) },
        { ...embeddedAccount, latestVerifiedAt: new Date(5000) },
        { type: "smart_wallet", address: SMART, latestVerifiedAt: new Date(6000) },
      ],
    };
    expect(describeAccount(user)).toEqual({
      userId: "did:privy:7",
      email: "player@example.com",
      displayName: "player@example.com",
      loginMethod: "email",
    });
  });

  it("labels Peer, X and wallet logins", () => {
    expect(
      describeAccount({
        id: "p",
        linkedAccounts: [{ type: "cross_app", providerApp: { id: PEER_PRIVY_APP_ID }, embeddedWallets: [] }],
      }),
    ).toMatchObject({ loginMethod: "peer", displayName: "Peer account" });
    expect(
      describeAccount({ id: "x", linkedAccounts: [{ type: "twitter_oauth", username: "zezima", name: "Zezima" }] }),
    ).toMatchObject({ loginMethod: "twitter", displayName: "@zezima" });
    expect(
      describeAccount({
        id: "w",
        linkedAccounts: [{ type: "wallet", address: METAMASK, walletClientType: "metamask" }],
      }),
    ).toMatchObject({ loginMethod: "wallet", displayName: "0x7777…7777" });
  });

  it("prefers the Google email when there is no email login", () => {
    expect(
      describeAccount({ id: "g", linkedAccounts: [{ type: "google_oauth", email: "g@example.com", name: "G" }] }),
    ).toMatchObject({ loginMethod: "google", email: "g@example.com", displayName: "g@example.com" });
  });
});
