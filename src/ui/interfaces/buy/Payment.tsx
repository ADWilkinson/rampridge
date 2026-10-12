import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getPaymentInstructions, type BuyFlowStore, type BuyOrder, type PaymentInstructions } from "@/peer/buy";
import { formatUsdc } from "@/peer/format";
import { BUY_PLATFORMS, minExtensionVersion } from "@/peer/platforms";
import { Checkbox, CountdownText, ParchmentScroll, PleaseWait, QrCode, StoneButton, cx, useCompactLandscape, useIsMobile, useNow } from "@/ui/kit";
import { useGame } from "../context";
import { useBuy, useBuyDeps, useNeedsComputer, useVerificationError } from "./deps";
import { useBuyOrderEvents } from "./events";
import { feeBreakdown } from "./fees";
import { useEnterKey } from "./hooks";
import {
  EXPIRY_WARN_MS,
  addExtensionLabel,
  errorText,
  extensionHeadsUp,
  extensionsPage,
  feesTakenText,
  missingPayLink,
  paidClaimed,
  payButtonLabel,
  paymentChecklist,
  peerAuthVersionText,
  qrCaption,
  txInFlight,
  type ChecklistItem,
} from "./model";
import { BuyErrorPanel, DismissOfferPrompt, FeeWaivedNote, HelpLine, LoginButton, VERIFY_ON_COMPUTER_TEXT } from "./parts";

const ORDER_STEPS = new Set(["awaitingPayment", "verifying", "selectPayment", "fulfilling", "error"]);

/**
 * The Payment scroll for the active buy order. The trade leads in one glance
 * (send this amount, to this handle, on this app; what you get; when it
 * expires), then three steps: (1) the platform's rules as a checklist and the
 * tick that unlocks the seller's details, (2) the seller's details to pay
 * with, (3) how the payment is proven. "I have paid" (verify) and "Cancel
 * offer" close it. An expired order says so and is never presented as
 * payable. Once the player has said they paid (verifying, an error raised
 * while verifying, or the order's persisted paid claim after a reload) the
 * scroll sends them to Verify instead of showing the payment instructions
 * again.
 */
export function PaymentInterface() {
  const game = useGame();
  const buy = useBuy();
  useBuyOrderEvents();
  const mobile = useIsMobile();
  const order = buy.order;
  const verifyFailed = useVerificationError(buy);
  // The steps spread the rules and the payment side by side on a wide scroll; every other state is a short note.
  const [compact, setCompact] = useState(false);
  let wide = false;

  // "Your offer has been cancelled." once a cancel started here lands.
  const cancelling = useRef(false);
  useEffect(() => {
    if (buy.pending === "cancel") cancelling.current = true;
    else if (cancelling.current && buy.step === "cancelled") {
      cancelling.current = false;
      game.message("Your offer has been cancelled.");
    } else if (cancelling.current && buy.pending === null) cancelling.current = false;
  }, [buy.pending, buy.step, game]);

  let body: ReactNode;
  if (!game.sender) {
    body = (
      <div className="rb-pay__center">
        <p className="rs-p12 rb-ink">You need to log in to trade.</p>
        <div className="rb-buttons">
          <LoginButton />
        </div>
      </div>
    );
  } else if (!order) {
    body = buy.recovering ? (
      <div className="rb-pay__center rs-p12 rb-ink">
        <PleaseWait text="Checking your offers" />
      </div>
    ) : (
      <div className="rb-pay__center">
        <p className="rs-p12 rb-ink">You have no open buy offer.</p>
        <div className="rb-buttons">
          <StoneButton onClick={() => game.open({ id: "exchange", side: "buy" })}>Open the Exchange</StoneButton>
        </div>
      </div>
    );
  } else if (order.status === "fulfilled" || buy.step === "completed") {
    body = (
      <div className="rb-pay__center">
        <p className="rb-pay__status rs-b12 rb-ink-green">This offer is complete.</p>
        <p className="rs-p12 rb-ink">You bought {formatUsdc(buy.completion?.usdcReceived ?? order.usdcExpected)} USDC.</p>
        <div className="rb-buttons">
          <StoneButton onClick={() => game.open({ id: "exchange" })}>View in the Exchange</StoneButton>
        </div>
      </div>
    );
  } else if (order.status === "cancelled" || buy.step === "cancelled") {
    body = (
      <div className="rb-pay__center">
        <p className="rb-pay__status rs-b12 rb-ink-red">{buy.notice ?? "Your offer has been cancelled."}</p>
        <p className="rs-p12 rb-ink">Do not send any money for this offer.</p>
        {/* Collect forgets the order: a player who said they paid gets its details for support first. */}
        {paidClaimed(order) && (
          <>
            <p className="rs-p12 rb-ink">If you already paid, keep your payment receipt and get help with this order's details before you collect.</p>
            <HelpLine order={order} lead="Already paid?" tone="parchment" safety={false} />
          </>
        )}
        <div className="rb-buttons">
          <StoneButton
            onClick={() => {
              buy.reset();
              game.playSound("collect");
              game.close();
            }}
          >
            Collect
          </StoneButton>
        </div>
      </div>
    );
  } else if (buy.step === "verifying" || buy.step === "selectPayment" || buy.step === "fulfilling") {
    body = (
      <div className="rb-pay__center">
        <p className="rb-pay__status rs-b12 rb-ink">You said you have paid.</p>
        <p className="rs-p12 rb-ink">Your payment is being verified.</p>
        <div className="rb-buttons">
          <StoneButton onClick={() => game.open({ id: "verify" })}>Continue verifying</StoneButton>
        </div>
      </div>
    );
  } else if (verifyFailed) {
    body = <VerifyFailed buy={buy} order={order} />;
  } else if (ORDER_STEPS.has(buy.step) || buy.step === "idle") {
    body = <Instructions buy={buy} order={order} mobile={mobile} onCompact={setCompact} />;
    wide = !compact;
  } else {
    body = (
      <div className="rb-pay__center rs-p12 rb-ink">
        <PleaseWait />
      </div>
    );
  }

  return (
    <ParchmentScroll title="Payment" onClose={game.close} width={mobile ? 380 : wide ? 760 : 480} className={cx("rb-pay", mobile && "rb-pay--mobile")} ariaLabel="Payment">
      {body}
    </ParchmentScroll>
  );
}

/** "This offer has expired. Do not send money." above an expired order, in every state that shows one. */
function ExpiredBanner() {
  return (
    <p className="rb-pay__expired rs-b12" role="alert">
      This offer has expired. Do not send money.
    </p>
  );
}

/** "£100.00 to @revtag on Revolut, for 124.74 USDC." The order as a record once it is no longer a payment to make. */
function OrderRecord({ order, info }: { order: BuyOrder; info: PaymentInstructions }) {
  const bank = info.method && BUY_PLATFORMS[order.platform].verifyMethods.length > 1 ? ` (${info.method.label})` : "";
  return (
    <p className="rb-pay__record rs-p12 rb-ink-muted">
      Your offer: <span className="rb-ink">{info.amountText}</span> {info.payeeDisplay ? <>to <span className="rb-ink rs-selectable">{info.payeeDisplay}</span> </> : ""}on {info.platformName}
      {bank}, for <span className="rb-ink">{formatUsdc(order.usdcExpected)} USDC</span>.
    </p>
  );
}

/** An error while proving a payment: the player said they paid, so they go back to Verify, not to the instructions. */
function VerifyFailed({ buy, order }: { buy: BuyFlowStore; order: BuyOrder }) {
  const game = useGame();
  const deps = useBuyDeps();
  const info = getPaymentInstructions(order);
  const expired = useNow(deps.now, 5_000) >= order.expiresAt;
  return (
    <div className="rb-pay__body">
      {expired && <ExpiredBanner />}
      <div className="rb-pay__summary-head">
        <p className="rb-pay__status rs-b12 rb-ink">You said you have paid. It hasn't been verified yet.</p>
        <OrderRecord order={order} info={info} />
      </div>
      {buy.error && (
        <p className="rb-pay__callout rb-pay__callout--alert rs-p12" role="alert">
          {errorText(buy.error, expired)}
        </p>
      )}
      <VerifyOnComputer />
      <div className="rb-pay__footer">
        <div className="rb-buttons">
          <StoneButton onClick={() => game.open({ id: "verify" })}>Continue verifying</StoneButton>
        </div>
        <HelpLine order={order} tone="parchment" />
      </div>
    </div>
  );
}

/**
 * On a browser that can't prove payments (a phone, Safari, Firefox), where
 * the proving happens. Nothing on desktop Chrome.
 */
function VerifyOnComputer() {
  if (!useNeedsComputer()) return null;
  return (
    <div className="rb-pay__callout rb-pay__callout--alert" role="note">
      <p className="rs-b12 rb-ink-red">Prove this payment with the Peer extension in Chrome or Brave on a computer, before the offer expires.</p>
      <p className="rs-p12 rb-ink">{VERIFY_ON_COMPUTER_TEXT}</p>
    </div>
  );
}

/**
 * Peer web's extra "Extension" step while paying, as the scroll's third step:
 * on a browser that can run the Peer extension but doesn't have it (or has a
 * build too old for this platform), proving the payment needs it, with the
 * install (or update) button; a quiet line once it is installed. Never blocks
 * paying. While the scroll is open the store looks for the extension at
 * once, every few seconds and on focus (Peer web's version poll), so this
 * clears by itself once installed.
 */
function ExtensionHeadsUp({ buy, order, quiet }: { buy: BuyFlowStore; order: BuyOrder; quiet: boolean }) {
  const game = useGame();
  const { watchExtension } = buy;
  useEffect(() => watchExtension(), [watchExtension, order.intentHash]);
  const kind = extensionHeadsUp(buy.extension);
  if (!kind) {
    if (!quiet) return null;
    const installed = buy.extension === "ready" || buy.extension === "needs_connection";
    return (
      <p className="rs-p12 rb-ink">
        {installed ? "PeerAuth is installed. Once you have paid, press I have paid to prove it." : "Once you have paid, press I have paid and prove it with PeerAuth, the Peer extension."}
      </p>
    );
  }
  const open = () => {
    game.playSound("click");
    buy.openExtensionInstall();
  };
  const name = BUY_PLATFORMS[order.platform].name;
  if (kind === "update") {
    return (
      <div className="rb-pay__ext" role="note" aria-label="Peer extension">
        <div className="rb-pay__ext-text">
          <p className="rs-b12 rb-ink-red">Update the Peer extension</p>
          <p className="rs-p12 rb-ink">
            Yours is too old to prove {name} payments. It needs version {minExtensionVersion(order.platform)} or newer: go to {extensionsPage()}, turn on Developer mode,
            press Update, then reload this page.
          </p>
        </div>
        <StoneButton onClick={open}>Update Peer extension</StoneButton>
      </div>
    );
  }
  return (
    <div className="rb-pay__ext" role="note" aria-label="Peer extension">
      <div className="rb-pay__ext-text">
        <p className="rs-p12 rb-ink">Proving needs PeerAuth, the Peer extension. Add it to this browser now.</p>
        {buy.awaitingInstall && (
          <>
            <p className="rs-b12 rb-ink">
              <PleaseWait text="Waiting for PeerAuth" />
            </p>
            {/* Peer web: "Waiting for installation. Try refreshing page." */}
            <p className="rs-p12 rb-ink-muted">Added it and nothing changed? Reload this page. Your offer is saved.</p>
          </>
        )}
      </div>
      {!buy.awaitingInstall && <StoneButton onClick={open}>{addExtensionLabel()}</StoneButton>}
    </div>
  );
}

/** A numbered step of the scroll: "1  Before you pay". */
function Step({ n, title, children, className }: { n: number; title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={cx("rb-pay__step", className)} aria-labelledby={id}>
      <h3 id={id} className="rb-pay__stephead rs-q8">
        <span className="rb-pay__stepnum" aria-hidden="true">
          {n}.
        </span>
        <span className="rs-visually-hidden">Step {n}: </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The do / don't / warning mark beside a checklist line, drawn as pixel ink. */
function RuleMark({ kind }: { kind: ChecklistItem["kind"] }) {
  return (
    <svg className={cx("rb-rule__mark", `rb-rule__mark--${kind}`)} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true" shapeRendering="crispEdges">
      {kind === "do" ? (
        <path d="M1 5h2v1h1v1h1V6h1V5h1V4h1V3h1V2h1v2H9v1H8v1H7v1H6v1H5v1H4V8H3V7H2V6H1z" />
      ) : kind === "dont" ? (
        <path d="M1 1h2v1h1v1h2V2h1V1h2v2H8v1H7v2h1v1h1v2H7V8H6V7H4v1H3v1H1V7h1V6h1V4H2V3H1z" />
      ) : (
        <path d="M4 0h2v6H4zM4 8h2v2H4z" />
      )}
    </svg>
  );
}

function Checklist({ items, label }: { items: ChecklistItem[]; label: string }) {
  return (
    <ul className="rb-pay__rules" aria-label={label}>
      {items.map((item) => (
        <li key={item.text} className={cx("rb-rule rs-p12", item.kind === "warn" && "rb-rule--warn")}>
          <RuleMark kind={item.kind} />
          {item.important ? <strong className="rb-rule__text rs-b12">{item.text}</strong> : <span className="rb-rule__text">{item.text}</span>}
        </li>
      ))}
    </ul>
  );
}

/** A small parchment button that copies one value, saying "Copied" for a moment. */
function CopyButton({ what, label, copied, onCopy }: { what: string; label: string; copied: boolean; onCopy: () => void }) {
  return (
    <>
      <button type="button" className={cx("rb-copy rs-p11", copied && "rb-copy--done")} onClick={onCopy} aria-label={copied ? `${label} copied` : `Copy ${what}`}>
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="rs-visually-hidden" aria-live="polite">
        {copied ? `${label} copied.` : ""}
      </span>
    </>
  );
}

function Instructions({ buy, order, mobile, onCompact }: { buy: BuyFlowStore; order: BuyOrder; mobile: boolean; onCompact: (compact: boolean) => void }) {
  const game = useGame();
  const deps = useBuyDeps();
  const info = getPaymentInstructions(order);
  const platform = BUY_PLATFORMS[order.platform];
  // Derived from the clock, not from the countdown's callback: the countdown isn't mounted in every
  // state (a Zelle order waiting for its bank choice), and the expired banner must appear in all of them.
  const now = useNow(deps.now, 1000);
  const expired = now >= order.expiresAt;
  const needsComputer = useNeedsComputer();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  // A player who said they paid (persisted on the order, so it survives a reload) sees Verify first;
  // "I haven't paid yet" brings the instructions back.
  const [showSteps, setShowSteps] = useState(false);
  const [copied, setCopied] = useState<"payee" | "amount" | null>(null);
  // Like Peer's SendPayment, the payee, QR and pay link stay hidden until the buyer ticks that they read
  // the rules, and the tick never carries over to another order.
  const [ackFor, setAckFor] = useState<string | null>(null);
  const acknowledged = ackFor === order.intentHash;
  const busy = txInFlight(buy.step, buy.pending);
  // A phone held sideways is still a phone: it can open the app.
  const phone = useCompactLandscape() || mobile;
  // Where the web pay page takes cards Peer can't verify (Revolut, Monzo, Cash App, Chime), a computer
  // gets the QR only, as on Peer's web app (supportsSendingPaymentOnWeb: false).
  const qrOnly = platform.payOnWeb === false && !phone;
  // Phones open the app; computers open the web page. An app-only link gets a browser fallback beside it.
  const link = qrOnly ? null : mobile ? (info.deepLink ?? info.webLink) : (info.webLink ?? info.deepLink);
  const browserLink = mobile && info.webLink && info.webLink !== link ? info.webLink : null;
  // Alipay pays by the seller's account code from Curator; without it there is nothing to pay with.
  const unpayable = missingPayLink(platform, info);
  const versionText = peerAuthVersionText(platform);

  const copy = async (what: "payee" | "amount", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
    } catch {
      game.message("Your browser blocked copying. Select the text and copy it instead.");
    }
  };
  const paid = () => {
    game.playSound("click");
    void buy.markPaid();
    game.open({ id: "verify" });
  };
  const compact = buy.pending === "cancel" || confirmCancel || (confirmDismiss && expired) || (paidClaimed(order) && !showSteps) || expired;
  useLayoutEffect(() => onCompact(compact), [compact, onCompact]);

  if (buy.pending === "cancel") {
    return (
      <div className="rb-pay__center rs-p12 rb-ink">
        <p className="rb-pay__status rs-b12 rb-ink">
          <PleaseWait text="Cancelling your offer" />
        </p>
        <p className="rs-p12 rb-ink">Confirm it in your wallet if asked. Do not send money for this offer.</p>
      </div>
    );
  }

  if (confirmCancel) {
    return (
      <div className="rb-pay__center">
        <p className="rb-pay__status rs-b12 rb-ink">Cancel this offer?</p>
        <p className="rs-p12 rb-ink-red">Only cancel if you have not sent any money. Cancelled offers can't be verified.</p>
        <div className="rb-buttons">
          <StoneButton
            onClick={() => {
              setConfirmCancel(false);
              void buy.cancelOrder();
            }}
          >
            Yes, cancel it
          </StoneButton>
          <StoneButton onClick={() => setConfirmCancel(false)} autoFocus>
            No, keep it
          </StoneButton>
        </div>
      </div>
    );
  }

  if (confirmDismiss && expired) {
    return (
      <div className="rb-pay__center">
        <DismissOfferPrompt tone="parchment" onDone={() => setConfirmDismiss(false)} />
      </div>
    );
  }

  if (paidClaimed(order) && !showSteps) {
    return <PaidClaimed buy={buy} order={order} expired={expired} onShowSteps={() => setShowSteps(true)} />;
  }

  // The payee is named only once it is payable (a bank chosen for Zelle, the offer live, a way to pay it) and the rules are acknowledged.
  const payable = !info.needsMethodChoice && !expired && !unpayable;
  const revealed = payable && Boolean(info.payee) && acknowledged;
  const checklist = paymentChecklist(info);
  const showQr = Boolean(info.qrValue) && !mobile;

  const recovering = buy.recovering && (
    <p className="rs-p11 rb-ink-muted rb-pay__checking">
      <PleaseWait text="Checking your offer on the chain" />
    </p>
  );
  const notice = buy.notice && <p className="rs-p12 rb-ink rb-pay__notice">{buy.notice}</p>;
  const footer = (
    <div className="rb-pay__footer">
      {buy.step === "error" ? (
        <BuyErrorPanel tone="parchment" />
      ) : expired ? (
        <div className="rb-buttons">
          <StoneButton onClick={paid} disabled={busy || !info.payee}>
            I paid before it expired
          </StoneButton>
          <StoneButton onClick={() => setConfirmDismiss(true)} disabled={busy}>
            Dismiss offer
          </StoneButton>
        </div>
      ) : (
        <div className="rb-buttons">
          <StoneButton onClick={paid} disabled={busy || !info.payee || info.needsMethodChoice || !acknowledged || unpayable}>
            I have paid
          </StoneButton>
          <button type="button" className="rb-quiet rs-p12" onClick={() => setConfirmCancel(true)} disabled={busy} autoFocus={unpayable}>
            Cancel offer
          </button>
        </div>
      )}
      <OrderFees order={order} />
      {/* BuyErrorPanel carries its own help line. */}
      {buy.step !== "error" && <HelpLine order={order} tone="parchment" />}
    </div>
  );

  if (expired) {
    return (
      <div className="rb-pay__body">
        {recovering}
        {notice}
        <ExpiredBanner />
        <OrderRecord order={order} info={info} />
        {buy.step !== "error" && <VerifyOnComputer />}
        {footer}
      </div>
    );
  }

  return (
    <div className="rb-pay__body">
      {recovering}
      {notice}
      <div className="rb-pay__hero">
        <p className="rb-pay__send">
          <span className="rb-pay__verb rs-quill">Send</span> <span className="rb-pay__amount">{info.amountText}</span>
        </p>
        <p className="rb-pay__to rs-p12 rb-ink">
          {revealed ? (
            <>
              to <strong className="rb-strong rs-selectable">{info.payeeDisplay ?? "the seller"}</strong> on {info.platformName}
            </>
          ) : (
            <>on {info.platformName}</>
          )}
        </p>
        <p className="rb-pay__get rs-p12 rb-ink">
          You get <strong className="rb-strong">{formatUsdc(order.usdcExpected)} USDC</strong>
        </p>
        <p className="rb-pay__expiry rs-p11 rb-ink-muted">
          Expires in <CountdownText until={order.expiresAt} now={deps.now} warnBelowMs={EXPIRY_WARN_MS} expiredText="Expired" />
        </p>
      </div>

      <div className="rb-pay__columns">
        <Step n={1} title="Before you pay">
          <Checklist items={checklist} label={`${info.platformName} rules`} />
          {payable && info.payee && (
            <Checkbox
              className="rb-pay__ack"
              checked={acknowledged}
              onChange={(on) => setAckFor(on ? order.intentHash : null)}
              label="I have read these rules. Not following them can lose my money."
            />
          )}
        </Step>

        <Step n={2} title="Pay the seller">
          {info.needsMethodChoice ? (
            <div className="rb-pay__methods">
              <p className="rs-p12 rb-ink">Which bank will you pay from? You must verify with the same bank.</p>
              <div className="rb-buttons rb-buttons--wrap">
                {platform.verifyMethods.map((m) => (
                  <StoneButton key={m.id} onClick={() => buy.setVerifyMethod(m.id)} disabled={busy}>
                    {m.label}
                  </StoneButton>
                ))}
              </div>
            </div>
          ) : unpayable ? (
            <div className="rb-pay__callout rb-pay__callout--alert" role="alert">
              <p className="rs-b12 rb-ink-red">This seller's {info.platformName} payment code is missing, so this offer can't be paid. Don't send any money.</p>
              <p className="rs-p12 rb-ink">Cancel this offer, then pick another seller.</p>
            </div>
          ) : !info.payee ? (
            <div className="rb-pay__methods">
              <p className="rs-p12 rb-ink-red">The seller's payment details haven't loaded yet. Don't pay until they show here.</p>
              <div className="rb-buttons">
                <StoneButton onClick={() => void buy.recover()} disabled={buy.recovering}>
                  {buy.recovering ? "Checking..." : "Try again"}
                </StoneButton>
              </div>
            </div>
          ) : !acknowledged ? (
            <p className="rb-pay__locked rs-p12 rb-ink-muted">Tick the box under the rules to see who to pay.</p>
          ) : (
            <>
              <div className="rb-pay__how">
                <dl className="rb-pay__facts">
                  <div className="rb-pay__fact">
                    <dt className="rs-p12 rb-ink-muted">{info.payeeLabel}</dt>
                    <dd className="rs-b12 rb-ink rs-selectable">{info.payeeDisplay}</dd>
                    <dd className="rb-pay__copycell">
                      <CopyButton what={info.payeeLabel} label={info.payeeLabel} copied={copied === "payee"} onCopy={() => void copy("payee", info.payee ?? "")} />
                    </dd>
                  </div>
                  <div className="rb-pay__fact">
                    <dt className="rs-p12 rb-ink-muted">Amount</dt>
                    <dd className="rs-b12 rb-ink rs-selectable">{info.amountText}</dd>
                    <dd className="rb-pay__copycell">
                      <CopyButton what="the amount" label="Amount" copied={copied === "amount"} onCopy={() => void copy("amount", info.amount)} />
                    </dd>
                  </div>
                  {info.memo && (
                    <div className="rb-pay__fact">
                      <dt className="rs-p12 rb-ink-muted">Note</dt>
                      <dd className="rs-p12 rb-ink rs-selectable">{info.memo}</dd>
                    </div>
                  )}
                  {info.method && platform.verifyMethods.length > 1 && (
                    <div className="rb-pay__fact">
                      <dt className="rs-p12 rb-ink-muted">{platform.methodChoice === "beforePayment" ? "Bank" : "Account"}</dt>
                      <dd className="rs-p12 rb-ink">{info.method.label}</dd>
                    </div>
                  )}
                </dl>
                {(showQr || link) && (
                  <div className={cx("rb-pay__payrow", showQr && "rb-pay__payrow--qr")}>
                    {/* A phone can't scan its own screen: phones get the "Open" button only. */}
                    {showQr && info.qrValue && (
                      <span className="rb-pay__qr">
                        <QrCode value={info.qrValue} size={104} label={`QR code to pay ${info.payeeDisplay ?? "the seller"} on ${info.platformName}`} />
                      </span>
                    )}
                    <div className="rb-pay__payside">
                      {qrOnly && showQr && <p className="rs-p12 rb-ink">{qrCaption(platform)}</p>}
                      {link && (
                        <a className="rb-linkbtn rs-p12" href={link} target="_blank" rel="noopener noreferrer">
                          {payButtonLabel(platform)}
                        </a>
                      )}
                      {link && showQr && <p className="rs-p11 rb-ink-muted">Or scan the QR code with your phone.</p>}
                      {link && order.platform === "upi" && <p className="rs-p11 rb-ink-muted">Pick Amazon Pay if your phone asks which app to use.</p>}
                      {browserLink && (
                        <a className="rb-pay__weblink rs-p11" href={browserLink} target="_blank" rel="noopener noreferrer">
                          Open {info.platformName} in your browser instead
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <p className="rb-pay__callout rb-pay__safety rs-b12" role="note">
                Pay exactly this amount, to this handle, from your own account.
              </p>
            </>
          )}
        </Step>
      </div>

      {buy.step !== "error" && payable && (
        <Step n={3} title="Prove your payment">
          <VerifyOnComputer />
          <ExtensionHeadsUp buy={buy} order={order} quiet={!needsComputer} />
          {versionText && buy.extension !== "needs_update" && <p className="rs-p11 rb-ink-muted">{versionText}</p>}
        </Step>
      )}

      {footer}
    </div>
  );
}

/** "Fees already taken: 1.20 USDC Peer + 0.63 USDC RampRidge (0.5%)." when the order recorded them, or that RampRidge's was waived. */
function OrderFees({ order }: { order: BuyOrder }) {
  return (
    <>
      {order.fees && <p className="rs-p11 rb-ink-muted rb-pay__fees">{feesTakenText(feeBreakdown(order.fees))}</p>}
      <FeeWaivedNote order={order} tone="parchment" className="rb-pay__fees" />
    </>
  );
}

/**
 * The player has already said they paid (it survives a reload), so the scroll
 * sends them to Verify instead of showing "Send exactly" again, which would
 * invite a second payment. "I haven't paid yet" brings the instructions back.
 */
function PaidClaimed({ buy, order, expired, onShowSteps }: { buy: BuyFlowStore; order: BuyOrder; expired: boolean; onShowSteps: () => void }) {
  const game = useGame();
  const info = getPaymentInstructions(order);
  const verify = () => {
    game.playSound("click");
    game.open({ id: "verify" });
  };
  useEnterKey(buy.step === "error" ? null : verify);
  return (
    <div className="rb-pay__body">
      {expired && <ExpiredBanner />}
      <div className="rb-pay__summary-head">
        <p className="rb-pay__status rs-b12 rb-ink">You said you have paid. Verify your payment.</p>
        <OrderRecord order={order} info={info} />
      </div>
      {buy.step === "error" ? <BuyErrorPanel tone="parchment" /> : <VerifyOnComputer />}
      <div className="rb-pay__footer">
        <div className="rb-buttons">
          <StoneButton onClick={verify}>Verify your payment</StoneButton>
          <button type="button" className="rb-quiet rs-p12" onClick={onShowSteps}>
            I haven't paid yet
          </button>
        </div>
        {buy.step !== "error" && <HelpLine order={order} tone="parchment" />}
      </div>
    </div>
  );
}
