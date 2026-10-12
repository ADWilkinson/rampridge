import { useSyncExternalStore } from "react";
import { PopupBlockedError, UserRejectedError, WalletBusyError } from "./errors";

/**
 * Privy cross-app (Peer account) requests open a window on Peer's domain.
 * Browsers only allow that shortly after a click, so the second transaction of
 * a batch, or one sent after slow network work, gets blocked. The wallet layer
 * then parks the request here and waits for the player to click once more.
 */
export interface WalletGestureRequest {
  /** What the pending wallet request is for, e.g. "Deposit 50 USDC". */
  readonly label: string;
  /** Call from a click handler: retries the wallet request inside that click. */
  confirm(): void;
  /** Abandons the request; the waiting `sendCalls`/`signMessage` rejects with `UserRejectedError`. */
  cancel(): void;
}

let pending: WalletGestureRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getWalletGestureRequest(): WalletGestureRequest | null {
  return pending;
}

export function subscribeWalletGesture(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    const abandoned = pending;
    // A Strict Mode remount resubscribes synchronously; only an unmount with no prompt left cancels.
    queueMicrotask(() => {
      if (listeners.size === 0 && pending === abandoned) abandoned?.cancel();
    });
  };
}

/**
 * Parks `run` until the player confirms. Rejects immediately with
 * `PopupBlockedError` when no prompt is mounted to ask them.
 */
export function requestWalletGesture<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (listeners.size === 0) return Promise.reject(new PopupBlockedError());
  if (pending) return Promise.reject(new WalletBusyError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const clear = () => {
      if (pending === request) {
        pending = null;
        emit();
      }
    };
    const request: WalletGestureRequest = {
      label,
      confirm() {
        if (settled || pending !== request) return;
        settled = true;
        clear();
        try {
          // Must run synchronously inside the click so the browser allows the window.
          run().then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      },
      cancel() {
        if (settled || pending !== request) return;
        settled = true;
        clear();
        reject(new UserRejectedError());
      },
    };
    pending = request;
    emit();
  });
}

/** The request waiting for a click, or null. Render a prompt with Continue/Cancel when set. */
export function useWalletGestureRequest(): WalletGestureRequest | null {
  return useSyncExternalStore(subscribeWalletGesture, getWalletGestureRequest, () => null);
}
