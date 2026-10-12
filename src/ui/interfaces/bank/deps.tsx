import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { CashClient } from "@zkp2p/cash";
import { getCashClient, type SellExtensionDeps } from "@/peer/sell";
import { useIsMobile } from "@/ui/kit";

/**
 * Dependencies the bank interfaces read beyond useGame(). Production uses the
 * app's Peer Cash client; the dev harness provides a fake one so every state
 * can be driven through the real sell hooks without touching the network.
 */
export interface BankDeps {
  cashClient?: CashClient;
  /** PeerAuth status and install page for payee registration (the harness fakes each state). */
  sellExtension?: SellExtensionDeps;
}

const BankDepsContext = createContext<BankDeps>({});

export function BankDepsProvider({ value, children }: { value: BankDeps; children?: ReactNode }) {
  return <BankDepsContext.Provider value={value}>{children}</BankDepsContext.Provider>;
}

/** The Peer Cash client for the sell hooks (the production singleton unless overridden). */
export function useCashClient(): CashClient {
  const { cashClient } = useContext(BankDepsContext);
  return cashClient ?? getCashClient();
}

/** PeerAuth for the sell flow: undefined means the real extension (`src/peer/extension.ts`). */
export function useSellExtension(): SellExtensionDeps | undefined {
  return useContext(BankDepsContext).sellExtension;
}

export interface InterfaceSize {
  mobile: boolean;
  width: number;
  height: number;
}

function viewport(): { w: number; h: number } {
  return typeof window === "undefined" ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Natural window size: the fixed desktop size, or a phone layout that fills
 * the width (16px gutters) and the space above the collapsed chatbox, so hit
 * areas stay full size instead of the window being scaled down.
 */
export function useInterfaceSize(desktop: { width: number; height: number }, phoneHeight: number): InterfaceSize {
  const mobile = useIsMobile();
  const [vp, setVp] = useState(viewport);
  useEffect(() => {
    const on = () => setVp(viewport());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  if (!mobile) return { mobile, ...desktop };
  const width = Math.max(300, Math.min(desktop.width, vp.w - 16));
  // The interface layer ends 76px above the bottom on phones (collapsed chat and tab strip).
  const height = Math.max(320, Math.min(phoneHeight, vp.h - 76 - 16));
  return { mobile, width, height };
}
