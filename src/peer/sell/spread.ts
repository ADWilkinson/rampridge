/**
 * Seller spread on the live oracle rate, as Peer's web app offers it when a
 * deposit is created (helpers/depositRateConfig.ts buildSpreadOracleRateConfig,
 * NewDeposit/utils/computeSpreadRate.ts): every currency keeps its spread
 * oracle (adapter, adapter config, max staleness, the 1 wei minimum
 * conversion rate sentinel) and only `spreadBps` changes. A buyer pays
 * oracle x (1 + spreadBps / 10000) fiat per USDC, so a positive spread pays
 * the seller more and a negative one fills faster. Peer web allows -5% to +5%
 * for a new deposit.
 *
 * A 0% spread is Peer Cash's own `prepare()` unchanged (submit.ts). Peer Cash
 * 0.7.2 only builds zero-spread tuples, so a non-zero spread is built here
 * with Peer Cash's exported `prepareCashDepositParams` (the same Curator
 * `makers/create` registration and error mapping, payment-method hashes,
 * gating service, intent range and retainOnEmpty), the spread set on each
 * oracle tuple, and the same approve + createDeposit calls with the same
 * ERC-8021 codes. Peer Cash's order reads refuse such a deposit; see
 * `spreadOrders.ts`.
 */

import {
  CASH_ATTRIBUTION_CODE,
  errors,
  isCashError,
  normalizeCashPayee,
  prepareCashDepositParams,
  toCashReferralAttributionCode,
  type PrepareResult,
  type PreparedTransaction,
} from "@zkp2p/cash";
import {
  Zkp2pClient,
  appendAttributionToCalldata,
  getPaymentMethodsCatalog,
  resolvePaymentMethodHashFromCatalog,
  type OnchainCurrency,
} from "@zkp2p/sdk";
import { createWalletClient, encodeFunctionData, http, parseAbi, type Hex } from "viem";
import { base } from "viem/chains";
import { BASE_RPC_URL, CHAIN_ID, PEER_API_URL, PEER_REFERRAL_CODE, PEER_REFERRER } from "@/config";
import type { ResolvedLeg } from "./machine";
import { isValidSpreadBps } from "./spreadRate";

// ---------------------------------------------------------------------------
// The SDK client (built as Peer Cash builds its read client)
// ---------------------------------------------------------------------------

/** The parts of the SDK client the spread path and the spread-order reads use. */
export type SellSdkClient = Pick<
  Zkp2pClient,
  | "chainId"
  | "runtimeEnv"
  | "registerPayeeDetails"
  | "prepareCreateDeposit"
  | "indexer"
  | "withdrawDeposit"
  | "removeFunds"
  | "pruneExpiredIntents"
  | "addFunds"
>;

let sdkClient: Zkp2pClient | null = null;

/** Production, Curator at api.zkp2p.xyz, Base RPC, no account: reads and unsigned prepares only. */
export function getSellSdkClient(): Zkp2pClient {
  const transport = http(BASE_RPC_URL);
  sdkClient ??= new Zkp2pClient({
    walletClient: createWalletClient({ chain: base, transport }),
    chainId: CHAIN_ID,
    runtimeEnv: "production",
    rpcTransport: transport,
    rpcUrl: BASE_RPC_URL,
    baseApiUrl: PEER_API_URL,
  } as ConstructorParameters<typeof Zkp2pClient>[0]);
  return sdkClient;
}

/** The ERC-8021 codes every sell transaction carries, in Peer Cash's order (peer-cash, peer-ref-TOFIAT, rampridge). */
export function sellAttributionCodes(): string[] {
  return [CASH_ATTRIBUTION_CODE, toCashReferralAttributionCode(PEER_REFERRAL_CODE), PEER_REFERRER];
}

/** Peer Cash's restricted (Peer Pay) platforms: their legs get an access policy after the deposit. */
const ACCESS_POLICY_PLATFORMS: ReadonlySet<string> = new Set(["venmo", "paypal"]);
/** Platforms whose new payees need an identity attestation (Peer Cash's list). */
const IDENTITY_ATTESTATION_PLATFORMS: ReadonlySet<string> = new Set(["wise", "paypal", "alipay"]);
const ERC20_APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

function paymentMethodHashOf(platform: string): Hex {
  return resolvePaymentMethodHashFromCatalog(platform, getPaymentMethodsCatalog(CHAIN_ID, "production") as never) as Hex;
}

type DepositParams = Awaited<ReturnType<typeof prepareCashDepositParams>>;

/** The tuple with the seller's spread on its oracle; refuses a tuple without one (never a fixed rate). */
function withSpread(tuple: OnchainCurrency, spreadBps: number): OnchainCurrency {
  const oracle = tuple.oracleRateConfig;
  if (!oracle) throw new Error("Spread needs a live oracle for every currency");
  return { ...tuple, oracleRateConfig: { ...oracle, spreadBps } };
}

export interface PrepareSpreadSellInput {
  /** USDC base units. */
  amount: bigint;
  legs: readonly Pick<ResolvedLeg, "platform" | "currencies" | "offchainId">[];
  /** Non-zero, inside Peer's -500..+500 bps. */
  spreadBps: number;
  /** Peer's single-order range (Alipay); Peer Cash's default otherwise. */
  intentAmountRange?: { min: bigint; max: bigint };
}

/**
 * Peer Cash's `prepare()` with the seller's spread on every oracle tuple:
 * the approve + createDeposit batch, the registered payee hashes and the Peer
 * Pay payment methods that need an access policy afterwards.
 */
export async function prepareSpreadSell(sdk: Pick<SellSdkClient, "chainId" | "runtimeEnv" | "registerPayeeDetails" | "prepareCreateDeposit">, input: PrepareSpreadSellInput): Promise<PrepareResult> {
  const { amount, legs, spreadBps, intentAmountRange } = input;
  if (!isValidSpreadBps(spreadBps) || spreadBps === 0) throw new Error(`Invalid spread: ${spreadBps} bps`);
  if (legs.length === 0) throw errors.invalidPayoutPlatforms("at least one payout leg is required");
  const payouts = legs.map((leg) => {
    const [first, ...rest] = leg.currencies;
    if (!first) throw errors.invalidPayoutCurrencies(leg.platform, "at least one currency is required");
    return {
      processorName: leg.platform,
      ...(rest.length === 0 ? { currency: first } : { currencies: [first, ...rest] }),
      payeeData: normalizeCashPayee(leg.platform, leg.offchainId),
    };
  });

  let params: DepositParams;
  try {
    params = await prepareCashDepositParams(sdk as never, { amount, payouts, ...(intentAmountRange ? { intentAmountRange } : {}) } as never);
  } catch (err) {
    // Peer Cash's buildDepositParams mapping, so the payee check and listing classify both paths alike.
    if (isCashError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/identityAttestation is required|identity attestation/i.test(message)) {
      const platforms = legs.map((leg) => leg.platform);
      const platform = platforms.find((p) => IDENTITY_ATTESTATION_PLATFORMS.has(p)) ?? platforms[0] ?? "this platform";
      throw errors.payeeVerificationRequired(platform, err);
    }
    throw errors.payeeRegistrationFailed(err);
  }

  if (!params.currenciesOverride?.length) throw new Error("Peer Cash built no currency tuples");
  const currenciesOverride = params.currenciesOverride.map((leg) => leg.map((tuple) => withSpread(tuple, spreadBps)));
  const referrer = sellAttributionCodes();
  const { prepared } = await sdk.prepareCreateDeposit({ ...params, currenciesOverride, txOverrides: { referrer } } as never);
  const approve: PreparedTransaction = {
    to: params.token as Hex,
    data: appendAttributionToCalldata(
      encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [prepared.to, amount] }),
      referrer,
    ) as Hex,
    value: 0n,
    chainId: CHAIN_ID,
  };
  const accessPolicyPaymentMethods = [
    ...new Set(legs.filter((leg) => ACCESS_POLICY_PLATFORMS.has(leg.platform.toLowerCase())).map((leg) => paymentMethodHashOf(leg.platform))),
  ];
  return {
    txs: [approve, prepared as PreparedTransaction],
    steps: [
      { kind: "approve", description: "Approve Base USDC for the Peer Cash escrow." },
      { kind: "createDeposit", description: "Create the protocol-held cash-out order." },
    ],
    register: { hashedOnchainIds: (params.paymentMethodDataOverride ?? []).map((d) => d.payeeDetails) },
    accessPolicyRequired: accessPolicyPaymentMethods.length > 0,
    accessPolicyPaymentMethods,
  } as PrepareResult;
}
