/**
 * Public runtime configuration. Everything here ships to the browser, so it
 * must only contain identifiers that are safe to expose.
 */

export const SITE_URL = "https://www.rampridge.xyz";

export const CHAIN_ID = 8453;
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const USDC_DECIMALS = 6;

/**
 * Peer protocol contracts on Base (production), as `@zkp2p/sdk`'s
 * `getContracts(8453, "production")` lists them; a test keeps the two equal.
 * USDC transferred straight to any of them is stuck there, so Send refuses
 * them as recipients. EscrowV2, OrchestratorV3 and WhitelistPolicy (with
 * USDC) are also the gas sponsor's allowlist for smart wallets.
 */
export const PEER_CONTRACTS = {
  EscrowV2: "0x777777779d229cdF3110e9de47943791c26300Ef",
  OrchestratorV3: "0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7",
  OrchestratorV2: "0x888888359E981B5225CA48fbCdCeff702FC3b888",
  WhitelistPolicy: "0x389Cd9bA91FfFcd83d267B241E975541892759Ce",
  UnifiedPaymentVerifier: "0xC6F4a193576C60892a47e111Bb5706c30162502B",
  ProtocolViewer: "0xC8A622e1614BB58141E72e1D6023B16f08677d6c",
  RateManagerV1: "0xeEd7Db23e724aC4590D6dB6F78fDa6DB203535F3",
  OrchestratorRegistry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
  IntentGuardian: "0x83671606454fA72ba1e2831E18C5090D25629414",
  ChainlinkOracleAdapter: "0x53881a928abD61C095e5f30b63bc554872C3b2f1",
  PythOracleAdapter: "0xad0b0126A657c0674d0DF53B2A2554D43bbb41D0",
  AddressGroupRegistry: "0x39F80118f9eB619135f116171b6Cb91D372C5AF2",
  StakeVault: "0x47c26258222e2f96424bD2B21bf173f0DA5034C7",
  DisputeProtectionPolicy: "0xbF4B769dB70DBEc89b6b2c44988304a7aD2de4Fc",
} as const;

/**
 * Contracts the CDP paymaster sponsors calls to for smart wallets (its
 * allowlist). The live policy is the authority (CDP portal, Paymaster,
 * Configuration); on 2026-10-12 pm_getPaymasterStubData sponsored a call to
 * each of these, including the Send interface's USDC.transfer, and refused
 * any other target ("called address not in allowlist").
 */
export const SPONSORED_CALL_TARGETS: readonly string[] = [
  USDC_ADDRESS,
  PEER_CONTRACTS.EscrowV2,
  PEER_CONTRACTS.OrchestratorV3,
  PEER_CONTRACTS.WhitelistPolicy,
];

/** Peer production API (Curator). CORS is open for browser callers. */
export const PEER_API_URL = "https://api.zkp2p.xyz";
/** The only attestation host the Peer extension accepts in production. */
export const PEER_ATTESTATION_URL = "https://attestation-service.zkp2p.xyz";
/** ERC-8021 builder code: analytics attribution for every transaction this app sends. */
export const PEER_REFERRER = "rampridge";

/**
 * Galleon's Peer referral code, shared with usdctofiat and tokensto.cash.
 * Deposits created here carry the `peer-ref-TOFIAT` marker, and Curator pays
 * the wallet that owns TOFIAT an integration share of Peer's fee on fills.
 * Sellers pay nothing extra for it.
 */
export const PEER_REFERRAL_CODE = "TOFIAT";
export const PEER_INTEGRATION_MARKER = `peer-ref-${PEER_REFERRAL_CODE}` as const;

/** Attribution codes on every transaction: builder code first, then the integration marker. */
export const PEER_ATTRIBUTION: readonly string[] = [PEER_REFERRER, PEER_INTEGRATION_MARKER];

/**
 * Buyer-side integrator fee, the same terms as usdctofiat's OTC buys: 50 bps
 * of each purchase, paid to Galleon's fee wallet out of the USDC the intent
 * releases. Quotes include it, so the USDC a player is shown is already net.
 */
export const BUY_REFERRER_FEE = {
  recipient: "0xC141Cbe4f4a9CAbc3cc78159a9268a4e008922CD",
  feeBps: 50,
} as const;

/**
 * Privy: the Galleon Labs app ("USDCtoFiat by Galleon Labs") with the web
 * client whose allowed origins already include https://www.rampridge.xyz and
 * http://localhost:5173. Smart wallets on Base are sponsored by that app.
 */
export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID ?? "cmcq3o9ro00e2k10lklib7oo1";
export const PRIVY_CLIENT_ID =
  import.meta.env.VITE_PRIVY_CLIENT_ID ?? "client-WY6N5YPHVn989LYEPNjMZHWZdofG2aKymVdhKtusfSWco";

export const BASE_RPC_URL = import.meta.env.VITE_BASE_RPC_URL ?? "https://mainnet.base.org";

/** Realtime world state (read-only for browsers). */
export const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  projectId: "peerlyticsapp",
  databaseURL: "https://rampridge-world.firebaseio.com",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
  /**
   * Dev server only: the local database emulator the dev API writes to
   * (vite.config.ts sets VITE_RTDB_EMULATOR_HOST from
   * FIREBASE_DATABASE_EMULATOR_HOST), so a local browser sees local players
   * and never watches the live database. Production builds ignore it.
   */
  emulatorHost: import.meta.env.DEV ? ((import.meta.env.VITE_RTDB_EMULATOR_HOST as string | undefined) ?? "") : "",
};

export const PEER_EXTENSION_INSTALL_URL =
  "https://chromewebstore.google.com/detail/peerauth-authenticate-and/ijpgccednehjpeclfcllnjjcmiohdjih";
