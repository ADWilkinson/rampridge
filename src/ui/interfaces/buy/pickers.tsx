import { useEffect, useRef } from "react";
import { formatUsdc } from "@/peer/format";
import type { PlatformPrice } from "@/peer/market";
import { FIAT_CURRENCIES, buyableCurrencies, platformsForCurrency, type BuyPlatformId, type FiatCode } from "@/peer/platforms";
import { ScrollArea, StoneButton, TextButton, cx } from "@/ui/kit";
import { PlatformIcon } from "../shared/PlatformIcon";
import { useGame } from "../context";
import { BetaTag, CurrencyIcon } from "./parts";
import { noOffersText, orderByLiquidity, peerOrder, rankPlatforms, rateText } from "./model";

/**
 * "Choose a currency": every currency at least one live platform takes, as
 * bank-note items. When the shell knows which currencies have fillable
 * offers right now, those come first and the rest say "No offers right now"
 * in grey (still selectable: liquidity comes and goes).
 */
export function CurrencyPicker({ value, onPick, onCancel }: { value: FiatCode; onPick: (c: FiatCode) => void; onCancel: () => void }) {
  const { liquidCurrencies } = useGame();
  const list = orderByLiquidity(buyableCurrencies(), liquidCurrencies ?? null);
  const selected = useRef<HTMLButtonElement>(null);
  useEffect(() => selected.current?.focus({ preventScroll: false }), []);
  return (
    <div className="rb-picker" role="group" aria-label="Choose a currency">
      <p className="rb-picker__title rs-p12 rs-c-orange rs-shadow">Choose the currency you will pay in:</p>
      <ScrollArea className="rb-picker__scroll" label="Currencies">
        <ul className="rb-picker__list">
          {list.map(({ code, liquid }) => (
            <li key={code}>
              <button
                ref={code === value ? selected : undefined}
                type="button"
                className={cx("rb-pick", code === value && "rb-pick--on")}
                aria-pressed={code === value}
                onClick={() => onPick(code)}
              >
                <CurrencyIcon currency={code} size="small" />
                <span className="rb-pick__name rs-p12">
                  <span className="rs-c-white rs-shadow">{code}</span> <span className="rs-c-orange rs-shadow">{FIAT_CURRENCIES[code].name}</span>
                  {!liquid && <span className="rb-pick__detail rs-c-quiet rs-shadow">No offers right now</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div className="rb-buttons">
        <StoneButton onClick={onCancel}>Cancel</StoneButton>
      </div>
    </div>
  );
}

/**
 * "Choose how you will pay": live platforms for the currency, each with its
 * guide rate for this amount when the price board has one. Methods with
 * offers come first, cheapest first; a method more than 3% above the
 * cheapest says so in red. Methods nobody sells on come last in grey ("No
 * sellers yet", or the platform's own reason, as for Venmo and PayPal; still
 * selectable: liquidity comes and goes) with the way to become that seller.
 * Ties keep Peer's order (Alipay first for CNY, UPI first for INR), and
 * methods Peer still calls beta say so.
 */
export function PlatformPicker({
  currency,
  value,
  prices,
  pricesLoading,
  onPick,
  onSell,
  onCancel,
}: {
  currency: FiatCode;
  value: BuyPlatformId | null;
  prices: readonly PlatformPrice[] | undefined;
  pricesLoading: boolean;
  onPick: (p: BuyPlatformId) => void;
  /** Opens the Sell interface for a method with no sellers. */
  onSell?: (p: BuyPlatformId) => void;
  onCancel: () => void;
}) {
  const rows = rankPlatforms(peerOrder(platformsForCurrency(currency), currency), pricesLoading ? undefined : prices);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: false }), []);
  return (
    <div className="rb-picker" role="group" aria-label="Choose a payment method">
      <p className="rb-picker__title rs-p12 rs-c-orange rs-shadow">Choose how you will pay in {currency}:</p>
      <ScrollArea className="rb-picker__scroll" label="Payment methods">
        <ul className="rb-picker__list rb-picker__list--wide">
          {rows.map(({ platform: p, price, available, overCheapest }, i) => {
            const empty = !pricesLoading && prices !== undefined && !available;
            const detail = pricesLoading
              ? "Checking..."
              : available && price?.quote
                ? `${rateText(price.quote.rate, currency)} (~${formatUsdc(price.quote.usdcAmount)} USDC)`
                : empty
                  ? noOffersText(p)
                  : "";
            return (
              <li key={p.id} className={cx("rb-pick__row", empty && "rb-pick__row--empty")}>
                <button
                  ref={p.id === value || (!value && i === 0) ? first : undefined}
                  type="button"
                  className={cx("rb-pick", p.id === value && "rb-pick--on")}
                  aria-pressed={p.id === value}
                  onClick={() => onPick(p.id)}
                >
                  <PlatformIcon platform={p.id} size={24} />
                  <span className="rb-pick__name rs-p12">
                    <span className="rb-pick__title">
                      <span className={cx("rs-shadow", empty ? "rs-c-quiet" : "rs-c-white")}>{p.name}</span>
                      {p.beta && <BetaTag />}
                    </span>
                    {detail && <span className={cx("rb-pick__detail rs-shadow", available ? "rs-c-yellow" : "rs-c-quiet")}>{detail}</span>}
                    {overCheapest && <span className="rb-pick__detail rs-c-stone-red rs-shadow">{overCheapest} over the cheapest method</span>}
                  </span>
                </button>
                {empty && onSell && (
                  <TextButton tone="yellow" font="p11" className="rb-pick__sell" onClick={() => onSell(p.id)}>
                    Sell USDC for {p.name} instead?
                  </TextButton>
                )}
              </li>
            );
          })}
        </ul>
      </ScrollArea>
      <div className="rb-buttons">
        <StoneButton onClick={onCancel}>Cancel</StoneButton>
      </div>
    </div>
  );
}
