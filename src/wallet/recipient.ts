import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { entryPoint06Address, entryPoint07Address, entryPoint08Address } from "viem/account-abstraction";
import { PEER_CONTRACTS, USDC_ADDRESS } from "@/config";

/**
 * Checks for the recipient of a USDC send. Pure: no network. The contract
 * check (eth_getCode) is separate because it needs the chain.
 */

/** Contracts that would keep USDC sent straight to them: no way to get it back out. */
export const TRAP_CONTRACTS: ReadonlyMap<string, string> = new Map<string, string>([
  [USDC_ADDRESS.toLowerCase(), "the USDC token contract"],
  ...Object.entries(PEER_CONTRACTS).map(([name, address]): [string, string] => [address.toLowerCase(), `Peer's ${name} contract`]),
  [entryPoint06Address.toLowerCase(), "the ERC-4337 EntryPoint contract"],
  [entryPoint07Address.toLowerCase(), "the ERC-4337 EntryPoint contract"],
  [entryPoint08Address.toLowerCase(), "the ERC-4337 EntryPoint contract"],
  ["0xca11bde05977b3631167028862be2a173976ca11", "the Multicall3 contract"],
  ["0x4200000000000000000000000000000000000006", "the WETH token contract"],
]);

export const ENTER_BASE_ADDRESS = "Enter a 0x address on Base.";

export type RecipientCheck =
  /** Nothing typed yet. */
  | { status: "empty" }
  | { status: "invalid"; message: string }
  /** A usable recipient, EIP-55 checksummed. */
  | { status: "ok"; address: Address };

const HEX_BODY = /^[0-9a-fA-F]*$/;

/**
 * Validates a typed or pasted recipient. Accepts any case; a mixed-case
 * address must match its EIP-55 checksum (a mismatch is almost always a
 * typo). Refuses the zero address, the sender's own address and contracts
 * that would trap USDC. ENS-style names are not supported.
 */
export function checkRecipient(input: string, options: { self?: string | null } = {}): RecipientCheck {
  const text = input.replace(/\s+/g, "");
  if (!text) return { status: "empty" };
  const prefixed = /^0x/i.test(text);
  if (!prefixed) {
    if (text.includes(".")) return { status: "invalid", message: `Names like .eth aren't supported. ${ENTER_BASE_ADDRESS}` };
    return { status: "invalid", message: ENTER_BASE_ADDRESS };
  }
  const body = text.slice(2);
  if (!HEX_BODY.test(body)) return { status: "invalid", message: `That isn't a valid address. ${ENTER_BASE_ADDRESS}` };
  if (body.length < 40) return { status: "invalid", message: "That address is too short. A Base address is 0x and 40 more characters." };
  if (body.length > 40) return { status: "invalid", message: "That address is too long. A Base address is 0x and 40 more characters." };
  const checksummed = getAddress(`0x${body.toLowerCase()}`);
  const mixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  if (mixedCase && `0x${body}` !== checksummed) {
    return { status: "invalid", message: "That address doesn't match its checksum, so it probably has a typo. Copy it again." };
  }
  const lower = checksummed.toLowerCase();
  if (lower === zeroAddress) return { status: "invalid", message: "That's the zero address. USDC sent there is lost for good." };
  if (options.self && lower === options.self.toLowerCase()) {
    return { status: "invalid", message: "That's your own wallet. Enter the address you're sending to." };
  }
  const trap = TRAP_CONTRACTS.get(lower);
  if (trap) return { status: "invalid", message: `That's ${trap}. USDC sent there would be stuck. Enter a wallet address.` };
  return { status: "ok", address: checksummed };
}

/** EIP-7702 delegation designator: an EOA running smart-account code. It holds its own keys. */
const DELEGATION_PREFIX = "0xef0100";

/**
 * What `eth_getCode` says about an address: no code (a plain wallet),
 * a delegated EOA (EIP-7702, still a wallet), or a contract. Smart wallets
 * are contracts, so a contract is a note, not a refusal.
 */
export function codeKind(code: Hex | null | undefined): "none" | "delegated" | "contract" {
  if (!code || code === "0x") return "none";
  if (code.toLowerCase().startsWith(DELEGATION_PREFIX) && code.length === 2 + 46) return "delegated";
  return "contract";
}

export const CONTRACT_NOTE = "This is a contract address. Make sure it can receive USDC on Base.";

/** "0x12 34AB CD..." as 4-character groups, so a player can check an address group by group. */
export function groupAddress(address: string): string[] {
  const body = address.startsWith("0x") ? address.slice(2) : address;
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += 4) groups.push(body.slice(i, i + 4));
  if (address.startsWith("0x") && groups.length) groups[0] = `0x${groups[0]}`;
  return groups;
}
