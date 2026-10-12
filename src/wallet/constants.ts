import { base } from "viem/chains";

/** The only chain this app transacts on (Base mainnet, `CHAIN_ID` in config). */
export const WALLET_CHAIN = base;

/**
 * Peer's own Privy app. Listing it as a `privy:` login method lets players log
 * in with their existing Peer account (Privy cross-app accounts).
 */
export const PEER_PRIVY_APP_ID = "clsc93lh705okcyxx8tkc650d";

/** WalletConnect Cloud project shared with the USDCtoFiat reference app (public id). */
export const WALLETCONNECT_PROJECT_ID = "936fb8b9cdbb127916fb83240e6f1c38";

/** Public Base RPC, used when the configured RPC is unavailable. It refuses eth_getLogs. */
export const FALLBACK_BASE_RPC_URL = "https://mainnet.base.org";

/** A public Base RPC that serves eth_getLogs (PublicNode), for `historyClient`. */
export const PUBLIC_LOGS_BASE_RPC_URL = "https://base-rpc.publicnode.com";

/** How long to wait for a submitted transaction to be mined before reporting it as pending. */
export const RECEIPT_TIMEOUT_MS = 180_000;

/**
 * After login Privy creates the embedded wallet first and links the smart
 * wallet a few seconds later. Embedded users wait this long for the smart
 * wallet before falling back to the embedded EOA, so the player's address does
 * not flip from the EOA to the smart account mid-session.
 */
export const SMART_WALLET_GRACE_MS = 20_000;

export const BALANCE_REFETCH_MS = 15_000;
