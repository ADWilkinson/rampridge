/**
 * Peer sell (cash-out) flow: a player lists USDC as a Peer Cash deposit and is
 * paid fiat by buyers. Headless; the bank UI renders on top of these hooks.
 */

export { getCashClient, sellCapabilities, findPlatform, fetchSellRate, fetchFillStats, estimateReceive } from "./cash";
export { etaFromFillStats, fillStatsKey, formatDuration, preferredCurrency, registrationRouteFor, RATE_PROBE_AMOUNT } from "./cash";
export { ZELLE_ENROLLMENT_TEXT } from "./cash";
export { singleOrderPolicy, singleOrderRule, singleOrderRange, intentAmountRangeFor, SINGLE_ORDER_MIN_GAP } from "./singleOrder";
export type { SingleOrderPolicy } from "./singleOrder";
export {
  SELL_SPREAD_ENABLED,
  SPREAD_MIN_BPS,
  SPREAD_MAX_BPS,
  SPREAD_STEP_BPS,
  isValidSpreadBps,
  clampSpreadBps,
  parseSpreadPercent,
  formatSpreadPercent,
  spreadRate,
} from "./spreadRate";
export { getSellSdkClient, prepareSpreadSell, sellAttributionCodes } from "./spread";
export type { SellSdkClient, PrepareSpreadSellInput } from "./spread";
export { withSpreadOrders, readSpreadOrder, readSpreadOrders, isSpreadPayoutSet, orderSpreadBps } from "./spreadOrders";
export type { SpreadOrderSdk } from "./spreadOrders";
export type { SellCapabilities, SellPlatform, SellRate, SellEta, SellLiquidity, PayeeRegistrationRoute } from "./cash";

export { parseUsdcAmount, formatUsdcAmount, formatUsdcInput, usdcToNumber } from "./amount";
export type { UsdcParseResult, UsdcFormatOptions } from "./amount";

export { normalizePayee, payeeField, platformName, displayPayee } from "./payees";
export type { PayeeField, PayeeFormat } from "./payees";

export { checkPayee, classifyPayeeError, payeeCheckKey, payeeConfirmedBy } from "./validatePayee";
export type { PayeeCheck, PayeeCheckInput } from "./validatePayee";

export {
  registerPayeeWithPeerExtension,
  peerRegistrationKind,
  peerRegistrationMinVersion,
  canUsePeerExtension,
  getPeerExtensionState,
  openPeerExtensionInstall,
  identityParamsFrom,
  PeerRegistrationError,
  PEER_WEB_URL,
} from "./identity";
export type {
  PeerRegistrationKind,
  PeerRegistrationPhase,
  PeerRegistrationErrorCode,
  PeerRegistrationInput,
  PeerRegistrationResult,
} from "./identity";

export { SellFlowError, isSellFlowError, toSellFlowError, sellError, provenNotBroadcast, classifySendFailure } from "./errors";
export type { SellErrorCode, SellLocalErrorCode, SellRecovery, SellRecoveryAction, SellErrorStage, SendFailure } from "./errors";

export { evaluateSell, toReceive, createLeg, initialSteps, isPristine, legCheckKey, checkCurrencies, enrollmentConfirmed } from "./machine";
export type {
  SellPhase,
  SellLegDraft,
  LegCheckState,
  SubmitStepId,
  SubmitStepStatus,
  SubmitSteps,
  ResolvedLeg,
  ListedSell,
  SubmissionState,
  SellDraftState,
  SellIssue,
  SellIssueCode,
  GasState,
  SellContext,
  SellEvaluation,
} from "./machine";

export {
  submitSell,
  retryAccessPolicy,
  reconcilePendingSell,
  discardPendingSell,
  reconcileError,
  isSellInFlight,
  userOperationReverted,
  toWalletCall,
  DISCARD_AFTER_MS,
  EOA_DISCARD_AFTER_MS,
  ABANDON_AFTER_MS,
} from "./submit";
export type { SellDeps, SellCashClient, SellPublicClient, SubmitSellInput, ReconcileResult, AccessPolicyFallback } from "./submit";

export {
  createPendingSellStore,
  defaultPendingSellStore,
  browserStorage,
  memoryStorage,
  rememberLastSellDeposit,
  readLastSellDeposit,
} from "./persistence";
export type {
  PendingSellRecord,
  PendingSellBaseline,
  PendingSellStore,
  PendingSellStage,
  KeyValueStorage,
  LastSellDeposit,
} from "./persistence";

export { useSellStore } from "./store";
export type { SellStore } from "./store";

export { useSellFlow } from "./useSellFlow";
export type { UseSellFlowOptions, SellFlow, SellLegView, LegRegistration, SellExtensionDeps } from "./useSellFlow";

export { useSellEstimate, useFillStats } from "./useSellEstimate";
export type { SellEstimate, SellEstimateInput } from "./useSellEstimate";

export { toSellOrderRow, fetchSellOrders, fetchSellOrder, withdrawSellOrder, topUpSellOrder, watchSellOrder } from "./orders";
export type { SellOrderRow, SellOrderTxResult, SellOrderDeps, WatchSellOrderOptions } from "./orders";

export { useMyCashOrders, useWatchedSellOrder, useSellOrderActions, useBuyerProfile, useLastSellDeposit } from "./useSellOrders";
export type { SellOrderAction } from "./useSellOrders";

export { readUsdcBalance, readGasBalance, useUsdcBalance, useGasBalance } from "./balance";
export type { BalanceQuery, BalanceReader, GasReader } from "./balance";

export { sellQueryKeys } from "./queryKeys";
