import { useEffect, useRef, useState, type RefObject } from "react";
import { getAddress } from "viem";
import { QrCode, StoneButton, Window, cx } from "@/ui/kit";
import type { TxSender } from "@/wallet/types";
import { useGame, type InterfaceProps } from "../context";
import { useKeyboardFirst, useSendSize } from "./deps";
import { GroupedAddress, LoggedOut } from "./SendInterface";

export const RECEIVE_WARNING = "Send only USDC on Base to this address. Other tokens or networks may be lost.";

/** What kind of wallet this is, and whether it needs ETH, in one line. */
export function walletNote(sender: Pick<TxSender, "kind" | "sponsored">): string {
  if (sender.kind === "smart") {
    return "This is a smart wallet, set up for your email or Google login. It needs no ETH: the bank pays its network fees.";
  }
  if (sender.sponsored) return "This wallet was set up for your email or Google login. The bank pays its network fees.";
  return "This is your own wallet. Sending from it needs a little ETH on Base for network fees.";
}

/**
 * Receive: the wallet's address on Base in full (checksummed, in 4-character
 * groups) with Copy and a QR code, so a player can fund a sell from another
 * wallet or an exchange.
 */
export function ReceiveInterface(_props: InterfaceProps<"receive">) {
  const { sender, login, close } = useGame();
  const size = useSendSize({ width: 440, height: 340 }, 520, { width: 560, height: 300 });
  // With a keyboard it opens on Copy, the one thing to do here.
  const copyButton = useRef<HTMLButtonElement>(null);
  const keyboard = useKeyboardFirst(size.layout);
  return (
    <Window
      title="Receive USDC"
      width={size.width}
      height={size.height}
      onClose={close}
      draggable
      initialFocus={keyboard ? copyButton : undefined}
      className={cx("sd-window", `sd--${size.layout}`)}
    >
      {sender ? <ReceiveBody sender={sender} layout={size.layout} copyButton={copyButton} /> : <LoggedOut onLogin={login} />}
    </Window>
  );
}

interface ReceiveBodyProps {
  sender: TxSender;
  layout: "desktop" | "phone" | "landscape";
  copyButton: RefObject<HTMLButtonElement | null>;
}

function ReceiveBody({ sender, layout, copyButton }: ReceiveBodyProps) {
  const address = getAddress(sender.address);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(address);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
    timer.current = window.setTimeout(() => setCopied(null), 2_000);
  };
  const qrSize = layout === "phone" ? 156 : layout === "landscape" ? 136 : 132;
  return (
    <div className={cx("sd-receive", `sd-receive--${layout}`)} data-send-state="receive">
      <div className="sd-receive__qr">
        <QrCode value={address} size={qrSize} label="QR code of your wallet address" />
      </div>
      <div className="sd-receive__text">
        <p className="rs-p12 rs-c-orange rs-shadow">Your wallet address on Base:</p>
        <GroupedAddress address={address} label="Your wallet address" />
        <div className="sd-row">
          <StoneButton ref={copyButton} className="sd-btn" onClick={() => void copy()} aria-live="polite">
            {copied === "yes" ? "Copied" : "Copy address"}
          </StoneButton>
          {copied === "failed" && <span className="sd-alert rs-p12 rs-c-red rs-shadow">Couldn't copy. Tap or click the address to select it, then copy.</span>}
        </div>
        <p className="sd-alert rs-p12 rs-c-red rs-shadow">{RECEIVE_WARNING}</p>
        <p className="rs-p12 rs-c-white rs-shadow">{walletNote(sender)}</p>
      </div>
    </div>
  );
}
