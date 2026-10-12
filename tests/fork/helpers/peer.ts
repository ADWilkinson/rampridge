/**
 * Peer protocol facts the fork suites assert against: deployed addresses,
 * payment-method and currency hashes, and ERC-8021 attribution parsing.
 */

import { getGatingServiceAddress, getPaymentMethodsCatalog, resolveFiatCurrencyBytes32 } from "@zkp2p/sdk";
import { Attribution } from "ox/erc8021";
import { getAddress, type Address, type Hash, type Hex } from "viem";
import { USDC_ADDRESS } from "@/config";
import { forkClient } from "./anvil";
import { ESCROW, ORCHESTRATOR } from "./offchain";

export { ESCROW, ORCHESTRATOR };

export const WHITELIST_POLICY: Address = "0x389Cd9bA91FfFcd83d267B241E975541892759Ce";
export const GATING_SERVICE: Address = getAddress(getGatingServiceAddress(8453, "production"));
export const REFERRER_FEE_WALLET: Address = "0xC141Cbe4f4a9CAbc3cc78159a9268a4e008922CD";
/** Peer Pay merchant group (@zkp2p/cash CASH_ACCESS_GROUP_IDS.production, not exported by the package). */
export const PEER_PAY_GROUPS: readonly Hex[] = ["0x174b8a29536721a3eae290bfd55651b85a53fc334b971d993fa93ed8dde15e48"];

/**
 * The CDP paymaster allowlist for sponsored smart-wallet calls (USDC,
 * EscrowV2, OrchestratorV3, WhitelistPolicy). Every call the money paths
 * build must target one of these, or a sponsored user operation is refused.
 */
export const PAYMASTER_ALLOWLIST: ReadonlySet<string> = new Set(
  [USDC_ADDRESS, ESCROW, ORCHESTRATOR, WHITELIST_POLICY].map((a) => a.toLowerCase()),
);

const catalog = getPaymentMethodsCatalog(8453, "production");

export function paymentMethodHash(platform: string): Hex {
  const entry = catalog[platform];
  if (!entry) throw new Error(`No production payment method for ${platform}`);
  return entry.paymentMethodHash as Hex;
}

export function currencyHash(code: string): Hex {
  return resolveFiatCurrencyBytes32(code) as Hex;
}

/** ERC-8021 codes on a transaction's calldata, in order (empty when none). */
export function attributionCodes(data: Hex): string[] {
  const parsed = Attribution.fromData(data);
  return parsed && "codes" in parsed ? [...parsed.codes] : [];
}

export async function txInput(hash: Hash): Promise<{ to: Address | null; input: Hex }> {
  const tx = await forkClient.getTransaction({ hash });
  return { to: tx.to ?? null, input: tx.input };
}
