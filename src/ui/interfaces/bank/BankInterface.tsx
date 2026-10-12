import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { defaultPendingSellStore, sellQueryKeys, useBuyerProfile, useMyCashOrders, type SellFlowError, type SellOrderRow } from "@/peer/sell";
import type { TxSender } from "@/wallet/types";
import { useUsdcBalance } from "@/wallet";
import { HelpLink } from "@/ui/interfaces/shared/help";
import { ItemGrid, PleaseWait, ScrollArea, StoneButton, Tabs, TextButton, TooltipBox, Window, cx, useChatPrompt, useEscapeLayer, ChatboxPrompt, type ChatPromptRequest } from "@/ui/kit";
import { useGame, type InterfaceProps } from "../context";
import { CenterNote, ErrorNote, ItemMenu, LoggedOut, OrderTxNote, TextLink, orderItem, useOrderDetails } from "./common";
import { useCashClient, useInterfaceSize } from "./deps";
import {
  BANK_TABS,
  buyerHold,
  buyerLine,
  emptyBankText,
  examineLines,
  examineSentence,
  filterOrders,
  holdMessage,
  itemMenuOptions,
  liveBuyer,
  payoutGroups,
  payoutTitle,
  remainingAmount,
  txUrl,
  usdcText,
  usdcUnitsFromNumber,
  type BankTab,
  type ItemHold,
  type ItemMenuOption,
} from "./helpers";
import {
  isLiveSend,
  orderTxChangedText,
  orderTxDoneText,
  orderTxFailedText,
  orderTxStore,
  orderTxWorkingText,
  releaseOrderTx,
  sendOrderTx,
  useOrderTxWatcher,
  useOrderTxs,
  type OrderTxEvent,
  type OrderTxRecord,
  type OrderTxRequest,
} from "./orderTx";

/**
 * "The Bank of RampRidge": the player's sell orders (Peer Cash deposits) as
 * bank items. Each is a coin stack sized to what is left, with the payout
 * platform as a badge; right-click (or tap) offers Withdraw-All, Withdraw-X,
 * Top-up, Advertise and Examine. Deposit opens the Sell interface.
 */
export function BankInterface(_props: InterfaceProps<"bank">) {
  const { sender, login, close } = useGame();
  const size = useInterfaceSize({ width: 488, height: 334 }, 470);
  return (
    <Window title="The Bank of RampRidge" width={size.width} height={size.height} onClose={close} draggable className="bk-window">
      {sender ? <BankBody sender={sender} mobile={size.mobile} width={size.width} /> : <LoggedOut text="You need to log in to use your bank." onLogin={login} />}
    </Window>
  );
}

/** The bank's status line; `failed` adds the help link (a withdrawal or top-up that went through but didn't happen). */
type Status = { tone: "good" | "info" | "bad"; text: string; tx?: string | null; failed?: boolean } | null;
type Confirm = { depositId: string; amount: bigint; from: HTMLElement | null } | null;

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function BankBody({ sender, mobile, width }: { sender: TxSender; mobile: boolean; width: number }) {
  const game = useGame();
  const { message, playSound, open, publicClient, setStall, stallDepositId, me } = game;
  const client = useCashClient();
  const queryClient = useQueryClient();
  const owner = sender.address;
  const balance = useUsdcBalance(owner);
  const orders = useMyCashOrders(owner, { client });
  const prompt = useChatPrompt();
  const txs = useOrderTxs(owner);

  const [tab, setTab] = useState<BankTab>("all");
  const [menu, setMenu] = useState<{ depositId: string; at: { x: number; y: number }; from: HTMLElement | null } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [examine, setExamine] = useState<string | null>(null);
  /** Non-money work (advertising, refreshing); money actions show their own line from the store. */
  const [working, setWorking] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  /** The last money action's error when it provably sent nothing. */
  const [lastError, setLastError] = useState<SellFlowError | null>(null);
  const [waitNote, setWaitNote] = useState<string | null>(null);
  const [inlinePrompt, setInlinePrompt] = useState<ChatPromptRequest | null>(null);
  const promptDispose = useRef<(() => void) | null>(null);
  const busyRef = useRef(false);

  const visible = useMemo(() => filterOrders(orders.orders, tab), [orders.orders, tab]);
  // List rows count any buyer hold as live; only the single-order read (with fills) knows if it expired.
  const needDetails = useMemo(() => visible.filter((r) => !r.payouts || r.pendingAmount > 0n), [visible]);
  const details = useOrderDetails(client, needDetails);
  const now = nowSeconds();

  /** The freshest view of an order: its single-order read when loaded, else the list row. */
  const viewOf = (depositId: string): SellOrderRow | null => {
    const row = orders.orders.find((r) => r.depositId === depositId);
    if (!row) return null;
    return details.get(depositId)?.data ?? row;
  };
  // Prompts and the confirm read the latest data when the player submits, not what was on screen when they opened.
  const latest = useRef({ viewOf, wallet: balance.data ?? null, stallDepositId });
  latest.current = { viewOf, wallet: balance.data ?? null, stallDepositId };

  const liveSend = txs.find(isLiveSend) ?? null;
  const unconfirmed = txs.filter((r) => r.phase !== "settling" && !isLiveSend(r));
  const settling = txs.find((r) => r.phase === "settling") ?? null;
  const busy = working !== null || liveSend !== null;
  const lockOf = (depositId: string) => txs.find((r) => r.depositId === depositId) ?? null;

  const holdOf = (row: SellOrderRow): ItemHold | null => {
    const lock = lockOf(row.depositId);
    if (lock) return isLiveSend(lock) ? null : lock.phase === "settling" ? "updating" : "unconfirmed";
    if (row.pendingAmount > 0n && !details.get(row.depositId)?.data) return "checking";
    return null;
  };

  const ordersData = orders.orders;
  // Re-read the local pending-deposit record whenever the orders refresh.
  const pendingDeposit = useMemo(() => (ordersData ? defaultPendingSellStore().read(owner) : null), [owner, ordersData]);

  const clearStallIfClosed = (record: Pick<OrderTxRecord, "kind" | "depositId">) => {
    if (record.kind === "withdraw-all" && record.depositId === latest.current.stallDepositId) void setStall(null).catch(() => undefined);
  };

  const onTxEvent = (event: OrderTxEvent) => {
    setWaitNote(null);
    switch (event.kind) {
      case "confirmed": {
        const text = orderTxDoneText(event.record, true);
        message(text);
        playSound("coins");
        setStatus({ tone: "good", text, tx: event.record.txHash });
        clearStallIfClosed(event.record);
        return;
      }
      case "failed": {
        const text = orderTxFailedText(event.record);
        message(text);
        setStatus({ tone: "info", text, tx: event.record.txHash, failed: true });
        return;
      }
      case "nothing-left": {
        const text = "This offer has nothing left to withdraw.";
        message(text);
        setStatus({ tone: "info", text });
        return;
      }
      default:
        return;
    }
  };
  const watcher = useOrderTxWatcher({ owner, client, publicClient, records: txs, onEvent: onTxEvent });

  const items = visible.map((row) => {
    const d = details.get(row.depositId);
    return orderItem(row, { details: d?.data ?? null, detailsLoading: Boolean(d?.isLoading), advertised: row.depositId === stallDepositId, nowSeconds: now });
  });

  const payoutsOf = (row: SellOrderRow) => row.payouts ?? details.get(row.depositId)?.data?.payouts ?? null;

  /** Closes any open amount prompt and the Withdraw-All confirm. */
  const closeInputs = () => {
    promptDispose.current?.();
    promptDispose.current = null;
    setInlinePrompt(null);
    setConfirm(null);
  };

  const runMoney = async (request: OrderTxRequest) => {
    closeInputs();
    if (busyRef.current) {
      message("Please wait for your last action to finish.");
      return;
    }
    setStatus(null);
    setLastError(null);
    setWaitNote(null);
    const result = await sendOrderTx({ client, sender, publicClient, queryClient }, request);
    switch (result.status) {
      case "sent": {
        const text = orderTxDoneText(result.record, false);
        message(text);
        playSound("coins");
        setStatus({ tone: "good", text, tx: result.txHash });
        clearStallIfClosed(result.record);
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
        setStatus({ tone: "info", text });
        return;
      }
      case "failed":
        message(result.error.message);
        playSound("error");
        // An unknown outcome is shown from the store (and survives closing the bank).
        if (!result.unknown) setLastError(result.error);
        return;
    }
  };

  const begin = (label: string): boolean => {
    if (busyRef.current || liveSend) return false;
    busyRef.current = true;
    setStatus(null);
    setWorking(label);
    return true;
  };
  const end = () => {
    busyRef.current = false;
    setWorking(null);
  };

  const advertise = async (depositId: string | null) => {
    if (!begin(depositId ? "Advertising your offer" : "Taking down your stall")) return;
    try {
      await setStall(depositId);
      const text = depositId ? "Players in the bank can now see your offer." : "You stop advertising your offer.";
      message(text);
      setStatus({ tone: "info", text });
    } catch (e) {
      const text = errorText(e, "Your offer couldn't be advertised. Try again.");
      message(text);
      playSound("error");
      setStatus({ tone: "bad", text });
    } finally {
      end();
    }
  };

  const ask = (request: ChatPromptRequest) => {
    closeInputs();
    const wrapped: ChatPromptRequest = {
      ...request,
      onSubmit: (raw, value) => {
        promptDispose.current = null;
        request.onSubmit(raw, value);
      },
      onCancel: () => {
        promptDispose.current = null;
        request.onCancel?.();
      },
    };
    if (prompt) promptDispose.current = prompt.open(wrapped);
    else setInlinePrompt(wrapped);
  };

  const onOption = (row: SellOrderRow, option: ItemMenuOption, hold: ItemHold | null) => {
    setMenu(null);
    playSound("click");
    const { depositId } = row;
    switch (option.action) {
      case "hold":
        message(holdMessage(hold ?? "checking"));
        return;
      case "withdraw-all":
        closeInputs();
        setConfirm({ depositId, amount: remainingAmount(row), from: menu?.from ?? null });
        return;
      case "withdraw-x":
        ask({
          title: "Enter amount to withdraw:",
          kind: "amount",
          decimals: 2,
          hint: `Up to ${usdcText(row.availableAmount)} USDC is unlocked.`,
          onSubmit: (_raw, value) => {
            const units = value === null ? null : usdcUnitsFromNumber(value);
            if (!units) return;
            const available = latest.current.viewOf(depositId)?.availableAmount ?? row.availableAmount;
            if (units > available) {
              message(`You can only withdraw ${usdcText(available)} USDC from this offer right now.`);
              return;
            }
            void runMoney({ kind: "withdraw", depositId, amount: units });
          },
        });
        return;
      case "top-up": {
        const wallet = latest.current.wallet;
        ask({
          title: "Enter amount to add:",
          kind: "amount",
          decimals: 2,
          hint: wallet !== null ? `You have ${usdcText(wallet)} USDC in your wallet.` : undefined,
          onSubmit: (_raw, value) => {
            const units = value === null ? null : usdcUnitsFromNumber(value);
            if (!units) return;
            const have = latest.current.wallet;
            if (have !== null && units > have) {
              message(`You only have ${usdcText(have)} USDC.`);
              return;
            }
            void runMoney({ kind: "top-up", depositId, amount: units });
          },
        });
        return;
      }
      case "advertise":
        if (!me) {
          message("You need to be in the bank to advertise.");
          return;
        }
        void advertise(depositId);
        return;
      case "stop-advertising":
        void advertise(null);
        return;
      case "examine":
        setExamine(depositId);
        message(examineSentence(row, buyerHold(row, nowSeconds())) || examineLines({ row, payouts: payoutsOf(row) })[0] || "");
        return;
    }
  };

  const openMenu = (index: number, at: { x: number; y: number }) => {
    const row = visible[index];
    if (!row) return;
    setExamine(null);
    const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMenu({ depositId: row.depositId, at, from });
  };
  /** Cancel, Esc or clicking away: focus goes back to the item, like closing any menu. */
  const dismissMenu = () => {
    const from = menu?.from;
    setMenu(null);
    if (from?.isConnected) from.focus({ preventScroll: true });
  };

  const onActivate = (index: number, _item: unknown, e: MouseEvent | KeyboardEvent) => {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const mouse = "clientX" in e && (e.clientX !== 0 || e.clientY !== 0);
    openMenu(index, mouse ? { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY } : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  /** Re-reads the orders and asks the chain about anything unconfirmed. Never releases a lock without evidence. */
  const refresh = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setWorking("Checking with the network");
    setWaitNote(null);
    try {
      await queryClient.refetchQueries({ queryKey: sellQueryKeys.orders(owner) });
      await queryClient.invalidateQueries({ queryKey: sellQueryKeys.all });
      await watcher.check();
      const key = owner.toLowerCase();
      const still = orderTxStore()
        .records()
        .some((r) => r.owner === key && r.phase !== "settling" && !isLiveSend(r));
      if (still) setWaitNote("Still waiting for the network.");
    } finally {
      busyRef.current = false;
      setWorking(null);
    }
  };

  const release = (record: OrderTxRecord) => {
    if (releaseOrderTx(orderTxStore(), record)) {
      setWaitNote(null);
      message("You can withdraw from or top up this offer again.");
    }
  };

  const stallRow = stallDepositId ? orders.orders.find((r) => r.depositId === stallDepositId) : undefined;
  const columns = mobile ? Math.max(4, Math.floor((width - 44 + 14) / 50)) : 8;

  let body;
  if (orders.isLoading) {
    body = (
      <CenterNote>
        <PleaseWait text="Loading your bank" className="rs-p12 rs-c-yellow rs-shadow" />
      </CenterNote>
    );
  } else if (orders.error && orders.orders.length === 0) {
    body = (
      <CenterNote>
        <p className="bk-alert rs-p12 rs-c-red rs-shadow" role="alert">
          Your sell offers couldn't be loaded. {orders.error.message}
        </p>
        <StoneButton onClick={orders.refetch}>Try again</StoneButton>
      </CenterNote>
    );
  } else if (visible.length === 0) {
    body = (
      <CenterNote>
        <p className="rs-p12 rs-c-orange rs-shadow">{emptyBankText(tab)}</p>
        {tab === "all" && <StoneButton onClick={() => open({ id: "sell" })}>Deposit</StoneButton>}
      </CenterNote>
    );
  } else {
    body = (
      <ScrollArea className="bk-bank__scroll" label="Your sell offers">
        <ItemGrid
          items={items}
          columns={columns}
          gapX={mobile ? 14 : 12}
          gapY={mobile ? 10 : 4}
          ariaLabel="Sell offers"
          onActivate={onActivate}
          onMenu={(index, _item, at) => openMenu(index, at)}
        />
      </ScrollArea>
    );
  }

  const balanceText = balance.data !== undefined ? `${usdcText(balance.data)} USDC` : balance.isError ? "unavailable" : "...";
  const examineRow = examine ? viewOf(examine) : null;
  const menuRow = menu ? viewOf(menu.depositId) : null;
  const menuHold = menuRow ? holdOf(menuRow) : null;
  const firstUnconfirmed = unconfirmed[0] ?? null;

  return (
    <div className={cx("bk-bank", mobile && "bk-bank--mobile")}>
      <div className="bk-bank__top">
        <Tabs label="Bank tabs" value={tab} onChange={setTab} tabs={BANK_TABS} idPrefix="bk-bank" />
      </div>
      <div className="bk-bank__grid" role="tabpanel" id={`bk-bank-panel-${tab}`} aria-labelledby={`bk-bank-tab-${tab}`}>
        {body}
        {examineRow && (
          <ExaminePanel
            row={examineRow}
            payouts={payoutsOf(examineRow)}
            advertised={examineRow.depositId === stallDepositId}
            onClose={() => setExamine(null)}
          />
        )}
      </div>
      <div className="bk-bank__status" aria-live="polite">
        {confirm ? (
          <ConfirmWithdraw
            text={`Close this offer and return ${usdcText(confirm.amount)} USDC to your wallet?`}
            onYes={() => {
              const c = confirm;
              setConfirm(null);
              void runMoney({ kind: "withdraw-all", depositId: c.depositId, expectRemaining: c.amount });
            }}
            onNo={() => {
              const from = confirm.from;
              setConfirm(null);
              if (from?.isConnected) from.focus({ preventScroll: true });
            }}
          />
        ) : working ? (
          <p className="rs-p12 rs-c-yellow rs-shadow">
            <PleaseWait text={working} />
          </p>
        ) : liveSend ? (
          <p className="rs-p12 rs-c-yellow rs-shadow">
            <PleaseWait text={orderTxWorkingText(liveSend)} />
          </p>
        ) : lastError ? (
          <ErrorNote error={lastError}>
            <span className="bk-row">
              {lastError.transactionHash && <TextLink href={txUrl(lastError.transactionHash)}>View on Basescan</TextLink>}
              <TextButton onClick={() => setLastError(null)}>OK</TextButton>
              <HelpLink />
            </span>
          </ErrorNote>
        ) : firstUnconfirmed ? (
          <OrderTxNote record={firstUnconfirmed} note={waitNote} onRefresh={() => void refresh()} onRelease={() => release(firstUnconfirmed)} />
        ) : status ? (
          <p className={cx("rs-p12 rs-shadow", status.tone === "good" ? "rs-c-green" : status.tone === "bad" ? "bk-alert rs-c-red" : "rs-c-white")}>
            {status.text} {status.tx && <TextLink href={txUrl(status.tx)}>Basescan</TextLink>} {status.failed && <HelpLink />}
          </p>
        ) : settling ? (
          <p className="rs-p12 rs-c-yellow rs-shadow">
            <PleaseWait text="Updating your bank" />
          </p>
        ) : pendingDeposit ? (
          <p className="rs-p12 rs-c-yellow rs-shadow">
            Your last deposit hasn't been confirmed yet. <TextButton onClick={() => open({ id: "sell" })}>Check status</TextButton>
          </p>
        ) : stallRow ? (
          <p className="rs-p12 rs-c-white rs-shadow">
            <span className="rs-c-orange">Advertising:</span> {usdcText(stallRow.availableAmount)} USDC{payoutTitle(payoutGroups(payoutsOf(stallRow))) ? ` on ${payoutTitle(payoutGroups(payoutsOf(stallRow)))}` : ""}.
          </p>
        ) : null}
        {inlinePrompt && (
          <div className="bk-inlinePrompt rs-chatarea">
            <ChatboxPrompt request={inlinePrompt} onDone={() => setInlinePrompt(null)} />
          </div>
        )}
      </div>
      <div className="bk-bank__foot">
        <StoneButton onClick={() => open({ id: "sell" })} disabled={busy}>
          Deposit
        </StoneButton>
        <StoneButton onClick={() => open({ id: "collection" })}>Collect</StoneButton>
        <span className="bk-bank__wallet rs-p12 rs-c-orange rs-shadow" aria-label={`Wallet balance: ${balanceText}`}>
          Wallet: <span className={balance.isError && balance.data === undefined ? "rs-c-yellow" : "rs-c-white"}>{balanceText}</span>
        </span>
      </div>
      {menu && menuRow && (
        <ItemMenu
          at={menu.at}
          options={itemMenuOptions({ ...menuRow, payouts: payoutsOf(menuRow) }, { advertised: menuRow.depositId === stallDepositId, busy, hold: menuHold })}
          onSelect={(option) => onOption(menuRow, option, menuHold)}
          onClose={dismissMenu}
        />
      )}
    </div>
  );
}

/**
 * The yellow examine box drawn over the bank grid (keyboard and touch players
 * get it here), plus the record of a buyer who is paying for part of it.
 */
function ExaminePanel({
  row,
  payouts,
  advertised,
  onClose,
}: {
  row: SellOrderRow;
  payouts: SellOrderRow["payouts"];
  advertised: boolean;
  onClose: () => void;
}) {
  useEscapeLayer(onClose);
  const client = useCashClient();
  const rows = useMemo(() => [row], [row]);
  const full = useOrderDetails(client, rows).get(row.depositId)?.data ?? null;
  const view = full ?? row;
  const now = nowSeconds();
  const hold = buyerHold(view, now);
  const lines = examineLines({ row: view, payouts: payouts ?? full?.payouts ?? null, advertised, hold });
  // Only a buyer inside their time limit is "paying now"; list rows carry no fills, so wait for the full read.
  const buyer = hold === "live" ? liveBuyer(view.fills, now) : null;
  const profile = useBuyerProfile(buyer, { client });
  const shown = buyer ? [...lines, buyerLine(buyer, profile.data ?? null, profile.isPending && !profile.isError)] : lines;
  return (
    <div className="bk-examine">
      <TooltipBox className="bk-examine__box">
        {shown.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </TooltipBox>
      <TextButton tone="white" onClick={onClose} autoFocus>
        Close
      </TextButton>
    </div>
  );
}

/** Keyboard presses on the destructive button are ignored for this long after the confirm appears. */
const CONFIRM_ARM_MS = 400;

/**
 * "Close this offer and return X USDC?" Focus starts on Cancel, and the
 * Withdraw button ignores held-down or immediate keyboard presses, so a slip
 * of Enter on the bank can never close an offer.
 */
function ConfirmWithdraw({ text, onYes, onNo }: { text: string; onYes: () => void; onNo: () => void }) {
  useEscapeLayer(onNo);
  const shownAt = useRef(performance.now());
  const early = () => performance.now() - shownAt.current < CONFIRM_ARM_MS;
  return (
    <div className="bk-confirm" role="alertdialog" aria-label="Confirm withdrawal">
      <p className="rs-p12 rs-c-white rs-shadow">{text}</p>
      <span className="bk-row">
        <StoneButton
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && (e.repeat || early())) e.preventDefault();
          }}
          onClick={(e) => {
            // detail 0: activated from the keyboard rather than a pointer.
            if (e.detail === 0 && early()) return;
            onYes();
          }}
        >
          Withdraw
        </StoneButton>
        <StoneButton onClick={onNo} autoFocus>
          Cancel
        </StoneButton>
      </span>
    </div>
  );
}
