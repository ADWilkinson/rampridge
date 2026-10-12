// Buffer/process globals must exist before Privy and WalletConnect evaluate (main.tsx installs them first too).
// oxlint-disable-next-line import/no-unassigned-import
import "@/lib/polyfills";

import { PrivyProvider, usePrivy, type PrivyClientConfig } from "@privy-io/react-auth";
import { SmartWalletsProvider } from "@privy-io/react-auth/smart-wallets";
import { useEffect, useLayoutEffect } from "react";
import { PRIVY_APP_ID, PRIVY_CLIENT_ID } from "@/config";
import { PEER_PRIVY_APP_ID, WALLET_CHAIN, WALLETCONNECT_PROJECT_ID } from "@/wallet/constants";
import { WalletGesturePrompt } from "@/wallet/WalletGesturePrompt";
import { WalletProvider, useWallet } from "@/wallet/WalletProvider";
import { useWalletBridge } from "./wallet";

/**
 * The wallet stack, its own chunk (loaded by `./wallet`): Privy (login and
 * embedded wallets), Privy smart wallets, the wallet context behind
 * `useWallet()`, and the prompt for blocked Peer wallet windows. It renders
 * beside the game rather than around it and publishes the wallet to the
 * shell's wallet bridge, so the game never remounts when it arrives.
 */

/** OSRS interface orange. */
const ACCENT = "#ff981f";
/**
 * OSRS interface brown as Privy's background. Privy treats a background under 50% relative luminance as dark
 * (this one is about 4%) and derives the rest of its palette from it, so the login window reads as part of the game.
 */
const THEME = "#3e3529";

const privyConfig: PrivyClientConfig = {
  appearance: {
    theme: THEME,
    accentColor: ACCENT,
    logo: "/game/ui/privy-logo.png",
    landingHeader: "Enter RampRidge",
    loginMessage: "Log in to trade at the Bank of RampRidge",
    walletChainType: "ethereum-only",
    walletList: ["detected_ethereum_wallets", "base_account", "coinbase_wallet", "metamask", "phantom", "wallet_connect"],
  },
  loginMethodsAndOrder: {
    // Peer account first, as in USDCtoFiat: existing Peer users log in with one click.
    // Privy renders at most four primary methods and warns beyond that; the rest go to "More options".
    primary: [`privy:${PEER_PRIVY_APP_ID}`, "email", "google", "detected_ethereum_wallets"],
    // wallet_connect expands into the full WalletConnect registry, so it goes last or it buries X and Apple.
    // Rabby is offered through detected_ethereum_wallets (EIP-6963); Privy no longer supports its dedicated entry.
    overflow: ["base_account", "coinbase_wallet", "metamask", "phantom", "twitter", "apple", "wallet_connect"],
  },
  embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
  defaultChain: WALLET_CHAIN,
  supportedChains: [WALLET_CHAIN],
  walletConnectCloudProjectId: WALLETCONNECT_PROJECT_ID,
};

/** Hands the wallet and the login modal's state to the shell, and opens a login asked for while Privy loaded. */
function WalletBridge() {
  const wallet = useWallet();
  const { isModalOpen } = usePrivy();
  const loginQueued = useWalletBridge((s) => s.loginQueued);
  // Before paint, so the shell never draws a frame with the loading wallet once this one exists.
  useLayoutEffect(() => {
    useWalletBridge.setState({ wallet, modalOpen: isModalOpen });
  }, [wallet, isModalOpen]);
  const { ready, authenticated, login } = wallet;
  useEffect(() => {
    if (!loginQueued || !ready) return;
    useWalletBridge.setState({ loginQueued: false });
    if (!authenticated) login();
  }, [loginQueued, ready, authenticated, login]);
  return null;
}

export function WalletStack() {
  return (
    <PrivyProvider appId={PRIVY_APP_ID} clientId={PRIVY_CLIENT_ID} config={privyConfig}>
      <SmartWalletsProvider>
        <WalletProvider>
          <WalletBridge />
          <WalletGesturePrompt />
        </WalletProvider>
      </SmartWalletsProvider>
    </PrivyProvider>
  );
}
