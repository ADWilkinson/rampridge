/**
 * The off-chain services the money paths call, as the fork suites see them.
 *
 * Curator (quotes, /v3/sign, payee lookups) stays the REAL production API.
 * Three services are answered locally, because the real ones cannot see the
 * fork or must not receive test data:
 *
 * - The Peer indexer (GraphQL): answered from fork chain state, so the cash
 *   SDK's order reads (withdraw, top-up) see deposits created on the fork.
 * - Payee registration (`POST /v2/makers/create`): never sent to Curator; it
 *   returns a deterministic test hash, so no handle is ever registered.
 * - The attestation service (`/buyer/verify/...`): answered by a per-test
 *   handler, so no fabricated proof is ever posted to Peer.
 *
 * Every request (real or answered locally) is recorded for assertions.
 */

import { CHAINLINK_ORACLE_ADAPTER, PYTH_ORACLE_ADAPTER, getContracts } from "@zkp2p/sdk";
import { Attribution } from "ox/erc8021";
import {
  getAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { forkClient } from "./anvil";

const contracts = getContracts(8453, "production");

function required(address: string | undefined, name: string): Address {
  if (!address) throw new Error(`@zkp2p/sdk has no production ${name} on Base`);
  return getAddress(address);
}

export const ESCROW: Address = required(contracts.addresses.escrowV2, "EscrowV2");
export const ORCHESTRATOR: Address = required(contracts.addresses.orchestratorV3, "OrchestratorV3");
const escrowAbi = contracts.abis.escrowV2 ?? contracts.abis.escrow;
const orchestratorAbi = contracts.abis.orchestratorV3 ?? contracts.abis.orchestrator;

/** The oracle adapters Peer Cash prices market-rate deposits with (the SDK's own constants). */
const ORACLE_KIND: Record<string, string> = {
  [CHAINLINK_ORACLE_ADAPTER.toLowerCase()]: "oracle_chainlink",
  [PYTH_ORACLE_ADAPTER.toLowerCase()]: "oracle_pyth",
};

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  /** "fork" when answered locally, "network" when passed through. */
  served: "fork" | "network";
  status?: number;
  response?: unknown;
}

export type AttestationHandler = (path: string, body: unknown) => Promise<unknown> | unknown;

/** A JSON-RPC request the app sent to the fork while recording was on. */
export interface RecordedRpc {
  method: string;
  params: unknown[];
}

interface OffchainState {
  requests: RecordedRequest[];
  /** JSON-RPC calls to the fork, recorded only between startRpcRecording and stopRpcRecording. */
  rpc: RecordedRpc[] | null;
  attestation: AttestationHandler | null;
  /** Deposits and intents are looked up in logs from this block on (the fork block). */
  fromBlock: bigint;
}

const state: OffchainState = { requests: [], rpc: null, attestation: null, fromBlock: 0n };
let originalFetch: typeof fetch | null = null;

/** The hash the stubbed payee registration returns for a handle. */
export function testPayeeHash(platform: string, offchainId: string): Hex {
  return keccak256(stringToHex(`rampridge-fork-test:${platform.toLowerCase()}:${offchainId}`));
}

export function recordedRequests(filter?: (r: RecordedRequest) => boolean): RecordedRequest[] {
  return filter ? state.requests.filter(filter) : [...state.requests];
}

export function clearRecordedRequests(): void {
  state.requests.length = 0;
}

/** Starts recording the JSON-RPC requests sent to the fork (eth_call, eth_sendTransaction, ...). */
export function startRpcRecording(): void {
  state.rpc = [];
}

export function stopRpcRecording(): RecordedRpc[] {
  const recorded = state.rpc ?? [];
  state.rpc = null;
  return recorded;
}

export function setAttestationHandler(handler: AttestationHandler | null): void {
  state.attestation = handler;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function readBody(init: RequestInit | undefined): Promise<unknown> {
  const raw = init?.body;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** Installs the interceptor (idempotent). Call `uninstallOffchain` in afterAll. */
export async function installOffchain(): Promise<void> {
  if (originalFetch) return;
  state.fromBlock = await forkClient.getBlockNumber();
  const passthrough = globalThis.fetch.bind(globalThis);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return "";
      }
    })();
    // JSON-RPC to the fork itself is only recorded on request (it is very chatty).
    if (host.startsWith("127.0.0.1") || host.startsWith("localhost")) {
      if (state.rpc) {
        const payload = await readBody(init);
        for (const call of Array.isArray(payload) ? payload : [payload]) {
          const { method, params } = (call ?? {}) as { method?: unknown; params?: unknown };
          if (typeof method === "string") state.rpc.push({ method, params: Array.isArray(params) ? params : [] });
        }
      }
      return passthrough(input, init);
    }

    const body = await readBody(init);
    if (/^indexer(-[a-z]+)?\.zkp2p\.xyz$/.test(host)) {
      const record: RecordedRequest = { url, method, body, served: "fork" };
      state.requests.push(record);
      try {
        const data = await answerGraphql(body as { query?: string; variables?: Record<string, unknown> });
        record.status = 200;
        record.response = data;
        return json({ data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record.status = 200;
        record.response = { errors: [{ message }] };
        return json({ errors: [{ message }] });
      }
    }
    if (method === "POST" && /\/v[0-9]\/makers\/create$/.test(new URL(url).pathname)) {
      const req = body as { processorName?: string; offchainId?: string };
      const hashedOnchainId = testPayeeHash(req.processorName ?? "", req.offchainId ?? "");
      const response = { success: true, message: "fork stub", responseObject: { hashedOnchainId }, statusCode: 201 };
      state.requests.push({ url, method, body, served: "fork", status: 201, response });
      return json(response, 201);
    }
    if (/^attestation-service(-[a-z]+)?\.zkp2p\.xyz$/.test(host)) {
      const handler = state.attestation;
      if (!handler) {
        state.requests.push({ url, method, body, served: "fork", status: 503 });
        return json({ success: false, message: "fork: no attestation handler installed" }, 503);
      }
      const response = await handler(new URL(url).pathname, body);
      state.requests.push({ url, method, body, served: "fork", status: 200, response });
      return json(response);
    }

    const record: RecordedRequest = { url, method, body, served: "network" };
    state.requests.push(record);
    const res = await passthrough(input, init);
    record.status = res.status;
    try {
      record.response = await res.clone().json();
    } catch {
      record.response = null;
    }
    return res;
  }) as typeof fetch;
}

export function uninstallOffchain(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
  state.attestation = null;
}

// ---------------------------------------------------------------------------
// Fork indexer: answers the SDK's GraphQL queries from chain state.
// ---------------------------------------------------------------------------

const ESCROW_EVENTS = parseAbi([
  "event DepositReceived(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount, (uint256 min, uint256 max) intentAmountRange, address delegate, address intentGuardian)",
  "event DepositWithdrawn(uint256 indexed depositId, address indexed depositor, uint256 amount)",
  "event DepositFundsAdded(uint256 indexed depositId, address indexed depositor, uint256 amount)",
  "event DepositClosed(uint256 depositId, address depositor)",
  "event FundsUnlockedAndTransferred(uint256 indexed depositId, bytes32 indexed intentHash, uint256 unlockedAmount, uint256 transferredAmount, address to)",
]);

const ORCHESTRATOR_EVENTS = parseAbi([
  "event IntentSignaled(bytes32 indexed intentHash, address indexed escrow, uint256 indexed depositId, bytes32 paymentMethod, address owner, address to, uint256 amount, bytes32 fiatCurrency, uint256 conversionRate, uint256 timestamp)",
  "event IntentFulfilled(bytes32 indexed intentHash, address indexed fundsTransferredTo, uint256 amount, bool isManualRelease)",
  "event IntentPruned(bytes32 indexed intentHash)",
]);

function compositeId(depositId: bigint): string {
  return `${ESCROW.toLowerCase()}_${depositId}`;
}

function parseCompositeId(id: string): bigint | null {
  const [escrow, raw] = id.toLowerCase().split("_").slice(-2);
  if (escrow !== ESCROW.toLowerCase() || !raw || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

async function logsSinceFork(address: Address): Promise<Log[]> {
  return forkClient.getLogs({ address, fromBlock: state.fromBlock, toBlock: "latest" });
}

interface DepositAggregate {
  depositor: Address;
  created: bigint;
  withdrawn: bigint;
  added: bigint;
  taken: bigint;
  closed: boolean;
  blockNumber: bigint;
  txHash: Hex;
}

async function depositAggregates(): Promise<Map<bigint, DepositAggregate>> {
  const logs = parseEventLogs({ abi: ESCROW_EVENTS, logs: await logsSinceFork(ESCROW) });
  const map = new Map<bigint, DepositAggregate>();
  for (const log of logs) {
    const id = log.args.depositId;
    if (log.eventName === "DepositReceived") {
      map.set(id, {
        depositor: log.args.depositor,
        created: log.args.amount,
        withdrawn: 0n,
        added: 0n,
        taken: 0n,
        closed: false,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      });
      continue;
    }
    const agg = map.get(id);
    if (!agg) continue;
    if (log.eventName === "DepositWithdrawn") agg.withdrawn += log.args.amount;
    if (log.eventName === "DepositFundsAdded") agg.added += log.args.amount;
    if (log.eventName === "DepositClosed") agg.closed = true;
    if (log.eventName === "FundsUnlockedAndTransferred") agg.taken += log.args.transferredAmount;
  }
  return map;
}

type Row = Record<string, unknown>;

function readEscrow<T>(functionName: string, args: unknown[]): Promise<T> {
  return forkClient.readContract({ address: ESCROW, abi: escrowAbi, functionName, args } as never) as Promise<T>;
}

async function depositRow(depositId: bigint, aggregates: Map<bigint, DepositAggregate>): Promise<Row | null> {
  const agg = aggregates.get(depositId);
  if (!agg) return null;
  const deposit = await readEscrow<{
    depositor: Address;
    delegate: Address;
    token: Address;
    intentAmountRange: { min: bigint; max: bigint };
    acceptingIntents: boolean;
    remainingDeposits: bigint;
    outstandingIntentAmount: bigint;
  }>("getDeposit", [depositId]);
  const live = deposit.depositor.toLowerCase() !== "0x0000000000000000000000000000000000000000";
  const block = await forkClient.getBlock({ blockNumber: agg.blockNumber });
  const now = await forkClient.getBlock({ blockTag: "latest" });
  return {
    id: compositeId(depositId),
    chainId: 8453,
    escrowAddress: ESCROW.toLowerCase(),
    depositId: depositId.toString(),
    depositor: agg.depositor.toLowerCase(),
    delegate: live ? deposit.delegate.toLowerCase() : null,
    rateManagerId: null,
    rateManagerAddress: null,
    delegatedAt: null,
    token: (live ? deposit.token : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").toLowerCase(),
    remainingDeposits: live ? deposit.remainingDeposits.toString() : "0",
    intentAmountMin: live ? deposit.intentAmountRange.min.toString() : "0",
    status: live ? "ACTIVE" : agg.withdrawn > 0n ? "WITHDRAWN" : "CLOSED",
    outstandingIntentAmount: live ? deposit.outstandingIntentAmount.toString() : "0",
    totalAmountTaken: agg.taken.toString(),
    totalWithdrawn: agg.withdrawn.toString(),
    successRateBps: null,
    totalIntents: 0,
    signaledIntents: 0,
    fulfilledIntents: 0,
    prunedIntents: 0,
    blockNumber: agg.blockNumber.toString(),
    timestamp: block.timestamp.toString(),
    txHash: agg.txHash,
    updatedAt: now.timestamp.toString(),
  };
}

async function relationRows(depositId: bigint): Promise<{ methods: Row[]; currencies: Row[] }> {
  const methods: Row[] = [];
  const currencies: Row[] = [];
  const hashes = await readEscrow<Hex[]>("getDepositPaymentMethods", [depositId]);
  for (const paymentMethod of hashes) {
    const [data, active, codes] = await Promise.all([
      readEscrow<{ intentGatingService: Address; payeeDetails: Hex }>("getDepositPaymentMethodData", [depositId, paymentMethod]),
      readEscrow<boolean>("getDepositPaymentMethodActive", [depositId, paymentMethod]),
      readEscrow<Hex[]>("getDepositCurrencies", [depositId, paymentMethod]),
    ]);
    methods.push({
      id: `${compositeId(depositId)}_${paymentMethod}`,
      chainId: 8453,
      depositIdOnContract: depositId.toString(),
      depositId: compositeId(depositId),
      paymentMethodHash: paymentMethod,
      intentGatingService: data.intentGatingService.toLowerCase(),
      payeeDetailsHash: data.payeeDetails,
      active,
    });
    for (const currencyCode of codes) {
      const [minRate, oracle] = await Promise.all([
        readEscrow<bigint>("getDepositCurrencyMinRate", [depositId, paymentMethod, currencyCode]),
        readEscrow<{ adapter: Address; adapterConfig: Hex; spreadBps: number; maxStaleness: number }>(
          "getDepositOracleRateConfig",
          [depositId, paymentMethod, currencyCode],
        ),
      ]);
      const kind = ORACLE_KIND[oracle.adapter.toLowerCase()] ?? null;
      currencies.push({
        id: `${compositeId(depositId)}_${paymentMethod}_${currencyCode}`,
        chainId: 8453,
        depositIdOnContract: depositId.toString(),
        depositId: compositeId(depositId),
        paymentMethodHash: paymentMethod,
        currencyCode,
        minConversionRate: minRate.toString(),
        conversionRate: minRate.toString(),
        takerConversionRate: null,
        managerFee: "0",
        rateSource: kind ? "ORACLE" : "MANUAL",
        oracleRate: null,
        effectiveOracleRate: null,
        lastOracleUpdatedAt: null,
        adapter: kind ? oracle.adapter.toLowerCase() : null,
        adapterConfig: kind ? oracle.adapterConfig : null,
        feed: null,
        feedDecimals: null,
        spreadBps: kind ? oracle.spreadBps : null,
        maxStaleness: kind ? oracle.maxStaleness : null,
        invert: null,
        kind,
        managerRate: null,
        rateManagerId: null,
      });
    }
  }
  return { methods, currencies };
}

async function intentRows(filter: { depositIds?: string[]; owner?: string; intentHash?: string; statuses?: string[] }): Promise<Row[]> {
  const logs = parseEventLogs({ abi: ORCHESTRATOR_EVENTS, logs: await logsSinceFork(ORCHESTRATOR) });
  const fulfilled = new Map<string, bigint>();
  const pruned = new Set<string>();
  for (const log of logs) {
    if (log.eventName === "IntentFulfilled") fulfilled.set(log.args.intentHash.toLowerCase(), log.args.amount);
    if (log.eventName === "IntentPruned") pruned.add(log.args.intentHash.toLowerCase());
  }
  const rows: Row[] = [];
  for (const log of logs) {
    if (log.eventName !== "IntentSignaled") continue;
    if (log.args.escrow.toLowerCase() !== ESCROW.toLowerCase()) continue;
    const hash = log.args.intentHash.toLowerCase();
    const depositKey = compositeId(log.args.depositId);
    if (filter.depositIds && !filter.depositIds.map((d) => d.toLowerCase()).includes(depositKey)) continue;
    if (filter.owner && log.args.owner.toLowerCase() !== filter.owner.toLowerCase()) continue;
    if (filter.intentHash && hash !== filter.intentHash.toLowerCase()) continue;
    const status = fulfilled.has(hash) ? "FULFILLED" : pruned.has(hash) ? "PRUNED" : "SIGNALED";
    if (filter.statuses && !filter.statuses.includes(status)) continue;
    const lock = await readEscrow<{ expiryTime: bigint }>("getDepositIntent", [log.args.depositId, log.args.intentHash]);
    rows.push({
      id: hash,
      intentHash: hash,
      depositId: depositKey,
      orchestratorAddress: ORCHESTRATOR.toLowerCase(),
      verifier: null,
      owner: log.args.owner.toLowerCase(),
      toAddress: log.args.to.toLowerCase(),
      amount: log.args.amount.toString(),
      fiatCurrency: log.args.fiatCurrency,
      conversionRate: log.args.conversionRate.toString(),
      status,
      isExpired: false,
      signalTimestamp: log.args.timestamp.toString(),
      expiryTime: lock.expiryTime > 0n ? lock.expiryTime.toString() : null,
      fulfillTimestamp: null,
      pruneTimestamp: null,
      updatedAt: log.args.timestamp.toString(),
      signalTxHash: log.transactionHash,
      fulfillTxHash: null,
      pruneTxHash: null,
      paymentMethodHash: log.args.paymentMethod,
      rateManagerId: null,
      managerFee: null,
      managerFeeRecipient: null,
      managerFeeAmount: null,
      paymentAmount: null,
      paymentCurrency: null,
      paymentTimestamp: null,
      paymentId: null,
      releasedAmount: fulfilled.get(hash)?.toString() ?? null,
      takerAmountNetFees: null,
    });
  }
  return rows;
}

/**
 * The indexer's attribution source for a deposit: the first ERC-8021 code
 * other than Peer's builder code on the createDeposit transaction's own
 * calldata (zkp2p-indexer src/utils/attribution.ts). A Coinbase Smart Wallet
 * batch (EntryPoint v0.6 executeBatch) carries the codes on the inner calls
 * only, so like the real indexer this finds none for it.
 */
async function attributionSource(txHash: Hex): Promise<string | null> {
  const tx = await forkClient.getTransaction({ hash: txHash });
  try {
    const parsed = Attribution.fromData(tx.input);
    const codes = parsed && "codes" in parsed ? parsed.codes : [];
    return codes.find((code) => code.length > 0 && code !== "bc_nbn6qkni") ?? null;
  } catch {
    return null;
  }
}

function whereValue(where: unknown, field: string, op: string): unknown {
  const clause = (where as Record<string, Record<string, unknown> | undefined> | undefined)?.[field];
  return clause?.[op];
}

async function answerGraphql(body: { query?: string; variables?: Record<string, unknown> }): Promise<Row> {
  const query = body.query ?? "";
  const op = /query\s+(\w+)/.exec(query)?.[1] ?? "";
  const vars = body.variables ?? {};
  const aggregates = await depositAggregates();
  const depositsFor = async (ids: bigint[]) =>
    (await Promise.all(ids.map((id) => depositRow(id, aggregates)))).filter((row): row is Row => row !== null);

  switch (op) {
    case "GetDepositsByIds": {
      const ids = ((vars.ids as string[] | undefined) ?? []).map(parseCompositeId).filter((id): id is bigint => id !== null);
      return { Deposit: await depositsFor(ids) };
    }
    case "GetDeposits": {
      const depositor = whereValue(vars.where, "depositor", "_ilike");
      const ids = [...aggregates.entries()]
        .filter(([, agg]) => typeof depositor !== "string" || agg.depositor.toLowerCase() === depositor.toLowerCase())
        .map(([id]) => id);
      return { Deposit: await depositsFor(ids) };
    }
    case "GetDepositRelations": {
      const ids = ((vars.depositIds as string[] | undefined) ?? []).map(parseCompositeId).filter((id): id is bigint => id !== null);
      const methods: Row[] = [];
      const currencies: Row[] = [];
      for (const id of ids) {
        if (!aggregates.has(id)) continue;
        const rel = await relationRows(id);
        methods.push(...rel.methods);
        currencies.push(...rel.currencies);
      }
      return { DepositPaymentMethod: methods, MethodCurrency: currencies };
    }
    case "GetIntents": {
      const where = vars.where;
      const depositIds = whereValue(where, "depositId", "_in");
      const owner = whereValue(where, "owner", "_ilike");
      const intentHash = whereValue(where, "intentHash", "_eq");
      const statuses = whereValue(where, "status", "_in");
      return {
        Intent: await intentRows({
          ...(Array.isArray(depositIds) ? { depositIds: depositIds as string[] } : {}),
          ...(typeof owner === "string" ? { owner } : {}),
          ...(typeof intentHash === "string" ? { intentHash } : {}),
          ...(Array.isArray(statuses) ? { statuses: statuses as string[] } : {}),
        }),
      };
    }
    case "PeerCashAttributedDeposits": {
      const ids = ((vars.ids as string[] | undefined) ?? []).map(parseCompositeId).filter((id): id is bigint => id !== null);
      const attributed: Row[] = [];
      for (const id of ids) {
        const agg = aggregates.get(id);
        if (agg && (await attributionSource(agg.txHash)) === "peer-cash") attributed.push({ id: compositeId(id) });
      }
      return { Deposit: attributed };
    }
    default:
      throw new Error(`fork indexer: unsupported query ${op || "(anonymous)"}`);
  }
}

/** For tests that need the raw escrow/orchestrator ABIs the SDK ships. */
export const PEER_CONTRACT_ABIS = { escrow: escrowAbi, orchestrator: orchestratorAbi };
