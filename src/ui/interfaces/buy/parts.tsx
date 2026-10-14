import { useId, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { DEFAULT_INTENT_TTL_MS, type BuyError, type BuyFlowStore, type BuyOrder } from "@/peer/buy";
import { formatUsdc } from "@/peer/format";
import { BUY_PLATFORMS, FIAT_CURRENCIES, type BuyPlatformId, type FiatCode } from "@/peer/platforms";
import { Checkbox, PleaseWait, Sprite, StoneButton, coinsSpriteFor, cx, useNow, type ItemData } from "@/ui/kit";
import { CopyOrderDetails, HELP_SAFETY_LINE, HelpLink } from "../shared/help";
import { PlatformIcon } from "../shared/PlatformIcon";
import { useGame } from "../context";
import { useBuyDeps } from "./deps";
import { errorActions, errorText, feeWaived, usdcStack } from "./model";
import { usePractice } from "./practiceContext";

/** USDC drawn as the coins item: whole dollars as the stack, exact cents on examine. */
export function usdcItem(usdc: bigint, name = "USDC"): ItemData {
  const stack = usdcStack(usdc);
  return {
    key: "usdc",
    name,
    icon: <Sprite name={coinsSpriteFor(Math.max(1, stack))} />,
    quantity: stack,
    stackable: true,
    examine: `${formatUsdc(usdc)} USDC.`,
  };
}

/** A currency drawn as a bank note with its code, the item for "pay in". */
export function CurrencyIcon({ currency, size = "item" }: { currency: FiatCode; size?: "item" | "small" }) {
  return (
    <span className={cx("rb-cur", size === "small" && "rb-cur--small")} role="img" aria-label={FIAT_CURRENCIES[currency].name}>
      <Sprite name="itemNoteBlank" fallback={<span className="rb-cur__paper" />} />
      <span className="rb-cur__code" aria-hidden="true">
        {currency}
      </span>
    </span>
  );
}

export function currencyItem(currency: FiatCode): ItemData {
  return { key: `cur:${currency}`, name: `${FIAT_CURRENCIES[currency].name} (${currency})`, icon: <CurrencyIcon currency={currency} /> };
}

export function platformItem(platform: string, name: string, examine?: ReactNode): ItemData {
  return { key: `pf:${platform}`, name, icon: <PlatformIcon platform={platform} size={28} />, examine };
}

/** "Beta" beside a payment method Peer still marks as beta (Alipay, UPI). */
export function BetaTag({ className }: { className?: string }) {
  return (
    <span className={cx("rb-beta rs-shadow", className)} title="Peer still marks this payment method as beta.">
      Beta
    </span>
  );
}

/**
 * A platform's notice before the buyer places an order (Alipay is new on
 * Peer; UPI must be standard UPI in the Amazon Pay app). Never blocks it.
 */
export function BuyNotice({ platform, className }: { platform: BuyPlatformId; className?: string }) {
  const text = BUY_PLATFORMS[platform].buyNotice;
  if (!text) return null;
  return (
    <p className={cx("rb-buynotice rs-p12 rs-c-yellow rs-shadow", className)} role="note">
      {text}
    </p>
  );
}

/** "Please wait..." centred in its area, with an optional line under it. */
export function Waiting({ text = "Please wait", detail, className }: { text?: string; detail?: ReactNode; className?: string }) {
  return (
    <div className={cx("rb-wait", className)}>
      <span className="rs-p12 rs-c-yellow rs-shadow">
        <PleaseWait text={text} />
      </span>
      {detail && <p className="rb-wait__detail rs-p12 rs-c-orange rs-shadow">{detail}</p>}
    </div>
  );
}

/** Replaces a trade action when no wallet is ready: "Log in to trade". */
export function LoginButton({ big = false }: { big?: boolean }) {
  const { login, walletReady } = useGame();
  return (
    <StoneButton size={big ? "big" : "normal"} onClick={login} disabled={!walletReady}>
      {walletReady ? "Log in to trade" : "Loading wallet..."}
    </StoneButton>
  );
}

/**
 * On a buy confirm screen: a wallet the bank doesn't sponsor (an external
 * wallet) pays Base gas for the signal itself. Nothing for sponsored wallets.
 */
export function GasNote({ className }: { className?: string }) {
  const { sender } = useGame();
  if (!sender || sender.sponsored) return null;
  return <p className={cx("rb-gasnote rs-p11 rs-c-quiet rs-shadow", className)}>Your wallet pays a small Base network fee in ETH.</p>;
}

/** How long an order stays open, in words ("6 hours"). */
export const ORDER_TTL_TEXT = `${Math.round(DEFAULT_INTENT_TTL_MS / 3_600_000)} hours`;

/** Where a buyer on a phone (or any browser without the extension) goes to prove their payment. */
export const VERIFY_ON_COMPUTER_TEXT = "Log in at www.rampridge.xyz on a computer with the same account. Your order is waiting in the Grand Exchange.";

/**
 * Before an order is placed on a browser that can't prove payments (a
 * phone, Safari, Firefox): the payment must be proven with the Peer
 * extension on a computer before the order expires.
 */
export function ComputerNotice({ className }: { className?: string }) {
  return (
    <p className={cx("rb-computer rs-p12 rs-c-stone-red rs-shadow", className)} role="note">
      To finish, you must prove this payment with the Peer extension in Chrome or Brave on a computer, within {ORDER_TTL_TEXT}.
    </p>
  );
}

/** The tick that unlocks placing an order where ComputerNotice shows. */
export function ComputerAck({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <Checkbox className="rb-computer__ack" checked={checked} onChange={onChange} label="I will verify on a computer" />;
}

/**
 * "Problem with this order? Get help", "Copy order details" and the line
 * that RampRidge never DMs first, for the money screens. `order` adds the
 * copy option; `tone` matches the Payment scroll's ink or a stone window.
 */
export function HelpLine({
  order,
  lead = "Problem with this order?",
  tone = "stone",
  safety = true,
  className,
}: {
  order?: BuyOrder | null;
  lead?: string;
  tone?: "stone" | "parchment";
  safety?: boolean;
  className?: string;
}) {
  const practice = usePractice();
  const parchment = tone === "parchment";
  const linkClass = parchment ? "rb-help__ink" : undefined;
  const linkTone = parchment ? "black" : "yellow";
  // A practice order has nobody to ask about it.
  if (practice) return null;
  const copy = order ? <CopyOrderDetails order={order} platformName={BUY_PLATFORMS[order.platform]?.name} tone={linkTone} className={linkClass} /> : null;
  return (
    <div className={cx("rb-help", parchment && "rb-help--parchment", className)}>
      <p className={cx("rs-p12", parchment ? "rb-ink" : "rs-c-orange rs-shadow")}>
        {lead} <HelpLink tone={linkTone} underline={parchment} className={linkClass} />
        {copy && (
          <>
            {" "}
            <span aria-hidden="true" className={parchment ? "rb-help__sep" : undefined}>
              |
            </span>{" "}
            <span className={parchment ? "rb-help__copy" : undefined}>{copy}</span>
          </>
        )}
      </p>
      {safety && <p className={cx("rs-p11", parchment ? "rb-ink-muted" : "rs-c-quiet rs-shadow")}>{HELP_SAFETY_LINE}</p>}
    </div>
  );
}

/** "RampRidge fee waived for this order." where no RampRidge fee was taken (see feeWaived). */
export function FeeWaivedNote({ order, tone = "stone", className }: { order: Pick<BuyOrder, "fees">; tone?: "stone" | "parchment"; className?: string }) {
  if (!feeWaived(order)) return null;
  return <p className={cx("rs-p11", tone === "parchment" ? "rb-ink-green" : "rs-c-green rs-shadow", className)}>RampRidge fee waived for this order.</p>;
}

/**
 * "Are you sure?" before an action that gives up the player's claim to an
 * order they may have paid. "No" has focus, so Enter (or a stray click on
 * the focused button) keeps things as they are.
 */
export function ConfirmPrompt({
  question,
  warning,
  yes,
  no = "No, keep it",
  onYes,
  onNo,
  disabled = false,
  tone = "stone",
}: {
  question: string;
  warning: string;
  yes: string;
  no?: string;
  onYes: () => void;
  onNo: () => void;
  disabled?: boolean;
  tone?: "stone" | "parchment";
}) {
  const id = useId();
  const parchment = tone === "parchment";
  return (
    <div className="rb-confirm" role="group" aria-labelledby={`${id}-q`} aria-describedby={`${id}-w`}>
      <p id={`${id}-q`} className={cx("rs-p12", parchment ? "rb-ink" : "rs-c-orange rs-shadow")}>
        {question}
      </p>
      <p id={`${id}-w`} className={cx("rs-p12", parchment ? "rb-ink-red" : "rs-c-stone-red rs-shadow")}>
        {warning}
      </p>
      <div className="rb-buttons">
        <StoneButton onClick={onYes} disabled={disabled}>
          {yes}
        </StoneButton>
        <StoneButton onClick={onNo} autoFocus>
          {no}
        </StoneButton>
      </div>
    </div>
  );
}

/**
 * Confirms dismissing an expired order. Dismissing forgets it here for good
 * (recovery never brings back an expired intent), so a player who paid
 * before it expired would lose the only way to prove it.
 */
export function DismissOfferPrompt({ onDone, tone = "stone" }: { onDone: () => void; tone?: "stone" | "parchment" }) {
  const { store } = useBuyDeps();
  const pending = useStore(store, (s) => s.pending);
  return (
    <ConfirmPrompt
      question="Dismiss this offer?"
      warning="If you sent any money for it, verify it first. Once dismissed it can't be verified here."
      yes="Yes, dismiss it"
      onYes={() => {
        store.getState().dismissOrder();
        onDone();
      }}
      onNo={onDone}
      disabled={pending !== null}
      tone={tone}
    />
  );
}

/**
 * The buy store's error with its recovery buttons. "Try again" runs the
 * store's own retry; when the store has no retry for this error it falls
 * back to going back, so the button is never a dead end. Cancelling an
 * older blocking order (one this app can't show) asks first: it may have
 * been paid elsewhere. `actions={false}` shows the message alone, for a
 * window that sends the player to their order instead (the open-order gates).
 */
export function BuyErrorPanel({
  tone = "stone",
  actions: withActions = true,
  onBack,
  onRetry,
}: {
  tone?: "stone" | "parchment";
  actions?: boolean;
  onBack?: () => void;
  onRetry?: () => void;
}) {
  const { store, now } = useBuyDeps();
  const error = useStore(store, (s) => s.error);
  const expiresAt = useStore(store, (s) => (s.order?.status === "active" ? s.order.expiresAt : null));
  const expired = useNow(now, 5_000) >= (expiresAt ?? Number.POSITIVE_INFINITY);
  const returnStep = useStore(store, (s) => s.errorReturnStep);
  const blocking = useStore(store, (s) => s.blockingIntent);
  const pending = useStore(store, (s) => s.pending);
  const order = useStore(store, (s) => (s.order?.status === "active" ? s.order : null));
  // Tied to the error it was opened for, so a new error never opens on the prompt.
  const [confirmCancel, setConfirmCancel] = useState<BuyError | null>(null);
  if (!error) return null;
  const actions = errorActions(error, returnStep);
  const run = async (action: "retry" | "back") => {
    const s: BuyFlowStore = store.getState();
    if (action === "back") {
      s.back();
      onBack?.();
      return;
    }
    const before = s.error;
    onRetry?.();
    await s.retry();
    const after = store.getState();
    if (after.step === "error" && after.error === before) after.back();
  };
  const canCancelBlocker = error.code === "active_intent" && blocking !== null;
  if (canCancelBlocker && confirmCancel === error) {
    return (
      <div className={cx("rb-error", tone === "parchment" && "rb-error--parchment")}>
        <ConfirmPrompt
          question="Cancel your older order?"
          warning="Only cancel it if you have not sent any money for it. Cancelled orders can't be verified."
          yes="Yes, cancel it"
          onYes={() => {
            setConfirmCancel(null);
            void store.getState().cancelOrder();
          }}
          onNo={() => setConfirmCancel(null)}
          disabled={pending !== null}
          tone={tone}
        />
      </div>
    );
  }
  return (
    <div className={cx("rb-error", tone === "parchment" && "rb-error--parchment")} role="alert">
      <p className={cx("rs-p12", tone === "parchment" ? "rb-ink-red" : "rs-c-stone-red rs-shadow")}>{errorText(error, expired)}</p>
      {withActions && (
        <div className="rb-buttons">
          {actions.primary && (
            <StoneButton onClick={() => void run(actions.primary!.action)} disabled={pending !== null}>
              {actions.primary.label}
            </StoneButton>
          )}
          {canCancelBlocker && (
            <StoneButton onClick={() => setConfirmCancel(error)} disabled={pending !== null}>
              Cancel old order
            </StoneButton>
          )}
          {actions.back && (
            <StoneButton onClick={() => void run("back")} disabled={pending !== null}>
              Back
            </StoneButton>
          )}
        </div>
      )}
      <HelpLine order={order} lead="Stuck?" tone={tone} safety={false} className="rb-error__help" />
    </div>
  );
}

/** A label/value row ("Rate:  0.7900 GBP per USDC"). */
export function Row({ label, children, tone = "stone" }: { label: ReactNode; children: ReactNode; tone?: "stone" | "parchment" }) {
  return (
    <div className="rb-row">
      <dt className={cx("rs-p12", tone === "stone" ? "rs-c-orange rs-shadow" : "rb-ink")}>{label}</dt>
      <dd className={cx("rs-p12", tone === "stone" ? "rs-c-white rs-shadow" : "rb-ink")}>{children}</dd>
    </div>
  );
}
