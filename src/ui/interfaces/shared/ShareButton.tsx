import { useEffect, useState, type CSSProperties } from "react";
import { SITE_URL, isShareId, sharePostText, shareUrl, siteUrlFor, xIntentUrl, type ShareSubject } from "@shared/share";
import { track } from "@/lib/telemetry";
import { BUTTON_TILES, NineSlice, TextButton } from "@/ui/kit/buttons";
import { cx } from "@/ui/kit/cx";

/**
 * Share a verified trade, or the bank itself, on X: a stone button that
 * opens X's compose screen with a line in the player's voice and the link.
 * A trade links to its own page (https://www.rampridge.xyz/t/{id}, which
 * unfurls as the trade's card) once the server has saved the trade's share
 * record; until then, or if it never does (an announcement that failed or
 * was declined), the button shares the site. Beside it, "Copy link", or
 * the device's own share sheet where there is one.
 *
 * The button is a link, not a script-opened window, so phones hand it
 * straight to the X app and pop-up blockers leave it alone.
 */

export interface ShareButtonProps {
  subject: ShareSubject;
  /** The trade's share id (shareIdFor in shared/share.ts); null or absent shares the site. */
  shareId?: string | null;
  /** Stone button label. */
  label?: string;
  /** Full-width stone button (side panel). */
  wide?: boolean;
  /** Hide the copy / share sheet option. */
  primaryOnly?: boolean;
  /**
   * "text": a single yellow text option (the Account tab's "Invite a friend")
   * that opens the device's share sheet on phones and X elsewhere.
   */
  variant?: "stone" | "text";
  className?: string;
}

/** How long after mounting the trade's record is looked for: about a minute, most often in the first seconds. */
const CHECK_DELAYS_MS = [0, 1_500, 3_000, 5_000, 8_000, 12_000, 16_000, 20_000];
/** Ids whose record exists; records are never removed, so this session never asks again. */
const confirmed = new Set<string>();

async function recordExists(id: string): Promise<boolean> {
  const response = await fetch(`/api/share?id=${encodeURIComponent(id)}&format=json`, { cache: "no-store" });
  return response.ok;
}

/** True once the trade's share record exists on the server. */
export function useShareRecord(shareId: string | null | undefined): boolean {
  const id = shareId && isShareId(shareId) ? shareId : null;
  const [found, setFound] = useState<string | null>(() => (id && confirmed.has(id) ? id : null));
  useEffect(() => {
    if (!id || confirmed.has(id)) return;
    let cancelled = false;
    let timer = 0;
    let attempt = 0;
    const check = async () => {
      try {
        if (await recordExists(id)) {
          confirmed.add(id);
          if (!cancelled) setFound(id);
          return;
        }
      } catch {
        // Offline or the API is down: try again on the next tick.
      }
      attempt += 1;
      if (!cancelled && attempt < CHECK_DELAYS_MS.length) timer = window.setTimeout(() => void check(), CHECK_DELAYS_MS[attempt]);
    };
    timer = window.setTimeout(() => void check(), CHECK_DELAYS_MS[0]);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id]);
  return id !== null && (found === id || confirmed.has(id));
}

function canNativeShare(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

const LINK_STYLE: CSSProperties = { textDecoration: "none", cursor: "pointer" };

export function ShareButton({ subject, shareId, label = "Share on X", wide = false, primaryOnly = false, variant = "stone", className }: ShareButtonProps) {
  const linked = useShareRecord(subject.kind === "invite" ? null : shareId);
  // An invite asks for the inviter's world, so the friend lands beside them (when it has room).
  const url = linked && shareId ? shareUrl(shareId) : subject.kind === "invite" ? siteUrlFor(subject.world) : SITE_URL;
  const text = sharePostText(subject);
  const [copied, setCopied] = useState(false);
  const [native] = useState(canNativeShare);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const other = async () => {
    track("share_click");
    if (native) {
      try {
        await navigator.share({ text, url });
      } catch {
        // Dismissed.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const intent = xIntentUrl(text, url);

  if (variant === "text") {
    return native ? (
      <TextButton tone="yellow" onClick={() => void other()} className={className}>
        {label}
      </TextButton>
    ) : (
      <a
        className={cx("rs-textbtn rs-p12 rs-textbtn--yellow", className)}
        href={intent}
        target="_blank"
        rel="noopener noreferrer"
        style={LINK_STYLE}
        onClick={() => track("share_click")}
      >
        {label}
      </a>
    );
  }

  return (
    <span className={cx("rr-share", className)} style={{ display: "inline-flex", flexDirection: wide ? "column" : "row", alignItems: "center", gap: wide ? 6 : 12, width: wide ? "100%" : undefined }}>
      <a
        className={cx("rs-btn rs-p12", wide && "rs-btn--wide")}
        href={intent}
        target="_blank"
        rel="noopener noreferrer"
        style={LINK_STYLE}
        onClick={() => track("share_click")}
        data-share-url={url}
        title={linked ? "Share this trade on X" : "Share RampRidge on X"}
      >
        <NineSlice tiles={BUTTON_TILES.grey} base="#50504c" light="#6e6c66" dark="#2e2d2a" />
        <span className="rs-btn__label">{label}</span>
      </a>
      {!primaryOnly && (
        <TextButton tone="yellow" onClick={() => void other()} aria-live="polite">
          {native ? "More ways to share" : copied ? "Link copied" : "Copy link"}
        </TextButton>
      )}
    </span>
  );
}
