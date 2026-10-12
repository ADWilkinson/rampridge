import type { ReactNode } from "react";
import { useStore } from "zustand";
// The kit's stylesheet without the kit barrel: these screens are in the entry chunk, before the game loads.
// oxlint-disable-next-line import/no-unassigned-import
import "@/ui/kit/kit.css";
import { StoneButton } from "@/ui/kit/buttons";
import { updateStore } from "./update";

export interface ErrorScreenProps {
  title: string;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
}

/** Full-screen notice in the client's style: black screen, yellow headline, plain text and one stone button. */
export function ErrorScreen({ title, children, action }: ErrorScreenProps) {
  return (
    <div className="rr-error rs-game" role="alert">
      <div className="rr-error__box">
        <h1 className="rr-error__title rs-b12">{title}</h1>
        <div className="rr-error__body rs-p12">{children}</div>
        {action && (
          <StoneButton className="rr-error__action" onClick={action.onClick} autoFocus>
            {action.label}
          </StoneButton>
        )}
      </div>
    </div>
  );
}

/** iPhone and iPad (iPadOS reports a Mac with touch). */
function isAppleMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Shown instead of the game when the browser cannot render WebGL 2. On an
 * iPhone or iPad that almost always means Lockdown Mode (which turns WebGL
 * off) or iOS older than 15, so those players get the exact fix.
 */
export function WebGLUnsupported() {
  return (
    <ErrorScreen title="Your browser can't run RampRidge." action={{ label: "Try again", onClick: () => window.location.reload() }}>
      <p>RampRidge needs WebGL 2 to draw the bank, and this browser has it turned off or doesn't support it.</p>
      {isAppleMobile() ? (
        <>
          <p>
            On an iPhone or iPad this is usually Lockdown Mode. You can turn it off for this site only: in Safari tap aA, then Website
            Settings, and switch Lockdown Mode off for rampridge.xyz.
          </p>
          <p>Otherwise, update to iOS 15 or later, or open RampRidge on a computer.</p>
        </>
      ) : (
        <p>Use a recent Chrome, Firefox, Safari or Edge, and check that hardware acceleration is switched on.</p>
      )}
    </ErrorScreen>
  );
}

/**
 * Shown over everything (including the crash screen) once a chunk failed
 * because a new release replaced this one. Buy and sell progress is saved
 * before every transaction, so reloading is safe mid-trade.
 */
export function UpdateNotice() {
  const updated = useStore(updateStore, (s) => s.updated);
  if (!updated) return null;
  return (
    <ErrorScreen title="RampRidge was updated. Reload to continue." action={{ label: "Reload", onClick: () => window.location.reload() }}>
      <p>A new version of the game is live, and this page can't load the parts it still needs.</p>
      <p>Trades in progress are saved. After reloading, open the Exchange or the Bank to pick up where you left off.</p>
    </ErrorScreen>
  );
}
