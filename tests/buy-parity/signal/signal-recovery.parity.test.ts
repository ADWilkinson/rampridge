/**
 * SIGNAL RECOVERY against the real contracts: when the wallet's answer is
 * lost after (or before) a signal is sent, RampRidge never resends a quote
 * until `reconcileSignal` has settled what the chain holds. The Curator
 * gating signature's expiry is what finally proves an unseen send can no
 * longer land, so that assumption is checked against OrchestratorV3 itself.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decodeErrorResult, type Hex, type TransactionReceipt } from "viem";
import { SignalSentError, cancelBuyIntent, reconcileSignal, signalBuyIntent } from "@/peer/buy/chain";
import { createPeerClient } from "@/peer/client";
import type { BuyQuote } from "@/peer/market";
import { TransactionPendingError, WalletError } from "@/wallet/errors";
import type { TxSender, WalletCall } from "@/wallet/types";
import { FALLBACK_PAIRS, PRIMARY_PAIRS, fillableQuotes, hasDuplicateRecipient, webReference } from "./helpers/cases";
import { assertOwnFork, eoaSender, forkClient, fundedAccount, revert, snapshot, type ForkAccount } from "./helpers/fork";
import { ORCHESTRATOR, ORCHESTRATOR_ABI, accountIntents, decodeSignal, readDeposit } from "./helpers/peer";

let forkStart: Hex;

/** How the wrapped wallet behaves on its next send. */
type Mode = "lose-answer-with-hash" | "lose-answer-without-hash" | "never-send";

/** RampRidge's real sender, but the wallet's answer is lost (or the send never happens) and it reports an unknown outcome. */
function lossySender(inner: TxSender, mode: Mode, seen: { data?: Hex }): TxSender {
  return {
    ...inner,
    async sendCalls(calls: WalletCall[], opts) {
      seen.data = calls[0]?.data;
      if (mode === "never-send") throw new WalletError("unknown", "wallet went away", { mayHaveLanded: true });
      const receipt: TransactionReceipt = await inner.sendCalls(calls, opts);
      if (mode === "lose-answer-with-hash") throw new TransactionPendingError(receipt.transactionHash);
      throw new WalletError("unknown", "wallet went away after sending", { mayHaveLanded: true });
    },
  };
}

async function freshQuote(fork: ForkAccount, sender: TxSender): Promise<BuyQuote> {
  const client = createPeerClient({ sender });
  for (const pair of [...PRIMARY_PAIRS, ...FALLBACK_PAIRS]) {
    for (const quote of await fillableQuotes(client, pair, fork.address)) {
      const web = await webReference(client, quote, fork.address);
      if (!hasDuplicateRecipient(web.withFee.params.referralFees)) return quote;
    }
  }
  throw new Error("no fillable quote");
}

const realClock = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now: () => Date.now() };

beforeAll(async () => {
  await assertOwnFork();
  forkStart = await snapshot();
});

afterAll(async () => {
  if (forkStart) await revert(forkStart);
});

describe("reconcileSignal on the fork", () => {
  for (const mode of ["lose-answer-with-hash", "lose-answer-without-hash"] as const) {
    test(`${mode}: SignalSentError, then the intent is found on-chain and is the one that was sent`, async () => {
      const fork = await fundedAccount();
      const real = eoaSender(fork);
      const quote = await freshQuote(fork, real);
      const seen: { data?: Hex } = {};
      const sender = lossySender(real, mode, seen);
      const client = createPeerClient({ sender });
      const sentAt = Date.now();
      const error = await signalBuyIntent(client, sender, quote).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SignalSentError);
      const sent = error as SignalSentError;
      expect(sent.orchestrator).toBe(ORCHESTRATOR);
      expect(sent.signatureExpiresAt).toBe(Number(decodeSignal(seen.data!).signatureExpiration) * 1000);
      if (mode === "lose-answer-with-hash") expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      else expect(sent.txHash).toBeNull();

      const outcome = await reconcileSignal(client, fork.address, quote, { ...sent, sentAt }, { timeoutMs: 30_000, ...realClock });
      expect(outcome.kind).toBe("found");
      const onchain = await accountIntents(forkClient, fork.address);
      if (outcome.kind !== "found") return;
      expect(onchain).toContain(outcome.signal.intentHash);
      expect(outcome.signal.amount).toBe(quote.signalAmount);
      expect(outcome.signal.rate).toBe(quote.rate);
      expect(outcome.signal.depositId).toBe(BigInt(quote.depositId));

      // Clean up through the real sender so the deposit's liquidity comes back.
      const before = await readDeposit(forkClient, BigInt(quote.depositId));
      await cancelBuyIntent(client, real, outcome.signal.intentHash, outcome.signal.orchestrator);
      const after = await readDeposit(forkClient, BigInt(quote.depositId));
      expect(after.remainingDeposits).toBe(before.remainingDeposits + quote.signalAmount);
    });
  }

  test("never sent: unknown while the signature can still land, lapsed only once it cannot, and OrchestratorV3 agrees", async () => {
    const fork = await fundedAccount();
    const real = eoaSender(fork);
    const quote = await freshQuote(fork, real);
    const seen: { data?: Hex } = {};
    const sender = lossySender(real, "never-send", seen);
    const client = createPeerClient({ sender });
    const sentAt = Date.now();
    const error = (await signalBuyIntent(client, sender, quote).then(
      () => null,
      (e: unknown) => e,
    )) as SignalSentError;
    expect(error).toBeInstanceOf(SignalSentError);
    expect(error.txHash).toBeNull();
    const params = decodeSignal(seen.data!);

    // Signature still valid: nothing on-chain yet, but the send could still land.
    const early = await reconcileSignal(client, fork.address, quote, { ...error, sentAt }, { timeoutMs: 1_000, intervalMs: 200, ...realClock });
    expect(early.kind).toBe("unknown");

    // The same call is still accepted now...
    await forkClient.call({ account: fork.address, to: ORCHESTRATOR, data: seen.data! });
    // ...and rejected by OrchestratorV3 once block time passes the signature's expiry.
    const expired = await forkClient
      .call({ account: fork.address, to: ORCHESTRATOR, data: seen.data!, blockOverrides: { time: params.signatureExpiration + 1n } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(expired).not.toBeNull();
    const revertData = findRevertData(expired);
    expect(revertData, "revert data from the expired call").not.toBeNull();
    expect(decodeErrorResult({ abi: ORCHESTRATOR_ABI, data: revertData! }).errorName).toBe("SignatureExpired");

    // Past expiry plus RampRidge's clock margin, with no intent on-chain: lapsed.
    const late = Number(params.signatureExpiration) * 1000 + 16 * 60 * 1000;
    const lapsed = await reconcileSignal(client, fork.address, quote, { ...error, sentAt }, {
      timeoutMs: 1_000,
      intervalMs: 200,
      sleep: realClock.sleep,
      now: () => late,
    });
    expect(lapsed.kind).toBe("lapsed");
  });
});

function findRevertData(error: unknown): Hex | null {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth += 1) {
    const data = (current as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) return data as Hex;
    if (data && typeof data === "object" && typeof (data as { data?: unknown }).data === "string") return (data as { data: Hex }).data;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
