import { Fragment, useState, type ReactNode } from "react";
import { StoneButton, TextButton } from "@/ui/kit/buttons";
import { shortAddress } from "@/ui/kit/format";
import { PleaseWait } from "@/ui/kit/PleaseWait";
import { HelpLink } from "@/ui/interfaces/shared/help";
import { ShareButton } from "@/ui/interfaces/shared/ShareButton";

export type WalletKindLabel = "smart" | "embedded" | "external";

export interface AccountPanelProps {
  displayName: string;
  /** The player's world: "Invite a friend" links to it. */
  world?: number | null;
  /** Opens the rename dialog (NameEntry). */
  onRename?: () => void;
  /** Wallet address, or null when no wallet is logged in. */
  address: string | null;
  walletKind?: WalletKindLabel;
  /** True when the gas for this wallet is sponsored. */
  sponsored?: boolean;
  /** Wallet ownership proven to the game with a signed message. */
  verified: boolean;
  /** A login, verify or logout is in progress. */
  busy?: "login" | "verify" | "logout" | null;
  /** Plain-English error from the last attempt. */
  error?: string | null;
  onLogin: () => void;
  onVerify: () => void;
  onLogoutWallet: () => void;
  /** Opens Send USDC; the button shows only with a wallet that can send. */
  onSend?: () => void;
  /** Opens Receive (the address with a QR code). */
  onReceive?: () => void;
  /** How the player logged in ("Logged in with Google: ..."), the last line of the tab. */
  loginMethod?: string | null;
}

/** A soft break after each "@", so a long email wraps before its domain rather than a letter from its end. */
function breakAfterAt(text: string): ReactNode {
  return text.split("@").map((part, i) =>
    i === 0 ? (
      part
    ) : (
      <Fragment key={i}>
        @<wbr />
        {part}
      </Fragment>
    ),
  );
}

const KIND_TEXT: Record<WalletKindLabel, string> = {
  smart: "Smart wallet",
  embedded: "Embedded wallet",
  external: "External wallet",
};

/** Account tab: display name, an invite to share the bank, where to get help, wallet address, Send and Receive, verification and wallet logout. */
export function AccountPanel({
  displayName,
  world = null,
  onRename,
  address,
  walletKind,
  sponsored,
  verified,
  busy = null,
  error,
  onLogin,
  onVerify,
  onLogoutWallet,
  onSend,
  onReceive,
  loginMethod = null,
}: AccountPanelProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="rs-panel rs-account rs-p12">
      <h3 className="rs-panel__title rs-b12">Account</h3>
      <div className="rs-account__row">
        <span className="rs-c-orange rs-shadow">Name: </span>
        <span className="rs-c-white rs-shadow">{displayName}</span>
      </div>
      {onRename && (
        <TextButton tone="yellow" onClick={onRename} className="rs-account__link">
          Change display name
        </TextButton>
      )}
      {/* One line, so the panel keeps its height once a wallet is connected (the shell adds a login line below). */}
      <div className="rs-account__link rs-account__links">
        <ShareButton subject={{ kind: "invite", world }} variant="text" label="Invite a friend" />
        <HelpLink />
      </div>
      <hr className="rs-panel__rule" />
      {address ? (
        <>
          <div className="rs-account__row">
            <span className="rs-c-orange rs-shadow">Wallet: </span>
            <span className="rs-c-white rs-shadow rs-selectable" title={address}>
              {shortAddress(address)}
            </span>
          </div>
          {onSend || onReceive ? (
            // Receive shows the address with Copy and a QR code, so it takes Copy address's place.
            <div className="rs-account__wallet">
              {onSend && (
                <StoneButton onClick={onSend} disabled={busy !== null}>
                  Send USDC
                </StoneButton>
              )}
              {onReceive && (
                <StoneButton onClick={onReceive} disabled={busy !== null}>
                  Receive
                </StoneButton>
              )}
            </div>
          ) : (
            <TextButton tone="yellow" onClick={copy} className="rs-account__link" aria-live="polite">
              {copied ? "Address copied" : "Copy address"}
            </TextButton>
          )}
          {walletKind && (
            <p className="rs-account__meta rs-p11 rs-c-orange rs-shadow">
              {KIND_TEXT[walletKind]}
              {sponsored ? " - gas is free" : " - you pay gas"}
            </p>
          )}
          <p className="rs-account__status rs-shadow" style={{ color: verified ? "#00ff00" : "#ff981f" }}>
            {verified ? "Wallet verified." : "Verify your wallet to trade."}
          </p>
          <div className="rs-account__actions">
            {!verified &&
              (busy === "verify" ? (
                <PleaseWait className="rs-c-yellow rs-shadow" text="Check your wallet" />
              ) : (
                <StoneButton onClick={onVerify} disabled={busy !== null} wide>
                  Verify wallet
                </StoneButton>
              ))}
            {busy === "logout" ? (
              <PleaseWait className="rs-c-yellow rs-shadow" />
            ) : (
              <StoneButton onClick={onLogoutWallet} disabled={busy !== null} wide>
                Log out of wallet
              </StoneButton>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="rs-account__status rs-c-orange rs-shadow">No wallet connected. Log in to buy or sell USDC.</p>
          <div className="rs-account__actions">
            {busy === "login" ? (
              <PleaseWait className="rs-c-yellow rs-shadow" />
            ) : (
              <StoneButton onClick={onLogin} wide>
                Log in
              </StoneButton>
            )}
          </div>
        </>
      )}
      {error && (
        <p className="rs-account__error rs-shadow" role="alert">
          {error}
        </p>
      )}
      {/* In the panel's own flow, so it scrolls with the tab rather than squeezing it, and wraps whole. */}
      {loginMethod && (
        <p className="rs-account__method rs-p11 rs-c-orange rs-shadow" title={loginMethod}>
          {breakAfterAt(loginMethod)}
        </p>
      )}
    </div>
  );
}
