import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useCompactLandscape, useIsMobile, useMediaQuery } from "@/ui/kit";
import { historyClient } from "@/wallet/publicClient";
import { createSendChain, defaultPendingSends, type PendingSendStore, type SendChain } from "@/wallet/send";
import { useGame } from "../context";
import type { SendState } from "./model";

/**
 * What the Send and Receive interfaces read beyond useGame(). Production uses
 * the game's Base public client and the browser's pending-send store; the dev
 * harness passes a fake chain and store so every state can be driven
 * through the real interface without touching the network.
 */
export interface SendDeps {
  chain?: SendChain;
  pending?: PendingSendStore;
  /** Dev harness and tests only: the state the Send interface opens in. */
  initial?: SendState;
}

const SendDepsContext = createContext<SendDeps>({});

export function SendDepsProvider({ value, children }: { value: SendDeps; children?: ReactNode }) {
  return <SendDepsContext.Provider value={value}>{children}</SendDepsContext.Provider>;
}

export function useSendDeps(): { chain: SendChain; pending: PendingSendStore; initial: SendState | undefined } {
  const deps = useContext(SendDepsContext);
  const { publicClient } = useGame();
  const chain = useMemo(() => deps.chain ?? createSendChain(publicClient, historyClient), [deps.chain, publicClient]);
  return { chain, pending: deps.pending ?? defaultPendingSends(), initial: deps.initial };
}

export type SendLayout = "desktop" | "phone" | "landscape";

/**
 * True on a desktop layout with a mouse: controls can take focus on their own
 * there. On touch screens focusing a field would pop the keyboard up uninvited
 * (and a focused button would show its focus ring before any key was pressed).
 */
export function useKeyboardFirst(layout: SendLayout): boolean {
  const finePointer = useMediaQuery("(pointer: fine)");
  return layout === "desktop" && finePointer;
}

export interface SendSize {
  layout: SendLayout;
  width: number;
  height: number;
}

function viewport(): { w: number; h: number } {
  return typeof window === "undefined" ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Window size per layout: the fixed desktop size; a phone held upright fills
 * the width (16px gutters) up to `phoneHeight`, above the collapsed chatbox
 * and tab strip (82px); a phone held sideways gets a wide, short window that
 * fits beside the tab strip without being scaled, so touch targets keep
 * their size.
 */
export function useSendSize(desktop: { width: number; height: number }, phoneHeight: number, landscape: { width: number; height: number }): SendSize {
  const mobile = useIsMobile();
  const compact = useCompactLandscape();
  const [vp, setVp] = useState(viewport);
  useEffect(() => {
    const on = () => setVp(viewport());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  if (compact) {
    return {
      layout: "landscape",
      width: Math.max(300, Math.min(landscape.width, vp.w - 264 - 16)),
      height: Math.max(240, Math.min(landscape.height, vp.h - 16)),
    };
  }
  if (!mobile) return { layout: "desktop", ...desktop };
  return {
    layout: "phone",
    width: Math.max(300, Math.min(desktop.width, vp.w - 16)),
    height: Math.max(320, Math.min(phoneHeight, vp.h - 82 - 16)),
  };
}
