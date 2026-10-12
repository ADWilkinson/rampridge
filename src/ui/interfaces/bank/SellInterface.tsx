import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { CurrencyType } from "@zkp2p/cash";
import { shareIdFor, usdcFromUnits } from "@shared/share";
import {
  PEER_WEB_URL,
  defaultPendingSellStore,
  formatSpreadPercent,
  parseSpreadPercent,
  spreadRate,
  SPREAD_MAX_BPS,
  SPREAD_MIN_BPS,
  SPREAD_STEP_BPS,
  useSellEstimate,
  useSellFlow,
  useSellStore,
  useWatchedSellOrder,
  type ListedSell,
  type SellFlow,
  type SellLegView,
} from "@/peer/sell";
import { formatUsdcAmount } from "@/peer/sell/amount";
import { platformName } from "@/peer/sell/payees";
import { InsufficientGasError, useUsdcBalance } from "@/wallet";
import type { TxSender } from "@/wallet/types";
import {
  AmountPad,
  ChatboxPrompt,
  Checkbox,
  NumberInput,
  PleaseWait,
  ScrollArea,
  StoneButton,
  TextButton,
  Window,
  cx,
  useChatPrompt,
  type ChatPromptRequest,
} from "@/ui/kit";
import { HelpLink } from "@/ui/interfaces/shared/help";
import { PlatformIcon } from "@/ui/interfaces/shared/PlatformIcon";
import { ShareButton } from "@/ui/interfaces/shared/ShareButton";
import { useGame, type InterfaceProps } from "../context";
import { CenterNote, ErrorNote, LoggedOut, TextLink } from "./common";
import { useCashClient, useInterfaceSize, useSellExtension } from "./deps";
import {
  currencyList,
  depositLabel,
  errorBlocksForm,
  errorButtons,
  fiatText,
  formIssue,
  isPeerPayOnly,
  legSetupIssue,
  legStatus,
  newlyActiveSteps,
  orderSentence,
  PEER_PAY_ONLY_TEXT,
  preciseRate,
  reviewLegs,
  reviewWarning,
  stepRows,
  txUrl,
  UNCONFIRMED_HANDLE,
  usdcInputText,
  usdcNumber,
  usdcText,
  type ErrorButton,
  type LegAction,
  type ReviewLeg,
  type StepRow,
} from "./helpers";

const MAX_LEGS = 4;
/** Confirm stays off this long after the review opens, so a double-click on Deposit can't pass straight through it. */
const REVIEW_ARM_MS = 600;

/**
 * Sell USDC: create a Peer Cash deposit (a sell offer) from the wallet. The
 * player sets the amount, one or more payout methods with their currencies
 * and handle (checked live), sees the oracle estimate, then Deposit opens a
 * review of the amount and every payout handle in full; only its Confirm runs
 * approve + createDeposit (+ the buyer-access policy) with per-step progress.
 * An interrupted deposit is reconciled on open; the form never reappears
 * while one may be on-chain.
 */
export function SellInterface({ open }: InterfaceProps<"sell">) {
  const { sender, login, close } = useGame();
  const size = useInterfaceSize({ width: 488, height: 500 }, 680);
  return (
    <Window title="Sell USDC" width={size.width} height={size.height} onClose={close} draggable className="bk-window">
      {sender ? (
        <SellBody sender={sender} mobile={size.mobile} initialPlatform={open.platform} initialCurrency={open.currency} />
      ) : (
        <LoggedOut text="You need to log in to trade." onLogin={login} />
      )}
    </Window>
  );
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

interface SellBodyProps {
  sender: TxSender;
  mobile: boolean;
  initialPlatform?: string;
  initialCurrency?: string;
}

function SellBody({ sender, mobile, initialPlatform, initialCurrency }: SellBodyProps) {
  const game = useGame();
  const { message, playSound, announce, publicClient } = game;
  const client = useCashClient();
  const balanceQuery = useUsdcBalance(sender.address);
  const balance = balanceQuery.data ?? null;

  const sellExtension = useSellExtension();
  const flow = useSellFlow({
    sender,
    publicClient,
    balance,
    client,
    ...(sellExtension ? { extension: sellExtension } : {}),
    onListed: (listed: ListedSell) => {
      message("Your offer is live.");
      playSound("offer");
      const tx = listed.txHashes.createDeposit;
      if (tx) void announce("listed", tx).catch(() => undefined);
    },
  });

  // Open with a platform/currency chosen elsewhere (e.g. the Exchange's Sell
  // button). Reads the store directly: useSellFlow may have just reset the
  // draft for this wallet in an earlier effect of this render.
  const prefilled = useRef(false);
  const setLegPlatform = flow.setLegPlatform;
  const setLegCurrencies = flow.setLegCurrencies;
  const platforms = flow.capabilities.platforms;
  useEffect(() => {
    if (prefilled.current) return;
    prefilled.current = true;
    if (!initialPlatform) return;
    const state = useSellStore.getState();
    const leg = state.legs[0];
    if (!leg || leg.platform || state.submission || state.amount || state.legs.length > 1) return;
    setLegPlatform(leg.id, initialPlatform);
    const currency = platforms.find((p) => p.platform === initialPlatform)?.currencies.find((c) => c === initialCurrency);
    if (currency) setLegCurrencies(leg.id, [currency]);
  }, [initialPlatform, initialCurrency, platforms, setLegPlatform, setLegCurrencies]);

  // useSellFlow keeps a leg's "checking" state in the shared store but drops
  // its timer on unmount, so a check interrupted by closing this window (or
  // StrictMode's remount) would never finish. Restart those checks on open.
  const recheckPayee = flow.recheckPayee;
  useEffect(() => {
    const { legs, checks } = useSellStore.getState();
    for (const leg of legs) if (checks[leg.id]?.status === "checking") recheckPayee(leg.id);
  }, [recheckPayee]);

  // Step progress as game messages ("Creating your offer...").
  const prevSteps = useRef(flow.steps);
  useEffect(() => {
    for (const text of newlyActiveSteps(prevSteps.current, flow.steps)) message(text);
    prevSteps.current = flow.steps;
  }, [flow.steps, message]);

  const lastError = useRef(flow.error);
  useEffect(() => {
    const error = flow.error;
    if (!error || error === lastError.current) return;
    lastError.current = error;
    message(error.message);
    playSound("error");
  }, [flow.error, message, playSound]);

  const pending = useMemo(
    () => defaultPendingSellStore().read(sender.address),
    // Re-read whenever the submission state moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sender.address, flow.phase, flow.error, flow.listed, flow.recovering],
  );

  if (flow.listed) return <ListedView listed={flow.listed} onNew={flow.reset} />;
  if (flow.phase === "submitting") return <SubmittingView flow={flow} />;
  if (flow.error && errorBlocksForm(flow.error)) return <RecoveryView flow={flow} />;
  if (pending && !flow.error) {
    return flow.recovering ? (
      <CenterNote>
        <PleaseWait text="Checking your last deposit" className="rs-p12 rs-c-yellow rs-shadow" />
      </CenterNote>
    ) : (
      <CenterNote>
        <p className="rs-p12 rs-c-yellow rs-shadow">Your last deposit hasn't been confirmed yet.</p>
        <p className="rs-p11 rs-c-white rs-shadow">Check its status before starting another one.</p>
        <StoneButton onClick={() => void flow.reconcile()} autoFocus>
          Check status
        </StoneButton>
      </CenterNote>
    );
  }
  return <SellForm flow={flow} sender={sender} mobile={mobile} balanceError={balanceQuery.isError} onRetryBalance={() => void balanceQuery.refetch()} />;
}

// ---------------------------------------------------------------------------
// The form

function SellForm({ flow, sender, mobile, balanceError, onRetryBalance }: { flow: SellFlow; sender: TxSender; mobile: boolean; balanceError: boolean; onRetryBalance: () => void }) {
  const submitting = useRef(false);
  const [reviewing, setReviewing] = useState(false);
  // Back from the review puts focus back on Deposit, where the player left.
  const [backFromReview, setBackFromReview] = useState(false);
  const caps = flow.capabilities;
  const balance = flow.balance;
  const max = balance !== null ? usdcNumber(balance) : undefined;
  const minText = formatUsdcAmount(caps.minAmount, { minDecimals: 0 });
  const amountDisplay = flow.amountUnits !== null && flow.amountUnits > 0n ? formatUsdcAmount(flow.amountUnits, { minDecimals: 0, group: true }) : "0";
  const issue = flow.phase === "idle" ? null : formIssue(flow.issues);
  const usedPlatforms = new Set(flow.legs.map((l) => l.platform).filter(Boolean));
  // The review lists the live draft, which can't be edited while it shows,
  // so what it lists is exactly what Confirm deposits.
  const review = reviewing && flow.canSubmit && flow.amountUnits !== null ? reviewLegs(flow.legs) : null;
  const reviewReady = review !== null;

  // Anything that makes the order not ready while it is being reviewed (the
  // balance, gas, a re-check) drops back to the form, which says why.
  useEffect(() => {
    if (reviewing && !reviewReady) setReviewing(false);
  }, [reviewing, reviewReady]);

  // Deposit (or Enter) only opens the review; nothing is sent from the form.
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!flow.canSubmit || submitting.current) return;
    setReviewing(true);
  };

  const onConfirm = async () => {
    if (!flow.canSubmit || submitting.current) return;
    submitting.current = true;
    try {
      await flow.submit();
    } finally {
      submitting.current = false;
    }
  };

  if (review && flow.amountUnits !== null) {
    return (
      <SellReview
        amount={flow.amountUnits}
        rows={review}
        spreadBps={flow.spreadBps}
        gas={flow.gas}
        sponsored={sender.sponsored}
        mobile={mobile}
        onBack={() => {
          setReviewing(false);
          setBackFromReview(true);
        }}
        onConfirm={() => void onConfirm()}
      />
    );
  }

  return (
    <form className={cx("bk-sell", mobile && "bk-sell--mobile")} onSubmit={onSubmit} noValidate>
      <ScrollArea className="bk-sell__scroll" label="Sell offer details">
        <section className="bk-sell__amount">
          <AmountPad
            label="Quantity (USDC):"
            value={usdcNumber(flow.amountUnits)}
            onChange={(v) => flow.setAmount(usdcInputText(v))}
            rules={{ min: 0, ...(max !== undefined ? { max } : {}), decimals: 2 }}
            format={() => amountDisplay}
            promptTitle="Enter amount to sell:"
            promptHint={balance !== null ? `Between ${minText} and ${usdcText(balance)} USDC.` : `At least ${minText} USDC.`}
            disabled={balance === null}
          />
          <div className="bk-sell__wallet">
            <span className="rs-p12 rs-c-orange rs-shadow">
              Wallet:{" "}
              {balance !== null ? (
                <span className="rs-c-white">{usdcText(balance)} USDC</span>
              ) : balanceError ? (
                <span className="rs-c-yellow">unavailable</span>
              ) : (
                <span className="rs-c-yellow">checking...</span>
              )}
            </span>
            {balanceError && balance === null ? (
              <TextButton onClick={onRetryBalance}>Try again</TextButton>
            ) : (
              <TextButton onClick={flow.setMaxAmount} disabled={!balance} aria-label="Sell all the USDC in your wallet">
                Sell all
              </TextButton>
            )}
          </div>
        </section>
        {flow.spreadEnabled && <SpreadPicker flow={flow} />}
        {flow.legs.map((leg, i) => (
          <LegEditor
            key={leg.id}
            leg={leg}
            index={i}
            flow={flow}
            canRemove={flow.legs.length > 1}
            usedPlatforms={usedPlatforms}
            single={flow.legs.length === 1}
          />
        ))}
        {flow.legs.length < Math.min(MAX_LEGS, caps.platforms.length) && (
          <TextButton className="bk-sell__addLeg" onClick={() => flow.addLeg()}>
            Add another payout method
          </TextButton>
        )}
      </ScrollArea>
      <div className="bk-sell__foot">
        <GasLine gas={flow.gas} sponsored={sender.sponsored} />
        {flow.error ? (
          <ErrorNote error={flow.error}>
            <ErrorButtons flow={flow} buttons={errorButtons(flow.error)} />
          </ErrorNote>
        ) : issue ? (
          <p className={cx("rs-p12 rs-shadow", issue.severity === "error" ? "bk-alert rs-c-red" : "rs-c-yellow")} role={issue.severity === "error" ? "alert" : "status"}>
            {issue.message}
          </p>
        ) : flow.phase === "ready" ? (
          <p className="rs-p12 rs-c-green rs-shadow">Ready to deposit {usdcText(flow.amountUnits ?? 0n)} USDC.</p>
        ) : null}
        <StoneButton submit size="big" disabled={!flow.canSubmit} className="bk-sell__deposit" data-bank-deposit="" autoFocus={backFromReview}>
          Deposit
        </StoneButton>
      </div>
    </form>
  );
}

/**
 * The Grand Exchange's "price per item", for a sell offer: the market (oracle)
 * rate is the guide price and the seller sets a spread on it in 0.1% steps,
 * or types one ("..."), within Peer's -5% to +5%. Buyers pay the market rate
 * plus the spread at the moment they lock an order.
 */
function SpreadPicker({ flow }: { flow: SellFlow }) {
  const client = useCashClient();
  const host = useChatPrompt();
  const [inline, setInline] = useState<ChatPromptRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disposePrompt = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      disposePrompt.current?.();
      disposePrompt.current = null;
    },
    [],
  );
  // The guide price is the first payout's market rate (each payout's own rate shows under it).
  const leg = flow.legs.find((l) => l.platform && l.currencies.length > 0) ?? null;
  const currency = leg?.currencies[0] ?? null;
  const estimate = useSellEstimate({ amount: null, currency, platform: leg?.platform || null, currencies: leg?.currencies ?? [], spreadBps: flow.spreadBps, client });
  const bps = flow.spreadBps;
  const step = (delta: number) => {
    setError(null);
    flow.setSpread(bps + delta);
  };
  const ask = () => {
    const request: ChatPromptRequest = {
      title: "Enter your price above or below the market rate (%):",
      kind: "text",
      maxLength: 7,
      hint: "Between -5.00% and +5.00%, e.g. 0.25 or -1.5. 0 is the market rate.",
      onSubmit: (raw) => {
        const parsed = parseSpreadPercent(raw);
        if (parsed.ok) {
          setError(null);
          flow.setSpread(parsed.bps);
        } else {
          setError(parsed.message);
        }
      },
    };
    if (host) disposePrompt.current = host.open(request);
    else setInline(request);
  };
  const stepText = `${(SPREAD_STEP_BPS / 100).toFixed(1)}%`;
  const market = estimate.rate?.rate ?? null;
  const yours = market !== null ? spreadRate(market, bps) : null;
  // Said once each: where the price sits (head), the price itself (box), the market's (guide).
  const where = bps === 0 ? "Market rate" : `${formatSpreadPercent(Math.abs(bps)).replace("+", "")} ${bps > 0 ? "above" : "below"} market`;
  return (
    <section className="bk-sell__price" aria-label="Price per USDC">
      <div className="bk-price__head">
        <span className="rs-p12 rs-c-orange rs-shadow">Price per USDC:</span>
        <span className={cx("bk-price__pct rs-p12 rs-shadow", bps === 0 ? "rs-c-grey" : "rs-c-yellow")}>{where}</span>
      </div>
      <div className="bk-price__row">
        <StoneButton className="bk-price__step" onClick={() => step(-SPREAD_STEP_BPS)} disabled={bps <= SPREAD_MIN_BPS} aria-label={`Lower your price by ${stepText}`}>
          -{stepText}
        </StoneButton>
        <NumberInput
          className="bk-price__box"
          display={yours !== null && currency ? `${preciseRate(yours)} ${currency}` : formatSpreadPercent(bps)}
          onClick={ask}
          ariaLabel={`Your price: ${bps === 0 ? "the market rate" : `the market rate ${formatSpreadPercent(bps)}`}. Enter a spread`}
        />
        <StoneButton className="bk-price__step" onClick={() => step(SPREAD_STEP_BPS)} disabled={bps >= SPREAD_MAX_BPS} aria-label={`Raise your price by ${stepText}`}>
          +{stepText}
        </StoneButton>
        <StoneButton className="bk-price__step" onClick={ask} aria-label="Enter a spread">
          ...
        </StoneButton>
      </div>
      <div className="bk-price__guide rs-p11 rs-shadow">
        <span>
          <span className="rs-c-orange">Guide price:</span>{" "}
          {market !== null && currency ? (
            <span className="rs-c-white">
              {preciseRate(market)} {currency}
            </span>
          ) : (
            <span className="rs-c-grey">{estimate.isLoadingRate ? "checking the live rate..." : "choose a payout method"}</span>
          )}
        </span>
        {bps !== 0 && (
          <TextButton font="p11" onClick={() => step(-bps)}>
            Use the market rate
          </TextButton>
        )}
      </div>
      {bps !== 0 && (
        <p className="rs-p11 rs-c-grey rs-shadow">
          {bps > 0 ? "Above the market: you get more per USDC, but it may take longer to fill." : "Below the market: it should fill sooner, for less per USDC."}
        </p>
      )}
      {error && (
        <p className="bk-alert rs-p11 rs-c-red rs-shadow" role="alert">
          {error}
        </p>
      )}
      {inline && (
        <div className="rs-amount__inline-prompt rs-chatarea">
          <ChatboxPrompt request={inline} onDone={() => setInline(null)} />
        </div>
      )}
    </section>
  );
}

function GasLine({ gas, sponsored }: { gas: SellFlow["gas"]; sponsored: boolean }) {
  if (sponsored || gas === "sponsored" || gas === "unknown") return null;
  if (gas === "empty") {
    return (
      <p className="bk-alert rs-p12 rs-c-red rs-shadow" role="alert">
        {new InsufficientGasError(null).message}
      </p>
    );
  }
  return <p className="rs-p11 rs-c-grey rs-shadow">Your wallet pays a small network fee in ETH.</p>;
}

interface SellReviewProps {
  amount: bigint;
  rows: ReviewLeg[];
  /** The seller's spread on the market rate, basis points. */
  spreadBps: number;
  gas: SellFlow["gas"];
  sponsored: boolean;
  mobile: boolean;
  onBack: () => void;
  onConfirm: () => void;
}

/**
 * "Are you sure you want to make this offer?", like the trade's second
 * screen: the amount and every payout handle in full with its currencies, so
 * a typo is caught before buyers can pay it. Handles Peer could not confirm
 * are flagged. Confirm is the only way to deposit.
 */
function SellReview({ amount, rows, spreadBps, gas, sponsored, mobile, onBack, onConfirm }: SellReviewProps) {
  const headingId = useId();
  const heading = useRef<HTMLParagraphElement>(null);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    heading.current?.focus();
    const timer = window.setTimeout(() => setArmed(true), REVIEW_ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <section className={cx("bk-sell bk-review", mobile && "bk-sell--mobile")} aria-labelledby={headingId}>
      <ScrollArea className="bk-sell__scroll" label="Your offer">
        <div className="bk-review__body">
          <p id={headingId} ref={heading} tabIndex={-1} className="bk-review__ask rs-p12 rs-c-white rs-shadow">
            Are you sure you want to make this offer?
          </p>
          <dl className="bk-facts bk-review__facts">
            <div>
              <dt className="rs-p12 rs-c-orange rs-shadow">Amount:</dt>
              <dd className="rs-b12 rs-c-white rs-shadow" data-bank-review-amount="">
                {usdcText(amount)} USDC
              </dd>
            </div>
            <div>
              <dt className="rs-p12 rs-c-orange rs-shadow">Price:</dt>
              <dd className="rs-p12 rs-c-white rs-shadow">
                {spreadBps === 0 ? "Market rate" : `Market rate ${formatSpreadPercent(spreadBps)}`}
                {spreadBps !== 0 && <span className="bk-review__sub rs-p11 rs-c-grey">Your rate follows the market until a buyer locks it.</span>}
              </dd>
            </div>
          </dl>
          <p className="rs-p12 rs-c-orange rs-shadow">{rows.length > 1 ? "Buyers will pay one of these handles:" : "Buyers will pay this handle:"}</p>
          <ul className="bk-review__legs">
            {rows.map((row) => (
              <li key={row.id} className="bk-review__leg">
                <span className="bk-review__icon" aria-hidden="true">
                  <PlatformIcon platform={row.platform} size={24} title="" />
                </span>
                <div className="bk-review__legText">
                  <p className="rs-p12 rs-c-orange rs-shadow">
                    {row.name} <span className="rs-c-white">in {row.currencies}</span>
                  </p>
                  <p className="bk-review__handle rs-p12 rs-c-white rs-shadow rs-selectable">{row.handle}</p>
                  {row.confirmed ? (
                    <p className="rs-p11 rs-c-green rs-shadow">Handle found</p>
                  ) : (
                    <p className="rs-p11 rs-c-yellow rs-shadow">{UNCONFIRMED_HANDLE} Check every character.</p>
                  )}
                  <ReviewEstimate platform={row.platform} currencies={row.currencyCodes} amount={amount} spreadBps={spreadBps} />
                  {row.warning && <p className="rs-p11 rs-c-yellow rs-shadow">{row.warning}</p>}
                  {isPeerPayOnly(row.platform) && <p className="rs-p11 rs-c-yellow rs-shadow">{PEER_PAY_ONLY_TEXT}</p>}
                </div>
              </li>
            ))}
          </ul>
          <p className="rs-p11 rs-c-grey rs-shadow">{UNSOLD_TEXT}</p>
          <p className="bk-review__warn bk-alert rs-b12 rs-c-red rs-shadow">{reviewWarning(rows.length)}</p>
        </div>
      </ScrollArea>
      <div className="bk-sell__foot">
        <GasLine gas={gas} sponsored={sponsored} />
        <span className="bk-row bk-review__buttons">
          <StoneButton onClick={onConfirm} disabled={!armed} data-bank-confirm="">
            Confirm
          </StoneButton>
          <StoneButton onClick={onBack}>Back</StoneButton>
        </span>
      </div>
    </section>
  );
}

/** Said on the review under the payout estimates. */
const UNSOLD_TEXT = "Unsold USDC can be withdrawn from the bank at any time, except while a buyer is paying for it.";

/**
 * "You will receive about £197.48 at 0.7899 GBP per USDC", with that
 * currency's market rate under it when the price is off the market (the
 * spread itself is said once, under Price), for one reviewed payout. It reads the same cached live rate as the
 * form's estimate for that method (useSellEstimate keys it by currency and
 * platform), so the review repeats exactly what the form showed.
 */
function ReviewEstimate({ platform, currencies, amount, spreadBps }: { platform: string; currencies: readonly CurrencyType[]; amount: bigint; spreadBps: number }) {
  const client = useCashClient();
  const currency = currencies[0] ?? null;
  const estimate = useSellEstimate({ amount: amount > 0n ? amount : null, currency, platform, currencies, spreadBps, client });
  if (!currency) return null;
  if (estimate.isLoadingRate) return <PleaseWait text="Checking the live rate" className="rs-p11 rs-c-yellow rs-shadow" />;
  if (!estimate.rate || estimate.receive === null || estimate.yourRate === null) {
    return <p className="rs-p11 rs-c-grey rs-shadow">The live rate is unavailable right now.</p>;
  }
  return (
    <>
      <p className="bk-review__receive rs-p12 rs-c-white rs-shadow">
        You will receive about <span className="rs-b12 rs-c-yellow">{fiatText(estimate.receive, currency)}</span> at {preciseRate(estimate.yourRate)} {currency} per USDC
        {currencies.length > 1 ? ` if paid in ${currency}` : ""}.
      </p>
      {spreadBps !== 0 && (
        <p className="rs-p11 rs-c-grey rs-shadow">
          Market rate {preciseRate(estimate.rate.rate)} {currency}.
        </p>
      )}
    </>
  );
}

function ErrorButtons({ flow, buttons }: { flow: SellFlow; buttons: ErrorButton[] }) {
  const busy = flow.recovering;
  const run = (b: ErrorButton) => {
    if (busy) return;
    if (b.kind === "recover") void flow.recover();
    else if (b.kind === "reconcile") void flow.reconcile();
    else if (b.kind === "discard") void flow.discardPending();
    else flow.dismissError();
  };
  return (
    <span className="bk-row">
      {buttons.map((b, i) => (
        <StoneButton key={b.kind} onClick={() => run(b)} disabled={busy} autoFocus={i === 0}>
          {b.label}
        </StoneButton>
      ))}
      <HelpLink />
      {busy && <PleaseWait text="Checking" className="rs-p12 rs-c-yellow rs-shadow" />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One payout leg

interface LegEditorProps {
  leg: SellLegView;
  index: number;
  flow: SellFlow;
  canRemove: boolean;
  usedPlatforms: Set<string>;
  single: boolean;
}

function LegEditor({ leg, index, flow, canRemove, usedPlatforms, single }: LegEditorProps) {
  const id = useId();
  const info = leg.platformInfo;
  const status = legStatus(leg, {
    extensionSupported: flow.extensionSupported,
    extension: flow.extension,
    installPending: flow.extensionInstallPending,
  });
  const setup = legSetupIssue(leg.issues);
  const enrollment = info?.payeeEnrollment ?? null;
  const singleOrder = info?.singleOrder ?? null;
  const toneClass = { good: "rs-c-green", bad: "rs-c-red", warn: "rs-c-yellow", pending: "rs-c-yellow", none: "" }[status.tone];

  const toggleCurrency = (c: CurrencyType) => {
    const has = leg.currencies.includes(c);
    if (has) {
      if (leg.currencies.length > 1) flow.setLegCurrencies(leg.id, leg.currencies.filter((x) => x !== c));
    } else {
      flow.setLegCurrencies(leg.id, [...leg.currencies, c]);
    }
  };

  const runAction = (action: LegAction) => {
    if (action === "register") void flow.registerPayee(leg.id);
    else if (action === "recheck") flow.recheckPayee(leg.id);
    else if (action === "cancelRegistration") flow.cancelRegistration(leg.id);
    else if (action === "install") flow.installExtension();
    else if (action === "installed") flow.recheckExtension();
  };

  return (
    <fieldset className="bk-leg">
      <legend className="bk-leg__title rs-p12 rs-c-orange rs-shadow">
        {single ? "Paid by:" : `Payout ${index + 1}:`}
        {info && <span className="rs-c-white"> {info.name}</span>}
      </legend>
      {canRemove && (
        <TextButton className="bk-leg__remove" tone="orange" onClick={() => flow.removeLeg(leg.id)} aria-label={`Remove payout ${index + 1}`}>
          Remove
        </TextButton>
      )}
      <div className="bk-leg__platforms" role="group" aria-label={`Payout method ${index + 1}`}>
        {flow.capabilities.platforms.map((p) => {
          const selected = leg.platform === p.platform;
          const taken = !selected && usedPlatforms.has(p.platform);
          return (
            <button
              key={p.platform}
              type="button"
              className={cx("bk-plat", selected && "is-selected")}
              aria-pressed={selected}
              aria-label={taken ? `${p.name} (already in this offer)` : p.name}
              title={p.name}
              disabled={taken}
              onClick={() => flow.setLegPlatform(leg.id, p.platform)}
            >
              <PlatformIcon platform={p.platform} size={24} title="" />
              <span className="bk-plat__name rs-p11" aria-hidden="true">
                {p.name}
              </span>
            </button>
          );
        })}
      </div>
      {!info ? (
        <p className="rs-p12 rs-c-white rs-shadow">Choose how you want to be paid.</p>
      ) : (
        <>
          <div className="bk-leg__currencies">
            <span className="rs-p12 rs-c-orange rs-shadow">{info.currencies.length > 1 ? "Currencies:" : "Currency:"}</span>
            {info.currencies.length > 1 ? (
              <span className="bk-chips" role="group" aria-label={`${info.name} currencies`}>
                {info.currencies.map((c) => {
                  const on = leg.currencies.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      className={cx("bk-chip rs-p11", on && "is-on")}
                      aria-pressed={on}
                      onClick={() => toggleCurrency(c)}
                      title={on && leg.currencies.length === 1 ? "At least one currency is needed" : undefined}
                    >
                      {c}
                    </button>
                  );
                })}
              </span>
            ) : (
              <span className="rs-p12 rs-c-white rs-shadow">{info.currencies[0]}</span>
            )}
          </div>
          <div className="bk-leg__payee">
            <label htmlFor={`${id}-payee`} className="rs-p12 rs-c-orange rs-shadow">
              {info.payeeLabel}:
            </label>
            <input
              id={`${id}-payee`}
              className={cx("bk-input rs-p12", status.tone === "bad" && "is-bad", status.tone === "good" && "is-good")}
              value={leg.payee}
              placeholder={info.payeePlaceholder}
              onChange={(e) => flow.setLegPayee(leg.id, e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={128}
              aria-invalid={status.tone === "bad" || undefined}
              aria-describedby={`${id}-hint ${id}-status`}
            />
          </div>
          <p id={`${id}-hint`} className="bk-leg__hint rs-p11 rs-c-grey rs-shadow">
            {info.payeeHint}
          </p>
          <div id={`${id}-status`} className="bk-leg__status" aria-live="polite">
            {status.text &&
              (status.tone === "pending" ? (
                <PleaseWait text={status.text.replace(/\.+$/, "")} className={cx("rs-p12 rs-shadow", toneClass)} />
              ) : (
                <span className={cx("rs-p12 rs-shadow", toneClass, status.tone === "bad" && "bk-alert")}>{status.text}</span>
              ))}
            {status.actions.map((a) =>
              a === "registerWeb" ? (
                <TextLink key={a} href={PEER_WEB_URL}>
                  Register this handle once at peer.xyz
                </TextLink>
              ) : (
                <TextButton key={a} tone={a === "register" || a === "install" ? "yellow" : "orange"} onClick={() => runAction(a)}>
                  {LEG_ACTION_LABELS[a]}
                </TextButton>
              ),
            )}
          </div>
          {enrollment && (
            // Bound to the exact handle now entered (editing it clears the tick); never sent to Peer.
            <Checkbox
              className={cx("bk-leg__enroll", !leg.enrollmentConfirmed && leg.offchainId && "bk-leg__enroll--todo")}
              checked={leg.enrollmentConfirmed}
              disabled={!leg.offchainId}
              onChange={(on) => flow.setLegEnrollment(leg.id, on)}
              label={enrollment.text}
            />
          )}
          {setup && (
            <p className="bk-alert rs-p12 rs-c-red rs-shadow" role="alert">
              {setup.message}
            </p>
          )}
          {singleOrder && (
            <p className="bk-leg__note rs-p11 rs-c-yellow rs-shadow">
              {singleOrder.warning} The minimum deposit is {formatUsdcAmount(singleOrder.minAmount, { minDecimals: 0 })} USDC.
            </p>
          )}
          {isPeerPayOnly(leg.platform) && <p className="bk-leg__note rs-p11 rs-c-yellow rs-shadow">{PEER_PAY_ONLY_TEXT}</p>}
          <LegEstimate leg={leg} amount={flow.amountUnits} spreadBps={flow.spreadBps} />
        </>
      )}
    </fieldset>
  );
}

const LEG_ACTION_LABELS: Record<Exclude<LegAction, "registerWeb">, string> = {
  register: "Verify with Peer",
  install: "Install Peer extension",
  installed: "I've installed it",
  recheck: "Check again",
  cancelRegistration: "Cancel",
};

function LegEstimate({ leg, amount, spreadBps }: { leg: SellLegView; amount: bigint | null; spreadBps: number }) {
  const client = useCashClient();
  const currency = leg.currencies[0] ?? null;
  const estimate = useSellEstimate({
    amount: amount && amount > 0n ? amount : null,
    currency,
    platform: leg.platform || null,
    currencies: leg.currencies,
    spreadBps,
    client,
  });
  if (!currency) return null;
  const others = leg.currencies.slice(1);
  if (estimate.isLoadingRate) {
    return (
      <p className="bk-leg__estimate">
        <PleaseWait text="Checking the live rate" className="rs-p12 rs-c-yellow rs-shadow" />
      </p>
    );
  }
  if (!estimate.rate || estimate.yourRate === null) {
    return <p className="bk-leg__estimate rs-p12 rs-c-grey rs-shadow">The live rate is unavailable right now.</p>;
  }
  const rate = estimate.rate;
  return (
    <div className="bk-leg__estimate">
      {estimate.receive !== null ? (
        <p className="rs-p12 rs-c-white rs-shadow">
          You will receive about <span className="rs-b12 rs-c-yellow">{fiatText(estimate.receive, currency)}</span> at{" "}
          {spreadBps === 0 ? "the live rate" : "your price"}
          {others.length ? ` if paid in ${currency}` : ""}.
        </p>
      ) : null}
      <p className="rs-p11 rs-c-grey rs-shadow">
        {spreadBps === 0
          ? `1 USDC = ${preciseRate(rate.rate)} ${currency}.`
          : `1 USDC = ${preciseRate(estimate.yourRate)} ${currency} (market ${preciseRate(rate.rate)}).`}
        {rate.stale ? " The rate feed is over a day old." : ""}
        {estimate.eta ? ` ${estimate.eta.label}.` : ""}
        {others.length ? ` Buyers may also pay in ${currencyList(others)}.` : ""}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Submitting, listed and recovery views

function StepList({ rows, unconfirmed = false }: { rows: StepRow[]; unconfirmed?: boolean }) {
  return (
    <ol className="bk-steps">
      {rows.map((row) => (
        <li key={row.id} className="bk-steps__row">
          <span className={cx("rs-p12 rs-shadow", row.status === "pending" ? "rs-c-grey" : "rs-c-white")}>{row.label}</span>
          <span className="bk-steps__status rs-p12 rs-shadow">
            {row.status === "active" ? (
              <PleaseWait text="Please wait" className="rs-c-yellow" />
            ) : row.status === "done" ? (
              <span className="rs-c-green">Done</span>
            ) : row.status === "failed" ? (
              unconfirmed ? <span className="rs-c-yellow">Unconfirmed</span> : <span className="rs-c-red">Not finished</span>
            ) : (
              <span className="rs-c-grey">Waiting</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function legsText(legs: readonly { platform: string; currencies: readonly string[] }[]): string {
  return legs.map((l) => `${platformName(l.platform)}${l.currencies.length ? ` (${l.currencies.join(", ")})` : ""}`).join(", ");
}

function SubmittingView({ flow }: { flow: SellFlow }) {
  const resolved = flow.legs.filter((l) => l.platform);
  return (
    <div className="bk-sellState">
      <p className="rs-b12 rs-c-orange rs-shadow">
        {flow.amountUnits ? `Depositing ${usdcText(flow.amountUnits)} USDC` : "Finishing your offer"}
      </p>
      {resolved.length > 0 && flow.amountUnits ? <p className="rs-p12 rs-c-white rs-shadow">Paid by {legsText(resolved)}.</p> : null}
      <StepList rows={stepRows(flow.steps)} />
      <p className="rs-p11 rs-c-white rs-shadow">Confirm in your wallet if it asks. Your offer keeps going if you close this window.</p>
    </div>
  );
}

function ListedView({ listed, onNew }: { listed: ListedSell; onNew: () => void }) {
  const { setStall, stallDepositId, open, message, playSound, me } = useGame();
  const client = useCashClient();
  const watched = useWatchedSellOrder(listed.depositId, { client });
  const [stallBusy, setStallBusy] = useState(false);
  const advertised = stallDepositId === listed.depositId;

  const toggleStall = async () => {
    if (stallBusy) return;
    if (!me) {
      message("You need to be in the bank to advertise.");
      return;
    }
    setStallBusy(true);
    try {
      await setStall(advertised ? null : listed.depositId);
      message(advertised ? "You stop advertising your offer." : "Players in the bank can now see your offer.");
    } catch (e) {
      message(errorText(e, "Your offer couldn't be advertised. Try again."));
      playSound("error");
    } finally {
      setStallBusy(false);
    }
  };

  const tx = listed.txHashes.createDeposit;
  // The offer's share link, once its "listed" announcement is saved.
  const shareId = tx && me ? shareIdFor("listed", tx, me.pid) : null;
  const firstLeg = listed.legs[0];
  // No player can take a Venmo- or PayPal-only offer from a stall, so it isn't advertised.
  const peerPayOnly = listed.legs.length > 0 && listed.legs.every((l) => isPeerPayOnly(l.platform));
  return (
    <div className="bk-sellState">
      <p className="bk-sellState__headline rs-b12 rs-c-green rs-shadow">Your offer is live.</p>
      {listed.amount > 0n && (
        <p className="rs-p12 rs-c-white rs-shadow">
          {usdcText(listed.amount)} USDC for sale{listed.legs.length ? `, paid by ${legsText(listed.legs)}` : ""}.
        </p>
      )}
      <p className="rs-p12 rs-c-white rs-shadow" aria-live="polite">
        {watched.order
          ? // The line above already says how much is for sale; a waiting offer only needs what happens next.
            watched.order.state === "awaiting-buyer"
            ? "Waiting for a buyer. You can withdraw it at any time."
            : orderSentence(watched.order)
          : peerPayOnly
            ? "Peer Pay merchants can now buy from it. Its progress shows in your bank."
            : "Buyers in the bank can now buy from it. Its progress shows in your bank."}
      </p>
      {listed.spreadBps ? (
        <p className="rs-p11 rs-c-grey rs-shadow">
          Price: the market rate {formatSpreadPercent(listed.spreadBps)}. Buyers pay the live rate {listed.spreadBps > 0 ? "plus" : "minus"} {formatSpreadPercent(Math.abs(listed.spreadBps)).replace("+", "")} when they lock an order.
        </p>
      ) : null}
      {listed.legs.some((l) => isPeerPayOnly(l.platform)) && <p className="rs-p11 rs-c-yellow rs-shadow">{PEER_PAY_ONLY_TEXT}</p>}
      <span className="bk-row">
        <span className="rs-p12 rs-c-orange rs-shadow">
          Offer: <span className="rs-c-white rs-selectable" title={listed.depositId}>{depositLabel(listed.depositId)}</span>
        </span>
        {tx && <TextLink href={txUrl(tx)}>View on Basescan</TextLink>}
        {listed.txHashes.accessPolicy.map((h, i) => (
          <TextLink key={h} href={txUrl(h)}>
            Buyer access{listed.txHashes.accessPolicy.length > 1 ? ` ${i + 1}` : ""}
          </TextLink>
        ))}
      </span>
      <span className="bk-row bk-sellState__buttons">
        {(!peerPayOnly || advertised) && (
          <StoneButton onClick={() => void toggleStall()} disabled={stallBusy} autoFocus>
            {advertised ? "Stop advertising" : "Advertise"}
          </StoneButton>
        )}
        <StoneButton onClick={() => open({ id: "bank" })} autoFocus={peerPayOnly && !advertised}>
          View bank
        </StoneButton>
        <StoneButton onClick={onNew}>New offer</StoneButton>
      </span>
      {firstLeg && listed.amount > 0n && (
        <ShareButton subject={{ kind: "listed", usdc: usdcFromUnits(listed.amount), platform: firstLeg.platform, currency: firstLeg.currencies[0] ?? null }} shareId={shareId} />
      )}
      {stallBusy && <PleaseWait text={advertised ? "Taking down your stall" : "Advertising your offer"} className="rs-p12 rs-c-yellow rs-shadow" />}
    </div>
  );
}

function RecoveryView({ flow }: { flow: SellFlow }) {
  const error = flow.error!;
  const rows = stepRows(flow.steps);
  const reconcile = error.recovery.action === "reconcile";
  return (
    <div className="bk-sellState">
      <p className="rs-b12 rs-c-orange rs-shadow">{reconcile ? "Your deposit" : "Your offer"}</p>
      {rows.length > 0 && <StepList rows={rows} unconfirmed={reconcile} />}
      <ErrorNote error={error}>
        {error.transactionHash && <TextLink href={txUrl(error.transactionHash)}>View on Basescan</TextLink>}
        <ErrorButtons flow={flow} buttons={errorButtons(error)} />
      </ErrorNote>
    </div>
  );
}
