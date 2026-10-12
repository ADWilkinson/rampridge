import { useEffect, useRef, useState, type ReactNode } from "react";
import { feeBreakdown } from "./fees";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { BuyFlowStore } from "@/peer/buy";
import { formatFiat, formatUsdc, shortAddress } from "@/peer/format";
import type { BuyQuote } from "@/peer/market";
import { BUY_PLATFORMS, isBuyPlatformId, isFiatCode, type BuyPlatformId, type FiatCode } from "@/peer/platforms";
import { AmountPad, ItemSlot, StoneButton, TextButton, Window, cx, useIsMobile } from "@/ui/kit";
import { useGame, type InterfaceProps, type TradeTarget } from "../context";
import { useBuy, useBuyDeps, useNeedsComputer } from "./deps";
import { useBuyOrderEvents } from "./events";
import { useDebounced, useEnterKey } from "./hooks";
import {
  amountRules,
  amountSteps,
  bestMarketRate,
  compareRate,
  effectiveRate,
  fiatAmountText,
  fiatOfferLabel,
  fiatUnits,
  isDepositQuote,
  onchainDepositId,
  openingTradeAmount,
  rateText,
  stallPeerPayOnly,
  txInFlight,
} from "./model";
import { BuyErrorPanel, BuyNotice, ComputerAck, ComputerNotice, CurrencyIcon, DismissOfferPrompt, GasNote, LoginButton, Waiting, usdcItem } from "./parts";

interface Market {
  platform: BuyPlatformId;
  currency: FiatCode;
}

function resolveMarket(target: TradeTarget): Market | null {
  const platform = target.kind === "merchant" ? target.platform : target.stall.platform;
  const currency = target.kind === "merchant" ? target.currency : target.stall.currency;
  const p = platform.toLowerCase();
  const c = currency.toUpperCase();
  if (!isBuyPlatformId(p) || !isFiatCode(c)) return null;
  const info = BUY_PLATFORMS[p];
  if (!info.live || !info.currencies.includes(c)) return null;
  return { platform: p, currency: c };
}

/** True when `quote` is the stall's own deposit. */
function isStallQuote(quote: BuyQuote, target: TradeTarget): boolean {
  return target.kind === "stall" && isDepositQuote(quote, target.stall.depositId, target.stall.escrow);
}

/**
 * The original two-screen trade against a merchant (the best live quote for
 * its platform and currency) or a player's stall (that exact deposit).
 * Screen 1 sets the fiat offer and shows the live USDC offer; screen 2 is
 * "Are you sure you want to make this trade?" with the exact terms that will
 * be signed, and its Accept signals the intent.
 */
export function TradeInterface({ open }: InterfaceProps<"trade">) {
  const target = open.target;
  const game = useGame();
  const buy = useBuy();
  useBuyOrderEvents();
  const mobile = useIsMobile();
  const needsComputer = useNeedsComputer();
  const market = resolveMarket(target);

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    game.playSound("trade");
  }, [game]);

  // Always closes (Esc, the X, Decline). Unplaced quotes are dropped; a transaction in flight carries on
  // in the store and the world hook still posts "Your offer has been placed." when it lands.
  const decline = () => {
    const s = buy;
    const unplaced = s.step === "quoting" || s.step === "quoted" || s.step === "confirming" || (s.step === "error" && s.order?.status !== "active");
    if (unplaced && !txInFlight(s.step, s.pending)) s.reset();
    game.close();
  };

  const width = mobile ? 374 : 488;
  // A browser that can't prove payments gets the "verify on a computer" notice (and, on the second screen, its tick);
  // a platform with a notice before ordering (UPI, Alipay) gets room for it on the second screen.
  const notice = market && BUY_PLATFORMS[market.platform].buyNotice ? 48 : 0;
  const height = mobile ? 560 : (needsComputer ? 408 : 348) + notice;
  return (
    <Window title={`Trading with: ${target.name}`} width={width} height={height} variant="steel" onClose={decline} className={cx("rb-trade", mobile && "rb-trade--mobile")} closeLabel="Decline trade">
      {market ? (
        <TradeBody target={target} market={market} buy={buy} onDecline={decline} />
      ) : (
        <div className="rb-trade__center">
          <p className="rs-p12 rs-c-orange rs-shadow">{target.name} isn't offering anything this bank can trade right now.</p>
          <div className="rb-buttons">
            <StoneButton onClick={game.close}>Close</StoneButton>
          </div>
        </div>
      )}
    </Window>
  );
}

function TradeBody({ target, market, buy, onDecline }: { target: TradeTarget; market: Market; buy: BuyFlowStore; onDecline: () => void }) {
  const game = useGame();
  const deps = useBuyDeps();
  const { platform, currency } = market;
  const platformInfo = BUY_PLATFORMS[platform];
  const [mode, setMode] = useState<"stall" | "market">(target.kind === "stall" ? "stall" : "market");
  const [screen, setScreen] = useState<"offer" | "confirm">("offer");
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const needsComputer = useNeedsComputer();
  const [computerAck, setComputerAck] = useState(false);
  // Venmo and PayPal sell orders carry Peer Pay's whitelist: no player here can fill them.
  const peerPayOnly = target.kind === "stall" && stallPeerPayOnly(platform);
  const peerPayOnlyText = `${platformInfo.name} sell orders are filled by Peer Pay merchants; players in the bank can't take this stall.`;
  // A stall that can't fill the amount may fall back to another seller's offer: say so on both screens.
  const marketFallback = target.kind === "stall" && mode === "market";

  const [matching, setMatching] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // A merchant opens at the amount its shout quoted, so the window shows the advertised rate.
  const [amount, setAmount] = useState(() => openingTradeAmount(target.kind === "merchant" ? target.fiatAmount : undefined, currency, platformInfo));
  const settled = useDebounced(amount);
  const fiatText = fiatAmountText(settled, currency);
  const recipient = (game.sender?.address ?? null) as Address | null;

  // Quotes or errors left by another window (the Exchange, another trade) never carry into this one.
  // An unconfirmed signal (tx_pending) stays: its message must be seen before trading again.
  const cleared = useRef(false);
  useEffect(() => {
    if (cleared.current) return;
    cleared.current = true;
    const s = deps.store.getState();
    const leftover = s.step === "quoted" || s.step === "confirming" || (s.step === "error" && s.order?.status !== "active" && s.error?.code !== "tx_pending");
    if (leftover) s.reset();
  }, [deps]);

  const preview = useQuery({
    queryKey: ["buy-ui", "trade", mode, platform, currency, fiatText, target.kind === "stall" ? target.stall.depositId : target.merchantId],
    queryFn: async (): Promise<BuyQuote | null> => {
      if (mode === "stall" && target.kind === "stall") {
        return deps.getDepositQuote({
          fiatAmount: fiatText,
          currency,
          platform,
          depositId: onchainDepositId(target.stall.depositId),
          escrow: target.stall.escrow as Address,
          recipient,
        });
      }
      const result = await deps.getBuyQuotes({ fiatAmount: fiatText, currency, platforms: [platform], recipient });
      return result.quotes[0] ?? null;
    },
    enabled: settled > 0 && screen === "offer",
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
  });

  const prices = useQuery({
    queryKey: ["buy-ui", "guide", currency, fiatText],
    queryFn: () => deps.getBestPricesByPlatform({ currency, fiatAmount: fiatText, recipient }),
    enabled: settled > 0,
    staleTime: 20_000,
    retry: 1,
  });
  const best = bestMarketRate(prices.data);
  const rules = amountRules(platformInfo, currency, preview.data?.rate ?? null);

  // An offer accepted here goes straight to the payment instructions.
  const placing = useRef(false);
  useEffect(() => {
    if (placing.current && buy.step === "awaitingPayment" && buy.order?.status === "active") {
      placing.current = false;
      game.open({ id: "payment" });
    }
    if (placing.current && buy.step === "error") placing.current = false;
  }, [buy.step, buy.order, game]);

  // Fresh quotes arrived for this trade: pick the exact offer that will be signed.
  useEffect(() => {
    if (buy.step !== "quoted" || !(matching || screen === "confirm")) return;
    let cancelled = false;
    void (async () => {
      let quote: BuyQuote | null = null;
      if (mode === "stall" && target.kind === "stall") {
        quote = buy.quotes.find((q) => isStallQuote(q, target)) ?? null;
        if (!quote && buy.request) {
          // The store asks Curator for its top five quotes and the stall may rank lower (up to 20 are
          // searched here). The store has no action to adopt an outside quote, so the stall's quote is
          // added to its list before selecting it; confirm() still runs every pre-check on it.
          let found: BuyQuote | null = null;
          try {
            found = await deps.getDepositQuote({
              fiatAmount: buy.request.fiatAmount,
              currency,
              platform,
              depositId: onchainDepositId(target.stall.depositId),
              escrow: target.stall.escrow as Address,
              recipient,
            });
          } catch {
            found = null;
          }
          if (cancelled) return;
          const s = deps.store.getState();
          if (found && s.step === "quoted") {
            if (!s.quotes.some((q) => q.id === found.id)) deps.store.setState({ quotes: [found, ...s.quotes] });
            quote = found;
          }
        }
      } else {
        quote = buy.quotes[0] ?? null;
      }
      if (cancelled) return;
      setMatching(false);
      if (quote) {
        deps.store.getState().selectQuote(quote.id);
        setScreen("confirm");
        setNote(null);
        game.playSound("trade");
      } else {
        deps.store.getState().reset();
        setScreen("offer");
        setNote(mode === "stall" ? (peerPayOnly ? peerPayOnlyText : "This stall can't fill that amount any more.") : "That offer is no longer available. Try another amount.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buy.step, buy.quotes, buy.request, matching, screen, mode, target, deps, currency, platform, recipient, game, peerPayOnly, peerPayOnlyText]);

  useEffect(() => {
    if (screen === "confirm" && (buy.step === "idle" || buy.step === "completed" || buy.step === "cancelled")) setScreen("offer");
    if (matching && buy.step === "error") setMatching(false);
  }, [buy.step, screen, matching]);

  const quote = preview.data ?? null;
  const waiting = settled !== amount || preview.isPending;
  const tooLow = amount < rules.min;
  const tooHigh = rules.max !== undefined && amount > rules.max;
  const fiat = fiatUnits(amount, currency);
  const accept = () => {
    if (!preview.data) return;
    setNote(null);
    setMatching(true);
    game.playSound("click");
    void buy.requestQuotes({ fiatAmount: fiatAmountText(amount, currency), currency, platforms: [platform] });
  };

  // Any active order blocks a new trade, whatever step it is in (an error included): Accept would
  // quote afresh, and quoting forgets an expired order the player may already have paid.
  const liveOrder = buy.order?.status === "active" ? buy.order : null;
  const cancellingOld = liveOrder === null && buy.pending === "cancel";
  const offerScreen = liveOrder === null && !cancellingOld && screen === "offer" && buy.step !== "signaling";
  useEnterKey(offerScreen && game.sender && quote && !waiting && !matching && !tooLow && !tooHigh ? accept : null);

  if (liveOrder) {
    const expired = deps.now() >= liveOrder.expiresAt;
    if (expired && confirmDismiss) {
      return (
        <div className="rb-trade__center">
          <DismissOfferPrompt onDone={() => setConfirmDismiss(false)} />
        </div>
      );
    }
    return (
      <div className="rb-trade__center">
        {buy.step === "error" && (
          <div className="rb-gate__error">
            <BuyErrorPanel actions={false} />
          </div>
        )}
        <p className={cx("rs-p12 rs-shadow", expired ? "rs-c-stone-red" : "rs-c-orange")}>{expired ? "Your last buy offer expired." : "You already have a buy offer open."}</p>
        <p className="rs-p12 rs-c-orange rs-shadow">
          {expired ? "If you paid it before it expired, verify it first. Otherwise dismiss it to trade." : "Pay it or cancel it before you trade again."}
        </p>
        <div className="rb-buttons">
          <StoneButton onClick={() => game.open({ id: "payment" })}>View offer</StoneButton>
          {expired && (
            <StoneButton onClick={() => setConfirmDismiss(true)} disabled={txInFlight(buy.step, buy.pending)}>
              Dismiss it
            </StoneButton>
          )}
          <StoneButton onClick={onDecline}>Decline</StoneButton>
        </div>
      </div>
    );
  }

  // Cancelling an older order this app can't show (from the error's "Cancel old order").
  if (cancellingOld) {
    return (
      <div className="rb-trade__center">
        <Waiting text="Cancelling your older order" detail="Confirm it in your wallet if asked." />
      </div>
    );
  }

  if (screen === "confirm" || buy.step === "signaling") {
    return (
      <ConfirmScreen
        buy={buy}
        best={best}
        bestLoading={prices.isPending}
        pricesFailed={prices.isError}
        marketFallbackFrom={marketFallback ? target.name : null}
        needsComputer={needsComputer}
        computerAck={computerAck}
        onComputerAck={setComputerAck}
        onDecline={onDecline}
        onAccept={() => (placing.current = true)}
      />
    );
  }


  let theirs: ReactNode;
  let status: ReactNode;
  if (tooLow || tooHigh || amount <= 0) {
    theirs = null;
    status = (
      <span className="rs-c-stone-red">
        {tooHigh && platformInfo.maxUsdc ? `${platformInfo.name} orders are capped at ${platformInfo.maxUsdc} USDC.` : `The smallest ${platformInfo.name} order is ${formatFiat(fiatUnits(rules.min, currency), currency)}.`}
      </span>
    );
  } else if (waiting) {
    theirs = <Waiting className="rb-wait--inline" />;
    status = <span className="rs-c-white">Waiting for other player...</span>;
  } else if (preview.isError) {
    theirs = null;
    status = (
      <span className="rs-c-stone-red">
        Offers are unavailable right now.{" "}
        <TextButton tone="yellow" onClick={() => void preview.refetch()}>
          Try again
        </TextButton>
      </span>
    );
  } else if (!quote) {
    theirs =
      mode === "stall" ? (
        <div className="rb-trade__none">
          <p className="rs-p12 rs-c-orange rs-shadow">{peerPayOnly ? peerPayOnlyText : `This stall can't fill ${formatFiat(fiat, currency)} right now.`}</p>
          <TextButton tone="yellow" onClick={() => setMode("market")}>
            See the best market offer
          </TextButton>
        </div>
      ) : (
        <p className="rs-p12 rs-c-orange rs-shadow">No seller can fill {formatFiat(fiat, currency)} right now.</p>
      );
    status = <span className="rs-c-stone-red">{mode === "stall" && peerPayOnly ? "Other player can't trade with you here." : "Other player can't trade this amount."}</span>;
  } else {
    // The USDC shown is net of fees and the listed rate is not, so the rate fees included is shown too.
    const afterFees = effectiveRate(quote.fiatAmount, quote.usdcAmount);
    theirs = (
      <>
        <span className="rb-itembox">
          <ItemSlot item={usdcItem(quote.usdcAmount)} />
        </span>
        <span className="rs-p12 rs-c-white rs-shadow">{formatUsdc(quote.usdcAmount)} USDC</span>
        <span className="rs-p11 rs-c-orange rs-shadow">{rateText(quote.rate, currency)}</span>
        {afterFees !== null && <span className="rs-p11 rs-c-quiet rs-shadow">After fees: {rateText(afterFees, currency)}</span>}
        {marketFallback && <span className="rs-p11 rs-c-yellow rs-shadow">Best market offer</span>}
      </>
    );
    status = <span className="rs-c-white">{marketFallback ? "A market seller has accepted." : "Other player has accepted."}</span>;
  }

  return (
    <div className="rb-trade__screen">
      <div className="rb-trade__panes">
        <section className="rb-trade__col" aria-label="Your offer">
          <p className="rs-p12 rs-c-orange rs-shadow">Your offer:</p>
          <div className="rb-trade__pane rb-trade__pane--yours">
            <span className="rb-trade__offer">
              <span className="rb-itembox">
                <ItemSlot item={{ key: "fiat", name: fiatOfferLabel(fiat, currency, platform), icon: <CurrencyIcon currency={currency} /> }} />
              </span>
              <span className="rs-p12 rs-c-white rs-shadow">{fiatOfferLabel(fiat, currency, platform)}</span>
            </span>
            <AmountPad
              value={amount}
              onChange={setAmount}
              steps={amountSteps(currency)}
              rules={{ min: 0, ...(rules.max !== undefined ? { max: rules.max } : {}), decimals: rules.decimals }}
              format={(v) => formatFiat(fiatUnits(v, currency), currency)}
              promptTitle={`How much ${currency} will you pay?`}
              plusMinus={false}
              disabled={matching}
            />
          </div>
        </section>
        <section className="rb-trade__col" aria-label="Their offer" aria-live="polite">
          <p className="rs-p12 rs-c-orange rs-shadow">Their offer:</p>
          <div className="rb-trade__pane rb-trade__pane--theirs">{theirs}</div>
        </section>
      </div>
      <div className="rb-trade__status rs-p12 rs-shadow" role="status">
        {matching ? <Waiting className="rb-wait--inline" /> : note ? <span className="rs-c-stone-red">{note}</span> : status}
      </div>
      {buy.step === "error" && !matching && <BuyErrorPanel onRetry={() => setMatching(buy.errorReturnStep === "idle" || buy.errorReturnStep === "quoted")} />}
      {needsComputer && <ComputerNotice className="rb-trade__computer" />}
      <div className="rb-trade__buttons">
        {game.sender ? (
          <StoneButton onClick={accept} disabled={!quote || waiting || matching || tooLow || tooHigh}>
            Accept
          </StoneButton>
        ) : (
          <LoginButton />
        )}
        <StoneButton onClick={onDecline}>Decline</StoneButton>
      </div>
    </div>
  );
}

function ConfirmScreen({
  buy,
  best,
  bestLoading,
  pricesFailed,
  marketFallbackFrom,
  needsComputer,
  computerAck,
  onComputerAck,
  onDecline,
  onAccept,
}: {
  buy: BuyFlowStore;
  best: ReturnType<typeof bestMarketRate>;
  bestLoading: boolean;
  pricesFailed: boolean;
  /** The stall owner's name when this is the best market offer from another seller instead of their stall. */
  marketFallbackFrom: string | null;
  needsComputer: boolean;
  computerAck: boolean;
  onComputerAck: (checked: boolean) => void;
  onDecline: () => void;
  onAccept: () => void;
}) {
  const game = useGame();
  const quote = buy.selectedQuote;
  const signalling = buy.step === "signaling" || buy.pending === "signal";
  const ackMissing = needsComputer && !computerAck;
  const accept = () => {
    if (ackMissing) return;
    onAccept();
    game.playSound("click");
    void buy.confirm();
  };
  useEnterKey(game.sender && quote && !signalling && buy.step === "confirming" && !ackMissing ? accept : null);

  if (signalling) {
    return (
      <div className="rb-trade__center">
        <Waiting
          text="Placing your offer"
          detail={buy.notice ?? (game.sender?.sponsored ? "Approve it if your wallet asks." : "Confirm the transaction in your wallet.")}
        />
      </div>
    );
  }
  if (buy.step === "error") {
    return (
      <div className="rb-trade__center">
        <BuyErrorPanel />
        <div className="rb-buttons">
          <StoneButton onClick={onDecline}>Decline</StoneButton>
        </div>
      </div>
    );
  }
  if (!quote) return <Waiting className="rb-wait--fill" />;

  const comparison = best ? compareRate(quote.rate, best.rate) : null;

  return (
    <div className="rb-trade__screen rb-trade__screen--confirm">
      <p className="rb-trade__ask rs-p12 rs-c-white rs-shadow">Are you sure you want to make this trade?</p>
      {marketFallbackFrom && (
        <p className="rb-trade__fallback rs-p12 rs-c-yellow rs-shadow">This is the best market offer from another seller, not {marketFallbackFrom}'s stall.</p>
      )}
      <div className="rb-trade__panes rb-trade__panes--text">
        <section className="rb-trade__col">
          <p className="rs-p12 rs-c-orange rs-shadow">You are about to give:</p>
          <p className="rs-p12 rs-c-white rs-shadow">{fiatOfferLabel(quote.fiatAmount, quote.currency, quote.platform)}</p>
        </section>
        <section className="rb-trade__col">
          <p className="rs-p12 rs-c-orange rs-shadow">In return you will receive:</p>
          <p className="rs-p12 rs-c-white rs-shadow">{formatUsdc(quote.usdcAmount)} USDC</p>
        </section>
      </div>
      <dl className="rb-trade__terms rs-p12 rs-shadow">
        <div>
          <dt className="rs-c-orange">Rate:</dt> <dd className="rs-c-white">{rateText(quote.rate, quote.currency)}</dd>
        </div>
        <div>
          <dt className="rs-c-orange">Fees:</dt> <dd className="rs-c-white">{feeBreakdown(quote.fees)}, already taken from what you receive</dd>
        </div>
        <div>
          <dt className="rs-c-orange">Seller:</dt>{" "}
          <dd className="rs-c-white">
            {quote.seller ? shortAddress(quote.seller) : "Unknown"}
            {quote.successRateBps !== null && <span className="rs-c-orange"> ({Math.floor(quote.successRateBps / 100)}% completed)</span>}
          </dd>
        </div>
      </dl>
      <GasNote className="rb-trade__gas" />
      <BuyNotice platform={quote.platform} />
      {comparison?.warn && best ? (
        <p className="rb-trade__warn rs-p12 rs-c-stone-red rs-shadow" role="alert">
          Warning: this rate is {comparison.percentText} worse than the best market rate ({rateText(best.rate, quote.currency)} on {BUY_PLATFORMS[best.platform].name}).
        </p>
      ) : !best && !bestLoading && pricesFailed ? (
        <p className="rs-p11 rs-c-quiet rs-shadow">The market rate couldn't be checked.</p>
      ) : null}
      {needsComputer && (
        <div className="rb-computer__box rb-trade__computer">
          <ComputerNotice />
          <ComputerAck checked={computerAck} onChange={onComputerAck} />
        </div>
      )}
      <div className="rb-trade__buttons">
        {game.sender ? (
          <StoneButton onClick={accept} disabled={ackMissing}>
            Accept
          </StoneButton>
        ) : (
          <LoginButton />
        )}
        <StoneButton onClick={onDecline}>Decline</StoneButton>
      </div>
    </div>
  );
}
