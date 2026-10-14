import { useEffect, useMemo, useState, type ReactNode } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { fetchMarket } from "@/net/market";
import { StoneButton, Window, useIsMobile } from "@/ui/kit";
import { GameContext, useGame, type GameContextValue, type InterfaceComponent, type InterfaceProps, type OpenInterface } from "../context";
import { BuyUiDepsProvider, type BuyUiDeps } from "./deps";
import { Waiting } from "./parts";
import { choosePractice, createPracticeRuntime, currentPractice, endPractice, enterPractice, type PracticeChoice, type PracticeRuntime } from "./practiceRuntime";
import { PracticeContext } from "./practiceContext";
import { TradeInterface } from "./Trade";

/**
 * The buy interfaces as a practice trade sees them: the practice runtime's
 * store, quotes, wallet and query cache in place of the live ones, and a game whose
 * windows stay in the practice (Payment and Verify open with `practice`),
 * whose messages say "Practice:", and which never logs in, announces or sets
 * a stall. Opening anything else, or closing the window, ends the practice.
 */
function PracticeScope({ runtime, children }: { runtime: PracticeRuntime; children: ReactNode }) {
  const game = useGame();
  const value = useMemo<GameContextValue>(
    () => ({
      ...game,
      sender: runtime.sender,
      walletReady: true,
      login: () => undefined,
      open: (target) => {
        if (target.id === "payment" || target.id === "verify") {
          game.open({ ...target, practice: true });
          return;
        }
        endPractice();
        game.open(target);
      },
      close: () => {
        endPractice();
        game.close();
      },
      message: (text) => game.message(`Practice: ${text}`),
      announce: () => Promise.resolve(),
      setStall: () => Promise.resolve(),
      stallDepositId: null,
    }),
    [game, runtime],
  );
  const deps = useMemo<Partial<BuyUiDeps>>(
    () => ({
      store: runtime.store,
      getBuyQuotes: runtime.quotes,
      getBestPricesByPlatform: runtime.bestPrices,
      getDepositQuote: () => Promise.resolve(null),
      cashClient: () => runtime.cash,
      verifyNeedsComputer: () => false,
    }),
    [runtime],
  );
  return (
    <PracticeContext.Provider value={true}>
      <QueryClientProvider client={runtime.queryClient}>
        <GameContext.Provider value={value}>
          <BuyUiDepsProvider value={deps}>{children}</BuyUiDepsProvider>
        </GameContext.Provider>
      </QueryClientProvider>
    </PracticeContext.Provider>
  );
}

/** A fresh practice trade, counted once, in the real trade window against the practice seller. */
function PracticeTrade({ choice }: { choice: PracticeChoice }) {
  const [runtime] = useState(() => createPracticeRuntime(choice));
  useEffect(() => enterPractice(runtime), [runtime]);
  return (
    <PracticeScope runtime={runtime}>
      <TradeInterface open={{ id: "trade", target: runtime.target }} />
    </PracticeScope>
  );
}

/**
 * The "practice" interface: prices the practice at the live market (the
 * merchants' own book), then opens the trade window. While the book loads,
 * or if it can't, a small window says so.
 */
export function PracticeInterface() {
  const game = useGame();
  const mobile = useIsMobile();
  const market = useQuery({ queryKey: ["buy-ui", "practice-market"], queryFn: ({ signal }) => fetchMarket(signal), staleTime: 30_000, retry: 1 });
  const choice = market.data ? choosePractice(market.data) : null;
  if (choice) return <PracticeTrade choice={choice} />;
  return (
    <Window title="Practice trade" width={mobile ? 374 : 340} height={150} variant="steel" onClose={game.close}>
      {market.isPending ? (
        <Waiting className="rb-wait--fill" />
      ) : (
        <div className="rb-trade__center">
          <p className="rs-p12 rs-c-orange rs-shadow">The practice trade couldn't load today's prices. Try again in a moment.</p>
          <div className="rb-buttons">
            <StoneButton onClick={game.close}>Close</StoneButton>
          </div>
        </div>
      )}
    </Window>
  );
}

/** The practice trade's own Payment scroll and Verify, opened from inside it; closed if the practice has ended. */
function PracticeContinuation({ children }: { children: ReactNode }) {
  const [runtime] = useState(currentPractice);
  const game = useGame();
  useEffect(() => {
    if (!runtime) game.close();
  }, [runtime, game]);
  return runtime ? <PracticeScope runtime={runtime}>{children}</PracticeScope> : null;
}

const inPractice = (open: OpenInterface): boolean => "practice" in open && open.practice === true;

/** `Interface` as registered: inside the practice when opened with `practice`, as itself otherwise. */
export function practiceAware<I extends "payment" | "verify">(Interface: InterfaceComponent<I>): InterfaceComponent<I> {
  return function PracticeAware(props: InterfaceProps<I>) {
    if (!inPractice(props.open)) return <Interface {...props} />;
    return (
      <PracticeContinuation>
        <Interface {...props} />
      </PracticeContinuation>
    );
  };
}
