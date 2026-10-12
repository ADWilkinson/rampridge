import { appendAttributionToCalldata } from "@zkp2p/sdk";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { PEER_ATTRIBUTION, USDC_ADDRESS } from "@/config";
import type { WalletCall } from "./types";

/**
 * `USDC.transfer(to, amount)` as the one call this app sends to move USDC.
 * Like every transaction this app sends, the calldata carries the ERC-8021
 * attribution suffix the Peer SDK appends on the buy path (`rampridge`,
 * `peer-ref-TOFIAT`, then Peer's Base builder code); ERC-20 decoding ignores
 * trailing bytes. The only call target is USDC, which the smart-wallet gas
 * sponsor allows.
 */
export function usdcTransferCall(to: Address, amount: bigint): WalletCall & { data: Hex } {
  return {
    to: USDC_ADDRESS,
    data: appendAttributionToCalldata(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }), [
      ...PEER_ATTRIBUTION,
    ]),
  };
}
