/** Test doubles for handler tests: deps over MemoryDb and a scripted chain. Never imported by functions. */

import { encodeAbiParameters, encodeEventTopics } from "viem";
import type { Abi, AbiEvent, Hex } from "viem";
import { FALLBACK_WORLD_RULES } from "../../shared/world.js";
import { peerContracts } from "./chain.js";
import type { ChainGateway, ReceiptLog } from "./chain.js";
import type { ApiDeps } from "./deps.js";
import type { TableFetcher } from "./market.js";
import { MemoryDb } from "./memoryDb.js";

export const TEST_SECRET = new TextEncoder().encode("test-session-secret-at-least-32-bytes-long");
export const TEST_CRON_SECRET = "cron-secret-for-tests";

export function fakeChain(overrides: Partial<ChainGateway> = {}): ChainGateway {
  return {
    contracts: peerContracts(),
    readDeposit: async () => null,
    effectiveRate: async () => null,
    getReceipt: async () => null,
    verifySiweMessage: async () => false,
    ...overrides,
  };
}

export interface TestDeps extends ApiDeps {
  memory: MemoryDb;
  clock: { now: number };
  chainStub: ChainGateway;
}

/** Deterministic bytes from a counter, so pids and nonces differ but tests are repeatable. */
function counterBytes(): (length: number) => Uint8Array {
  let seed = 1;
  return (length) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      // The low bits of this generator repeat every 256 draws; the high bits do not.
      out[i] = (seed >>> 16) & 0xff;
    }
    return out;
  };
}

export function testDeps(
  options: { chain?: Partial<ChainGateway>; fetchTable?: TableFetcher; now?: number } = {},
): TestDeps {
  const memory = new MemoryDb();
  const clock = { now: options.now ?? 1_800_000_000_000 };
  const chainStub = fakeChain(options.chain);
  return {
    memory,
    clock,
    chainStub,
    db: () => memory,
    now: () => clock.now,
    sessionSecret: () => TEST_SECRET,
    sessionNotBefore: () => null,
    cronSecret: () => TEST_CRON_SECRET,
    chain: () => chainStub,
    fetchTable: options.fetchTable ?? (async () => Promise.reject(new Error("no market in this test"))),
    randomBytes: counterBytes(),
    random: () => 0.5,
    worldRules: () => FALLBACK_WORLD_RULES,
  };
}

export function jsonRequest(
  url: string,
  body: unknown,
  init: { token?: string; method?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...init.headers };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return new Request(`https://www.rampridge.xyz${url}`, {
    method: init.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function readBody<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Encodes a log for `eventName` from `abi` as it would appear in a receipt. */
export function encodeLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  address: string,
  logIndex: number,
): ReceiptLog {
  const event = abi.find((item): item is AbiEvent => item.type === "event" && item.name === eventName);
  if (!event) throw new Error(`No ${eventName} in ABI`);
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[];
  const dataInputs = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(
    dataInputs,
    dataInputs.map((input) => args[input.name!]),
  );
  return { address: address.toLowerCase(), topics, data, logIndex };
}
