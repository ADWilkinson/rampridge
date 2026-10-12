/**
 * The real buy UI (Exchange, Payment scroll, Verify) and the real buy store,
 * mounted inside the real GameFrame, with only the edges replaced:
 * - wallet: createForkSender (RampRidge's external-wallet TxSender over anvil),
 * - store: createBuyStore with production defaults except the clock (so the
 *   driver can run it ahead for expiry), persisted with localOrderStorage,
 * - extension: the default peerExtension(), which resolves the simulated
 *   window.peer installed by main.ts,
 * - quotes, guide prices and payee lookups: the live Curator API,
 * - chain: VITE_BASE_RPC_URL is the anvil fork for every SDK client.
 * The game shell's world-side effects (chat, sounds, fireworks, announce) are
 * recorded on window.__e2e for the driver.
 */
import "@/lib/polyfills";
import "@/styles/index.css";
import "@/ui/interfaces/buy/dev/harness.css";

import { StrictMode, useCallback, useMemo, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { createBuyStore, type BuyFlowStore } from "@/peer/buy";
import { GameFrame, InventoryPanel, appendLines, chatLine, gameMessage, type ChatLine } from "@/ui/frame";
import { Window, ensureSprites, useIsMobile } from "@/ui/kit";
import { GameContext, type GameContextValue, type OpenInterface } from "@/ui/interfaces/context";
import { BuyUiDepsProvider } from "@/ui/interfaces/buy/deps";
import { interfaces } from "@/ui/interfaces/buy";
import type { ExtensionSimHandle } from "./extensionSim";
import { createForkSender, type ForkSenderLog } from "./forkSender";
import type { GuardLog } from "./guard";

void ensureSprites();

export interface HarnessOptions {
  buyer: Address;
  forkRpcUrl: string;
  guard: GuardLog;
  clock: { offset: number; now: () => number };
  ext: ExtensionSimHandle;
  open: string;
}

export interface E2eWindow {
  ready: boolean;
  buyer: Address;
  store: ReturnType<typeof createBuyStore>;
  state(): BuyFlowStore;
  clock: HarnessOptions["clock"];
  ext: ExtensionSimHandle;
  guard: GuardLog;
  sender: ForkSenderLog;
  chat: string[];
  sounds: string[];
  announced: Array<{ kind: string; tx: string }>;
  celebrated: number;
  current: OpenInterface | null;
  open(target: OpenInterface | null): void;
  errors: string[];
}

declare global {
  interface Window {
    __e2e?: E2eWindow;
  }
}

function interfaceFor(id: string): OpenInterface | null {
  switch (id) {
    case "exchange":
    case "payment":
    case "verify":
      return { id } as OpenInterface;
    case "none":
      return null;
    default:
      return { id: "exchange" };
  }
}

export function mountHarness(options: HarnessOptions): void {
  const { sender, log: senderLog } = createForkSender(options.buyer, options.forkRpcUrl);
  const store = createBuyStore({ now: options.clock.now });
  const publicClient = createPublicClient({ chain: base, transport: http(options.forkRpcUrl) }) as unknown as PublicClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

  const e2e: E2eWindow = {
    ready: false,
    buyer: options.buyer,
    store,
    state: () => store.getState(),
    clock: options.clock,
    ext: options.ext,
    guard: options.guard,
    sender: senderLog,
    chat: [],
    sounds: [],
    announced: [],
    celebrated: 0,
    current: interfaceFor(options.open),
    open: () => undefined,
    errors: [],
  };
  window.__e2e = e2e;
  window.addEventListener("error", (event) => e2e.errors.push(String(event.message)));
  window.addEventListener("unhandledrejection", (event) => e2e.errors.push(String((event.reason as Error)?.message ?? event.reason)));

  function App() {
    const [current, setCurrent] = useState<OpenInterface | null>(e2e.current);
    const [lines, setLines] = useState<ChatLine[]>(() => [gameMessage("Welcome to RampRidge."), gameMessage("(e2e) Base fork, simulated Peer extension, mock attestation.")]);
    const [fireworks, setFireworks] = useState(0);
    const mobile = useIsMobile();
    e2e.current = current;
    e2e.open = setCurrent;

    const say = useCallback((line: ChatLine) => setLines((l) => appendLines(l, [line])), []);
    const game = useMemo<GameContextValue>(
      () => ({
        sender,
        walletReady: true,
        login: () => undefined,
        publicClient,
        me: { pid: "p-e2e", name: "Fork Buyer", verifiedWallet: options.buyer.toLowerCase() },
        open: (target) => setCurrent(target),
        close: () => setCurrent(null),
        message: (text) => {
          e2e.chat.push(text);
          say(gameMessage(text));
        },
        playSound: (name) => {
          e2e.sounds.push(name);
        },
        celebrate: () => {
          e2e.celebrated += 1;
          setFireworks((n) => n + 1);
        },
        announce: async (kind, tx) => {
          e2e.announced.push({ kind, tx });
          say(chatLine("news", `Fork Buyer bought USDC at the Bank of RampRidge. (${tx.slice(0, 10)}...)`));
        },
        setStall: async () => undefined,
        stallDepositId: null,
      }),
      [say],
    );

    const Component = current ? (interfaces[current.id] as ComponentType<{ open: OpenInterface }> | undefined) : undefined;
    const iface = current ? (
      Component ? (
        <Component key={JSON.stringify(current)} open={current} />
      ) : (
        <Window title={current.id} width={320} height={120} onClose={() => setCurrent(null)}>
          <p className="rs-window__pad rs-p12 rs-c-orange rs-shadow">The {current.id} interface is not part of the buy e2e.</p>
        </Window>
      )
    ) : null;

    return (
      <QueryClientProvider client={queryClient}>
        <GameContext.Provider value={game}>
          <BuyUiDepsProvider value={{ store, now: options.clock.now }}>
            <GameFrame
              viewport={<div className="bh-scene" />}
              minimap={{ runEnergy: 100, running: true, onToggleRun: () => undefined, usdcBalance: null }}
              chat={{ lines, playerName: "Fork Buyer", onSend: (text) => say(chatLine("public", text, { name: "Fork Buyer" })) }}
              side={{
                active: mobile ? null : "inventory",
                onChange: () => undefined,
                panels: { inventory: <InventoryPanel items={[]} notice="Fork wallet" /> },
              }}
              interfaces={iface}
            />
            {fireworks > 0 && <div className="bh-fireworks" aria-hidden="true" />}
          </BuyUiDepsProvider>
        </GameContext.Provider>
      </QueryClientProvider>
    );
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("no #root");
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  e2e.ready = true;
}
