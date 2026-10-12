import { create } from "zustand";
import type { CurrencyType } from "@zkp2p/cash";
import {
  createLeg,
  type LegCheckState,
  type SellDraftState,
  type SellLegDraft,
  type SubmissionState,
} from "./machine";
import { clampSpreadBps } from "./spreadRate";

export interface SellStore extends SellDraftState {
  /** Lowercase wallet the draft belongs to; switching wallets resets the draft. */
  owner: string | null;
  setOwner(owner: string | null): void;
  setAmount(amount: string): void;
  /** The seller's spread on the oracle rate, basis points, clamped to Peer's -5% to +5%. */
  setSpread(spreadBps: number): void;
  /** Adds a payout leg and returns its id. */
  addLeg(platform?: string, currencies?: CurrencyType[]): string;
  removeLeg(id: string): void;
  updateLeg(id: string, patch: Partial<Omit<SellLegDraft, "id">>): void;
  setCheck(id: string, check: LegCheckState): void;
  setSubmission(submission: SubmissionState | null): void;
  reset(): void;
}

function emptyDraft(): SellDraftState {
  return { amount: "", legs: [createLeg()], checks: {}, submission: null, spreadBps: 0 };
}

/**
 * The single sell draft for the bank's Sell dialogue. Edits are ignored while
 * a submission is in flight or listed; an error that left nothing on-chain is
 * cleared by the next edit.
 */
export const useSellStore = create<SellStore>()((set, get) => {
  const editable = (): boolean => {
    const submission = get().submission;
    return !submission || submission.status === "error";
  };
  /** Clears a submission error whose recovery is "fix the form", so editing returns to the form. */
  const clearSafeError = (): Partial<SellDraftState> => {
    const submission = get().submission;
    if (submission?.status !== "error") return {};
    const action = submission.error.recovery.action;
    return action === "reconcile" || action === "retryAccessPolicy" ? {} : { submission: null };
  };
  const pendingOnChain = (): boolean => {
    const submission = get().submission;
    if (submission?.status !== "error") return false;
    const action = submission.error.recovery.action;
    return action === "reconcile" || action === "retryAccessPolicy";
  };

  return {
    ...emptyDraft(),
    owner: null,
    setOwner: (owner) => {
      const next = owner?.toLowerCase() ?? null;
      if (get().owner === next) return;
      set({ ...emptyDraft(), owner: next });
    },
    setAmount: (amount) => {
      if (!editable() || pendingOnChain()) return;
      set({ amount, ...clearSafeError() });
    },
    setSpread: (spreadBps) => {
      if (!editable() || pendingOnChain()) return;
      set({ spreadBps: clampSpreadBps(spreadBps), ...clearSafeError() });
    },
    addLeg: (platform = "", currencies = []) => {
      const leg = createLeg(platform, currencies);
      if (!editable() || pendingOnChain()) return leg.id;
      set((s) => ({ legs: [...s.legs, leg], ...clearSafeError() }));
      return leg.id;
    },
    removeLeg: (id) => {
      if (!editable() || pendingOnChain()) return;
      set((s) => {
        const checks = { ...s.checks };
        delete checks[id];
        return { legs: s.legs.filter((leg) => leg.id !== id), checks, ...clearSafeError() };
      });
    },
    updateLeg: (id, patch) => {
      if (!editable() || pendingOnChain()) return;
      set((s) => ({ legs: s.legs.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)), ...clearSafeError() }));
    },
    setCheck: (id, check) => set((s) => ({ checks: { ...s.checks, [id]: check } })),
    setSubmission: (submission) => set({ submission }),
    reset: () => {
      if (get().submission?.status === "submitting") return;
      // A deposit that may be on-chain keeps its recovery in view; only the form clears.
      set({ ...emptyDraft(), submission: pendingOnChain() ? get().submission : null });
    },
  };
});
