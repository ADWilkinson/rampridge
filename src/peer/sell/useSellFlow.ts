import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CashClient, CurrencyType } from "@zkp2p/cash";
import { canInstallPeerExtension, getExtensionStatus, openExtensionInstallPage, type ExtensionStatus } from "@/peer/extension";
import { track } from "@/lib/telemetry";
import type { TxSender } from "@/wallet/types";
import { reportFailure } from "../errorDetail";
import { formatUsdcInput } from "./amount";
import { useGasBalance, useUsdcBalance } from "./balance";
import { findPlatform, getCashClient, preferredCurrency, sellCapabilities, type SellCapabilities, type SellPlatform } from "./cash";
import { toSellFlowError, type SellFlowError } from "./errors";
import {
  peerRegistrationKind,
  registerPayeeWithPeerExtension,
  PeerRegistrationError,
  type PeerRegistrationPhase,
} from "./identity";
import {
  checkCurrencies,
  enrollmentConfirmed,
  evaluateSell,
  initialSteps,
  legCheckKey,
  type GasState,
  type LegCheckState,
  type ListedSell,
  type SellIssue,
  type SellLegDraft,
  type SellPhase,
  type SubmitSteps,
} from "./machine";
import { normalizePayee } from "./payees";
import { sellQueryKeys } from "./queryKeys";
import { SELL_SPREAD_ENABLED } from "./spreadRate";
import { useSellStore } from "./store";
import {
  discardPendingSell,
  reconcileError,
  reconcilePendingSell,
  retryAccessPolicy,
  submitSell,
  type ReconcileResult,
  type SellDeps,
  type SellPublicClient,
} from "./submit";
import { checkPayee, type PayeeCheck } from "./validatePayee";

export interface UseSellFlowOptions {
  /** The logged-in wallet, or null when logged out. */
  sender: TxSender | null;
  /** Base public client (WalletState.publicClient) for balance, gas and recovery reads. */
  publicClient?: SellPublicClient | null;
  /** USDC balance in base units when the caller already tracks it; omit to read it here. */
  balance?: bigint | null;
  /** Called once per new listing (including one recovered after a reload), e.g. to announce it. */
  onListed?: (listed: ListedSell) => void;
  /** Payee check debounce (default 800 ms). */
  debounceMs?: number;
  /** Override the Peer Cash client (tests). */
  client?: CashClient;
  /** Override the PeerAuth status read and install page (tests, dev harness). */
  extension?: SellExtensionDeps;
}

/** How the flow reads PeerAuth and opens its install page (defaults: `src/peer/extension.ts`). */
export interface SellExtensionDeps {
  status(): Promise<ExtensionStatus>;
  openInstallPage(): void;
  /** Desktop Chromium, where PeerAuth can be installed. */
  canInstall: boolean;
}

const DEFAULT_EXTENSION: SellExtensionDeps = {
  status: () => getExtensionStatus(),
  openInstallPage: () => openExtensionInstallPage(),
  get canInstall() {
    return canInstallPeerExtension();
  },
};

export interface LegRegistration {
  phase: PeerRegistrationPhase;
  error: PeerRegistrationError | null;
}

export interface SellLegView extends SellLegDraft {
  platformInfo: SellPlatform | null;
  /** Normalised handle when the local format check passes. */
  offchainId: string | null;
  check: LegCheckState;
  issues: SellIssue[];
  /** PeerAuth registration progress for this leg, when one has run. */
  registration: LegRegistration | null;
  /** True when `registerPayee` can register this leg's handle through the extension. */
  canRegister: boolean;
  /** The platform needs the seller to confirm the handle is enrolled (Zelle). */
  enrollmentRequired: boolean;
  /** The seller confirmed enrolment for exactly the handle now entered. */
  enrollmentConfirmed: boolean;
}

export interface SellFlow {
  phase: SellPhase;
  amount: string;
  /** The seller's spread on the oracle rate, basis points (0 = the market rate). */
  spreadBps: number;
  /** Sellers may set a spread (`SELL_SPREAD_ENABLED`). */
  spreadEnabled: boolean;
  /** Parsed amount (base units) when the text is a valid number. */
  amountUnits: bigint | null;
  legs: SellLegView[];
  /** Every blocking or pending issue; `legId` ties an issue to a leg. */
  issues: SellIssue[];
  capabilities: SellCapabilities;
  balance: bigint | null;
  balanceLoading: boolean;
  gas: GasState;
  canSubmit: boolean;
  /** Per-step status while submitting, after listing, or where an error stopped. */
  steps: SubmitSteps | null;
  listed: ListedSell | null;
  error: SellFlowError | null;
  /** A status check, policy retry or discard is running. */
  recovering: boolean;
  /**
   * PeerAuth can run in this browser (desktop Chromium). When false, offer
   * registration at PEER_WEB_URL instead of `registerPayee`.
   */
  extensionSupported: boolean;
  /**
   * PeerAuth in this browser, read while a leg's handle needs the one-time
   * registration (null before that, or when it can't be read). "needs_install"
   * offers the Chrome Web Store at that moment, as Peer's web app does.
   */
  extension: ExtensionStatus | null;
  /**
   * The install page was opened and PeerAuth isn't found yet: the flow checks
   * again on focus and every 2 s (for 10 minutes).
   */
  extensionInstallPending: boolean;

  setAmount(text: string): void;
  /** Sets the spread, clamped to Peer's -5% to +5%. */
  setSpread(spreadBps: number): void;
  /** Fills the amount with the whole USDC balance. */
  setMaxAmount(): void;
  addLeg(platform?: string): string;
  removeLeg(id: string): void;
  /** Picks the platform and a default currency for it. */
  setLegPlatform(id: string, platform: string): void;
  setLegCurrencies(id: string, currencies: CurrencyType[]): void;
  setLegPayee(id: string, payee: string): void;
  /**
   * Confirms (or withdraws) that this leg's handle is enrolled with the
   * platform and can receive payments (Zelle). Bound to the exact handle now
   * entered; editing the handle needs a new confirmation. Never sent to Peer.
   */
  setLegEnrollment(id: string, confirmed: boolean): void;
  /** Runs the payee check again now (e.g. after registering elsewhere). */
  recheckPayee(id: string): void;
  /** Registers this leg's handle through PeerAuth, then re-checks it. Resolves true on success. */
  registerPayee(id: string): Promise<boolean>;
  cancelRegistration(id: string): void;
  /** Opens PeerAuth's Chrome Web Store page and watches for the install. */
  installExtension(): void;
  /** Reads PeerAuth's state again now ("I've installed it"). */
  recheckExtension(): void;
  /** Lists the order. Resolves with the listing, or null when it failed (see `error`). */
  submit(): Promise<ListedSell | null>;
  /** Runs the recovery the current error calls for (retry, check status or finish setup). */
  recover(): Promise<void>;
  /** Checks an interrupted submission against the chain. */
  reconcile(): Promise<void>;
  /**
   * Abandons an interrupted submission once no deposit from it can still land
   * (`error.recovery.canDiscard`); refuses otherwise. Resolves true if discarded.
   */
  discardPending(): Promise<boolean>;
  /** Clears an error that left nothing on-chain. */
  dismissError(): void;
  /** Starts a fresh order (keeps a pending recovery visible). */
  reset(): void;
}

const DEFAULT_DEBOUNCE_MS = 800;
/** After the install page opens: how often, and for how long, the flow looks for PeerAuth. */
const INSTALL_POLL_MS = 2_000;
const INSTALL_WATCH_MS = 10 * 60_000;
const AUTO_RECONCILE_DELAY_MS = 5_000;
const announced = new Set<string>();

function allDoneSteps(listed: ListedSell): SubmitSteps {
  return {
    approve: "done",
    createDeposit: "done",
    accessPolicy: listed.txHashes.accessPolicy.length ? "done" : "skipped",
  };
}

/**
 * Headless sell flow for the bank's Sell dialogue: draft editing, debounced
 * live payee checks, PeerAuth registration, submission with step progress,
 * and recovery of an interrupted submission when the wallet (re)connects.
 * Needs a QueryClientProvider ancestor.
 */
export function useSellFlow(options: UseSellFlowOptions): SellFlow {
  const { sender, publicClient = null, debounceMs = DEFAULT_DEBOUNCE_MS } = options;
  const client = options.client ?? getCashClient();
  const queryClient = useQueryClient();
  const store = useSellStore();
  const capabilities = useMemo(() => sellCapabilities(client), [client]);
  const owner = sender?.address ?? null;

  const usdc = useUsdcBalance(publicClient, owner, { enabled: options.balance === undefined });
  const balance = options.balance !== undefined ? options.balance : usdc.value;
  const gasQuery = useGasBalance(publicClient, owner, { enabled: Boolean(sender && !sender.sponsored) });
  const gas: GasState = !sender
    ? "unknown"
    : sender.sponsored
      ? "sponsored"
      : gasQuery.value === null
        ? "unknown"
        : gasQuery.value === 0n
          ? "empty"
          : "ok";

  const evaluation = evaluateSell(store, { caps: capabilities, walletConnected: Boolean(sender), balance, gas });

  const [recovering, setRecovering] = useState(false);
  const extensionSupported = useMemo(() => (options.extension ?? DEFAULT_EXTENSION).canInstall, [options.extension]);
  const extensionRef = useRef(options.extension ?? DEFAULT_EXTENSION);
  extensionRef.current = options.extension ?? DEFAULT_EXTENSION;
  const [registrations, setRegistrations] = useState<Record<string, LegRegistration>>({});
  const registrationAborts = useRef(new Map<string, AbortController>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const onListedRef = useRef(options.onListed);
  onListedRef.current = options.onListed;

  const deps = useMemo<SellDeps | null>(() => (sender ? { client, sender, publicClient } : null), [client, sender, publicClient]);

  const afterListed = useCallback(
    (listed: ListedSell) => {
      if (owner) {
        void queryClient.invalidateQueries({ queryKey: sellQueryKeys.orders(owner) });
        void queryClient.invalidateQueries({ queryKey: sellQueryKeys.usdcBalance(owner) });
      }
      if (listed.depositId && !announced.has(listed.depositId)) {
        announced.add(listed.depositId);
        onListedRef.current?.(listed);
      }
    },
    [owner, queryClient],
  );

  const applyReconcile = useCallback(
    (result: ReconcileResult) => {
      const { setSubmission } = useSellStore.getState();
      if (result.status === "inFlight") return;
      if (result.status === "none") {
        setSubmission(null);
      } else if (result.status === "closed") {
        // The order filled or was withdrawn before its policy attached: nothing is pending any more.
        setSubmission(null);
        if (owner) void queryClient.invalidateQueries({ queryKey: sellQueryKeys.orders(owner) });
      } else if (result.status === "listed") {
        setSubmission({ status: "listed", steps: allDoneSteps(result.listed), listed: result.listed });
        afterListed(result.listed);
      } else {
        const error = reconcileError(result);
        if (error) setSubmission({ status: "error", steps: result.steps, error });
      }
    },
    [afterListed, owner, queryClient],
  );

  // Read through refs so the reconcile below runs once per wallet, not per render.
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const applyReconcileRef = useRef(applyReconcile);
  applyReconcileRef.current = applyReconcile;

  // A new wallet gets a fresh draft, and any submission it left mid-flight is reconciled.
  useEffect(() => {
    useSellStore.getState().setOwner(owner);
    const current = depsRef.current;
    setRecovering(Boolean(owner && current));
    if (!owner || !current) return;
    let cancelled = false;
    reconcilePendingSell(current)
      .then((result) => {
        if (!cancelled && result.status !== "none" && result.status !== "inFlight") applyReconcileRef.current(result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setRecovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [owner]);

  const runCheck = useCallback(
    (leg: SellLegDraft, key: string, delay: number) => {
      const platform = findPlatform(capabilities, leg.platform);
      if (!platform) return;
      const existing = timers.current.get(leg.id);
      if (existing) clearTimeout(existing);
      useSellStore.getState().setCheck(leg.id, { status: "checking", key });
      const timer = setTimeout(() => {
        timers.current.delete(leg.id);
        void checkPayee(client, {
          platform: leg.platform,
          currencies: checkCurrencies(leg, platform),
          payee: leg.payee,
          requiresIdentityAttestation: platform.requiresIdentityAttestation,
        })
          .catch((): PayeeCheck => ({ kind: "error", retryable: true, message: "Couldn't check that handle. Try again." }))
          .then((result) => {
            const current = useSellStore.getState().checks[leg.id];
            if (current?.status === "checking" && current.key === key) {
              useSellStore.getState().setCheck(leg.id, { status: "done", key, result });
            }
          });
      }, delay);
      timers.current.set(leg.id, timer);
    },
    [capabilities, client],
  );

  // Debounced live payee check whenever a leg's platform or handle changes.
  useEffect(() => {
    const { legs, checks, setCheck } = useSellStore.getState();
    const liveIds = new Set(legs.map((leg) => leg.id));
    for (const [id, timer] of timers.current) {
      if (!liveIds.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
    for (const leg of legs) {
      const key = legCheckKey(leg, capabilities);
      const current = checks[leg.id];
      if (!key) {
        const timer = timers.current.get(leg.id);
        if (timer) {
          clearTimeout(timer);
          timers.current.delete(leg.id);
        }
        if (current && current.status !== "unchecked") setCheck(leg.id, { status: "unchecked" });
        continue;
      }
      if (current && current.status !== "unchecked" && current.key === key) continue;
      runCheck(leg, key, debounceMs);
    }
  }, [store.legs, store.checks, capabilities, debounceMs, runCheck]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      for (const controller of registrationAborts.current.values()) controller.abort();
      registrationAborts.current.clear();
    },
    [],
  );

  const setLegPlatform = useCallback(
    (id: string, platformId: string) => {
      const platform = findPlatform(capabilities, platformId);
      const leg = useSellStore.getState().legs.find((l) => l.id === id);
      if (!leg) return;
      const kept = platform ? leg.currencies.filter((c) => platform.currencies.includes(c)) : [];
      const fallback = platform ? preferredCurrency(platform.currencies) : null;
      useSellStore.getState().updateLeg(id, {
        platform: platformId,
        currencies: kept.length ? kept : fallback ? [fallback] : [],
      });
    },
    [capabilities],
  );

  const reconcile = useCallback(async () => {
    if (!deps) return;
    setRecovering(true);
    try {
      applyReconcile(await reconcilePendingSell(deps));
    } finally {
      setRecovering(false);
    }
  }, [applyReconcile, deps]);
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  const submit = useCallback(async (): Promise<ListedSell | null> => {
    const prior = useSellStore.getState().submission;
    if (prior?.status === "submitting" || prior?.status === "listed") return null;
    if (prior?.status === "error") {
      // Something may be on-chain: only its recovery may run, never a new deposit.
      if (prior.error.recovery.action === "reconcile" || prior.error.recovery.action === "retryAccessPolicy") return null;
      useSellStore.getState().setSubmission(null);
    }
    const state = useSellStore.getState();
    const current = evaluateSell(state, { caps: capabilities, walletConnected: Boolean(sender), balance, gas });
    if (!deps || !current.canSubmit || !current.legs || current.amount === null) return null;
    let steps = initialSteps();
    state.setSubmission({ status: "submitting", steps });
    track("sell_start");
    try {
      const listed = await submitSell(deps, { amount: current.amount, legs: current.legs, spreadBps: current.spreadBps }, (next) => {
        steps = next;
        useSellStore.getState().setSubmission({ status: "submitting", steps: next });
      });
      useSellStore.getState().setSubmission({ status: "listed", steps, listed });
      track("deposit_ok");
      afterListed(listed);
      return listed;
    } catch (err) {
      const error = toSellFlowError(err);
      if (error.code !== "USER_REJECTED") {
        track("deposit_fail");
        reportFailure(err, "deposit");
      }
      useSellStore.getState().setSubmission({ status: "error", steps, error });
      // An unknown outcome usually resolves once the indexer catches up: check once automatically.
      if (error.recovery.action === "reconcile") {
        setTimeout(() => {
          const now = useSellStore.getState().submission;
          if (now?.status === "error" && now.error === error) void reconcileRef.current();
        }, AUTO_RECONCILE_DELAY_MS);
      }
      return null;
    }
  }, [afterListed, balance, capabilities, deps, gas, sender]);

  const finishAccessPolicy = useCallback(async () => {
    const state = useSellStore.getState();
    const submission = state.submission;
    if (!deps || submission?.status !== "error") return;
    const { error } = submission;
    let steps = submission.steps;
    setRecovering(true);
    state.setSubmission({ status: "submitting", steps: { ...steps, accessPolicy: "active" } });
    try {
      const fallback =
        error.depositId && error.paymentMethod
          ? {
              depositId: error.depositId,
              paymentMethods: [error.paymentMethod],
              amount: evaluation.amount ?? 0n,
              legs: [],
            }
          : undefined;
      const listed = await retryAccessPolicy(
        deps,
        (next) => {
          steps = next;
          useSellStore.getState().setSubmission({ status: "submitting", steps: next });
        },
        fallback,
      );
      useSellStore.getState().setSubmission({ status: "listed", steps, listed });
      afterListed(listed);
    } catch (err) {
      useSellStore.getState().setSubmission({ status: "error", steps, error: toSellFlowError(err, { stage: "policy" }) });
    } finally {
      setRecovering(false);
    }
  }, [afterListed, deps, evaluation.amount]);

  const dismissError = useCallback(() => {
    const { submission, setSubmission } = useSellStore.getState();
    if (submission?.status !== "error") return;
    const action = submission.error.recovery.action;
    if (action === "reconcile" || action === "retryAccessPolicy") return;
    setSubmission(null);
  }, []);

  const recover = useCallback(async () => {
    const submission = useSellStore.getState().submission;
    if (submission?.status !== "error") return;
    switch (submission.error.recovery.action) {
      case "retry":
        useSellStore.getState().setSubmission(null);
        await submit();
        return;
      case "reconcile":
        await reconcile();
        return;
      case "retryAccessPolicy":
        await finishAccessPolicy();
        return;
      default:
        dismissError();
    }
  }, [dismissError, finishAccessPolicy, reconcile, submit]);

  const discardPending = useCallback(async () => {
    if (!deps) return false;
    setRecovering(true);
    try {
      const result = await discardPendingSell(deps);
      applyReconcile(result);
      return result.status === "none";
    } finally {
      setRecovering(false);
    }
  }, [applyReconcile, deps]);

  const recheckPayee = useCallback(
    (id: string) => {
      const leg = useSellStore.getState().legs.find((l) => l.id === id);
      if (!leg) return;
      const key = legCheckKey(leg, capabilities);
      if (key) runCheck(leg, key, 0);
    },
    [capabilities, runCheck],
  );

  const registerPayee = useCallback(
    async (id: string): Promise<boolean> => {
      const leg = useSellStore.getState().legs.find((l) => l.id === id);
      if (!leg || !sender || !peerRegistrationKind(leg.platform)) return false;
      const format = normalizePayee(leg.platform, leg.payee);
      if (!format.ok) return false;
      registrationAborts.current.get(id)?.abort();
      const controller = new AbortController();
      registrationAborts.current.set(id, controller);
      const update = (registration: LegRegistration) => setRegistrations((prev) => ({ ...prev, [id]: registration }));
      try {
        await registerPayeeWithPeerExtension({
          platform: leg.platform,
          offchainId: format.offchainId,
          callerAddress: sender.address,
          signal: controller.signal,
          onPhase: (phase) => update({ phase, error: null }),
        });
        update({ phase: "registered", error: null });
        recheckPayee(id);
        return true;
      } catch (err) {
        const error = err instanceof PeerRegistrationError ? err : new PeerRegistrationError("REGISTRATION_FAILED", undefined, err);
        update({ phase: error.code === "CANCELLED" ? "idle" : "failed", error: error.code === "CANCELLED" ? null : error });
        return false;
      } finally {
        if (registrationAborts.current.get(id) === controller) registrationAborts.current.delete(id);
      }
    },
    [recheckPayee, sender],
  );

  const cancelRegistration = useCallback((id: string) => {
    registrationAborts.current.get(id)?.abort();
  }, []);

  // PeerAuth is read only while a leg's handle needs the one-time registration through it.
  const registrationNeeded = store.legs.some((leg) => {
    const check = store.checks[leg.id];
    return (
      Boolean(findPlatform(capabilities, leg.platform)?.registration) &&
      check?.status === "done" &&
      (check.result.kind === "needsIdentityAttestation" || check.result.kind === "notFound")
    );
  });
  const watchExtension = extensionSupported && registrationNeeded;
  const [extension, setExtension] = useState<ExtensionStatus | null>(null);
  const [installOpenedAt, setInstallOpenedAt] = useState<number | null>(null);
  const extensionReads = useRef(0);
  const readExtension = useCallback(() => {
    const run = ++extensionReads.current;
    void extensionRef.current
      .status()
      .catch(() => null)
      .then((status) => {
        if (run === extensionReads.current) setExtension(status);
      });
  }, []);

  // Read when needed, and again whenever the player comes back to this tab (from the Web Store, say).
  useEffect(() => {
    if (!watchExtension) return;
    readExtension();
    const onReturn = () => {
      if (document.visibilityState !== "hidden") readExtension();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [readExtension, watchExtension]);

  // After the install page opens, keep looking until PeerAuth answers (Peer web re-checks the same way).
  const extensionInstallPending = installOpenedAt !== null && extension === "needs_install";
  useEffect(() => {
    if (!watchExtension || installOpenedAt === null || extension !== "needs_install") return;
    const timer = setInterval(() => {
      if (Date.now() - installOpenedAt > INSTALL_WATCH_MS) clearInterval(timer);
      else readExtension();
    }, INSTALL_POLL_MS);
    return () => clearInterval(timer);
  }, [extension, installOpenedAt, readExtension, watchExtension]);

  const installExtension = useCallback(() => {
    extensionRef.current.openInstallPage();
    setInstallOpenedAt(Date.now());
    readExtension();
  }, [readExtension]);

  const legs: SellLegView[] = store.legs.map((leg) => {
    const platformInfo = findPlatform(capabilities, leg.platform);
    const format = leg.platform ? normalizePayee(leg.platform, leg.payee) : null;
    const check = store.checks[leg.id] ?? { status: "unchecked" };
    const flagged = check.status === "done" && (check.result.kind === "needsIdentityAttestation" || check.result.kind === "notFound");
    return {
      ...leg,
      platformInfo,
      offchainId: format?.ok ? format.offchainId : null,
      check,
      issues: evaluation.issues.filter((issue) => issue.legId === leg.id),
      registration: registrations[leg.id] ?? null,
      canRegister: Boolean(sender && format?.ok && flagged && platformInfo?.registration),
      enrollmentRequired: Boolean(platformInfo?.payeeEnrollment),
      enrollmentConfirmed: Boolean(platformInfo?.payeeEnrollment) && enrollmentConfirmed(leg, platformInfo),
    };
  });

  const submission = store.submission;
  return {
    phase: evaluation.phase,
    amount: store.amount,
    spreadBps: evaluation.spreadBps,
    spreadEnabled: SELL_SPREAD_ENABLED,
    amountUnits: evaluation.amount,
    legs,
    issues: evaluation.issues,
    capabilities,
    balance,
    balanceLoading: options.balance === undefined && usdc.isLoading,
    gas,
    canSubmit: evaluation.canSubmit,
    steps: submission?.steps ?? null,
    listed: submission?.status === "listed" ? submission.listed : null,
    error: submission?.status === "error" ? submission.error : null,
    recovering,
    extensionSupported,
    extension: watchExtension ? extension : null,
    extensionInstallPending: watchExtension && extensionInstallPending,
    setAmount: store.setAmount,
    setSpread: (spreadBps) => {
      if (SELL_SPREAD_ENABLED) useSellStore.getState().setSpread(spreadBps);
    },
    setMaxAmount: () => {
      if (balance !== null) useSellStore.getState().setAmount(formatUsdcInput(balance));
    },
    addLeg: (platform?: string) => {
      const id = useSellStore.getState().addLeg();
      if (platform) setLegPlatform(id, platform);
      return id;
    },
    removeLeg: store.removeLeg,
    setLegPlatform,
    setLegCurrencies: (id, currencies) => useSellStore.getState().updateLeg(id, { currencies }),
    setLegPayee: (id, payee) => useSellStore.getState().updateLeg(id, { payee }),
    setLegEnrollment: (id, confirmed) => {
      const leg = useSellStore.getState().legs.find((l) => l.id === id);
      if (!leg) return;
      const format = normalizePayee(leg.platform, leg.payee);
      useSellStore.getState().updateLeg(id, { enrolledFor: confirmed && format.ok ? format.offchainId : null });
    },
    recheckPayee,
    registerPayee,
    cancelRegistration,
    installExtension,
    recheckExtension: readExtension,
    submit,
    recover,
    reconcile,
    discardPending,
    dismissError,
    reset: store.reset,
  };
}
