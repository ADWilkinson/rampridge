import { describe, expect, it, vi } from "vitest";
import type { Address, TransactionReceipt } from "viem";
import { EARLIER_MOVE_NO, EARLIER_MOVE_YES, createEarlierMover, earlierMoveQuestion, type EarlierWalletLike, type MoveDeps } from "./earlierUsdc";

const EOA = "0x2222222222222222222222222222222222222222" as Address;
const RECEIPT = { status: "success" } as TransactionReceipt;

function setup(overrides: Partial<MoveDeps> = {}, sweep: () => Promise<TransactionReceipt | null> = () => Promise.resolve(RECEIPT)) {
  const said: string[] = [];
  const deps: MoveDeps = {
    readBalance: vi.fn(() => Promise.resolve(12_345_678n)),
    confirm: vi.fn(() => Promise.resolve(true)),
    say: (text) => said.push(text),
    describe: (err) => (err instanceof Error ? err.message : "Something went wrong. Try again."),
    ...overrides,
  };
  const sweepFallbackUsdc = vi.fn(sweep);
  const wallet: EarlierWalletLike = { fallbackEoa: EOA, sweepFallbackUsdc };
  return { move: createEarlierMover(deps), deps, said, wallet, sweepFallbackUsdc };
}

describe("createEarlierMover", () => {
  it("asks with the exact amount, then moves it and says so", async () => {
    const { move, deps, said, wallet, sweepFallbackUsdc } = setup();
    await move(() => wallet);
    expect(deps.confirm).toHaveBeenCalledWith("Move 12.34 USDC from your earlier wallet?", EARLIER_MOVE_YES, EARLIER_MOVE_NO);
    expect(earlierMoveQuestion("12.34")).toBe("Move 12.34 USDC from your earlier wallet?");
    expect(sweepFallbackUsdc).toHaveBeenCalledTimes(1);
    expect(said).toEqual(["Moving 12.34 USDC to your wallet...", "Your USDC is now in your wallet."]);
  });

  it("moves nothing when the player says no", async () => {
    const { move, said, wallet, sweepFallbackUsdc } = setup({ confirm: () => Promise.resolve(false) });
    await move(() => wallet);
    expect(sweepFallbackUsdc).not.toHaveBeenCalled();
    expect(said).toEqual([]);
  });

  it("ignores clicks while a move is running, so it never sends twice", async () => {
    let finish: (receipt: TransactionReceipt) => void = () => undefined;
    let calls = 0;
    const { move, wallet, sweepFallbackUsdc } = setup({}, () => {
      calls += 1;
      return calls === 1 ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(RECEIPT);
    });
    const first = move(() => wallet);
    await vi.waitFor(() => expect(sweepFallbackUsdc).toHaveBeenCalledTimes(1));
    await move(() => wallet);
    await move(() => wallet);
    finish(RECEIPT);
    await first;
    expect(sweepFallbackUsdc).toHaveBeenCalledTimes(1);
    // Once finished, the next click works again.
    await move(() => wallet);
    expect(sweepFallbackUsdc).toHaveBeenCalledTimes(2);
  });

  it("says when there is nothing to move, without asking", async () => {
    const { move, deps, said, wallet, sweepFallbackUsdc } = setup({ readBalance: () => Promise.resolve(0n) });
    await move(() => wallet);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(sweepFallbackUsdc).not.toHaveBeenCalled();
    expect(said).toEqual(["There is no USDC left in your earlier wallet."]);
  });

  it("explains a failed balance read or a failed transfer in plain words", async () => {
    const unread = setup({ readBalance: () => Promise.reject(new Error("HTTP request failed. Status: 503")) });
    await unread.move(() => unread.wallet);
    expect(unread.said).toEqual(["Couldn't read your earlier wallet's balance. Try again in a moment."]);

    const failed = setup({}, () => Promise.reject(new Error("Your wallets are still loading. Try again in a moment.")));
    await failed.move(() => failed.wallet);
    expect(failed.said).toEqual(["Moving 12.34 USDC to your wallet...", "Your wallets are still loading. Try again in a moment."]);
  });

  it("does nothing without an earlier wallet", async () => {
    const { move, deps } = setup();
    await move(() => ({ fallbackEoa: null, sweepFallbackUsdc: () => Promise.resolve(null) }));
    expect(deps.readBalance).not.toHaveBeenCalled();
  });
});
