/**
 * Builds the stall a player advertises from one of their live deposits,
 * after checking on-chain that the deposit is theirs and can be filled: the
 * first active payment method this bank names, with a currency it knows and a
 * positive rate. stallSweep.ts re-runs this for open stalls.
 */

import { getCurrencyCodeFromHash, getPaymentMethodsCatalog, resolvePaymentMethodNameFromHash } from "@zkp2p/sdk";
import type { StallSummary } from "../../shared/protocol.js";
import { parseDepositId } from "../../shared/validate.js";
import type { ChainGateway } from "./chain.js";
import { CHAIN_ID } from "./chain.js";
import { badRequest, forbidden, HttpError } from "./http.js";
import { formatRate, formatUsdc } from "./units.js";

const catalog = getPaymentMethodsCatalog(CHAIN_ID, "production");

export function platformName(paymentMethodHash: string): string | null {
  return resolvePaymentMethodNameFromHash(paymentMethodHash, catalog) ?? null;
}

export function currencyCode(currencyHash: string): string | null {
  return getCurrencyCodeFromHash(currencyHash) ?? null;
}

export async function buildStall(chain: ChainGateway, depositIdInput: string, wallet: string): Promise<StallSummary> {
  const parsed = parseDepositId(depositIdInput);
  if (!parsed) throw badRequest("That is not a deposit id.");
  const { escrow, usdc } = chain.contracts;
  if (parsed.escrow && parsed.escrow !== escrow) {
    throw badRequest("That deposit is on an older Peer escrow and can't be advertised.");
  }
  const id = BigInt(parsed.id);

  const deposit = await chain.readDeposit(id);
  if (!deposit) throw new HttpError(404, "not_found", "That deposit does not exist.");
  if (deposit.depositor !== wallet.toLowerCase()) throw forbidden("That deposit belongs to a different wallet.");
  if (deposit.token !== usdc) throw badRequest("Only USDC deposits can be advertised.");
  if (!deposit.acceptingIntents) throw badRequest("That deposit is paused and not accepting orders.");
  if (deposit.available <= 0n) throw badRequest("That deposit has no USDC left to sell.");

  for (const method of deposit.paymentMethods) {
    if (!method.active) continue;
    const platform = platformName(method.hash);
    if (!platform) continue;
    for (const currency of method.currencies) {
      const code = currencyCode(currency.code);
      if (!code) continue;
      const rate = (await chain.effectiveRate(id, method.hash, currency.code)) ?? currency.minConversionRate;
      if (rate <= 0n) continue;
      return {
        depositId: `${escrow}_${id}`,
        escrow,
        platform,
        currency: code,
        available: formatUsdc(deposit.available),
        rate: formatRate(rate),
      };
    }
  }
  throw badRequest("That deposit has no active payment method this bank supports.");
}
