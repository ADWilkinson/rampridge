import { useEffect, useState } from "react";
import type { BuyOrder } from "@/peer/buy";
import { TextButton, type TextTone } from "@/ui/kit/buttons";
import { cx } from "@/ui/kit/cx";

/**
 * Where a player goes when a trade goes wrong: the RampRidge account on X
 * (the launch thread posts from it), a "Get help" link to it, and "Copy
 * order details" so a buyer can hand over the facts of their order without
 * retyping a 66-character hash.
 *
 * Imported by the frame, bank and info interfaces as well as the buy flow,
 * so it stays light: type-only imports from @/peer (the Peer SDKs and viem
 * must never reach the title screen's download, see src/app/titleGraph.test.ts)
 * and the kit's own modules rather than its index.
 */

/** Where players get help. The launch thread posts from this account. */
export const HELP_URL = "https://x.com/andrewwilkinson";
export const HELP_HANDLE = "@andrewwilkinson";

/** Said beside every help link: the scam this bank's chat filter exists to stop. */
export const HELP_SAFETY_LINE = "We will never DM you first or ask you to send money.";

/**
 * A text option that opens the help account on X in a new tab. `underline`
 * for ink on parchment, where a link needs more than its colour.
 */
export function HelpLink({
  label = "Get help",
  tone = "yellow",
  underline = false,
  className,
}: {
  label?: string;
  tone?: TextTone;
  underline?: boolean;
  className?: string;
}) {
  return (
    <a
      className={cx("rs-textbtn rs-p12", `rs-textbtn--${tone}`, className)}
      href={HELP_URL}
      target="_blank"
      rel="noopener noreferrer"
      style={{ textDecoration: underline ? "underline" : "none", cursor: "pointer" }}
      title={`Message ${HELP_HANDLE} on X`}
    >
      {label}
    </a>
  );
}

/** The order fields a support request needs. */
export type OrderDetailsInput = Pick<BuyOrder, "intentHash" | "fiatToSendText" | "currency" | "platform" | "usdcExpected" | "signaledAt">;

/** 6-decimal USDC base units as "124.75" (cents kept, trailing zeros past them trimmed). */
function usdcText(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

/** "2026-10-11 14:03 UTC" */
function utcText(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A platform id as a name when the caller has none ("cashapp" -> "Cashapp"). */
function platformFallback(id: string): string {
  return id ? id[0]!.toUpperCase() + id.slice(1) : "Unknown";
}

/**
 * The plain-text order summary "Copy order details" puts on the clipboard:
 * the intent hash (which identifies the order on-chain), what was owed, the
 * method, the USDC expected and when it was placed. No payee handle or wallet
 * address: the hash is enough to look the rest up.
 */
export function orderDetailsText(order: OrderDetailsInput, platformName?: string): string {
  return [
    "RampRidge buy order",
    `Intent: ${order.intentHash}`,
    `Payment: ${order.fiatToSendText} ${order.currency} on ${platformName || platformFallback(order.platform)}`,
    `USDC expected: ${usdcText(order.usdcExpected)}`,
    `Placed: ${utcText(order.signaledAt)}`,
  ].join("\n");
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Blocked (some in-app browsers): try the old way below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** "Copy order details": puts orderDetailsText on the clipboard and says so. */
export function CopyOrderDetails({
  order,
  platformName,
  label = "Copy order details",
  tone = "yellow",
  className,
}: {
  order: OrderDetailsInput;
  platformName?: string;
  label?: string;
  tone?: TextTone;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2_500);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <TextButton
      tone={tone}
      className={className}
      aria-live="polite"
      onClick={() => {
        void copyText(orderDetailsText(order, platformName)).then((ok) => setState(ok ? "copied" : "failed"));
      }}
    >
      {state === "copied" ? "Order details copied" : state === "failed" ? "Copying was blocked" : label}
    </TextButton>
  );
}
