import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sellQueryKeys, useLastSellDeposit, useMyCashOrders, type SellFlowError, type SellOrderRow } from "@/peer/sell";
import type { TxSender } from "@/wallet/types";
import { HelpLink } from "@/ui/interfaces/shared/help";
import { PleaseWait, ScrollArea, StoneButton, TextButton, Window, cx } from "@/ui/kit";
import { useGame, type InterfaceProps } from "../context";
import { CenterNote, ErrorNote, LoggedOut, OrderIcon, OrderTxNote, TextLink, useOrderDetails, type OrderDetail } from "./common";
import { useCashClient, useInterfaceSize } from "./deps";
import { addressUrl, dateText, fillRows, holdMessage, orderSentence, payoutGroups, payoutTitle, remainingAmount, stateLabel, txUrl, usdcText } from "./helpers";
import {
  isLiveSend,
  orderTxChangedText,
  orderTxDoneText,
  orderTxFailedText,
  orderTxStore,
  recordAmount,
  releaseOrderTx,
  sendOrderTx,
  useOrderTxWatcher,
  useOrderTxs,
  type OrderTxEvent,
  type OrderTxRecord,
} from "./orderTx";

/**
 * The collection box: completed and closed sell offers with who filled them
 * (amount, buyer, what they paid). An offer that closed with USDC still in
 * it can be collected back to the wallet from here.
 */
export function CollectionInterface(_props: InterfaceProps<"collection">) {
  const { sender, login, close } = useGame();
  const size = useInterfaceSize({ width: 488, height: 334 }, 560);
  return (
    <Window title="Collection box" width={size.width} height={size.height} onClose={close} draggable className="bk-window">
      {sender ? <CollectionBody sender={sender} /> : <LoggedOut text="You need to log in to see your collection box." onLogin={login} />}
    </Window>
  );
}

/** The last collection's outcome; `failed` adds the help link (the transaction went through but didn't collect). */
type Done = { tone: "good" | "info"; text: string; tx: string | null; failed?: boolean } | null;

function CollectionBody({ sender }: { sender: TxSender }) {
  const { message, playSound, publicClient } = useGame();
  const client = useCashClient();
  const queryClient = useQueryClient();
  const owner = sender.address;
  const orders = useMyCashOrders(owner, { client });
  const closed = useMemo(() => orders.orders.filter((r) => !r.isInFlight), [orders.orders]);
  const details = useOrderDetails(client, closed);
  const last = useLastSellDeposit(owner);
  const txs = useOrderTxs(owner);
  const [done, setDone] = useState<Done>(null);
  const [lastError, setLastError] = useState<SellFlowError | null>(null);
  const [waitNote, setWaitNote] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const liveSend = txs.find(isLiveSend) ?? null;
  const unconfirmed = txs.filter((r) => r.phase !== "settling" && !isLiveSend(r));
  const firstUnconfirmed = unconfirmed[0] ?? null;

  const onTxEvent = (event: OrderTxEvent) => {
    setWaitNote(null);
    switch (event.kind) {
      case "confirmed": {
        const text = orderTxDoneText(event.record, true);
        message(text);
        playSound("coins");
        setDone({ tone: "good", text, tx: event.record.txHash });
        return;
      }
      case "failed": {
        const text = orderTxFailedText(event.record);
        message(text);
        setDone({ tone: "info", text, tx: event.record.txHash, failed: true });
        return;
      }
      case "nothing-left": {
        const text = "This offer has nothing left to withdraw.";
        message(text);
        setDone({ tone: "info", text, tx: null });
        return;
      }
      default:
        return;
    }
  };
  const watcher = useOrderTxWatcher({ owner, client, publicClient, records: txs, onEvent: onTxEvent });

  const collect = async (row: SellOrderRow) => {
    if (liveSend || checking) return;
    setDone(null);
    setLastError(null);
    setWaitNote(null);
    const request = { kind: "withdraw-all", depositId: row.depositId, expectRemaining: remainingAmount(row) } as const;
    const result = await sendOrderTx({ client, sender, publicClient, queryClient }, request);
    switch (result.status) {
      case "sent": {
        const text = `You collect ${usdcText(recordAmount(result.record))} USDC.`;
        message(text);
        playSound("coins");
        setDone({ tone: "good", text, tx: result.txHash });
        return;
      }
      case "locked":
        message(holdMessage(result.record.phase === "settling" ? "updating" : "unconfirmed"));
        return;
      case "busy":
        message("Your wallet is busy. Wait for it to finish.");
        return;
      case "changed": {
        const text = orderTxChangedText(request, result.order);
        message(text);
        setDone({ tone: "info", text, tx: null });
        return;
      }
      case "failed":
        message(result.error.message);
        playSound("error");
        if (!result.unknown) setLastError(result.error);
        return;
    }
  };

  const refresh = async () => {
    if (checking) return;
    setChecking(true);
    setWaitNote(null);
    try {
      await queryClient.refetchQueries({ queryKey: sellQueryKeys.orders(owner) });
      await watcher.check();
      const key = owner.toLowerCase();
      const still = orderTxStore()
        .records()
        .some((r) => r.owner === key && r.phase !== "settling" && !isLiveSend(r));
      if (still) setWaitNote("Still waiting for the network.");
    } finally {
      setChecking(false);
    }
  };

  const release = (record: OrderTxRecord) => {
    if (releaseOrderTx(orderTxStore(), record)) {
      setWaitNote(null);
      message("You can collect from this offer again.");
    }
  };

  if (orders.isLoading) {
    return (
      <CenterNote>
        <PleaseWait text="Opening your collection box" className="rs-p12 rs-c-yellow rs-shadow" />
      </CenterNote>
    );
  }
  if (orders.error && orders.orders.length === 0) {
    return (
      <CenterNote>
        <p className="bk-alert rs-p12 rs-c-red rs-shadow" role="alert">
          Your offers couldn't be loaded. {orders.error.message}
        </p>
        <StoneButton onClick={orders.refetch}>Try again</StoneButton>
      </CenterNote>
    );
  }
  if (closed.length === 0) {
    return (
      <CenterNote>
        <p className="rs-p12 rs-c-orange rs-shadow">You have nothing to collect.</p>
        <p className="rs-p11 rs-c-white rs-shadow">Completed and closed sell offers appear here.</p>
      </CenterNote>
    );
  }

  const busy = liveSend !== null || checking;
  return (
    <div className="bk-coll">
      <p className="bk-coll__intro rs-p12 rs-c-orange rs-shadow">Completed and closed sell offers</p>
      <ScrollArea className="bk-coll__scroll" label="Completed and closed sell offers">
        <ul className="bk-coll__list">
          {closed.map((row) => (
            <CollectionRow
              key={row.depositId}
              row={row}
              detail={details.get(row.depositId) ?? { data: null, isLoading: true, error: null }}
              depositTx={last && last.depositId === row.depositId ? last.txHash : null}
              busy={busy || txs.some((r) => r.depositId === row.depositId)}
              onCollect={() => void collect(row)}
            />
          ))}
        </ul>
      </ScrollArea>
      <div className="bk-coll__status" aria-live="polite">
        {checking ? (
          <PleaseWait text="Checking with the network" className="rs-p12 rs-c-yellow rs-shadow" />
        ) : liveSend ? (
          <PleaseWait text={`Collecting ${usdcText(recordAmount(liveSend))} USDC`} className="rs-p12 rs-c-yellow rs-shadow" />
        ) : lastError ? (
          <ErrorNote error={lastError}>
            <span className="bk-row">
              <TextButton onClick={() => setLastError(null)}>OK</TextButton>
              <HelpLink />
            </span>
          </ErrorNote>
        ) : firstUnconfirmed ? (
          <OrderTxNote record={firstUnconfirmed} note={waitNote} onRefresh={() => void refresh()} onRelease={() => release(firstUnconfirmed)} />
        ) : done ? (
          <p className={cx("rs-p12 rs-shadow", done.tone === "good" ? "rs-c-green" : "rs-c-white")}>
            {done.text} {done.tx && <TextLink href={txUrl(done.tx)}>Basescan</TextLink>} {done.failed && <HelpLink />}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** "Expired, not paid" is quiet, not red: nothing went wrong for the seller, the USDC came back. */
const FILL_TONE = { good: "rs-c-green", pending: "rs-c-yellow", bad: "rs-c-grey" } as const;

function CollectionRow({ row, detail, depositTx, busy, onCollect }: { row: SellOrderRow; detail: OrderDetail; depositTx: string | null; busy: boolean; onCollect: () => void }) {
  const full = detail.data;
  const groups = payoutGroups(row.payouts ?? full?.payouts ?? null);
  const remaining = remainingAmount(row);
  const canCollect = row.canWithdraw && remaining > 0n && !row.order.withdrawn;
  const fills = fillRows(full?.fills ?? row.fills);
  const title = payoutTitle(groups);
  const delivered = row.state === "delivered";
  return (
    <li className="bk-collRow">
      <span className="bk-collRow__icon" aria-hidden="true">
        <OrderIcon row={row} badge={groups[0]?.platform ?? null} />
      </span>
      <div className="bk-collRow__main">
        <p className="rs-p12 rs-shadow">
          <span className="rs-c-white">{usdcText(row.totalAmount)} USDC</span>
          {title && <span className="rs-c-orange"> {title}</span>}
          <span className={cx(delivered ? "rs-c-green" : "rs-c-yellow")}> {stateLabel(row.state)}</span>
        </p>
        <p className="rs-p11 rs-c-white rs-shadow">
          {orderSentence(row)}
          {row.updatedAt ? <span className="rs-c-grey"> {dateText(row.updatedAt)}.</span> : null}
          {depositTx && (
            <>
              {" "}
              <TextLink href={txUrl(depositTx)}>Deposit on Basescan</TextLink>
            </>
          )}
        </p>
        {detail.isLoading && !full ? (
          <PleaseWait text="Loading buyers" className="rs-p11 rs-c-yellow rs-shadow" />
        ) : detail.error && !full ? (
          <p className="bk-alert bk-alert--inline rs-p11 rs-c-red rs-shadow">Buyer details couldn't be loaded.</p>
        ) : fills.length === 0 ? (
          <p className="rs-p11 rs-c-grey rs-shadow">No buyer filled this offer.</p>
        ) : (
          <ul className="bk-fills" aria-label="Buyers">
            {fills.map((f) => (
              <li key={f.key} className="bk-fills__row rs-p11 rs-shadow">
                <span className="rs-c-white">{f.amount}</span>
                <TextLink href={addressUrl(f.buyer)} className="rs-p11">
                  <span aria-label={`Buyer ${f.buyer} on Basescan`}>{f.buyerShort}</span>
                </TextLink>
                <span className={FILL_TONE[f.tone]}>{f.outcome}</span>
              </li>
            ))}
          </ul>
        )}
        {canCollect && (
          <StoneButton className="bk-collRow__collect" onClick={onCollect} disabled={busy}>
            Collect {usdcText(remaining)} USDC
          </StoneButton>
        )}
      </div>
    </li>
  );
}
