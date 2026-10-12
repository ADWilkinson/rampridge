import { getContracts } from "@zkp2p/sdk";
import type { Abi, AbiFunction } from "viem";
import { toFunctionSignature } from "viem";
import { describe, expect, it } from "vitest";
import { PAYMENT_METHOD_ACTIVE_ABI, peerContracts } from "./chain";

describe("PAYMENT_METHOD_ACTIVE_ABI", () => {
  it("matches the escrow ABI the SDK ships for production", () => {
    const { abis } = getContracts(8453, "production");
    const escrowAbi = (abis.escrowV2 ?? abis.escrow) as Abi;
    const shipped = escrowAbi.find(
      (item): item is AbiFunction => item.type === "function" && item.name === "getDepositPaymentMethodActive",
    );
    expect(shipped).toBeDefined();
    expect(toFunctionSignature(shipped!)).toBe(toFunctionSignature(PAYMENT_METHOD_ACTIVE_ABI[0]));
    expect(shipped!.outputs.map((o) => o.type)).toEqual(["bool"]);
  });

  it("reads from the escrow stalls are validated against", () => {
    const contracts = peerContracts();
    expect(contracts.escrows).toContain(contracts.escrow);
  });
});
