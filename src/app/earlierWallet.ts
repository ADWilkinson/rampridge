import { skipToken, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import type { InterfaceId } from "@/ui/interfaces/context";
// Deep imports, not the "@/wallet" barrel: the barrel re-exports the Privy wallet stack, which loads later (./wallet).
import type { TxSender, WalletContextValue } from "@/wallet";
import { getBuyFlow, loadBuyFlow, subscribeBuyFlow, useBuyModule } from "./buyFlow";
import { blockedEarlierOrder, nextEarlierLatch, type EarlierLatch, type LatchInput } from "./buyOrders";
import { createEarlierMover } from "./earlierUsdc";
import { askConfirm, describeError, gameMessage } from "./gameContext";
import { useOpenInterface } from "./openInterface";

/**
 * The player's earlier wallet: the Privy embedded EOA behind their smart
 * wallet. A player whose smart wallet arrived late traded from the EOA in
 * that tab (the wallet module's grace fallback); a later tab selects the
 * smart wallet. This keeps an order placed from the EOA payable and
 * verifiable, and lets the player move its USDC across.
 */

/** Interfaces that drive the buy flow; they get the buy binding's sender. */
export const BUY_INTERFACES: ReadonlySet<InterfaceId> = new Set<InterfaceId>(["exchange", "trade", "payment", "verify"]);

export interface BuyBinding {
  /** The wallet the buy flow uses: the player's wallet, or the earlier wallet while it holds an open order. */
  sender: TxSender | null;
  /** Whose orders the buy flow shows: the sender's address, or the wallet's address read-only while it loads. */
  owner: Address | null;
  /** The buy flow is on the earlier wallet. */
  earlier: boolean;
  /** An open order on the earlier wallet waiting behind the player's own open order (its intent hash). */
  waitingEarlierOrder: string | null;
}


/** The earlier wallet's open order (live, or its own stored one even if expired), read-only. */
async function findEarlierOrder(owner: Address): Promise<{ intentHash: string } | null> {
  const [{ createPeerClient }, { recoverBuyOrder, localOrderStorage }] = await Promise.all([import("@/peer/client"), loadBuyFlow()]);
  const result = await recoverBuyOrder({
    client: createPeerClient(),
    owner,
    stored: localOrderStorage.load(owner),
    now: Date.now(),
  });
  return result.kind === "active" && result.order.status === "active" ? { intentHash: result.order.intentHash } : null;
}

/**
 * Chooses the wallet the buy flow is bound to. It stays on the player's
 * wallet unless the earlier wallet has an open order and the player's own
 * wallet has none; then it moves to the earlier wallet until that order is
 * finished and its screens are closed (or a new offer starts).
 */
export function useBuyBinding(wallet: WalletContextValue): BuyBinding {
  const main = wallet.status === "ready" ? wallet.sender : null;
  const eoa = wallet.status === "ready" && wallet.source === "smart" ? wallet.fallbackEoa : null;
  const earlierSender = eoa ? wallet.fallbackSender : null;

  const lookup = useQuery({
    queryKey: ["shell", "earlier-wallet-order", eoa ? eoa.toLowerCase() : null],
    queryFn: eoa ? () => findEarlierOrder(eoa) : skipToken,
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
    retry: 2,
  });

  const [latch, setLatch] = useState<EarlierLatch | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const latchRef = useRef<EarlierLatch | null>(null);
  const released = useRef(new Set<string>());
  const staleBefore = useRef(0);

  const found = lookup.data ? { intentHash: lookup.data.intentHash, at: lookup.dataUpdatedAt } : null;
  const foundHash = found?.intentHash ?? null;
  const foundAt = found?.at ?? 0;
  // The buy flow loads with the player's wallet (useBindBuySender); until then there is nothing to latch onto.
  const buyLoaded = useBuyModule((s) => s.mod !== null);

  useEffect(() => {
    const evaluate = () => {
      const flow = getBuyFlow();
      if (!flow) return;
      const current = latchRef.current;
      const open = useOpenInterface.getState().current;
      const input: LatchInput = {
        flow,
        main: main?.address ?? null,
        eoa,
        earlierReady: earlierSender !== null,
        found: foundHash ? { intentHash: foundHash, at: foundAt } : null,
        staleBefore: staleBefore.current,
        released: released.current,
        buyInterfaceOpen: open !== null && BUY_INTERFACES.has(open.id),
      };
      const step = nextEarlierLatch(current, input);
      if (step.forget) released.current.add(step.forget);
      // The flow found nothing where the lookup saw an order: wait for the lookup's next scheduled read
      // (not an immediate one, so a disagreement can't bounce the flow between wallets).
      if (step.recheck) staleBefore.current = Date.now();
      if (step.latch !== current) {
        latchRef.current = step.latch;
        setLatch(step.latch);
      }
      setWaiting(blockedEarlierOrder(input, step.latch !== null));
    };
    evaluate();
    const offStore = subscribeBuyFlow(evaluate);
    const offOpen = useOpenInterface.subscribe(evaluate);
    return () => {
      offStore();
      offOpen();
    };
  }, [main, eoa, earlierSender, foundHash, foundAt, buyLoaded]);

  const earlier = latch !== null && earlierSender !== null && latch.eoa === eoa?.toLowerCase();
  const sender = earlier ? earlierSender : wallet.sender;
  const owner = sender?.address ?? (wallet.authenticated ? wallet.address : null);
  return useMemo(() => ({ sender, owner, earlier, waitingEarlierOrder: waiting }), [sender, owner, earlier, waiting]);
}

/** Moves the earlier wallet's USDC to the player's wallet, asking first in the chatbox (createEarlierMover). */
export const moveEarlierUsdc = createEarlierMover({
  // Loaded on use: the balance reads bring in the Base client, which the title doesn't need.
  readBalance: (address) => import("@/wallet/balances").then(({ fetchUsdcBalance }) => fetchUsdcBalance(address)),
  confirm: askConfirm,
  say: gameMessage,
  describe: describeError,
});
