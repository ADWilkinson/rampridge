import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { Address } from "viem";
import { track } from "@/lib/telemetry";
import { PleaseWait, ScrollArea, StoneButton, Window, cx } from "@/ui/kit";
import { useUsdcBalance, walletQueryKeys } from "@/wallet/balances";
import { CallRevertedError, toWalletError } from "@/wallet/errors";
import { shortAddress } from "@/wallet/format";
import { CONTRACT_NOTE, checkRecipient, codeKind, groupAddress } from "@/wallet/recipient";
import {
  canReleasePending,
  checkPendingSend,
  isSendInFlight,
  formatSendAmount,
  sendUsdc,
  sentMessage,
  usdcTransferCall,
  type PendingCheck,
  type PendingSend,
  type PendingSendStore,
  type SendChain,
} from "@/wallet/send";
import type { TxSender } from "@/wallet/types";
import { useGame, type InterfaceProps } from "../context";
import { useKeyboardFirst, useSendDeps, useSendSize, type SendLayout } from "./deps";
import {
  AMOUNT_STEPS,
  RELEASE_LABEL,
  REVIEW_ARM_MS,
  addToAmount,
  allAmount,
  checkAmount,
  feeLine,
  feeView,
  inFlightText,
  initialSendState,
  releaseHint,
  sendFailure,
  sendReducer,
  shortOfGasText,
  txUrl,
  unconfirmedText,
  usdcHistoryUrl,
  type SendAction,
  type SendFailure,
  type SendState,
  type SentView,
} from "./model";

/**
 * Send USDC: from the player's wallet to any address on Base. The form takes
 * an amount (All, +10, +100) and a 0x address checked as it is typed; Continue
 * opens a review of exactly what will be sent with the network fee, and only
 * its Confirm (off for a moment, so a double click can't reach it) sends.
 * A send whose outcome is unknown is settled from the chain before another
 * one can start, even after a reload.
 */
export function SendInterface(_props: InterfaceProps<"send">) {
  const { sender, login, close } = useGame();
  const size = useSendSize({ width: 480, height: 336 }, 430, { width: 560, height: 312 });
  const keyboard = useKeyboardFirst(size.layout);
  // With a keyboard, Send opens in the amount field, so typing goes there and not to the chatbox.
  const amountField = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState(false);
  // Moving from one field to the next blurs then focuses: settle before moving the window back down.
  const blurTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(blurTimer.current), []);
  const onTyping = useCallback((next: boolean) => {
    window.clearTimeout(blurTimer.current);
    if (next) setTyping(true);
    else blurTimer.current = window.setTimeout(() => setTyping(false), 150);
  }, []);
  return (
    <Window
      title="Send USDC"
      width={size.width}
      height={size.height}
      onClose={close}
      draggable
      initialFocus={keyboard ? amountField : undefined}
      className={cx("sd-window", `sd--${size.layout}`, typing && "sd-window--typing")}
    >
      {sender ? (
        <SendBody key={sender.address} sender={sender} layout={size.layout} keyboard={keyboard} amountField={amountField} onTyping={onTyping} />
      ) : (
        <LoggedOut onLogin={login} />
      )}
    </Window>
  );
}

/** "Log in to trade." with the login button, as every trading interface shows without a wallet. */
export function LoggedOut({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="sd-center">
      <p className="rs-p12 rs-c-orange rs-shadow">Log in to trade.</p>
      <StoneButton autoFocus onClick={onLogin} className="sd-btn">
        Log in
      </StoneButton>
    </div>
  );
}

/** A link styled like an interface option; opens in a new tab. */
export function SendLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a className="sd-link rs-p12" href={href} target="_blank" rel="noopener noreferrer">
      <span className="sd-link__text">{children}</span>
    </a>
  );
}

/** Focuses `ref` once, right after the component mounts, when `enabled` was true then. */
function useFocusOnMount(ref: RefObject<HTMLElement | null>, enabled: boolean): void {
  const due = useRef(enabled);
  useEffect(() => {
    if (!due.current) return;
    due.current = false;
    ref.current?.focus({ preventScroll: true });
  }, [ref]);
}

/**
 * The address in 4-character groups inside an input-like well, so it can be
 * checked group by group. One tap or click selects all of it, and copying
 * gives the plain address, not the groups.
 */
export function GroupedAddress({ address, label }: { address: string; label: string }) {
  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    e.clipboardData.setData("text/plain", address);
    e.preventDefault();
  };
  return (
    <div role="group" className="sd-address rs-p12 rs-c-white rs-shadow" aria-label={`${label}: ${address}`} onCopy={onCopy}>
      {groupAddress(address).map((group, i) => (
        <span key={i} className="sd-address__group" aria-hidden="true">
          {group}
        </span>
      ))}
    </div>
  );
}

type SendOutcome = { kind: "sent"; sent: SentView } | { kind: "failed"; failure: SendFailure; record: PendingSend | null };

/**
 * How a send that outlived its window ended, for a Send window opened on it
 * meanwhile (that one shows it as unconfirmed while the wallet works).
 */
const outcomeListeners = new Set<(address: string, outcome: SendOutcome) => void>();

function announceOutcome(address: string, outcome: SendOutcome): void {
  for (const listener of outcomeListeners) listener(address.toLowerCase(), outcome);
}

function useMounted(): { readonly current: boolean } {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

interface SendBodyProps {
  sender: TxSender;
  layout: SendLayout;
  /** Desktop with a mouse: fields take focus on their own (see useKeyboardFirst). */
  keyboard: boolean;
  amountField: RefObject<HTMLInputElement | null>;
  onTyping: (typing: boolean) => void;
}

function SendBody({ sender, layout, keyboard, amountField, onTyping }: SendBodyProps) {
  const game = useGame();
  const { chain, pending, initial } = useSendDeps();
  const queryClient = useQueryClient();
  const balanceQuery = useUsdcBalance(sender.address);
  const balance = balanceQuery.data ?? null;
  // An unconfirmed earlier send comes first: nothing else can be sent until it is settled.
  const [state, dispatch] = useReducer(sendReducer, undefined, () => {
    const earlier = pending.read(sender.address);
    return earlier ? initialSendState({}, earlier) : (initial ?? initialSendState());
  });
  const mounted = useMounted();
  const busy = useRef(false);
  const { message, playSound } = game;

  const refreshBalances = useCallback(() => void queryClient.invalidateQueries({ queryKey: walletQueryKeys.all }), [queryClient]);

  // The coins land with the player whether or not this window is still open.
  const finish = useCallback(
    (sent: SentView) => {
      message(sentMessage(sent.amount, sent.to));
      playSound("coins");
      refreshBalances();
      if (mounted.current) dispatch({ type: "sent", sent });
    },
    [message, playSound, refreshBalances, mounted],
  );

  const confirm = async (amount: bigint, to: Address) => {
    if (busy.current) return;
    busy.current = true;
    dispatch({ type: "sending" });
    try {
      const result = await sendUsdc({ sender, to, amount, chain, pending });
      const sent = { hash: result.hash, amount: result.amount, to: result.to };
      track("send_ok");
      finish(sent);
      announceOutcome(sender.address, { kind: "sent", sent });
    } catch (error) {
      const failure = sendFailure(error);
      if (failure.kind === "unconfirmed") track("send_unconfirmed");
      else if (failure.kind === "error") track("send_fail");
      const record = failure.kind === "unconfirmed" ? pending.read(sender.address) : null;
      refreshBalances();
      if (failure.kind === "error") playSound("error");
      if (mounted.current) dispatch({ type: "failed", failure, record });
      else announceInBackground(failure, message);
      announceOutcome(sender.address, { kind: "failed", failure, record });
    } finally {
      busy.current = false;
    }
  };

  // This window opened on a send still running from an earlier window: take its outcome when it ends.
  const screenStep = state.screen.step;
  useEffect(() => {
    if (screenStep !== "unconfirmed") return;
    const own = sender.address.toLowerCase();
    const listener = (address: string, outcome: SendOutcome) => {
      if (address !== own) return;
      if (outcome.kind === "sent") dispatch({ type: "sent", sent: outcome.sent });
      else if (outcome.failure.kind === "unconfirmed" && outcome.record) dispatch({ type: "unconfirmed", record: outcome.record });
      else dispatch({ type: "released", failure: outcome.failure.kind === "error" ? outcome.failure : undefined });
    };
    outcomeListeners.add(listener);
    return () => {
      outcomeListeners.delete(listener);
    };
  }, [screenStep, sender.address]);

  // The window focuses the screen it opens on; each later screen focuses its own first control,
  // so focus never drops out of the window (and keys never fall through to the chatbox).
  const opened = useRef(state.screen);
  const focus = state.screen !== opened.current;
  const walletApp = sender.kind === "external";

  const { screen } = state;
  switch (screen.step) {
    case "form":
      return (
        <SendForm
          state={state}
          dispatch={dispatch}
          sender={sender}
          balance={balance}
          balanceError={balanceQuery.isError}
          onRetryBalance={() => void balanceQuery.refetch()}
          chain={chain}
          layout={layout}
          keyboard={keyboard}
          amountRef={amountField}
          focusOnMount={focus}
          onTyping={onTyping}
        />
      );
    case "review":
      return (
        <SendReview
          amount={screen.amount}
          to={screen.to}
          sender={sender}
          chain={chain}
          layout={layout}
          onBack={() => dispatch({ type: "back" })}
          onConfirm={() => void confirm(screen.amount, screen.to)}
        />
      );
    case "sending":
      return <SendingView amount={screen.amount} to={screen.to} sponsored={sender.sponsored} focusOnMount={focus} />;
    case "success":
      return <SuccessView sent={screen.sent} onDone={game.close} />;
    case "error":
      return <ErrorView failure={screen.failure} from={sender.address} onBack={() => dispatch({ type: "back" })} onClose={game.close} />;
    case "unconfirmed":
      return (
        <UnconfirmedView
          record={screen.record}
          chain={chain}
          pending={pending}
          walletApp={walletApp}
          userOperationStatus={sender.userOperationStatus}
          focusOnMount={focus}
          dispatch={dispatch}
          onLanded={finish}
          onRefresh={refreshBalances}
        />
      );
  }
}

/** A send that ended after its window closed still tells the player, in the chatbox. */
function announceInBackground(failure: SendFailure, say: (text: string) => void): void {
  if (failure.kind === "unconfirmed") say("Your send hasn't been confirmed yet. Open Send again to check on it before sending more.");
  else if (failure.kind === "error") say(`Your send didn't go through. ${failure.message}`);
}

// ---------------------------------------------------------------------------
// The form

interface SendFormProps {
  state: SendState;
  dispatch: Dispatch<SendAction>;
  sender: TxSender;
  balance: bigint | null;
  balanceError: boolean;
  onRetryBalance: () => void;
  chain: SendChain;
  layout: SendLayout;
  keyboard: boolean;
  /** The amount field: the window's initial focus with a keyboard. */
  amountRef: RefObject<HTMLInputElement | null>;
  /** Back from the review or an error: focus the amount field (keyboard) or Continue (touch). */
  focusOnMount: boolean;
  onTyping: (typing: boolean) => void;
}

function canReadClipboard(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";
}

/** eth_getCode for a valid recipient, shared by the form and the review. */
function useRecipientCode(chain: SendChain, address: Address | null) {
  return useQuery({
    queryKey: ["send", "code", address?.toLowerCase() ?? null],
    queryFn: address ? () => chain.code(address).then((code) => code ?? "0x") : skipToken,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

function SendForm({ state, dispatch, sender, balance, balanceError, onRetryBalance, chain, layout, keyboard, amountRef, focusOnMount, onTyping }: SendFormProps) {
  const id = useId();
  const toRef = useRef<HTMLInputElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  useFocusOnMount(keyboard ? amountRef : continueRef, focusOnMount);
  const [toBlurred, setToBlurred] = useState(state.toText !== "");
  const [submitted, setSubmitted] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const amount = checkAmount(state.amountText, balance);
  const recipient = checkRecipient(state.toText, { self: sender.address });
  const okAddress = recipient.status === "ok" ? recipient.address : null;
  const code = useRecipientCode(chain, okAddress);
  const contract = code.data !== undefined && codeKind(code.data) === "contract";

  // Errors show once they are certain: a bad character at once, a short address only once the player moves on.
  const showRecipientError =
    recipient.status === "invalid" && (submitted || toBlurred || state.toText.replace(/\s+/g, "").length >= 42 || !/^0x[0-9a-f]*$/i.test(state.toText.replace(/\s+/g, "") || "0x"));
  const amountMessage = amount.status === "invalid" ? amount.message : submitted && amount.status === "empty" ? "Enter an amount to send." : null;
  const recipientMessage = showRecipientError && recipient.status === "invalid" ? recipient.message : submitted && recipient.status === "empty" ? "Enter the address to send to." : null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (amount.status !== "ok") {
      amountRef.current?.focus();
      return;
    }
    if (!okAddress) {
      toRef.current?.focus();
      return;
    }
    onTyping(false);
    dispatch({ type: "review", amount: amount.units, to: okAddress });
  };

  const paste = async () => {
    setPasteError(null);
    try {
      const text = await navigator.clipboard.readText();
      dispatch({ type: "to", text: text.trim() });
      setToBlurred(true);
      if (keyboard) toRef.current?.focus();
    } catch {
      setPasteError("Couldn't read your clipboard. Paste into the box instead.");
    }
  };

  // With a keyboard, a quick amount leaves the caret in the amount field, so the next keys land there.
  const setAmount = (text: string) => {
    dispatch({ type: "amount", text });
    if (keyboard) amountRef.current?.focus();
  };

  // Enter (or a phone's Next) in the amount field moves on to the address while it is empty, without
  // submitting the form and marking the untouched address as missing.
  const onAmountKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || state.toText.trim() !== "") return;
    e.preventDefault();
    toRef.current?.focus();
  };

  const typingHandlers = { onFocus: () => onTyping(true), onBlur: () => onTyping(false) };
  // On a phone Paste sits on the label's line, so the field is wide enough for a whole address.
  const pasteButton = canReadClipboard() ? (
    <StoneButton className="sd-btn sd-paste" onClick={() => void paste()} aria-label="Paste the address">
      Paste
    </StoneButton>
  ) : null;

  return (
    <form className={cx("sd-body", `sd-body--${layout}`)} onSubmit={onSubmit} noValidate>
      <ScrollArea className="sd-scroll" label="Send details">
        <div className="sd-form">
          <section className="sd-field sd-field--amount">
            <label htmlFor={`${id}-amount`} className="rs-p12 rs-c-orange rs-shadow">
              Amount (USDC):
            </label>
            <div className="sd-amountrow">
            <input
              ref={amountRef}
              id={`${id}-amount`}
              className={cx("sd-input rs-p12", amountMessage && "is-bad")}
              value={state.amountText}
              onChange={(e) => dispatch({ type: "amount", text: e.target.value })}
              inputMode="decimal"
              enterKeyHint="next"
              autoComplete="off"
              placeholder="0.00"
              maxLength={24}
              aria-invalid={amountMessage ? true : undefined}
              aria-describedby={`${id}-amount-note`}
              data-send-amount=""
              onKeyDown={onAmountKey}
              {...typingHandlers}
            />
            <div className="sd-quick" role="group" aria-label="Quick amounts">
              <StoneButton
                className="sd-btn"
                onClick={() => balance !== null && setAmount(allAmount(balance))}
                disabled={!balance}
                aria-label="Fill in all your USDC"
              >
                All
              </StoneButton>
              {AMOUNT_STEPS.map((step) => (
                <StoneButton key={step} className="sd-btn" onClick={() => setAmount(addToAmount(state.amountText, step))} aria-label={`Add ${step} USDC`}>
                  +{step}
                </StoneButton>
              ))}
            </div>
            </div>
            <p id={`${id}-amount-note`} className="sd-note rs-p12 rs-shadow" aria-live="polite">
              {amountMessage ? (
                <span className="sd-alert sd-alert--note rs-c-red">{amountMessage}</span>
              ) : balance !== null ? (
                <span className="rs-c-orange">
                  You have <span className="rs-c-white">{formatSendAmount(balance)} USDC</span>
                </span>
              ) : balanceError ? (
                <span className="sd-inline">
                  <span className="sd-alert sd-alert--inline rs-c-red">Couldn't read your balance.</span>
                  <button type="button" className="sd-textbtn rs-p12" onClick={onRetryBalance}>
                    Try again
                  </button>
                </span>
              ) : (
                <span className="rs-c-yellow">Checking your balance...</span>
              )}
            </p>
          </section>
          <section className="sd-field sd-field--to">
            <div className="sd-labelrow">
              <label htmlFor={`${id}-to`} className="rs-p12 rs-c-orange rs-shadow">
                To (address on Base):
              </label>
              {layout === "phone" && pasteButton}
            </div>
            <div className="sd-row">
              <input
                ref={toRef}
                id={`${id}-to`}
                className={cx("sd-input sd-input--address rs-p12", recipientMessage && "is-bad", okAddress && "is-good")}
                value={state.toText}
                onChange={(e) => {
                  setPasteError(null);
                  dispatch({ type: "to", text: e.target.value });
                }}
                onFocus={() => onTyping(true)}
                onBlur={() => {
                  onTyping(false);
                  setToBlurred(state.toText.trim() !== "");
                  // Shown checksummed once it is valid: the same address, its letters in their checked case.
                  if (okAddress && okAddress !== state.toText) dispatch({ type: "to", text: okAddress });
                }}
                enterKeyHint="go"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="0x..."
                maxLength={80}
                aria-invalid={recipientMessage ? true : undefined}
                aria-describedby={`${id}-to-note`}
                data-send-to=""
              />
              {layout !== "phone" && pasteButton}
            </div>
            <p id={`${id}-to-note`} className="sd-note rs-p12 rs-shadow" aria-live="polite">
              {recipientMessage ? (
                <span className="sd-alert sd-alert--note rs-c-red">{recipientMessage}</span>
              ) : pasteError ? (
                <span className="sd-alert sd-alert--note rs-c-red">{pasteError}</span>
              ) : contract ? (
                <span className="rs-c-yellow">{CONTRACT_NOTE}</span>
              ) : okAddress ? (
                <span className="rs-c-green">Valid Base address.</span>
              ) : (
                <span className="rs-c-grey">Names like .eth aren't supported.</span>
              )}
            </p>
          </section>
        </div>
      </ScrollArea>
      <div className="sd-foot">
        <StoneButton ref={continueRef} submit size="big" className="sd-btn sd-continue" disabled={balance === null} data-send-continue="">
          Continue
        </StoneButton>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// The review

interface SendReviewProps {
  amount: bigint;
  to: Address;
  sender: TxSender;
  chain: SendChain;
  layout: SendLayout;
  onBack: () => void;
  onConfirm: () => void;
}

interface FeeRead {
  fee: bigint | null;
  eth: bigint | null;
}

/**
 * "Are you sure you want to send this?": the amount, the whole address in
 * groups, the network and its fee. Confirm is off for REVIEW_ARM_MS, and
 * stays off while the send would fail or the wallet can't pay its fee.
 */
function SendReview({ amount, to, sender, chain, layout, onBack, onConfirm }: SendReviewProps) {
  const headingId = useId();
  const heading = useRef<HTMLParagraphElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    heading.current?.focus();
    const timer = window.setTimeout(() => setArmed(true), REVIEW_ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const call = usdcTransferCall(to, amount);
  const from = sender.address;
  const simulation = useQuery({
    queryKey: ["send", "simulate", from.toLowerCase(), to.toLowerCase(), amount.toString()],
    queryFn: () => chain.simulate(from, call).then(() => true),
    retry: 0,
    staleTime: 30_000,
  });
  const fees = useQuery({
    queryKey: ["send", "fee", from.toLowerCase(), to.toLowerCase(), amount.toString()],
    queryFn: sender.sponsored
      ? skipToken
      : async (): Promise<FeeRead> => {
          const [eth, fee] = await Promise.allSettled([chain.ethBalance(from), chain.estimateFee(from, call)]);
          return { eth: eth.status === "fulfilled" ? eth.value : null, fee: fee.status === "fulfilled" ? fee.value : null };
        },
    retry: 0,
    staleTime: 30_000,
  });
  const code = useRecipientCode(chain, to);
  const contract = code.data !== undefined && codeKind(code.data) === "contract";

  const fee = feeView({ sponsored: sender.sponsored, fee: fees.data?.fee ?? null, eth: fees.data?.eth ?? null, loading: !sender.sponsored && fees.isPending });
  const line = feeLine(fee);
  // Only a revert blocks: a read that failed for any other reason leaves the wallet to decide.
  const wouldFail = simulation.error ? toWalletError(simulation.error) : null;
  const failText = wouldFail instanceof CallRevertedError ? `This send would fail on Base${wouldFail.reason ? ` (${wouldFail.reason})` : ""}. Check the address and the amount.` : null;
  // Confirm is a plain button: Enter or Space confirms only while it has focus.
  const blocked = fee.kind === "short" || fee.kind === "checking" || failText !== null;

  return (
    <section className={cx("sd-body", `sd-body--${layout}`)} aria-labelledby={headingId}>
      <ScrollArea className="sd-scroll" label="Your send">
        <div className="sd-review">
          <p id={headingId} ref={heading} tabIndex={-1} className="sd-review__ask rs-p12 rs-c-white rs-shadow">
            Are you sure you want to send this?
          </p>
          <dl className="sd-facts">
            <div className="sd-fact">
              <dt className="rs-p12 rs-c-orange rs-shadow">Amount:</dt>
              <dd className="rs-b12 rs-c-white rs-shadow" data-send-review-amount="">
                {formatSendAmount(amount)} USDC
              </dd>
            </div>
            <div className="sd-fact sd-fact--address">
              <dt className="rs-p12 rs-c-orange rs-shadow">To:</dt>
              <dd>
                <GroupedAddress address={to} label="Recipient" />
              </dd>
            </div>
            <div className="sd-fact">
              <dt className="rs-p12 rs-c-orange rs-shadow">Network:</dt>
              <dd className="rs-p12 rs-c-white rs-shadow">Base</dd>
            </div>
            <div className="sd-fact">
              <dt className="rs-p12 rs-c-orange rs-shadow">Network fee:</dt>
              <dd className={cx("rs-p12 rs-shadow", `rs-c-${line.tone}`)}>
                {fee.kind === "checking" ? <PleaseWait text="Checking" className="rs-c-yellow" /> : line.text}
              </dd>
            </div>
          </dl>
          {contract && <p className="rs-p12 rs-c-yellow rs-shadow">{CONTRACT_NOTE}</p>}
          {fee.kind === "short" && (
            <p className="sd-alert rs-p12 rs-c-red rs-shadow" role="alert">
              {shortOfGasText(fee)}
            </p>
          )}
          {failText && (
            <p className="sd-alert rs-p12 rs-c-red rs-shadow" role="alert">
              {failText}
            </p>
          )}
          <p className="sd-review__warn rs-b12 rs-c-red rs-shadow">Sends can't be undone. Only send to an address that accepts USDC on Base.</p>
        </div>
      </ScrollArea>
      <div className="sd-foot sd-foot--review">
        <StoneButton className="sd-btn" onClick={onConfirm} disabled={!armed || blocked} data-send-confirm="">
          Confirm
        </StoneButton>
        <StoneButton className="sd-btn" onClick={onBack} data-send-back="">
          Back
        </StoneButton>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sending, sent, failed and unconfirmed

function SendingView({ amount, to, sponsored, focusOnMount }: { amount: bigint; to: Address; sponsored: boolean; focusOnMount: boolean }) {
  // Nothing to press while it sends: the headline holds focus so Tab stays in the window.
  const headline = useRef<HTMLParagraphElement>(null);
  useFocusOnMount(headline, focusOnMount);
  return (
    <div className="sd-center" data-send-state="sending">
      <p ref={headline} tabIndex={-1} className="sd-focus-text rs-b12 rs-c-orange rs-shadow">
        Sending {formatSendAmount(amount)} USDC to {shortAddress(to)}
      </p>
      <PleaseWait className="rs-p12 rs-c-yellow rs-shadow" />
      <p className="rs-p12 rs-c-white rs-shadow">{sponsored ? "This takes a few seconds." : "Confirm the send in your wallet."}</p>
      <p className="rs-p11 rs-c-grey rs-shadow">It keeps going if you close this window.</p>
    </div>
  );
}

function SuccessView({ sent, onDone }: { sent: SentView; onDone: () => void }) {
  return (
    <div className="sd-center" data-send-state="success">
      <p className="sd-headline rs-b12 rs-c-green rs-shadow">Sent!</p>
      <p className="rs-p12 rs-c-white rs-shadow">{sentMessage(sent.amount, sent.to)}</p>
      <div className="sd-row sd-row--center">
        <SendLink href={txUrl(sent.hash)}>View on Basescan</SendLink>
        <StoneButton className="sd-btn" onClick={onDone} autoFocus>
          Done
        </StoneButton>
      </div>
    </div>
  );
}

interface ErrorViewProps {
  failure: Extract<SendFailure, { kind: "error" }>;
  from: Address;
  onBack: () => void;
  onClose: () => void;
}

function ErrorView({ failure, from, onBack, onClose }: ErrorViewProps) {
  return (
    <div className="sd-center" data-send-state="error">
      <p className="sd-alert rs-p12 rs-c-red rs-shadow" role="alert">
        {failure.message}
      </p>
      {failure.hint && <p className="rs-p12 rs-c-white rs-shadow">{failure.hint}</p>}
      {failure.history && <SendLink href={usdcHistoryUrl(from)}>Your USDC history on Basescan</SendLink>}
      <div className="sd-row sd-row--center">
        <StoneButton className="sd-btn" onClick={onBack} autoFocus>
          {failure.back === "review" && failure.retry ? "Try again" : "Back"}
        </StoneButton>
        <StoneButton className="sd-btn" onClick={onClose}>
          Close
        </StoneButton>
      </div>
    </div>
  );
}

const CHECK_EVERY_MS = 15_000;

interface UnconfirmedViewProps {
  record: PendingSend;
  chain: SendChain;
  pending: PendingSendStore;
  /** The player has a wallet app of their own (an external wallet) to look in. */
  walletApp: boolean;
  /** The smart wallet's bundler lookup, for a send that got as far as a user operation. */
  userOperationStatus: TxSender["userOperationStatus"];
  focusOnMount: boolean;
  dispatch: Dispatch<SendAction>;
  onLanded: (sent: SentView) => void;
  onRefresh: () => void;
}

/**
 * A send that may have gone through. It is looked for on Base now and every
 * 15 s: its transaction, its user operation (smart wallets), or a Transfer of
 * exactly the amount since it started. Found: it is a success. Failed
 * on-chain: nothing moved. Until then no other send can start. Only once the
 * evidence says it didn't happen (canReleasePending: the whole history
 * searched, the balance not down by the amount, nothing queued, and
 * RELEASE_PENDING_AFTER_MS passed) may the player send again.
 */
function UnconfirmedView({ record, chain, pending, walletApp, userOperationStatus, focusOnMount, dispatch, onLanded, onRefresh }: UnconfirmedViewProps) {
  const [check, setCheck] = useState<PendingCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const running = useRef(false);
  // Where the history search has got to for this send: each check reads only the blocks after it.
  const scan = useRef<{ startedAt: number; through: bigint | null }>({ startedAt: record.startedAt, through: null });
  const mounted = useMounted();
  const inFlight = isSendInFlight(record.from);
  const checkButton = useRef<HTMLButtonElement>(null);
  const headline = useRef<HTMLParagraphElement>(null);
  useFocusOnMount(inFlight ? headline : checkButton, focusOnMount);

  const run = useCallback(async () => {
    // The send is still with the wallet in this page: its own outcome settles it (see announceOutcome).
    if (running.current || isSendInFlight(record.from)) {
      if (mounted.current) setNow(Date.now());
      return;
    }
    running.current = true;
    setChecking(true);
    try {
      if (scan.current.startedAt !== record.startedAt) scan.current = { startedAt: record.startedAt, through: null };
      const result = await checkPendingSend(record, chain, { userOperationStatus, scannedThrough: scan.current.through });
      if (result.status === "landed") {
        pending.clear(record.from);
        onLanded({ hash: result.hash, amount: record.amount, to: record.to });
        return;
      }
      if (result.status === "failed") {
        pending.clear(record.from);
        onRefresh();
        if (mounted.current) {
          dispatch({
            type: "released",
            failure: { kind: "error", message: "That send failed on Base. No USDC moved.", hint: "You can send again.", back: "form", retry: false },
          });
        }
        return;
      }
      scan.current = { startedAt: record.startedAt, through: result.scannedThrough };
      if (mounted.current) setCheck(result);
    } finally {
      running.current = false;
      if (mounted.current) {
        setChecking(false);
        setNow(Date.now());
      }
    }
  }, [record, chain, pending, userOperationStatus, dispatch, onLanded, onRefresh, mounted]);

  useEffect(() => {
    void run();
    const timer = window.setInterval(() => void run(), CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [run]);

  const canRelease = canReleasePending(record, check, now, inFlight);
  const release = () => {
    pending.clear(record.from);
    dispatch({ type: "released" });
  };
  const minutes = Math.max(0, Math.round((now - record.startedAt) / 60_000));

  return (
    <div className="sd-center" data-send-state="unconfirmed">
      <p ref={headline} tabIndex={-1} className="sd-focus-text rs-b12 rs-c-yellow rs-shadow">
        Your send hasn't been confirmed yet.
      </p>
      <p className="rs-p12 rs-c-white rs-shadow">
        {formatSendAmount(record.amount)} USDC to {shortAddress(record.to)}, started {minutes < 1 ? "just now" : minutes === 1 ? "a minute ago" : `${minutes} minutes ago`}.
      </p>
      <p className="rs-p12 rs-c-white rs-shadow" aria-live="polite">
        {inFlight ? inFlightText(walletApp) : canRelease ? releaseHint(walletApp) : unconfirmedText(check)}
      </p>
      <div className="sd-row sd-row--center">
        {record.hash ? (
          <SendLink href={txUrl(record.hash)}>View on Basescan</SendLink>
        ) : (
          <SendLink href={usdcHistoryUrl(record.from)}>Your USDC history on Basescan</SendLink>
        )}
        {/* Never disabled while checking: a focused button that turns disabled drops focus out of the window. */}
        <StoneButton ref={checkButton} className="sd-btn" onClick={() => void run()} disabled={inFlight} aria-busy={checking || undefined} data-send-check="">
          {checking ? "Checking..." : "Check again"}
        </StoneButton>
        {canRelease && (
          <StoneButton className="sd-btn" onClick={release} data-send-release="">
            {RELEASE_LABEL}
          </StoneButton>
        )}
      </div>
    </div>
  );
}
