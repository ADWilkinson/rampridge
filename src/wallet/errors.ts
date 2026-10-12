import type { Address, Hash, TransactionReceipt } from "viem";

export type WalletErrorCode =
  /** The player declined or closed the wallet prompt. */
  | "user_rejected"
  /** The wallet pays its own gas and has no ETH on Base. */
  | "insufficient_gas"
  /** The app's gas sponsorship refused or could not cover the transaction. */
  | "sponsorship_failed"
  /** The wallet could not be switched to Base. */
  | "chain_switch_failed"
  /** No usable signer yet (smart wallet still being created, wallet disconnected). */
  | "wallet_not_ready"
  /** Another wallet request from this player is still in progress. */
  | "busy"
  /** The browser blocked the Peer cross-app wallet window. */
  | "popup_blocked"
  /** The transaction would revert; nothing was sent. */
  | "call_reverted"
  /** The transaction was mined and reverted. */
  | "reverted"
  /**
   * The transaction may have been submitted but its outcome is unknown: the
   * receipt wait timed out or failed, or the wallet timed out after the request
   * reached it. Never resend blindly; check the chain first.
   */
  | "receipt_timeout"
  /** The wallet did not answer in time. */
  | "request_timeout"
  /** The caller passed an invalid request (for example an empty batch). */
  | "invalid_request"
  | "unknown";

export interface WalletErrorOptions {
  cause?: unknown;
  /** Overrides the default `mayHaveLanded` for the code (see the field). */
  mayHaveLanded?: boolean;
}

/**
 * Base class for every error thrown by `TxSender` methods. `message` is plain
 * English that the UI can show as is.
 */
export class WalletError extends Error {
  readonly code: WalletErrorCode;
  /**
   * True when the request may have put a transaction on-chain that could still
   * execute: it was submitted and its outcome is unknown, or nothing rules that
   * out. False when the failure proves nothing will execute: the request was
   * refused or failed before anything was submitted, or it was mined and
   * reverted. Only when true must a caller check the chain before resending.
   * Defaults to true for `receipt_timeout` and `unknown`, false otherwise.
   */
  readonly mayHaveLanded: boolean;
  /**
   * Hashes of transactions from the same `sendCalls` request that already
   * confirmed on Base before this failure. Non-empty means the request
   * partially happened (for example an approval landed but the deposit did
   * not), so the UI must not present it as "nothing happened".
   */
  completedHashes: readonly Hash[] = [];

  constructor(code: WalletErrorCode, message: string, options?: WalletErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WalletError";
    this.code = code;
    this.mayHaveLanded = options?.mayHaveLanded ?? (code === "receipt_timeout" || code === "unknown");
  }
}

export class UserRejectedError extends WalletError {
  constructor(options?: { cause?: unknown }) {
    super("user_rejected", "You cancelled the request in your wallet.", options);
    this.name = "UserRejectedError";
  }
}

export class InsufficientGasError extends WalletError {
  readonly address: Address | null;

  constructor(address: Address | null, options?: { cause?: unknown }) {
    super(
      "insufficient_gas",
      "Your wallet needs a little ETH on Base to pay the network fee. Add some ETH on Base and try again.",
      options,
    );
    this.name = "InsufficientGasError";
    this.address = address;
  }
}

export class SponsorshipError extends WalletError {
  /** What the paymaster or Privy said, for logs (URLs removed); null when it gave no reason. */
  readonly reason: string | null;

  constructor(options?: { cause?: unknown; reason?: string | null }) {
    super("sponsorship_failed", "The bank couldn't sponsor this transaction, so nothing was sent. Try again later.", options);
    this.name = "SponsorshipError";
    this.reason = options?.reason ?? (options?.cause === undefined ? null : failureReason(causeChain(options.cause)));
  }
}

export class ChainSwitchError extends WalletError {
  constructor(options?: { cause?: unknown }) {
    super("chain_switch_failed", "Switch your wallet to the Base network and try again.", options);
    this.name = "ChainSwitchError";
  }
}

export class WalletNotReadyError extends WalletError {
  constructor(message = "Your wallet is still getting ready. Try again in a moment.", options?: { cause?: unknown }) {
    super("wallet_not_ready", message, options);
    this.name = "WalletNotReadyError";
  }
}

export class WalletBusyError extends WalletError {
  constructor() {
    super("busy", "Finish the request already open in your wallet first.");
    this.name = "WalletBusyError";
  }
}

export class PopupBlockedError extends WalletError {
  constructor(options?: { cause?: unknown }) {
    super(
      "popup_blocked",
      "Your browser blocked the Peer wallet window. Allow pop-ups for this site and try again.",
      options,
    );
    this.name = "PopupBlockedError";
  }
}

export class CallRevertedError extends WalletError {
  /** The revert reason reported by the node or wallet, when there is one. */
  readonly reason: string | null;

  constructor(reason: string | null, options?: { cause?: unknown }) {
    super(
      "call_reverted",
      reason
        ? `The transaction would fail (${reason}), so nothing was sent.`
        : "The transaction would fail, so nothing was sent.",
      options,
    );
    this.name = "CallRevertedError";
    this.reason = reason;
  }
}

export class TransactionRevertedError extends WalletError {
  readonly hash: Hash;
  readonly receipt: TransactionReceipt | null;

  constructor(hash: Hash, receipt: TransactionReceipt | null, options?: { cause?: unknown }) {
    super("reverted", "The transaction failed on Base. No funds moved in that step.", options);
    this.name = "TransactionRevertedError";
    this.hash = hash;
    this.receipt = receipt;
  }
}

export class TransactionPendingError extends WalletError {
  /** The submitted transaction, when the wallet reported one. */
  readonly hash: Hash | null;

  constructor(hash: Hash | null, options?: { cause?: unknown }) {
    super(
      "receipt_timeout",
      hash
        ? "Your transaction was submitted but is not confirmed yet. Check your balance before trying again."
        : "Your wallet did not confirm whether the transaction was sent. Check your balance and wallet activity before trying again.",
      options,
    );
    this.name = "TransactionPendingError";
    this.hash = hash;
  }
}

export class WalletTimeoutError extends WalletError {
  constructor(options?: { cause?: unknown }) {
    super("request_timeout", "Your wallet did not respond in time. Check your wallet before trying again.", options);
    this.name = "WalletTimeoutError";
  }
}

const MAX_CAUSE_DEPTH = 12;

interface ErrorFacts {
  numericCodes: number[];
  stringCodes: string[];
  names: string[];
  /** JSON-RPC methods of the failed requests (viem records the request body on transport errors). */
  methods: string[];
  text: string;
}

/** Follows `cause` links (viem nests the original wallet error several levels deep). */
export function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH && !chain.includes(current)) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/**
 * Gathers codes, names and human text from every error in the chain. viem's
 * `message` appends `metaMessages` (request arguments such as `paymaster`,
 * calldata and URLs), which would make text patterns match the request rather
 * than the failure, so viem errors contribute `shortMessage` and `details` only.
 */
function collectFacts(chain: unknown[]): ErrorFacts {
  const facts: ErrorFacts = { numericCodes: [], stringCodes: [], names: [], methods: [], text: "" };
  const parts: string[] = [];
  for (const entry of chain) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.code === "number") facts.numericCodes.push(record.code);
    if (typeof record.code === "string") facts.stringCodes.push(record.code);
    if (typeof record.name === "string") facts.names.push(record.name);
    facts.methods.push(...requestMethods(record));
    const keys = typeof record.shortMessage === "string" ? ["shortMessage", "details", "reason"] : ["message", "details", "reason"];
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  facts.text = parts.join("\n");
  return facts;
}

const REQUEST_BODY_TEXT = /^Request body: (.+)$/s;
const REQUEST_METHOD_TEXT = /"method":"([A-Za-z0-9_]+)"/g;

export interface RpcRequestBody {
  method: string;
  params: unknown[];
}

function asRequestBodies(value: unknown): RpcRequestBody[] {
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { method, params } = entry as { method?: unknown; params?: unknown };
    return typeof method === "string" ? [{ method, params: Array.isArray(params) ? params : [] }] : [];
  });
}

/**
 * The JSON-RPC requests an error was raised for: viem's HttpRequestError
 * keeps the request `body`, and RpcRequestError and TimeoutError print it into
 * `metaMessages` ("Request body: {...}").
 */
export function requestBodies(record: Record<string, unknown>): RpcRequestBody[] {
  const bodies = asRequestBodies(record.body);
  if (Array.isArray(record.metaMessages)) {
    for (const line of record.metaMessages) {
      const text = typeof line === "string" ? REQUEST_BODY_TEXT.exec(line.trim())?.[1] : undefined;
      if (!text) continue;
      try {
        bodies.push(...asRequestBodies(JSON.parse(text)));
      } catch {
        // Not JSON (a truncated or custom message): the method names are still readable.
        for (const match of text.matchAll(REQUEST_METHOD_TEXT)) if (match[1]) bodies.push({ method: match[1], params: [] });
      }
    }
  }
  return bodies;
}

function requestMethods(record: Record<string, unknown>): string[] {
  return requestBodies(record).map((body) => body.method);
}

/** ERC-7677 paymaster web service calls (and the older Pimlico/Alchemy sponsor calls). */
function isPaymasterMethod(method: string): boolean {
  return method.startsWith("pm_") || /sponsorUserOperation$/i.test(method);
}

const URL_TEXT = /\bhttps?:\/\/([^\s/"'<>)]+)[^\s"'<>)]*/gi;

/** Keeps only the host of every URL: RPC, bundler and paymaster URLs can carry API keys. */
function redactUrls(text: string): string {
  return text.replace(URL_TEXT, (_match, host: string) => `https://${host}/…`);
}

/** A stack frame line: V8 ("at fn (url:1:2)") or Safari and Firefox ("fn@url:1:2"). */
const STACK_FRAME = /^\s*at\s|@.*:\d+:\d+$/;

/**
 * Only the frame lines of an error's stack, for reports. A V8 stack starts
 * with the error's message, and viem's message quotes the request URL (an
 * RPC, bundler or paymaster key) and body. Frames name script files, which
 * are kept whole. Undefined when there are none.
 */
export function stackFrames(error: unknown): string | undefined {
  const stack = error instanceof Error ? error.stack : undefined;
  const frames = stack?.split("\n").filter((line) => STACK_FRAME.test(line));
  return frames && frames.length > 0 ? frames.map((line) => line.trim()).join("\n") : undefined;
}

const MAX_REASON_LENGTH = 200;

/**
 * The most specific human reason in the chain: the service's own words
 * (viem's `details`, which is the JSON-RPC error message), otherwise the first
 * plain error message. URLs are reduced to their host. Null when there is none.
 */
function failureReason(chain: unknown[]): string | null {
  let fallback: string | null = null;
  for (const entry of chain) {
    if (typeof entry === "string") {
      fallback ??= entry;
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.details === "string" && record.details.trim()) return clip(record.details);
    if (typeof record.shortMessage !== "string" && typeof record.message === "string" && record.message.trim()) {
      fallback ??= record.message.split("\n")[0] ?? null;
    }
  }
  return fallback ? clip(fallback) : null;
}

function clip(text: string): string {
  const clean = redactUrls(text.trim());
  return clean.length > MAX_REASON_LENGTH ? `${clean.slice(0, MAX_REASON_LENGTH - 1)}…` : clean;
}

const USER_REJECTED_TEXT =
  /user (rejected|denied|cancel+ed|declined|exited|closed|dismissed)|rejected by (the )?user|denied by (the )?user|cancel+ed by (the )?user|request (was )?rejected|transaction was rejected|denied transaction signature|exited the modal|exited before/i;
const POPUP_BLOCKED_TEXT = /failed to initialize signature request|popup (was )?blocked|pop-up (was )?blocked/i;
const INSUFFICIENT_GAS_TEXT =
  /insufficient funds|insufficient balance for (gas|transfer)|\bAA21\b|didn't pay prefund|exceeds the balance of the account|gas required exceeds allowance/i;
/** EntryPoint paymaster codes (AA30-AA39). Checked before reverts because bundlers phrase them "AA33 reverted". */
const PAYMASTER_CODE_TEXT = /\bAA3\d\b/i;
/**
 * Paymaster or sponsorship refusals worded by Privy, bundlers or paymaster
 * services, including Coinbase CDP's policy refusals ("request denied - policy
 * rejected: called address not in allowlist: 0x…", spend and count limits).
 */
const SPONSORSHIP_TEXT =
  /paymaster|cannot sponsor|sponsoring is only supported|sponsorship|gas (manager|policy)|policy rejected|not in (the )?allowlist|spend limit|max(imum)? per (user|address)/i;
const CHAIN_TEXT = /chain mismatch|does not match the target chain|unrecognized chain|switch(ing)? (to )?(the )?(chain|network)|wallet_switchEthereumChain|unsupported chain/i;
const REVERT_TEXT = /execution reverted|reverted|\bAA2[3-9]\b/i;
const TIMEOUT_TEXT = /request timeout|timed out|timeout|took too long to respond/i;

const USER_REJECTED_NAMES = new Set(["UserRejectedRequestError", "UserRejectedError"]);
const CHAIN_NAMES = new Set(["ChainMismatchError", "SwitchChainError", "ChainNotConfiguredError", "ChainDisconnectedError"]);
const RECEIPT_TIMEOUT_NAMES = new Set(["WaitForTransactionReceiptTimeoutError", "WaitForUserOperationReceiptTimeoutError"]);
const INSUFFICIENT_GAS_NAMES = new Set(["InsufficientFundsError", "InsufficientPrefundError"]);
const REVERT_NAMES = new Set(["ContractFunctionRevertedError", "ExecutionRevertedError", "SmartAccountFunctionRevertedError"]);
/** viem's typed bundler errors for paymaster failures (viem/account-abstraction). */
const PAYMASTER_NAMES = new Set([
  "PaymasterDepositTooLowError",
  "PaymasterFunctionRevertedError",
  "PaymasterNotDeployedError",
  "PaymasterPostOpFunctionRevertedError",
  "PaymasterRateLimitError",
  "PaymasterStakeTooLowError",
  "UserOperationPaymasterExpiredError",
  "UserOperationPaymasterSignatureError",
  "UserOperationRejectedByPaymasterError",
  "InvalidPaymasterAndDataError",
]);
const TIMEOUT_NAMES = new Set(["TimeoutError", "WalletTimeoutError"]);

/** "execution reverted: X" (node) or "Execution reverted with reason: X." (viem). Raw revert data is not a reason. */
const REVERT_REASON_TEXT = /execution reverted(?: with reason)?:\s*(.+?)\.?\s*$/im;

function revertReason(chain: unknown[]): string | null {
  for (const entry of chain) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.reason === "string" && record.reason.trim()) return record.reason.trim();
  }
  for (const entry of chain) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    for (const key of ["shortMessage", "details"]) {
      const value = record[key];
      const match = typeof value === "string" ? REVERT_REASON_TEXT.exec(value) : null;
      const reason = match?.[1]?.trim();
      if (reason && !/^0x[0-9a-f]*$/i.test(reason)) return reason;
    }
  }
  return null;
}

function bestMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    for (const key of ["shortMessage", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0] ?? value.trim();
    }
  }
  return "Something went wrong with your wallet. Try again.";
}

/** True when the error is a Privy sponsorship refusal raised before anything was broadcast. */
export function isSponsorshipUnavailable(error: unknown): boolean {
  return /sponsoring is only supported for wallets on the TEE stack|cannot sponsor/i.test(
    collectFacts(causeChain(error)).text,
  );
}

export interface ToWalletErrorOptions {
  /**
   * The error came from a transaction request (not a signature) that may have
   * reached the network. A wallet timeout then means the transaction may
   * already have been broadcast, so it becomes `TransactionPendingError(null)`
   * instead of a retryable timeout, and an unrecognised failure keeps
   * `mayHaveLanded`. Leave it unset for a send proven to have stopped before
   * submission.
   */
  sending?: boolean;
}

/**
 * Normalises any wallet, Privy or viem error into a `WalletError`. An existing
 * `WalletError` anywhere in the cause chain wins, so typed errors raised inside
 * a viem transport survive viem's wrapping.
 */
export function toWalletError(error: unknown, options: ToWalletErrorOptions = {}): WalletError {
  const chain = causeChain(error);
  for (const entry of chain) {
    if (entry instanceof WalletError) return entry;
  }
  const facts = collectFacts(chain);
  const hasName = (names: ReadonlySet<string>) => facts.names.some((name) => names.has(name));
  const cause = { cause: error };

  if (
    facts.numericCodes.includes(4001) ||
    facts.numericCodes.includes(5000) ||
    facts.stringCodes.includes("ACTION_REJECTED") ||
    hasName(USER_REJECTED_NAMES) ||
    USER_REJECTED_TEXT.test(facts.text)
  ) {
    return new UserRejectedError(cause);
  }
  if (POPUP_BLOCKED_TEXT.test(facts.text)) return new PopupBlockedError(cause);
  if (hasName(RECEIPT_TIMEOUT_NAMES)) return new TransactionPendingError(null, cause);
  if (hasName(INSUFFICIENT_GAS_NAMES) || INSUFFICIENT_GAS_TEXT.test(facts.text)) {
    return new InsufficientGasError(null, cause);
  }
  if (hasName(PAYMASTER_NAMES) || PAYMASTER_CODE_TEXT.test(facts.text)) return new SponsorshipError(cause);
  if (
    facts.numericCodes.includes(4902) ||
    facts.numericCodes.includes(4901) ||
    hasName(CHAIN_NAMES) ||
    CHAIN_TEXT.test(facts.text)
  ) {
    return new ChainSwitchError(cause);
  }
  // A contract rejection must win over sponsorship wording: the bank cannot fix a call that would revert.
  if (hasName(REVERT_NAMES) || REVERT_TEXT.test(facts.text)) {
    return new CallRevertedError(revertReason(chain), cause);
  }
  // Any failed paymaster call (a policy refusal, a limit, its service timing out) happens before submission.
  if (SPONSORSHIP_TEXT.test(facts.text) || facts.methods.some(isPaymasterMethod)) return new SponsorshipError(cause);
  if (hasName(TIMEOUT_NAMES) || TIMEOUT_TEXT.test(facts.text)) {
    return options.sending ? new TransactionPendingError(null, cause) : new WalletTimeoutError(cause);
  }
  return new WalletError("unknown", bestMessage(error), { cause: error, mayHaveLanded: options.sending === true });
}

/**
 * How far a failed ERC-4337 send got. Privy's smart wallet runs prepare
 * (nonce, paymaster stub, gas estimate, paymaster data), signing,
 * `eth_sendUserOperation` and the receipt wait as one call, so the failed
 * JSON-RPC method tells them apart:
 *
 * - `submitted`: the receipt wait timed out, or polling for the receipt
 *   failed, so the user operation hash exists and the operation may land.
 * - `unknown`: `eth_sendUserOperation` failed without the bundler answering
 *   (lost connection, timeout, 5xx), so it may have been accepted.
 * - `not_submitted`: anything else. The bundler refused the operation, or it
 *   failed before submission, so no user operation exists that could land.
 */
export type UserOperationSubmission = "not_submitted" | "submitted" | "unknown";

export const SEND_USER_OPERATION = "eth_sendUserOperation";
/** Bundler reads that only happen once a user operation hash exists. */
export const AFTER_SUBMISSION_METHODS: ReadonlySet<string> = new Set(["eth_getUserOperationReceipt", "eth_getUserOperationByHash"]);
/** JSON-RPC "internal error": the bundler may have failed after accepting the operation. */
const INTERNAL_RPC_ERROR = -32603;

export function userOperationSubmission(error: unknown): UserOperationSubmission {
  const chain = causeChain(error);
  const facts = collectFacts(chain);
  if (facts.names.includes("WaitForUserOperationReceiptTimeoutError")) return "submitted";
  if (facts.methods.some((method) => AFTER_SUBMISSION_METHODS.has(method))) return "submitted";
  if (!facts.methods.includes(SEND_USER_OPERATION)) return "not_submitted";
  return bundlerRefused(chain) ? "not_submitted" : "unknown";
}

/** The bundler answered with an error (a JSON-RPC error or an HTTP 4xx), so it did not accept the operation. */
function bundlerRefused(chain: unknown[]): boolean {
  return chain.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const record = entry as Record<string, unknown>;
    if (record.name === "RpcRequestError") return typeof record.code === "number" && record.code !== INTERNAL_RPC_ERROR;
    if (record.name === "HttpRequestError") return typeof record.status === "number" && record.status >= 400 && record.status < 500;
    return false;
  });
}

/** Records the confirmed hashes of a partially completed request on the error. */
export function withCompletedHashes(error: WalletError, completed: readonly Hash[]): WalletError {
  if (completed.length > 0 && error.completedHashes.length === 0) error.completedHashes = [...completed];
  return error;
}

/**
 * Player-facing copy for any error thrown by the wallet layer, including the
 * partial-completion warning when earlier steps already confirmed.
 */
export function walletErrorMessage(error: unknown): string {
  const walletError = toWalletError(error);
  if (walletError.completedHashes.length === 0) return walletError.message;
  return `${walletError.message} Earlier steps of this request already confirmed on Base, so check your balance before trying again.`;
}
