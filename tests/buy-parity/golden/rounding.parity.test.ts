/**
 * "Send exactly" amounts against real intents (fixtures/rounding.json, built by
 * discover-rounding.ts from every IntentSignaled on OrchestratorV3 in ~3 days).
 *
 * The attestation service releases floor(paid x 1e22 / rate), capped at the
 * intent amount (formula checked against 20 real attestations in
 * golden-fulfil.parity.test.ts). So the least payment that releases the whole
 * intent is ceil(amount x rate / 1e22) minor units. RampRidge's fiatToSend
 * (src/peer/buy/amounts.ts) floors amount x rate to 6-decimal fiat first and
 * only then rounds up to the cent, exactly like Peer's web app. When the exact
 * product lies just past a whole cent, the floor lands on the cent and the
 * amount shown is one cent short: a buyer who pays exactly what RampRidge says
 * gets amount - 1 base unit released (a partial fulfilment) instead of the
 * whole intent. Read-only: mainnet reads only, no fork.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getContracts } from "@zkp2p/sdk";
import type { Abi, Address, Hex } from "viem";
import { fiatToSend } from "@/peer/buy/amounts";
import type { FiatCode } from "@/peer/platforms";
import { FULFILL_SELECTOR, decodeFulfillCalldata, decodePaymentDetails, decodePaymentProof, locateCall } from "./lib/decode";
import { attestedRelease, minimumFullPaymentMinor, peerFiatToSend } from "./lib/peer-reference";
import { upstreamRpc } from "./lib/rpc";

interface RoundingFixture {
  total: number;
  perCurrency: Record<string, { intents: number; underquoted: number }>;
  underquoted: Array<{
    signalTxHash: Hex;
    intentHash: Hex;
    currency: string;
    amount: string;
    conversionRate: string;
    fulfilTxHash: Hex | null;
  }>;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/rounding.json", import.meta.url)), "utf8"),
) as RoundingFixture;
const contracts = getContracts(8453, "production");
const ORCH = contracts.addresses.orchestratorV3 as Address;
const ABI = contracts.abis.orchestratorV3 as Abi;

/** RampRidge's "send exactly", in minor units. */
function rampridgeMinor(amount: bigint, rate: bigint, currency: string): bigint {
  return fiatToSend(amount, rate, currency as FiatCode) / 10_000n;
}

/**
 * True once src/peer/buy/amounts.ts rounds the exact product up in one step.
 * Probed on a real Base intent: 111.82 USDC
 * at 0.894294... EUR is 100.000000000000000007864 EUR, so the full release needs
 * 100.01 EUR. The suite asserts the matching invariants either way, so it stays
 * green before and after the fix lands, and the pre-fix bug stays an expected fail.
 */
const ROUNDS_EXACT_PRODUCT = fiatToSend(111_820_000n, 894_294_401_717_045_252n, "EUR") === 100_010_000n;

describe("fiat to send on real intents", () => {
  it("is Peer's web app figure today, and exactly one cent above it on these intents once fixed", () => {
    expect(fixture.underquoted.length).toBeGreaterThan(0);
    for (const u of fixture.underquoted) {
      const amount = BigInt(u.amount);
      const rate = BigInt(u.conversionRate);
      // Peer's own figure is one cent short on these intents; the fix asks for the cent that releases the whole intent.
      const expected = ROUNDS_EXACT_PRODUCT ? peerFiatToSend(amount, rate) + 10_000n : peerFiatToSend(amount, rate);
      expect(fiatToSend(amount, rate, u.currency as FiatCode)).toBe(expected);
    }
  });

  it("real fulfilments of these intents show the attestation releasing less than the intent when the payment is that figure", async () => {
    const rpc = upstreamRpc();
    let checked = 0;
    for (const u of fixture.underquoted) {
      if (!u.fulfilTxHash) continue;
      const call = await locateCall(rpc, u.fulfilTxHash, ORCH, FULFILL_SELECTOR, (input) => {
        try {
          return decodeFulfillCalldata(ABI, input).args.intentHash.toLowerCase() === u.intentHash.toLowerCase();
        } catch {
          return false;
        }
      });
      const proof = decodePaymentProof(decodeFulfillCalldata(ABI, call.input).args.paymentProof);
      const paid = decodePaymentDetails(proof.encodedPaymentDetails).payment.amount;
      const amount = BigInt(u.amount);
      const rate = BigInt(u.conversionRate);
      // The real attestation follows the formula for whatever the buyer actually paid ...
      expect(proof.releaseAmount).toBe(attestedRelease(paid, rate, amount));
      // ... and a payment of exactly the shown figure would have released less than the intent.
      if (paid === rampridgeMinor(amount, rate, u.currency)) expect(proof.releaseAmount).toBeLessThan(amount);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  }, 300_000);

  // BUG (low): src/peer/buy/amounts.ts fiatToSend floors amount x rate to 6-decimal fiat before rounding
  // up to the cent, so for ~1.6% of real EUR and ~2.8% of real GBP intents the amount shown is one cent
  // below what releases the whole intent. Paying exactly the shown amount releases amount - 1 base unit.
  // An expected fail until fiatToSend rounds the exact product up (fixes.patch), then a plain test.
  (ROUNDS_EXACT_PRODUCT ? it : it.fails)("releases the whole intent when paid exactly (one cent short on these intents before the fix)", () => {
    for (const u of fixture.underquoted) {
      const amount = BigInt(u.amount);
      const rate = BigInt(u.conversionRate);
      const shown = rampridgeMinor(amount, rate, u.currency);
      expect(shown, `${u.currency} intent ${u.intentHash}`).toBe(minimumFullPaymentMinor(amount, rate));
      expect(attestedRelease(shown, rate, amount)).toBe(amount);
    }
  });

  it("is never short by more than one cent (never short once fixed), and is short on few real intents", () => {
    for (const u of fixture.underquoted) {
      const amount = BigInt(u.amount);
      const rate = BigInt(u.conversionRate);
      const shown = rampridgeMinor(amount, rate, u.currency);
      const needed = minimumFullPaymentMinor(amount, rate);
      expect(needed - shown).toBe(ROUNDS_EXACT_PRODUCT ? 0n : 1n);
      // One cent short loses at most a couple of base units of USDC.
      expect(amount - attestedRelease(shown, rate, amount)).toBeLessThanOrEqual(2n);
    }
    expect(fixture.underquoted.length / fixture.total).toBeLessThan(0.01);
  });
});
