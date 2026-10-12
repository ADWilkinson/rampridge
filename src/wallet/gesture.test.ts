import { describe, expect, it, vi } from "vitest";
import { PopupBlockedError, UserRejectedError, WalletBusyError } from "./errors";
import { getWalletGestureRequest, requestWalletGesture, subscribeWalletGesture } from "./gesture";

describe("requestWalletGesture", () => {
  it("fails fast with PopupBlockedError when no prompt is mounted", async () => {
    const run = vi.fn(async () => "never");
    await expect(requestWalletGesture("Deposit", run)).rejects.toBeInstanceOf(PopupBlockedError);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs the request synchronously when the player confirms", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWalletGesture(listener);
    const run = vi.fn(async () => "0xhash");
    const result = requestWalletGesture("Deposit", run);
    const pending = getWalletGestureRequest();
    expect(pending?.label).toBe("Deposit");
    expect(listener).toHaveBeenCalled();
    pending?.confirm();
    expect(run).toHaveBeenCalledTimes(1);
    expect(getWalletGestureRequest()).toBeNull();
    await expect(result).resolves.toBe("0xhash");
    pending?.confirm();
    expect(run).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("rejects with UserRejectedError on cancel and refuses overlapping requests", async () => {
    const unsubscribe = subscribeWalletGesture(() => {});
    const first = requestWalletGesture("Sign", async () => "sig");
    await expect(requestWalletGesture("Other", async () => "x")).rejects.toBeInstanceOf(WalletBusyError);
    getWalletGestureRequest()?.cancel();
    await expect(first).rejects.toBeInstanceOf(UserRejectedError);
    unsubscribe();
  });

  it("cancels a waiting request when the last prompt unmounts", async () => {
    const unsubscribe = subscribeWalletGesture(() => {});
    const result = requestWalletGesture("Sign", async () => "sig");
    unsubscribe();
    await expect(result).rejects.toBeInstanceOf(UserRejectedError);
    expect(getWalletGestureRequest()).toBeNull();
  });
});
