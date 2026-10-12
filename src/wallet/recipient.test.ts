import { describe, expect, it } from "vitest";
import { getContracts } from "@zkp2p/sdk";
import { PEER_CONTRACTS, SPONSORED_CALL_TARGETS, USDC_ADDRESS } from "@/config";
import { CONTRACT_NOTE, ENTER_BASE_ADDRESS, TRAP_CONTRACTS, checkRecipient, codeKind, groupAddress } from "./recipient";

// vitalik.eth's address: a well-known EIP-55 checksum.
const CHECKSUMMED = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SELF = "0x5555555555555555555555555555555555555555";

describe("checkRecipient", () => {
  it("accepts an address in any single case and returns it checksummed", () => {
    expect(checkRecipient(CHECKSUMMED.toLowerCase())).toEqual({ status: "ok", address: CHECKSUMMED });
    expect(checkRecipient(`0x${CHECKSUMMED.slice(2).toUpperCase()}`)).toEqual({ status: "ok", address: CHECKSUMMED });
    expect(checkRecipient(CHECKSUMMED)).toEqual({ status: "ok", address: CHECKSUMMED });
  });

  it("ignores whitespace around and inside a pasted address", () => {
    expect(checkRecipient(`  ${CHECKSUMMED}\n`)).toEqual({ status: "ok", address: CHECKSUMMED });
    expect(checkRecipient(`${CHECKSUMMED.slice(0, 20)} ${CHECKSUMMED.slice(20)}`)).toEqual({ status: "ok", address: CHECKSUMMED });
  });

  it("refuses a mixed-case address whose checksum is wrong (a likely typo)", () => {
    // One letter's case flipped.
    const typo = CHECKSUMMED.replace("dA6", "da6");
    const result = checkRecipient(typo);
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toMatch(/checksum/);
    // A changed character with the old capitals is caught the same way.
    expect(checkRecipient(CHECKSUMMED.replace("6045", "6046")).status).toBe("invalid");
  });

  it("explains names and malformed text", () => {
    expect(checkRecipient("")).toEqual({ status: "empty" });
    expect(checkRecipient("   ")).toEqual({ status: "empty" });
    const name = checkRecipient("vitalik.eth");
    expect(name.status === "invalid" && name.message).toBe(`Names like .eth aren't supported. ${ENTER_BASE_ADDRESS}`);
    const baseName = checkRecipient("jesse.base.eth");
    expect(baseName.status === "invalid" && baseName.message).toContain(ENTER_BASE_ADDRESS);
    const noPrefix = checkRecipient(CHECKSUMMED.slice(2));
    expect(noPrefix.status === "invalid" && noPrefix.message).toBe(ENTER_BASE_ADDRESS);
    const short = checkRecipient(CHECKSUMMED.slice(0, 41));
    expect(short.status === "invalid" && short.message).toMatch(/too short/);
    const long = checkRecipient(`${CHECKSUMMED}0`);
    expect(long.status === "invalid" && long.message).toMatch(/too long/);
    const bad = checkRecipient(`0x${"g".repeat(40)}`);
    expect(bad.status === "invalid" && bad.message).toMatch(/isn't a valid address/);
  });

  it("refuses the zero address and the sender's own address", () => {
    expect(checkRecipient(`0x${"0".repeat(40)}`).status).toBe("invalid");
    const self = checkRecipient(SELF.toUpperCase().replace("0X", "0x"), { self: SELF });
    expect(self.status === "invalid" && self.message).toMatch(/your own wallet/);
  });

  it("refuses USDC, every Peer contract and the EntryPoints, which would trap the funds", () => {
    for (const address of [USDC_ADDRESS, ...Object.values(PEER_CONTRACTS), "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"]) {
      const result = checkRecipient(address.toLowerCase());
      expect(result.status, address).toBe("invalid");
      expect(result.status === "invalid" && result.message).toMatch(/would be stuck/);
    }
    const escrow = checkRecipient(PEER_CONTRACTS.EscrowV2);
    expect(escrow.status === "invalid" && escrow.message).toContain("Peer's EscrowV2 contract");
  });
});

describe("protocol addresses", () => {
  it("match the Peer SDK's production deployment on Base", () => {
    const sdk = getContracts(8453, "production").addresses;
    expect(PEER_CONTRACTS.EscrowV2).toBe(sdk.escrowV2);
    expect(PEER_CONTRACTS.OrchestratorV3).toBe(sdk.orchestratorV3);
    expect(PEER_CONTRACTS.WhitelistPolicy).toBe(sdk.whitelistPolicy);
    expect(USDC_ADDRESS).toBe(sdk.usdc);
    // Every address the SDK lists for this deployment is refused as a recipient.
    const listed = Object.values(sdk as Record<string, unknown>).flatMap((value): string[] =>
      typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [],
    );
    for (const address of listed) expect(TRAP_CONTRACTS.has(address.toLowerCase()), address).toBe(true);
  });

  it("keep USDC on the sponsored-call allowlist", () => {
    expect(SPONSORED_CALL_TARGETS).toContain(USDC_ADDRESS);
  });
});

describe("codeKind", () => {
  it("tells wallets, delegated EOAs and contracts apart", () => {
    expect(codeKind(undefined)).toBe("none");
    expect(codeKind("0x")).toBe("none");
    expect(codeKind(`0xef0100${"ab".repeat(20)}`)).toBe("delegated");
    expect(codeKind("0x6080604052")).toBe("contract");
    expect(CONTRACT_NOTE).toBe("This is a contract address. Make sure it can receive USDC on Base.");
  });
});

describe("groupAddress", () => {
  it("splits into 4-character groups with 0x on the first", () => {
    const groups = groupAddress(CHECKSUMMED);
    expect(groups).toHaveLength(10);
    expect(groups[0]).toBe("0xd8dA");
    expect(groups.join("")).toBe(CHECKSUMMED);
  });
});
