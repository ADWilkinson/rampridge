/**
 * Deposits listed with Galleon's Peer referral code TOFIAT (RampRidge,
 * usdctofiat and tokensto.cash sell orders). Curator pays the code's owner,
 * which is also RampRidge's buyer fee wallet, an integration share of Peer's
 * fee as a referral leg of its own, so a quote with RampRidge's 50 bps fee on
 * such a deposit asks for two legs to the same recipient.
 *
 * Found from recent real intents on Base mainnet whose legs already pay that
 * wallet, then quoted live against that one deposit.
 */

import { parseEventLogs, type Address, type Hex } from "viem";
import { BUY_REFERRER_FEE } from "@/config";
import { getDepositQuote, type BuyQuote } from "@/peer/market";
import { FIAT_CODES, isBuyPlatformId, type BuyPlatformId, type FiatCode } from "@/peer/platforms";
import type { Zkp2pClient } from "@zkp2p/sdk";
import { forkClient, mainnetClient } from "./fork";
import { ESCROW, ORCHESTRATOR, ORCHESTRATOR_ABI, currencyHash, paymentMethodName, readDeposit, type OnchainIntent } from "./peer";

export interface TofiatDeposit {
  depositId: bigint;
  platform: BuyPlatformId;
  currency: FiatCode;
}

const codeByHash = new Map(FIAT_CODES.map((code) => [currencyHash(code).toLowerCase(), code]));

export async function recentTofiatDeposits(opts: { blocks?: bigint; maxIntents?: number } = {}): Promise<TofiatDeposit[]> {
  const latest = await mainnetClient.getBlockNumber();
  const floor = latest - (opts.blocks ?? 40_000n);
  const found = new Map<string, TofiatDeposit>();
  let inspected = 0;
  for (let to = latest; to > floor && inspected < (opts.maxIntents ?? 400); to -= 5_000n) {
    const logs = await mainnetClient.getLogs({ address: ORCHESTRATOR, fromBlock: to - 4_999n, toBlock: to });
    const events = parseEventLogs({ abi: ORCHESTRATOR_ABI, logs, eventName: "IntentSignaled" }).reverse();
    const intents = await Promise.all(
      events.map((event) =>
        mainnetClient
          .readContract({
            address: ORCHESTRATOR,
            abi: ORCHESTRATOR_ABI,
            functionName: "getIntent",
            args: [(event.args as { intentHash: Hex }).intentHash],
            blockNumber: event.blockNumber,
          })
          .then((intent) => intent as OnchainIntent)
          .catch(() => null),
      ),
    );
    inspected += events.length;
    for (const intent of intents) {
      if (!intent || intent.escrow.toLowerCase() !== ESCROW.toLowerCase()) continue;
      if (!intent.referralFees.some((l) => l.recipient.toLowerCase() === BUY_REFERRER_FEE.recipient.toLowerCase())) continue;
      const platform = paymentMethodName(intent.paymentMethod);
      const currency = codeByHash.get(intent.fiatCurrency.toLowerCase());
      if (!platform || !isBuyPlatformId(platform) || !currency) continue;
      found.set(`${intent.depositId}:${platform}:${currency}`, { depositId: intent.depositId, platform, currency });
    }
  }
  return [...found.values()];
}

/** A live, fork-fillable quote on one of those deposits, or null. */
export async function tofiatQuote(
  client: Zkp2pClient,
  recipient: Address,
  deposits: readonly TofiatDeposit[],
): Promise<{ deposit: TofiatDeposit; quote: BuyQuote } | null> {
  for (const deposit of deposits) {
    for (const fiatAmount of ["20", "10", "50"]) {
      const quote = await getDepositQuote({
        platform: deposit.platform,
        currency: deposit.currency,
        fiatAmount,
        depositId: deposit.depositId.toString(),
        escrow: ESCROW,
        recipient,
        client,
      }).catch(() => null);
      if (!quote) continue;
      if ((await readDeposit(forkClient, deposit.depositId)).remainingDeposits < quote.signalAmount) continue;
      return { deposit, quote };
    }
  }
  return null;
}
