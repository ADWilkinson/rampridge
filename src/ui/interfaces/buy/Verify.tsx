import { useCallback, useEffect, useState, type ReactNode } from "react";
import { shareIdFor, usdcFromUnits } from "@shared/share";
import { CAPTURE_SAFETY_MS, type BuyFlowStore, type BuyOrder } from "@/peer/buy";
import { formatFiat, formatUsdc } from "@/peer/format";
import { BUY_PLATFORMS, minExtensionVersion } from "@/peer/platforms";
import { CountdownText, ItemSlot, PleaseWait, ScrollArea, StoneButton, TextButton, Window, cx, useIsMobile, useNow } from "@/ui/kit";
import { useGame } from "../context";
import { ShareButton } from "../shared/ShareButton";
import { useBuy, useBuyDeps } from "./deps";
import { useBuyOrderEvents } from "./events";
import { useEnterKey, useWindowFocus } from "./hooks";
import { addExtensionLabel, extensionsPage, paidClaimed, paymentRowAmount, paymentRowDate, peerAuthVersionText, rowMatchesOrder, verifySite } from "./model";
import { BuyErrorPanel, FeeWaivedNote, HelpLine, LoginButton, VERIFY_ON_COMPUTER_TEXT, Waiting, usdcItem } from "./parts";

/**
 * Proving the payment with the Peer extension: install, connect, capture,
 * then the player picks the payment that matches (never auto-selected), the
 * proof is checked and the USDC released.
 */
export function VerifyInterface() {
  const game = useGame();
  const buy = useBuy();
  useBuyOrderEvents();
  const mobile = useIsMobile();
  // Peer web titles its prove step by what it needs first: "Install PeerAuth Extension", "Update Extension".
  const prompt = buy.step === "verifying" && buy.order?.status === "active" ? buy.verifying : null;
  const title = prompt === "needsInstall" ? "Install the Peer extension" : prompt === "needsUpdate" ? "Update the Peer extension" : "Verify payment";
  const tall = prompt === "needsInstall" || prompt === "needsUpdate";
  return (
    <Window
      title={title}
      width={mobile ? 374 : 456}
      height={mobile ? 520 : tall ? 392 : 340}
      onClose={game.close}
      className={cx("rb-verify", mobile && "rb-verify--mobile")}
      bodyClassName="rb-verify__body"
    >
      <VerifyBody buy={buy} />
    </Window>
  );
}

function VerifyBody({ buy }: { buy: BuyFlowStore }) {
  const game = useGame();
  const order = buy.order;
  // While an open offer is on screen the store looks for the extension (Peer web's version poll): at
  // once, every few seconds and on focus while it is missing or too old. A fresh install injects itself
  // into open tabs, so the install prompt moves on to connecting by itself; nothing is ever prompted.
  const { watchExtension, checkExtension } = buy;
  const watching = order?.status === "active";
  useEffect(() => (watching ? watchExtension() : undefined), [watchExtension, watching]);
  // Back from the extension's approval window, which stays open 2 minutes while requestConnection()
  // gives up after 30 s: re-check on focus, silently, never while a connect or capture is pending.
  const recheckOnFocus = buy.step === "verifying" && buy.pending === null && buy.verifying === "needsConnection";
  const recheck = useCallback(() => void checkExtension(), [checkExtension]);
  useWindowFocus(recheck, recheckOnFocus);

  if (!game.sender) {
    return (
      <Panel>
        <p className="rs-p12 rs-c-orange rs-shadow">You need to log in to trade.</p>
        <div className="rb-buttons">
          <LoginButton />
        </div>
      </Panel>
    );
  }
  if (!order) {
    return (
      <Panel>
        {buy.recovering ? (
          <Waiting text="Checking your offers" />
        ) : (
          <>
            <p className="rs-p12 rs-c-orange rs-shadow">You have no buy offer to verify.</p>
            <div className="rb-buttons">
              <StoneButton onClick={() => game.open({ id: "exchange", side: "buy" })}>Open the Exchange</StoneButton>
            </div>
          </>
        )}
      </Panel>
    );
  }
  if (buy.step === "completed" || order.status === "fulfilled") return <Completed buy={buy} order={order} />;
  if (buy.step === "cancelled" || order.status === "cancelled") {
    return (
      <Panel>
        <p className="rs-p12 rs-c-stone-red rs-shadow">{buy.notice ?? "This offer was cancelled."}</p>
        {paidClaimed(order) ? (
          <p className="rs-p12 rs-c-orange rs-shadow">It can no longer be verified. If you already paid, keep your payment receipt and get help with this order's details.</p>
        ) : (
          <p className="rs-p12 rs-c-orange rs-shadow">There is nothing left to verify.</p>
        )}
        <div className="rb-buttons">
          <StoneButton onClick={() => game.open({ id: "exchange" })}>View in the Exchange</StoneButton>
        </div>
        {paidClaimed(order) && <HelpLine order={order} lead="Already paid?" safety={false} />}
      </Panel>
    );
  }

  const name = BUY_PLATFORMS[order.platform].name;
  // Where the extension reads the payment: UPI's from Amazon Pay on amazon.in, Alipay's from alipay.com.
  const site = verifySite(BUY_PLATFORMS[order.platform]);
  const account = order.platform === "upi" ? "Amazon Pay" : name;
  const header = <OrderLine order={order} />;

  if (buy.step === "error") {
    return (
      <Panel header={header}>
        <BuyErrorPanel />
      </Panel>
    );
  }
  if (buy.step === "fulfilling") {
    return (
      <Panel header={header}>
        <Waiting text="Verifying your payment" detail="The proof is being checked and your USDC released. This can take a minute. Keep this tab open." />
      </Panel>
    );
  }
  if (buy.step === "selectPayment") return <SelectPayment buy={buy} order={order} header={header} />;
  if (buy.step === "verifying") {
    switch (buy.verifying) {
      case "needsInstall":
        return (
          <Panel header={header}>
            <InstallExtension buy={buy} account={account} />
            <BackToPayment buy={buy} />
          </Panel>
        );
      case "needsUpdate":
        return (
          <Panel header={header}>
            <UpdateExtension buy={buy} name={name} minimum={minExtensionVersion(order.platform)} />
            <BackToPayment buy={buy} />
          </Panel>
        );
      case "unsupportedBrowser":
        return (
          <Panel header={header}>
            <p className="rs-p12 rs-c-orange rs-shadow">This browser can't run the Peer extension. Verify in Chrome or Brave on a computer.</p>
            <p className="rs-p12 rs-c-white rs-shadow">{VERIFY_ON_COMPUTER_TEXT}</p>
            <p className="rs-p12 rs-c-stone-red rs-shadow">Verify before the offer expires.</p>
            <BackToPayment buy={buy} />
            <HelpLine order={order} />
          </Panel>
        );
      case "needsConnection":
        return (
          <Panel header={header}>
            <p className="rs-p12 rs-c-orange rs-shadow">Connect the Peer extension so it can prove your {name} payment.</p>
            {buy.notice && <p className="rs-p12 rs-c-yellow rs-shadow">{buy.notice}</p>}
            <div className="rb-buttons">
              <StoneButton onClick={() => void buy.connectExtension()} disabled={buy.pending === "connect"}>
                {buy.pending === "connect" ? "Waiting for approval..." : "Connect the Peer extension"}
              </StoneButton>
            </div>
            <BackToPayment buy={buy} />
          </Panel>
        );
      case "capturing":
        return (
          <Panel header={header}>
            <Waiting text="Waiting for your payments" detail={`Log in to ${site} in the tab the extension opened. Your recent payments will appear here.`} />
            <BackToPayment buy={buy} label="Stop and go back" />
          </Panel>
        );
      default:
        return (
          <Panel header={header}>
            <Waiting text="Checking for the Peer extension" />
          </Panel>
        );
    }
  }
  return <Ready buy={buy} order={order} header={header} />;
}

/**
 * Peer web's InstallExtension: what PeerAuth will and won't do, then "Add to
 * Chrome" (or Brave). The store looks for the extension while this is open
 * (at once, every few seconds, on focus); once it appears this moves on to
 * connecting it.
 */
function InstallExtension({ buy, account }: { buy: BuyFlowStore; account: string }) {
  const game = useGame();
  const waiting = buy.awaitingInstall;
  const add = () => {
    game.playSound("click");
    buy.openExtensionInstall();
  };
  useEnterKey(waiting ? null : add);
  return (
    <>
      <p className="rs-p12 rs-c-orange rs-shadow">Proving your payment needs the Peer extension, PeerAuth. It's free on the Chrome Web Store.</p>
      <div className="rb-consent">
        <div>
          <p className="rs-p12 rs-c-yellow rs-shadow">It will:</p>
          <ul className="rb-consent__list rs-p12 rs-c-white rs-shadow">
            <li>Ask before it reads anything for RampRidge</li>
            <li>Read only details of your recent {account} payments</li>
            <li>Encrypt what it reads for Peer's secure enclave</li>
          </ul>
        </div>
        <div>
          <p className="rs-p12 rs-c-yellow rs-shadow">It will never:</p>
          <ul className="rb-consent__list rs-p12 rs-c-white rs-shadow">
            <li>Make payments for you</li>
          </ul>
        </div>
      </div>
      <div className="rb-buttons">
        <StoneButton size="big" onClick={add} disabled={waiting}>
          {waiting ? <PleaseWait text="Waiting for PeerAuth" /> : addExtensionLabel()}
        </StoneButton>
      </div>
      {waiting ? (
        <p className="rs-p11 rs-c-yellow rs-shadow">
          This moves on by itself once PeerAuth is added. If it doesn't, reload this page. Your offer is saved.{" "}
          <TextButton font="p11" tone="orange" onClick={() => buy.openExtensionInstall()}>
            Open the Web Store again
          </TextButton>
        </p>
      ) : (
        <p className="rs-p11 rs-c-yellow rs-shadow">Add it in the tab that opens, then come back here. Your offer is saved.</p>
      )}
    </>
  );
}

/**
 * Peer web's update path: a browser doesn't re-inject an updated extension
 * into open tabs, so after updating, the page is reloaded rather than
 * re-checked.
 */
function UpdateExtension({ buy, name, minimum }: { buy: BuyFlowStore; name: string; minimum: string }) {
  return (
    <>
      <p className="rs-p12 rs-c-orange rs-shadow">
        Your Peer extension is out of date and can't prove {name} payments yet. It needs version {minimum} or newer.
      </p>
      <ol className="rb-consent__list rb-consent__list--steps rs-p12 rs-c-white rs-shadow">
        <li>Open a new tab and go to {extensionsPage()}</li>
        <li>Turn on Developer mode (top right)</li>
        <li>Press Update (top left)</li>
        <li>Come back here and reload this page</li>
      </ol>
      <div className="rb-buttons">
        <StoneButton onClick={() => buy.openExtensionInstall()}>Update Peer extension</StoneButton>
        {/* An updated extension is not re-injected into open tabs: reload rather than re-check. */}
        <StoneButton onClick={() => window.location.reload()}>I've updated it</StoneButton>
      </div>
      <p className="rs-p11 rs-c-yellow rs-shadow">Restarting the browser also updates it. Then reload this page. Your offer is saved.</p>
    </>
  );
}

function Panel({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className="rb-verify__panel">
      {header}
      <div className="rb-verify__content">{children}</div>
    </div>
  );
}

/** "Offer: £100.00 to @revtag on Revolut, for 124.74 USDC", so the payment to look for is named in full. */
function OrderLine({ order }: { order: BuyOrder }) {
  const deps = useBuyDeps();
  const expired = useNow(deps.now, 5_000) >= order.expiresAt;
  const platform = BUY_PLATFORMS[order.platform];
  return (
    <p className="rb-verify__order rs-p12 rs-shadow">
      <span className="rs-c-orange">Offer: </span>
      <span className="rs-c-white">
        {formatFiat(order.fiatToSend, order.currency)}
        {order.payeeHandle ? ` to ${platform.formatPayee(order.payeeHandle)}` : ""} on {platform.name}, for {formatUsdc(order.usdcExpected)} USDC
      </span>
      {expired ? <span className="rs-c-stone-red"> (expired)</span> : null}
    </p>
  );
}

function BackToPayment({ buy, label = "Back to payment" }: { buy: BuyFlowStore; label?: string }) {
  const game = useGame();
  return (
    <div className="rb-buttons">
      <StoneButton
        onClick={() => {
          buy.back();
          game.open({ id: "payment" });
        }}
      >
        {label}
      </StoneButton>
    </div>
  );
}

/** Before verifying: the method choice where a platform has several, then "Verify with Peer". */
function Ready({ buy, order, header }: { buy: BuyFlowStore; order: BuyOrder; header: ReactNode }) {
  const game = useGame();
  const deps = useBuyDeps();
  const platform = BUY_PLATFORMS[order.platform];
  const expired = deps.now() >= order.expiresAt;
  const methods = platform.verifyMethods;
  const chosen = order.verifyMethodId ?? (platform.methodChoice === "beforePayment" ? null : (methods[0]?.id ?? null));
  useEnterKey(chosen && buy.pending === null ? () => void buy.startVerification() : null);
  return (
    <Panel header={header}>
      <p className="rs-p12 rs-c-orange rs-shadow">Once you have paid, prove it with the Peer extension. It opens {verifySite(platform)} in a new tab.</p>
      {peerAuthVersionText(platform) && <p className="rs-p11 rs-c-yellow rs-shadow">{peerAuthVersionText(platform)}</p>}
      {methods.length > 1 && (
        <div className="rb-verify__methods">
          <p className="rs-p12 rs-c-orange rs-shadow">{platform.methodChoice === "beforePayment" ? "Which bank did you pay from?" : "Which account did you pay from?"}</p>
          <div className="rb-buttons rb-buttons--wrap">
            {methods.map((m) => (
              <StoneButton key={m.id} selected={chosen === m.id} onClick={() => buy.setVerifyMethod(m.id)} aria-pressed={chosen === m.id}>
                {m.label}
              </StoneButton>
            ))}
          </div>
        </div>
      )}
      {expired && <p className="rs-p12 rs-c-stone-red rs-shadow">This offer has expired. Only verify if you paid before it expired.</p>}
      <div className="rb-buttons">
        <StoneButton size="big" onClick={() => void buy.startVerification()} disabled={!chosen || buy.pending !== null}>
          Verify with Peer
        </StoneButton>
        <StoneButton size="big" onClick={() => game.open({ id: "payment" })}>
          Back to payment
        </StoneButton>
      </div>
    </Panel>
  );
}

/** The captured payments: the player clicks the one that matches, then verifies it. */
function SelectPayment({ buy, order, header }: { buy: BuyFlowStore; order: BuyOrder; header: ReactNode }) {
  const deps = useBuyDeps();
  const game = useGame();
  const [picked, setPicked] = useState<number | null>(null);
  const rows = buy.payments;
  const matches = rows.filter((r) => rowMatchesOrder(r, order)).length;
  // Peer's web client (#1888): a Revolut list with no recipient on any row is a partial capture. The
  // attestation rejects those rows ("missing recipient username"), so send the buyer to Check again first.
  const noRecipients = order.platform === "revolut" && rows.length > 0 && rows.every((r) => !r.recipient);
  const pickedRow = rows.find((r) => r.index === picked) ?? null;
  // The store refuses a pick this close to the capture's expiry, so the list ends here too (Peer's PAYMENTS_EXPIRED).
  const listDeadline = buy.captureExpiresAt === null ? null : buy.captureExpiresAt - CAPTURE_SAFETY_MS;
  const listExpired = useNow(deps.now, 1_000) >= (listDeadline ?? Number.POSITIVE_INFINITY);
  const verify = () => {
    if (pickedRow === null || buy.pending !== null || listExpired) return;
    game.playSound("click");
    void buy.choosePayment(pickedRow.index);
  };
  useEnterKey(pickedRow && !listExpired ? verify : null);
  return (
    <Panel header={header}>
      <p className="rs-p12 rs-c-orange rs-shadow">
        Click the payment you sent for this offer: <span className="rs-c-white">{formatFiat(order.fiatToSend, order.currency)}</span>.
      </p>
      {noRecipients ? (
        <p className="rs-p11 rs-c-stone-red rs-shadow">Recipient details are missing. Press Check again and log in to Revolut again.</p>
      ) : matches > 0 ? (
        <p className="rs-p11 rs-c-yellow rs-shadow">Payments marked "Amount matches" are for the right amount. Check the recipient and date too.</p>
      ) : (
        <p className="rs-p11 rs-c-yellow rs-shadow">
          None of these show exactly {formatFiat(order.fiatToSend, order.currency)}. Pick the payment you sent for this offer and check the recipient and date. If you already paid for this offer, do not pay again.
        </p>
      )}
      <ScrollArea className="rb-rows-scroll" label="Your recent payments">
        <ul className="rb-payrows" role="radiogroup" aria-label="Your recent payments">
          {rows.map((row) => {
            const match = rowMatchesOrder(row, order);
            const on = picked === row.index;
            return (
              <li key={row.index}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-row={row.index}
                  className={cx("rb-payrow", on && "rb-payrow--on")}
                  onClick={() => setPicked(row.index)}
                  disabled={buy.pending !== null || listExpired}
                >
                  <span className="rb-payrow__amount rs-p12 rs-c-white rs-shadow">{paymentRowAmount(row, order.currency)}</span>
                  <span className="rb-payrow__to rs-p12 rs-c-orange rs-shadow">{row.recipient ? `to ${row.recipient}` : "Recipient not shown"}</span>
                  <span className="rb-payrow__date rs-p11 rs-c-quiet rs-shadow">{paymentRowDate(row.date, order.platform)}</span>
                  {match && <span className="rb-payrow__match rs-p11 rs-c-green rs-shadow">Amount matches</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
      <div className="rb-buttons">
        <StoneButton onClick={verify} disabled={pickedRow === null || buy.pending !== null || listExpired}>
          Verify this payment
        </StoneButton>
        <StoneButton onClick={() => void buy.startVerification()} disabled={buy.pending !== null}>
          Check again
        </StoneButton>
      </div>
      {/* Like every other Verify state: back to the scroll, where an unpaid offer can be cancelled. */}
      <BackToPayment buy={buy} />
      {listDeadline !== null &&
        (listExpired ? (
          <p className="rs-p11 rs-c-stone-red rs-shadow">This list has expired. Check again to load your payments.</p>
        ) : (
          <p className="rs-p11 rs-c-orange rs-shadow">
            This list expires in <CountdownText until={listDeadline} now={deps.now} warnBelowMs={60_000} />.
          </p>
        ))}
    </Panel>
  );
}

function Completed({ buy, order }: { buy: BuyFlowStore; order: BuyOrder }) {
  const game = useGame();
  const usdc = buy.completion?.usdcReceived ?? order.usdcExpected;
  // The purchase's share link, once its announcement is saved (no release transaction: nothing was announced).
  const completion = buy.completion;
  const shareId =
    completion && game.me && completion.fulfillTxHash.toLowerCase() !== completion.intentHash.toLowerCase()
      ? shareIdFor("bought", completion.fulfillTxHash, game.me.pid)
      : null;
  const collect = () => {
    buy.reset();
    game.playSound("collect");
    game.close();
  };
  useEnterKey(collect);
  return (
    <Panel>
      <div className="rb-done">
        <p className="rb-done__title rs-b12 rs-c-yellow rs-shadow">Congratulations!</p>
        <span className="rb-itembox rb-itembox--big">
          <ItemSlot item={usdcItem(usdc)} />
        </span>
        <p className="rs-p12 rs-c-white rs-shadow">You bought {formatUsdc(usdc)} USDC.</p>
        <p className="rs-p12 rs-c-orange rs-shadow">
          It's in your wallet. You paid {formatFiat(buy.completion?.fiatSent ?? order.fiatToSend, order.currency)} on {BUY_PLATFORMS[order.platform].name}.
        </p>
        <FeeWaivedNote order={order} />
        <div className="rb-buttons">
          <StoneButton size="big" onClick={collect}>
            Collect
          </StoneButton>
        </div>
        <ShareButton subject={{ kind: "bought", usdc: usdcFromUnits(usdc), platform: order.platform }} shareId={shareId} />
      </div>
    </Panel>
  );
}
