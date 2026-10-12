import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { BuyFlowStore, BuyStep } from "@/peer/buy";
import { formatFiat, formatUsdc, shortAddress } from "@/peer/format";
import type { BuyQuote } from "@/peer/market";
import {
  BUY_PLATFORMS,
  FIAT_CURRENCIES,
  defaultCurrencyForLocale,
  isBuyPlatformId,
  isFiatCode,
  platformsForCurrency,
  type BuyPlatformId,
  type FiatCode,
} from "@/peer/platforms";
import { useMyCashOrders, type SellOrderRow } from "@/peer/sell";
import { AmountPad, CountdownText, ItemSlot, ProgressBar, Sprite, StoneButton, TextButton, Window, cx, useIsMobile, useNow, useSprite, type ItemData } from "@/ui/kit";
import { useGame, type InterfaceProps } from "../context";
import { PlatformIcon } from "../shared/PlatformIcon";
import { feeBreakdown } from "./fees";
import { useBuy, useBuyDeps, useNeedsComputer, useVerificationError } from "./deps";
import { useBuyOrderEvents } from "./events";
import { useDebounced, useEnterKey } from "./hooks";
import {
  amountRules,
  amountSteps,
  assembleSlots,
  buySlotTarget,
  buySlotView,
  defaultAmount,
  effectiveRate,
  fiatAmountText,
  fiatUnits,
  overCheapest,
  paidClaimed,
  rateText,
  sellSlotView,
  txInFlight,
  type BuySlotView,
} from "./model";
import { BetaTag, BuyErrorPanel, BuyNotice, ComputerAck, ComputerNotice, CurrencyIcon, DismissOfferPrompt, FeeWaivedNote, GasNote, HelpLine, LoginButton, Row, Waiting, usdcItem } from "./parts";
import { CurrencyPicker, PlatformPicker } from "./pickers";

const SETUP_STEPS: ReadonlySet<BuyStep> = new Set(["quoting", "quoted", "confirming", "signaling"]);

type View = "slots" | "setup" | "collect";

/**
 * The Grand Exchange: eight offer slots (the buy order and live sell orders),
 * then the Buy offer screen (currency, payment method, amount, guide price),
 * the best quote and "Confirm offer", which signals the intent.
 */
export function ExchangeInterface({ open }: InterfaceProps<"exchange">) {
  const game = useGame();
  const buy = useBuy();
  useBuyOrderEvents();
  const mobile = useIsMobile();
  const needsComputer = useNeedsComputer();
  const liveOrder = buy.order?.status === "active" ? buy.order : null;
  const resume = SETUP_STEPS.has(buy.step) || (buy.step === "error" && !liveOrder);
  const [view, setView] = useState<View>(() => (open.side === "buy" || open.platform || open.currency || resume ? "setup" : "slots"));

  // The sell side lives in the bank's Sell interface.
  const redirected = useRef(false);
  useEffect(() => {
    if (open.side !== "sell" || redirected.current) return;
    redirected.current = true;
    game.open({ id: "sell", ...(open.platform ? { platform: open.platform } : {}), ...(open.currency ? { currency: open.currency } : {}) });
  }, [open, game]);

  // An offer placed from this window goes straight to the payment instructions.
  const placing = useRef(false);
  useEffect(() => {
    if (placing.current && buy.step === "awaitingPayment" && buy.order?.status === "active") {
      placing.current = false;
      game.open({ id: "payment" });
    }
    if (placing.current && buy.step === "error") placing.current = false;
  }, [buy.step, buy.order, game]);

  const width = mobile ? 374 : 488;
  // A browser that can't prove payments gets the "verify on a computer" notice and tick on the offer screens;
  // a quote on a platform with a notice before ordering (UPI, Alipay) gets room for it.
  const quotedPlatform = buy.step === "quoted" || buy.step === "confirming" ? buy.request?.platforms?.[0] : undefined;
  const notice = quotedPlatform && BUY_PLATFORMS[quotedPlatform].buyNotice ? 48 : 0;
  const height = mobile ? 600 : (needsComputer ? 404 : 356) + notice;
  const back = () => {
    if (buy.step === "signaling" || buy.pending === "signal") return;
    // Leaving the offer screen drops its quotes. A placed order (and any error about it, such as a
    // failed verification) is never touched here, nor a finished one still waiting to be collected.
    const unplaced = buy.step === "quoting" || buy.step === "quoted" || buy.step === "confirming" || (buy.step === "error" && buy.order?.status !== "active");
    if (unplaced) buy.reset();
    setView("slots");
  };

  return (
    <Window title="Grand Exchange" width={width} height={height} onClose={game.close} className={cx("rb-ge", mobile && "rb-ge--mobile")} bodyClassName="rb-ge__body">
      {view === "slots" && <SlotsView buy={buy} onBuy={() => setView("setup")} onCollect={() => setView("collect")} />}
      {view === "setup" && (
        <SetupView
          buy={buy}
          initial={{ platform: open.platform, currency: open.currency }}
          onBack={back}
          onPlace={() => {
            placing.current = true;
          }}
        />
      )}
      {view === "collect" && <CollectView buy={buy} onDone={() => setView("slots")} />}
    </Window>
  );
}

// ---------------------------------------------------------------------------
// Slots

function SlotsView({ buy, onBuy, onCollect }: { buy: BuyFlowStore; onBuy: () => void; onCollect: () => void }) {
  const game = useGame();
  const deps = useBuyDeps();
  const owner = game.sender?.address ?? null;
  const cash = useMemo(() => deps.cashClient(), [deps]);
  const sells = useMyCashOrders(owner, { client: cash });
  const platforms = useSellPlatforms(sells.liveOrders, cash);
  // Re-checked every few seconds so an order that expires while the window is open turns red.
  const now = useNow(deps.now, 5_000);
  const buyView = buySlotView(buy.step, buy.order, now, useVerificationError(buy));
  const slots = assembleSlots(buyView && buy.order ? { view: buyView } : null, sells.liveOrders);
  const liveBuy = buyView !== null && buyView.status !== "completed" && buyView.status !== "cancelled";
  const expiredBuy = buyView?.status === "expired";

  const startBuy = () => {
    if (liveBuy && !expiredBuy) {
      game.playSound("error");
      game.message("You can only have one buy offer at a time. Finish or cancel it first.");
      return;
    }
    game.playSound("click");
    onBuy();
  };
  const openBuySlot = (view: BuySlotView) => {
    const target = buySlotTarget(view.status);
    if (target === "collect") onCollect();
    else game.open({ id: target });
  };

  let footer: ReactNode;
  if (!game.sender) {
    footer = (
      <>
        <span className="rs-c-orange rs-shadow">You need to log in to trade.</span>
        <TextButton tone="yellow" onClick={game.login} disabled={!game.walletReady}>
          Log in
        </TextButton>
      </>
    );
  } else if (sells.error) {
    footer = (
      <>
        <span className="rs-c-stone-red rs-shadow">Your sell offers couldn't be loaded.</span>
        <TextButton tone="yellow" onClick={sells.refetch}>
          Try again
        </TextButton>
      </>
    );
  } else if (buy.recovering || sells.isLoading) {
    footer = <Waiting text="Checking your offers" className="rb-wait--inline" />;
  } else if (slots.every((s) => s.kind === "empty")) {
    footer = <span className="rs-c-orange rs-shadow">Choose Buy to buy USDC with cash, or Sell to sell yours.</span>;
  } else {
    footer = <span className="rs-c-orange rs-shadow">Click an offer to see it.</span>;
  }

  return (
    <div className="rb-slots-view">
      <ul className="rb-slots" aria-label="Your offers">
        {slots.map((slot, i) => (
          <li key={slot.key} className="rb-slot-cell">
            {slot.kind === "empty" && <EmptySlot index={i} onBuy={startBuy} onSell={() => game.open({ id: "sell" })} />}
            {slot.kind === "buy" && buy.order && <BuySlot view={slot.buy.view} buy={buy} onOpen={() => openBuySlot(slot.buy.view)} />}
            {slot.kind === "sell" && <SellSlot row={slot.sell} platform={platforms[slot.sell.depositId] ?? null} onOpen={() => game.open({ id: "bank" })} />}
            {slot.kind === "more" && (
              <button type="button" className="rb-slot rb-slot--more" onClick={() => game.open({ id: "bank" })}>
                <span className="rb-slot__head rs-p12 rs-c-orange rs-shadow">Sell</span>
                <span className="rb-slot__more rs-p12 rs-c-white rs-shadow">+{slot.count} more sell offers</span>
                <span className="rs-p11 rs-c-yellow rs-shadow">See them in the bank</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="rb-ge__footer rs-p12" role="status">
        {footer}
      </div>
    </div>
  );
}

function GeIcon({ name, hover, active }: { name: "geBuy" | "geSell"; hover: "geBuyHover" | "geSellHover"; active: boolean }) {
  const base = useSprite(name);
  return (
    <span className="rb-geicon" aria-hidden="true">
      {base.status === "missing" ? (
        <span className={cx("rb-geicon__fallback", name === "geBuy" ? "rb-geicon__fallback--buy" : "rb-geicon__fallback--sell")} />
      ) : (
        <Sprite name={active ? hover : name} canvas />
      )}
    </span>
  );
}

function EmptySlot({ index, onBuy, onSell }: { index: number; onBuy: () => void; onSell: () => void }) {
  const [hover, setHover] = useState<"buy" | "sell" | null>(null);
  return (
    <div className="rb-slot rb-slot--empty" role="group" aria-label={`Slot ${index + 1}: empty`}>
      <span className="rb-slot__head rs-p12 rs-c-orange rs-shadow">Empty</span>
      <div className="rb-slot__choices">
        <button
          type="button"
          className="rb-geaction"
          onClick={onBuy}
          onPointerEnter={() => setHover("buy")}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover("buy")}
          onBlur={() => setHover(null)}
          aria-label={`Buy USDC (slot ${index + 1})`}
        >
          <GeIcon name="geBuy" hover="geBuyHover" active={hover === "buy"} />
          <span className="rs-p12 rs-c-orange rs-shadow">Buy</span>
        </button>
        <button
          type="button"
          className="rb-geaction"
          onClick={onSell}
          onPointerEnter={() => setHover("sell")}
          onPointerLeave={() => setHover(null)}
          onFocus={() => setHover("sell")}
          onBlur={() => setHover(null)}
          aria-label={`Sell USDC (slot ${index + 1})`}
        >
          <GeIcon name="geSell" hover="geSellHover" active={hover === "sell"} />
          <span className="rs-p12 rs-c-orange rs-shadow">Sell</span>
        </button>
      </div>
    </div>
  );
}

function BuySlot({ view, buy, onOpen }: { view: BuySlotView; buy: BuyFlowStore; onOpen: () => void }) {
  const order = buy.order!;
  const usdc = buy.completion?.usdcReceived ?? order.usdcExpected;
  const fiat = formatFiat(order.fiatToSend, order.currency);
  return (
    <FilledSlot
      side="Buy"
      item={{ ...usdcItem(usdc), examine: `${formatUsdc(usdc)} USDC for ${fiat} on ${BUY_PLATFORMS[order.platform].name}.` }}
      platform={order.platform}
      sub={fiat}
      amount={`${formatUsdc(usdc)} USDC`}
      progress={view.progress}
      bar={view.bar}
      status={buy.pending === "cancel" ? "Cancelling..." : view.label}
      alert={view.alert === true && buy.pending !== "cancel"}
      onOpen={onOpen}
      ariaLabel={`Buy offer: ${formatUsdc(usdc)} USDC for ${fiat} on ${BUY_PLATFORMS[order.platform].name}. ${view.label}.`}
    />
  );
}

function SellSlot({ row, platform, onOpen }: { row: SellOrderRow; platform: string | null; onOpen: () => void }) {
  const view = sellSlotView(row.state, row.progress);
  const name = platform && isBuyPlatformId(platform) ? BUY_PLATFORMS[platform].name : null;
  return (
    <FilledSlot
      side="Sell"
      item={{ ...usdcItem(row.totalAmount), examine: row.explanation }}
      platform={platform}
      sub={name ?? "Sell order"}
      amount={`${formatUsdc(row.totalAmount)} USDC`}
      progress={view.progress}
      bar={view.bar}
      status={view.label}
      onOpen={onOpen}
      ariaLabel={`Sell offer: ${formatUsdc(row.totalAmount)} USDC${name ? ` on ${name}` : ""}. ${view.label}. ${row.explanation}`}
    />
  );
}

/** A Grand Exchange offer: the item and what it trades for, the offer bar and where it stands. */
function FilledSlot(props: {
  side: "Buy" | "Sell";
  item: ItemData;
  platform: string | null;
  sub: string;
  amount: string;
  progress: number;
  bar: BuySlotView["bar"];
  status: string;
  /** Red status text without aborting the bar (e.g. "Verification failed"). */
  alert?: boolean;
  onOpen: () => void;
  ariaLabel: string;
}) {
  const tone = props.bar === "aborted" || props.alert ? "rs-c-stone-red" : props.bar === "complete" ? "rs-c-green" : "rs-c-yellow";
  return (
    <button type="button" className="rb-slot rb-slot--filled" onClick={props.onOpen} aria-label={props.ariaLabel}>
      <span className="rb-slot__head rs-p12 rs-c-orange rs-shadow">{props.side}</span>
      <span className="rb-slot__item">
        <span className="rb-itembox">
          <ItemSlot item={props.item} />
          {props.platform && <PlatformBadge platform={props.platform} />}
        </span>
        <span className="rb-slot__name">
          <span className="rs-p12 rs-c-white rs-shadow">USDC</span>
          <span className="rs-p11 rs-c-orange rs-shadow">{props.sub}</span>
        </span>
      </span>
      <ProgressBar value={props.progress} state={props.bar} width="100%" ariaLabel={`${props.side} offer progress`} />
      <span className="rb-slot__amount rs-p12 rs-c-white rs-shadow">{props.amount}</span>
      <span className={cx("rb-slot__status rs-p11 rs-shadow", tone)}>{props.status}</span>
    </button>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  return (
    <span className="rb-badge" aria-hidden="true">
      <PlatformIcon platform={platform} size={17} />
    </span>
  );
}

/** List rows carry no payout legs, so each live order's platform is read once from its detail. */
function useSellPlatforms(rows: readonly SellOrderRow[], client: { order(id: string): Promise<{ payouts?: { platform: string }[] }> }): Record<string, string | null> {
  const results = useQueries({
    queries: rows.map((row) => ({
      queryKey: ["buy-ui", "sell-platform", row.depositId],
      queryFn: async () => {
        const known = row.payouts?.[0]?.platform;
        if (known) return known;
        const detail = await client.order(row.depositId);
        return detail.payouts?.[0]?.platform ?? null;
      },
      staleTime: 10 * 60_000,
      retry: 1,
    })),
  });
  const out: Record<string, string | null> = {};
  rows.forEach((row, i) => {
    out[row.depositId] = results[i]?.data ?? null;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Buy offer setup

function initialCurrency(buy: BuyFlowStore, requested?: string): FiatCode {
  if (requested && isFiatCode(requested) && platformsForCurrency(requested).length > 0) return requested;
  const last = buy.request?.currency;
  if (last && platformsForCurrency(last).length > 0) return last;
  return defaultCurrencyForLocale();
}

function initialPlatform(currency: FiatCode, buy: BuyFlowStore, requested?: string): BuyPlatformId | null {
  const live = platformsForCurrency(currency).map((p) => p.id);
  if (requested && isBuyPlatformId(requested) && live.includes(requested)) return requested;
  const last = buy.request?.platforms?.[0];
  if (last && live.includes(last) && buy.request?.currency === currency) return last;
  return null;
}

function SetupView({
  buy,
  initial,
  onBack,
  onPlace,
}: {
  buy: BuyFlowStore;
  initial: { platform?: string; currency?: string };
  onBack: () => void;
  onPlace: () => void;
}) {
  const game = useGame();
  const deps = useBuyDeps();
  const [currency, setCurrency] = useState<FiatCode>(() => initialCurrency(buy, initial.currency));
  const [platform, setPlatform] = useState<BuyPlatformId | null>(() => initialPlatform(currency, buy, initial.platform));
  const [amount, setAmount] = useState<number>(() => {
    const last = buy.request && buy.request.currency === currency ? Number(buy.request.fiatAmount) : NaN;
    return Number.isFinite(last) && last > 0 ? last : defaultAmount(currency);
  });
  const [picker, setPicker] = useState<"currency" | "platform" | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  // On a browser that can't prove payments, nothing is placed until the buyer says they will verify on a computer.
  const needsComputer = useNeedsComputer();
  const [computerAck, setComputerAck] = useState(false);
  const ackMissing = needsComputer && !computerAck;
  const settled = useDebounced(amount);
  const fiatText = fiatAmountText(settled, currency);

  const prices = useQuery({
    queryKey: ["buy-ui", "guide", currency, fiatText],
    queryFn: () => deps.getBestPricesByPlatform({ currency, fiatAmount: fiatText, recipient: game.sender?.address ?? null }),
    enabled: settled > 0,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: 1,
  });
  const price = platform ? prices.data?.find((p) => p.platform === platform) : undefined;
  const guide = price?.available && price.quote ? price.quote : null;
  const platformInfo = platform ? BUY_PLATFORMS[platform] : null;
  const rules = amountRules(platformInfo, currency, guide?.rate ?? null);
  const tooLow = amount < rules.min;
  const tooHigh = rules.max !== undefined && amount > rules.max;

  const liveOrder = buy.order?.status === "active" ? buy.order : null;
  const expired = liveOrder !== null && deps.now() >= liveOrder.expiresAt;
  const busy = buy.step === "quoting" || buy.step === "signaling" || buy.pending === "signal";

  const pickCurrency = (c: FiatCode) => {
    if (c !== currency) {
      setCurrency(c);
      setAmount(defaultAmount(c));
      if (platform && !platformsForCurrency(c).some((p) => p.id === platform)) setPlatform(null);
    }
    setPicker(null);
  };
  const pickPlatform = (p: BuyPlatformId) => {
    setPlatform(p);
    setPicker(null);
  };
  const requestQuotes = () => {
    if (!platform) return;
    game.playSound("click");
    void buy.requestQuotes({ fiatAmount: fiatAmountText(amount, currency), currency, platforms: [platform] });
  };
  const formShown = picker === null && !liveOrder && (buy.step === "idle" || buy.step === "completed" || buy.step === "cancelled");
  useEnterKey(formShown && game.sender && platform && !tooLow && !tooHigh && amount > 0 && !ackMissing ? requestQuotes : null);

  const title = (
    <div className="rb-setup__top">
      <button type="button" className="rb-back" onClick={onBack} disabled={busy} aria-label="Back to your offers">
        <Sprite name="geBack" fallback={<span className="rs-b12 rs-c-orange">&lt;</span>} />
      </button>
      <h3 className="rb-setup__title rs-b12 rs-c-orange rs-shadow">Buy offer</h3>
    </div>
  );

  // An open order (even one in an error) blocks a new one; an expired one is shown first so a paid order is never forgotten.
  if (liveOrder && !SETUP_STEPS.has(buy.step)) {
    return (
      <div className="rb-setup">
        {title}
        <div className="rb-gate">
          {buy.step === "error" && !confirmDismiss && (
            <div className="rb-gate__error">
              <BuyErrorPanel actions={false} />
            </div>
          )}
          {expired && confirmDismiss ? (
            <DismissOfferPrompt onDone={() => setConfirmDismiss(false)} />
          ) : expired ? (
            <>
              <p className="rs-p12 rs-c-stone-red rs-shadow">Your last offer expired.</p>
              <p className="rs-p12 rs-c-orange rs-shadow">If you paid it before it expired, verify it now. Otherwise dismiss it to start a new one.</p>
              <div className="rb-buttons">
                <StoneButton onClick={() => game.open({ id: "payment" })}>View offer</StoneButton>
                <StoneButton onClick={() => setConfirmDismiss(true)} disabled={txInFlight(buy.step, buy.pending)}>
                  Dismiss it
                </StoneButton>
              </div>
            </>
          ) : (
            <>
              <p className="rs-p12 rs-c-orange rs-shadow">You already have a buy offer open.</p>
              <p className="rs-p12 rs-c-orange rs-shadow">Pay it or cancel it before you place another.</p>
              <div className="rb-buttons">
                <StoneButton onClick={() => game.open({ id: "payment" })}>View offer</StoneButton>
                <StoneButton onClick={onBack}>Back</StoneButton>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (buy.step === "error") {
    return (
      <div className="rb-setup">
        {title}
        <div className="rb-gate">
          <BuyErrorPanel />
        </div>
      </div>
    );
  }

  // Cancelling an older order this app can't show (from the error's "Cancel old order").
  if (buy.pending === "cancel") {
    return (
      <div className="rb-setup">
        {title}
        <Waiting text="Cancelling your older order" detail="Confirm it in your wallet if asked." className="rb-wait--fill" />
      </div>
    );
  }

  if (buy.step === "signaling" || buy.pending === "signal") {
    return (
      <div className="rb-setup">
        {title}
        <Waiting
          text="Placing your offer"
          detail={buy.notice ?? (game.sender?.sponsored ? "Approve it if your wallet asks." : "Confirm the transaction in your wallet.")}
          className="rb-wait--fill"
        />
      </div>
    );
  }

  if (buy.step === "quoting") {
    return (
      <div className="rb-setup">
        {title}
        <Waiting text="Finding the best offer" className="rb-wait--fill" />
      </div>
    );
  }

  if (buy.step === "quoted" || buy.step === "confirming") {
    return (
      <div className="rb-setup">
        {title}
        <QuoteView buy={buy} onPlace={onPlace} needsComputer={needsComputer} computerAck={computerAck} onComputerAck={setComputerAck} />
      </div>
    );
  }

  if (picker === "currency") {
    return (
      <div className="rb-setup">
        {title}
        <CurrencyPicker value={currency} onPick={pickCurrency} onCancel={() => setPicker(null)} />
      </div>
    );
  }
  if (picker === "platform") {
    return (
      <div className="rb-setup">
        {title}
        <PlatformPicker
          currency={currency}
          value={platform}
          prices={prices.data}
          pricesLoading={prices.isPending}
          onPick={pickPlatform}
          onSell={(p) => game.open({ id: "sell", platform: p, currency })}
          onCancel={() => setPicker(null)}
        />
      </div>
    );
  }

  const fiatShown = formatFiat(fiatUnits(amount, currency), currency);
  let guideLine: ReactNode;
  if (!platform) guideLine = <span className="rs-c-orange rs-shadow">Choose how you will pay to see the guide price.</span>;
  else if (prices.isPending || settled !== amount) guideLine = <Waiting text="Checking prices" className="rb-wait--inline" />;
  else if (prices.isError) guideLine = <span className="rs-c-stone-red rs-shadow">Prices are unavailable right now. Try again in a moment.</span>;
  // Venmo and PayPal: the book is empty for a known reason, not because of this amount.
  else if (!guide && platformInfo?.noOffersNote) guideLine = <span className="rs-c-stone-red rs-shadow">{platformInfo.noOffersNote} Try another method.</span>;
  else if (!guide) guideLine = <span className="rs-c-stone-red rs-shadow">No sellers on {platformInfo?.name} can fill {fiatShown} right now. Try another amount or method.</span>;
  else {
    // The guide's USDC is net of fees; its listed rate is not, so the rate fees included sits beside it.
    const afterFees = effectiveRate(guide.fiatAmount, guide.usdcAmount);
    guideLine = (
      <>
        <span className="rs-c-orange rs-shadow">Guide price: </span>
        <span className="rs-c-white rs-shadow">{rateText(guide.rate, currency)}</span>
        <br />
        <span className="rs-c-orange rs-shadow">You will receive </span>
        <span className="rs-c-yellow rs-shadow">~{formatUsdc(guide.usdcAmount)} USDC</span>
        {afterFees !== null && (
          <>
            <br />
            <span className="rs-c-orange rs-shadow">After fees: </span>
            <span className="rs-c-white rs-shadow">{rateText(afterFees, currency)}</span>
          </>
        )}
      </>
    );
  }

  let limitLine: string | null = null;
  if (tooLow) limitLine = `The smallest ${platformInfo?.name ?? ""} order is ${formatFiat(fiatUnits(rules.min, currency), currency)}.`.replace("  ", " ");
  else if (rules.max !== undefined && amount >= rules.max && platformInfo?.maxUsdc) limitLine = `${platformInfo.name} orders are capped at ${Number(platformInfo.maxUsdc).toLocaleString("en-US")} USDC.`;

  return (
    <div className="rb-setup">
      {title}
      <div className="rb-setup__grid">
        <div className="rb-setup__choices">
          <ChoiceBox
            label="Pay in:"
            icon={<CurrencyIcon currency={currency} />}
            name={`${currency} - ${FIAT_CURRENCIES[currency].name}`}
            onClick={() => setPicker("currency")}
            ariaLabel={`Currency: ${FIAT_CURRENCIES[currency].name}. Change currency`}
          />
          <ChoiceBox
            label="Pay with:"
            icon={platform ? <PlatformIcon platform={platform} size={28} /> : <span className="rb-choice__empty" />}
            name={platformInfo?.name ?? "Choose a method..."}
            tag={platformInfo?.beta ? <BetaTag /> : null}
            onClick={() => setPicker("platform")}
            ariaLabel={platformInfo ? `Payment method: ${platformInfo.name}. Change method` : "Choose a payment method"}
            highlight={!platform}
          />
        </div>
        <div className="rb-setup__amount">
          <AmountPad
            value={amount}
            onChange={setAmount}
            label={`Amount (${currency}):`}
            steps={amountSteps(currency)}
            rules={{ min: 0, ...(rules.max !== undefined ? { max: rules.max } : {}), decimals: rules.decimals }}
            format={(v) => formatFiat(fiatUnits(v, currency), currency)}
            promptTitle={`How much ${currency} will you pay?`}
          />
          {limitLine && <p className="rs-p12 rs-c-stone-red rs-shadow">{limitLine}</p>}
          <div className="rb-guide rs-p12" aria-live="polite">
            <Sprite name="geGuidePrice" className="rb-guide__icon" fallback={null} />
            <span>{guideLine}</span>
          </div>
        </div>
      </div>
      {needsComputer ? (
        <div className="rb-setup__desc rb-setup__desc--computer">
          <ComputerNotice />
          <ComputerAck checked={computerAck} onChange={setComputerAck} />
        </div>
      ) : (
        <p className="rb-setup__desc rs-p12 rs-c-orange rs-shadow">
          {platformInfo
            ? `You pay the seller directly on ${platformInfo.name}, then prove it with the Peer extension. The USDC is released to your wallet once the proof checks out.`
            : "You pay the seller directly with the method you choose. The USDC is released to your wallet once your payment is proven."}
        </p>
      )}
      <div className="rb-setup__confirm">
        {game.sender ? (
          <StoneButton size="big" wide onClick={requestQuotes} disabled={!platform || tooLow || tooHigh || amount <= 0 || ackMissing}>
            Confirm
          </StoneButton>
        ) : (
          <LoginButton big />
        )}
      </div>
    </div>
  );
}

function ChoiceBox({
  label,
  icon,
  name,
  tag = null,
  onClick,
  ariaLabel,
  highlight = false,
}: {
  label: string;
  icon: ReactNode;
  name: string;
  /** Drawn after the name, e.g. "Beta". */
  tag?: ReactNode;
  onClick: () => void;
  ariaLabel: string;
  highlight?: boolean;
}) {
  return (
    <div className="rb-choice">
      <span className="rs-p12 rs-c-orange rs-shadow">{label}</span>
      <button type="button" className={cx("rb-choice__btn", highlight && "rb-choice__btn--prompt")} onClick={onClick} aria-label={ariaLabel}>
        <span className="rb-itembox">{icon}</span>
        <span className="rb-choice__name rs-p12 rs-c-white rs-shadow">
          {name}
          {tag && <> {tag}</>}
        </span>
        <span className="rb-choice__change rs-p11 rs-c-yellow rs-shadow">Change</span>
      </button>
    </div>
  );
}

function QuoteView({
  buy,
  onPlace,
  needsComputer,
  computerAck,
  onComputerAck,
}: {
  buy: BuyFlowStore;
  onPlace: () => void;
  needsComputer: boolean;
  computerAck: boolean;
  onComputerAck: (checked: boolean) => void;
}) {
  const game = useGame();
  const deps = useBuyDeps();
  const quote: BuyQuote | undefined = buy.selectedQuote ?? buy.quotes[0];
  const request = buy.request;
  const [expired, setExpired] = useState(() => buy.quotesExpireAt !== null && deps.now() >= buy.quotesExpireAt);
  useEffect(() => setExpired(buy.quotesExpireAt !== null && deps.now() >= buy.quotesExpireAt), [buy.quotesExpireAt, deps]);
  const requestText = request ? `${formatFiat(fiatUnits(Number(request.fiatAmount), request.currency), request.currency)}` : "";
  const platformName = request?.platforms?.[0] ? BUY_PLATFORMS[request.platforms[0]].name : "";
  // The other methods' prices at this amount (the setup screen's guide query), to flag a method far above the cheapest.
  const guideFiat = request ? fiatAmountText(Number(request.fiatAmount), request.currency) : null;
  const prices = useQuery({
    queryKey: ["buy-ui", "guide", request?.currency, guideFiat],
    queryFn: () => deps.getBestPricesByPlatform({ currency: request!.currency, fiatAmount: guideFiat!, recipient: game.sender?.address ?? null }),
    enabled: request !== null && guideFiat !== null,
    staleTime: 20_000,
    retry: 1,
  });
  const over = quote ? overCheapest(quote.rate, prices.data) : null;
  const ackMissing = needsComputer && !computerAck && !expired;

  const confirm = () => {
    if (!quote) return;
    if (expired) {
      if (request) void buy.requestQuotes(request);
      return;
    }
    if (ackMissing) return;
    onPlace();
    game.playSound("click");
    if (buy.step !== "confirming" || buy.selectedQuote?.id !== quote.id) buy.selectQuote(quote.id);
    void buy.confirm();
  };
  useEnterKey(quote && game.sender && !ackMissing ? confirm : null);

  if (!quote) {
    const nearby = [...buy.nearby.below, ...buy.nearby.above];
    return (
      <div className="rb-quote">
        <p className="rs-p12 rs-c-stone-red rs-shadow">
          No seller can fill {requestText} on {platformName} right now.
        </p>
        {nearby.length > 0 ? (
          <>
            <p className="rs-p12 rs-c-orange rs-shadow">Sellers can fill these amounts instead:</p>
            <div className="rb-buttons rb-buttons--wrap">
              {nearby.map((n) => (
                <StoneButton key={`${n.quote.id}:${n.fiatAmount}`} onClick={() => void buy.requoteAt(n.fiatAmount)}>
                  {request ? formatFiat(n.fiatAmount, request.currency) : ""}
                </StoneButton>
              ))}
            </div>
          </>
        ) : (
          <p className="rs-p12 rs-c-orange rs-shadow">Try a different amount or payment method.</p>
        )}
        <div className="rb-buttons">
          <StoneButton onClick={() => buy.back()}>Change offer</StoneButton>
        </div>
      </div>
    );
  }

  return (
    <div className="rb-quote">
      <p className="rs-p12 rs-c-orange rs-shadow">
        {!buy.selectedQuote || buy.selectedQuote.id === buy.quotes[0]?.id ? "Best offer for " : "Offer for "}
        <span className="rs-c-white">{formatFiat(quote.fiatAmount, quote.currency)}</span> on {BUY_PLATFORMS[quote.platform].name}:
      </p>
      <div className="rb-quote__body">
        <span className="rb-itembox rb-itembox--big">
          <ItemSlot item={usdcItem(quote.usdcAmount)} />
        </span>
        <dl className="rb-rows">
          <Row label="Seller:">
            {quote.seller ? shortAddress(quote.seller) : "Unknown"}
            {quote.successRateBps !== null && <span className="rs-c-orange"> ({Math.floor(quote.successRateBps / 100)}% completed)</span>}
          </Row>
          <Row label="Rate:">{rateText(quote.rate, quote.currency)}</Row>
          <Row label="Fees:">{feeBreakdown(quote.fees)}</Row>
          <Row label="You receive:">
            <span className="rs-c-yellow">{formatUsdc(quote.usdcAmount)} USDC</span>
          </Row>
        </dl>
      </div>
      {over && over.best.platform !== quote.platform && (
        <p className="rs-p12 rs-c-stone-red rs-shadow rb-quote__note" role="alert">
          {over.percentText} over the cheapest method ({BUY_PLATFORMS[over.best.platform].name} at {rateText(over.best.rate, quote.currency)}).
        </p>
      )}
      <p className="rs-p11 rs-c-orange rs-shadow rb-quote__note">
        {expired ? (
          <span className="rs-c-stone-red">This price has expired.</span>
        ) : buy.quotesExpireAt ? (
          <>
            Quote fresh for <CountdownText until={buy.quotesExpireAt} now={deps.now} warnBelowMs={15_000} onExpire={() => setExpired(true)} />. Nothing is reserved until you confirm. Fees are already taken from what you receive.
          </>
        ) : (
          "Fees are already taken from what you receive."
        )}
      </p>
      <GasNote className="rb-quote__note" />
      {!expired && <BuyNotice platform={quote.platform} className="rb-quote__note" />}
      {needsComputer && !expired && (
        <div className="rb-computer__box">
          <ComputerNotice />
          <ComputerAck checked={computerAck} onChange={onComputerAck} />
        </div>
      )}
      <div className="rb-buttons">
        {game.sender ? (
          <StoneButton size="big" onClick={confirm} disabled={ackMissing}>
            {expired ? "Get fresh prices" : "Confirm offer"}
          </StoneButton>
        ) : (
          <LoginButton big />
        )}
        <StoneButton size="big" onClick={() => buy.back()}>
          Back
        </StoneButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collect a finished or cancelled offer

function CollectView({ buy, onDone }: { buy: BuyFlowStore; onDone: () => void }) {
  const game = useGame();
  const order = buy.order;
  const completion = buy.completion;
  const done = buy.step === "completed" || order?.status === "fulfilled";
  const collect = () => {
    if (buy.pending !== null) return;
    buy.reset();
    game.playSound("collect");
    onDone();
  };
  useEnterKey(collect);
  return (
    <div className="rb-setup">
      <div className="rb-setup__top">
        <button type="button" className="rb-back" onClick={onDone} aria-label="Back to your offers">
          <Sprite name="geBack" fallback={<span className="rs-b12 rs-c-orange">&lt;</span>} />
        </button>
        <h3 className="rb-setup__title rs-b12 rs-c-orange rs-shadow">Buy offer</h3>
      </div>
      <div className="rb-gate">
        {order && done ? (
          <>
            <span className="rb-itembox rb-itembox--big">
              <ItemSlot item={usdcItem(completion?.usdcReceived ?? order.usdcExpected)} />
            </span>
            <p className="rs-p12 rs-c-green rs-shadow">
              You bought {formatUsdc(completion?.usdcReceived ?? order.usdcExpected)} USDC for {formatFiat(completion?.fiatSent ?? order.fiatToSend, order.currency)} on {BUY_PLATFORMS[order.platform].name}.
            </p>
            <p className="rs-p12 rs-c-orange rs-shadow">The USDC is in your wallet.</p>
            <FeeWaivedNote order={order} />
          </>
        ) : order ? (
          <>
            <p className="rs-p12 rs-c-stone-red rs-shadow">{buy.notice ?? "This offer was cancelled."}</p>
            <p className="rs-p12 rs-c-orange rs-shadow">
              {formatFiat(order.fiatToSend, order.currency)} on {BUY_PLATFORMS[order.platform].name} for {formatUsdc(order.usdcExpected)} USDC.
            </p>
            {/* Collect forgets the order: a player who paid needs its details for support first. */}
            {paidClaimed(order) && <HelpLine order={order} lead="Already paid for it?" safety={false} />}
          </>
        ) : (
          <p className="rs-p12 rs-c-orange rs-shadow">There is nothing to collect.</p>
        )}
        <div className="rb-buttons">
          <StoneButton size="big" onClick={collect}>
            {order ? "Collect" : "Back"}
          </StoneButton>
        </div>
      </div>
    </div>
  );
}

