import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueries } from "@tanstack/react-query";
import type { CashClient } from "@zkp2p/cash";
import { fetchSellOrder, sellQueryKeys, type SellFlowError, type SellOrderRow } from "@/peer/sell";
import { ContextMenu } from "@/ui/frame";
import { HelpLink } from "@/ui/interfaces/shared/help";
import { PlatformIcon } from "@/ui/interfaces/shared/PlatformIcon";
import { Sprite, StoneButton, TextButton, coinsSpriteFor, cx, type ItemData } from "@/ui/kit";
import { buyerHold, examineLines, orderStack, payoutGroups, payoutTitle, txUrl, type ItemMenuOption } from "./helpers";
import { UNKNOWN_RELEASE_AFTER_MS, orderTxUnconfirmedText, type OrderTxRecord } from "./orderTx";

/** Centred message filling the interface body, e.g. the logged-out and empty states. */
export function CenterNote({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cx("bk-center", className)}>{children}</div>;
}

/** "You need to log in to ..." with the login button. */
export function LoggedOut({ text, onLogin }: { text: string; onLogin: () => void }) {
  return (
    <CenterNote>
      <p className="rs-p12 rs-c-orange rs-shadow">{text}</p>
      <StoneButton autoFocus onClick={onLogin}>
        Log in
      </StoneButton>
    </CenterNote>
  );
}

/** A link styled like an interface text option; external links open in a new tab. */
export function TextLink({ href, children, className }: { href: string; children?: ReactNode; className?: string }) {
  return (
    <a className={cx("bk-link rs-p12", className)} href={href} target="_blank" rel="noopener noreferrer">
      <span className="bk-link__text">{children}</span>
    </a>
  );
}

/** Red error line with the recovery hint underneath, on a dark well so the red stays legible; actions follow below it. */
export function ErrorNote({ error, hint, children }: { error: Pick<SellFlowError, "message" | "recovery">; hint?: string; children?: ReactNode }) {
  const shown = hint ?? error.recovery.hint;
  return (
    <div className="bk-error" role="alert">
      <div className="bk-alert">
        <p className="rs-p12 rs-c-red rs-shadow">{error.message}</p>
        {shown && <p className="rs-p11 rs-c-white rs-shadow">{shown}</p>}
      </div>
      {children}
    </div>
  );
}

/** The coin pile for an order with its platform as a note-style badge in the corner. */
export function OrderIcon({ row, badge }: { row: Pick<SellOrderRow, "totalAmount" | "filledAmount" | "returnedAmount">; badge: string | null }) {
  const stack = orderStack(row);
  return (
    <span className="bk-orderIcon">
      <Sprite name={coinsSpriteFor(stack.spriteQuantity)} />
      {badge && (
        <span className="bk-orderIcon__badge" aria-hidden="true">
          <PlatformIcon platform={badge} size={16} title="" />
        </span>
      )}
    </span>
  );
}

/**
 * One order as a bank item: coins sized to what is left, examine text on
 * hover. `details` (the single-order read, with fills) is preferred over the
 * list row when loaded, since only it knows whether a buyer's time ran out.
 */
export function orderItem(
  row: SellOrderRow,
  opts: { details: SellOrderRow | null; detailsLoading: boolean; advertised: boolean; selected?: boolean; nowSeconds: number },
): ItemData {
  const view = opts.details ?? row;
  const payouts = row.payouts ?? opts.details?.payouts ?? null;
  const groups = payoutGroups(payouts);
  const stack = orderStack(view);
  const lines = examineLines({ row: view, payouts, payoutsLoading: opts.detailsLoading, advertised: opts.advertised, hold: buyerHold(view, opts.nowSeconds) });
  const title = payoutTitle(groups);
  return {
    key: row.depositId,
    name: title ? `USDC offer, ${title}` : "USDC offer",
    icon: <Sprite name={coinsSpriteFor(stack.spriteQuantity)} />,
    overlay: groups[0] ? (
      <span className="bk-orderIcon__badge">
        <PlatformIcon platform={groups[0].platform} size={16} title="" />
      </span>
    ) : undefined,
    quantity: stack.quantity,
    stackable: true,
    placeholder: stack.placeholder,
    selected: opts.selected ?? opts.advertised,
    examine: lines.join("\n"),
  };
}

export interface OrderDetail {
  data: SellOrderRow | null;
  isLoading: boolean;
  error: SellFlowError | null;
}

/**
 * Single-order reads (payout legs and fills) for the given deposits. List
 * rows from `useMyCashOrders` may not carry payouts and never carry fills.
 * Closed orders never change, so they are cached for the session.
 */
export function useOrderDetails(client: CashClient, rows: readonly Pick<SellOrderRow, "depositId" | "isInFlight">[]): Map<string, OrderDetail> {
  const ids = rows.map((row) => row.depositId);
  const idsKey = ids.join("|");
  const combine = useCallback(
    (results: { data?: SellOrderRow; isPending: boolean; error: unknown }[]) => {
      const map = new Map<string, OrderDetail>();
      idsKey.split("|").forEach((id, i) => {
        const r = results[i];
        if (!id || !r) return;
        map.set(id, { data: r.data ?? null, isLoading: r.isPending, error: (r.error as SellFlowError | null) ?? null });
      });
      return map;
    },
    [idsKey],
  );
  return useQueries({
    queries: rows.map((row) => ({
      queryKey: sellQueryKeys.order(row.depositId),
      queryFn: () => fetchSellOrder(client, row.depositId),
      staleTime: row.isInFlight ? 20_000 : Number.POSITIVE_INFINITY,
      refetchInterval: row.isInFlight ? 20_000 : (false as const),
      retry: 1,
    })),
    combine,
  });
}

/**
 * The Choose Option menu for an item, portalled to the page so the window's
 * transform cannot offset it. Esc, Cancel, a click outside or moving away
 * closes it, like the original.
 */
export function ItemMenu({ at, options, onSelect, onClose }: { at: { x: number; y: number }; options: ItemMenuOption[]; onSelect: (option: ItemMenuOption) => void; onClose: () => void }) {
  if (typeof document === "undefined") return null;
  return createPortal(<ContextMenu x={at.x} y={at.y} options={options} onSelect={onSelect} onClose={onClose} />, document.body);
}

/** Wall-clock ms, re-read every `intervalMs` so time-based copy moves on by itself. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * A withdrawal or top-up whose outcome is not known yet. It stays on screen
 * (and the order's money actions stay off) until the chain or the order shows
 * what happened. After UNKNOWN_RELEASE_AFTER_MS with no sign of it, the
 * player may say their wallet shows nothing pending.
 */
export function OrderTxNote({
  record,
  note,
  onRefresh,
  onRelease,
}: {
  record: OrderTxRecord;
  /** Result of the last Refresh, e.g. "Still waiting for the network." */
  note: string | null;
  onRefresh: () => void;
  onRelease: () => void;
}) {
  const now = useNow(15_000);
  const canRelease = now - record.startedAt >= UNKNOWN_RELEASE_AFTER_MS;
  const hint = canRelease
    ? record.mined
      ? "A transaction mined, but your offer hasn't changed. If your wallet shows nothing pending, you can carry on."
      : "There's still no sign of it on-chain. If your wallet shows nothing pending, it didn't go through."
    : (note ?? (record.mined ? "The network has it. Waiting for your bank to update." : "Don't send it again. Check your wallet's activity."));
  return (
    <div className="bk-error">
      <p className="rs-p12 rs-c-yellow rs-shadow">{orderTxUnconfirmedText(record)}</p>
      <p className="rs-p11 rs-c-white rs-shadow">{hint}</p>
      <span className="bk-row">
        {record.txHash && <TextLink href={txUrl(record.txHash)}>View on Basescan</TextLink>}
        <TextButton onClick={onRefresh}>Refresh</TextButton>
        {canRelease && <TextButton onClick={onRelease}>Nothing is pending</TextButton>}
        {canRelease && <HelpLink />}
      </span>
    </div>
  );
}
