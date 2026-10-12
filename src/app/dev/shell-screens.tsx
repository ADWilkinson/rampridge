// Dev harness only (not part of the app bundle): the shell's full-screen states, and the world HUD with
// the shell's own inventory, account tab, reminders and chatbox questions over fake wallet data.
// /src/app/dev/shell-screens.html?screen=crash|update|webgl|loading-error
// /src/app/dev/shell-screens.html?screen=world&state=earlier|verifying|expired|confirm|no-wallet|failed&tab=inventory|account
// oxlint-disable-next-line import/no-unassigned-import
import "@/styles/index.css";
// oxlint-disable-next-line import/no-unassigned-import
import "@/app/app.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Address, Hex } from "viem";
import { useWorldStore } from "@/net";
import { buyStore, type BuyOrder, type BuyStep } from "@/peer/buy";
import { platformName } from "@/game/menu";
import { buyOrderReminder } from "@/app/buyOrders";
import { toChatboxLines } from "@/app/chatLines";
import { EARLIER_MOVE_NO, EARLIER_MOVE_YES, earlierCoinsReminder, earlierMoveQuestion } from "@/app/earlierUsdc";
import type { BuyBinding } from "@/app/earlierWallet";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { WebGLUnsupported } from "@/app/ErrorScreen";
import { ConfirmDialogue, NO_WALLET_TEXT, askConfirm, gameMessage, useConfirm, useConfirmHost, useNoWallet } from "@/app/gameContext";
import { INTERFACE_LOAD_FAILED } from "@/app/interfaces";
import { AccountTab, useInventory, type ItemAction } from "@/app/panels";
import { mountBankBackdrop } from "@/ui/dev/sceneBackdrop";
import { ContextMenu, EmotesPanel, GameFrame, InventoryPanel, LogoutPanel, SettingsPanel, type SideTabId } from "@/ui/frame";
import { ensureSprites, useIsMobile } from "@/ui/kit";
import { LoadingScreen } from "@/ui/screens";
import { publicClient, walletQueryKeys, type TxSender, type WalletContextValue } from "@/wallet";

void ensureSprites();
const params = new URLSearchParams(window.location.search);
const screen = params.get("screen") ?? "crash";
const state = params.get("state") ?? "earlier";

function Throws({ message }: { message: string }): never {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fake wallet data for the world screen (dev only).

const SMART = "0x2a9e8fa175F45b235efDdD97d2727741EF4Eee63" as Address;
const EOA = "0x7d3c1b0f2e6a9c84b5d1e0f3a2c4b6d8e9f01a23" as Address;
const NOW = Date.now();

function fakeSender(address: Address, kind: TxSender["kind"]): TxSender {
  return { address, kind, sponsored: true } as TxSender;
}

const smartSender = fakeSender(SMART, "smart");
const eoaSender = fakeSender(EOA, "embedded");

function fakeWallet(): WalletContextValue {
  const noWallet = state === "no-wallet";
  return {
    ready: true,
    authenticated: true,
    sender: noWallet ? null : smartSender,
    publicClient,
    login: () => undefined,
    logout: () => Promise.resolve(),
    status: noWallet ? "no_wallet" : "ready",
    address: noWallet ? null : SMART,
    source: noWallet ? null : "smart",
    kind: noWallet ? null : "smart",
    sponsored: !noWallet,
    walletName: noWallet ? null : "Smart wallet",
    account: { userId: "did:privy:dev", email: "zezima@example.com", displayName: "zezima@example.com", loginMethod: "email" },
    reconnect: () => undefined,
    getAccessToken: () => Promise.resolve(null),
    fallbackEoa: noWallet ? null : EOA,
    fallbackSender: noWallet ? null : eoaSender,
    sweepFallbackUsdc: () => Promise.resolve(null),
  };
}

function fakeOrder(): BuyOrder {
  return {
    owner: EOA,
    intentHash: "0x5f2b9c1d0e3a4b6c8d7e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e" as Hex,
    depositId: "412",
    escrow: "0x2f121CDDCA6d652f35e8B3E560f9760898888888" as Address,
    orchestrator: null,
    platform: "revolut",
    currency: "GBP",
    usdcGross: 129_000_000n,
    usdcExpected: 128_420_000n,
    rate: 786_800_000_000_000_000n,
    fiatToSend: 101_500_000n,
    fiatToSendText: "101.50",
    payeeHandle: "harbourmaster",
    payeeDetailsHash: "0x9a7c000000000000000000000000000000000000000000000000000000000000" as Hex,
    signalTxHash: null,
    signaledAt: NOW - 20 * 60_000,
    expiresAt: state === "expired" ? NOW - 5 * 60_000 : NOW + 5 * 60 * 60_000,
    verifyMethodId: null,
    memo: null,
    status: "active",
    fees: null,
    paidClaimedAt: null,
  };
}

function makeQueryClient(): QueryClient {
  // Reads stay off: the harness shows seeded balances and never calls the RPC.
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  client.setQueryData(walletQueryKeys.usdcBalance(SMART), 1_250_400_000n);
  client.setQueryData(walletQueryKeys.ethBalance(SMART), 0n);
  client.setQueryData(walletQueryKeys.usdcBalance(EOA), 12_340_000n);
  return client;
}

function seedBuyFlow(): void {
  if (state === "no-wallet") return;
  const step: BuyStep = state === "verifying" ? "verifying" : "awaitingPayment";
  // Same owner as the binding below, so watching it doesn't start a chain recovery.
  buyStore.setState({ owner: EOA.toLowerCase() as Address, order: fakeOrder(), step, verifying: step === "verifying" ? "capturing" : null });
}

function Backdrop() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? mountBankBackdrop(ref.current) : undefined), []);
  return <div ref={ref} style={{ position: "absolute", inset: 0 }} />;
}

function drawMinimap(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  const img = new Image();
  img.src = "/game/world/minimap.png";
  img.onload = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, -(3184.5 - 3164) * 4 + canvas.width / 2, -(3462 + 1 - 3439.5) * 4 + canvas.height / 2);
  };
}

function WorldHarness() {
  const wallet = useMemo(fakeWallet, []);
  const buy = useMemo<BuyBinding>(
    () =>
      state === "no-wallet"
        ? { sender: null, owner: null, earlier: false, waitingEarlierOrder: null }
        : { sender: eoaSender, owner: EOA, earlier: true, waitingEarlierOrder: null },
    [],
  );
  const chat = useWorldStore((s) => s.chat);
  const events = useWorldStore((s) => s.events);
  const lines = useMemo(() => toChatboxLines(chat, events, platformName, Date.now()), [chat, events]);
  const confirming = useConfirm((s) => s.request !== null);
  const [tab, setTab] = useState<SideTabId | null>(() => (params.get("tab") as SideTabId | null) ?? "inventory");
  const [menu, setMenu] = useState<{ x: number; y: number; options: ItemAction[] } | null>(null);
  const inventory = useInventory(wallet, buy, NOW);
  useConfirmHost();
  // As World does: the phone's side sheet makes way for a chatbox question.
  const mobile = useIsMobile();
  useEffect(() => {
    if (mobile && confirming) setTab(null);
  }, [mobile, confirming]);

  useEffect(() => {
    // Once per page load (StrictMode runs effects twice in development).
    if (document.body.dataset.ready === "1") return;
    document.body.dataset.ready = "1";
    gameMessage("Welcome to RampRidge.");
    gameMessage("Trades only settle through the bank. Never send money to a player directly.");
    if (state === "no-wallet") {
      useNoWallet.setState({ settled: true });
      gameMessage(NO_WALLET_TEXT);
      return;
    }
    gameMessage(buyOrderReminder(state === "expired", true));
    gameMessage(earlierCoinsReminder("12.34"));
    if (state === "failed") gameMessage(INTERFACE_LOAD_FAILED);
    // After StrictMode's remount, which answers any open question "no".
    if (state === "confirm") window.setTimeout(() => void askConfirm(earlierMoveQuestion("12.34"), EARLIER_MOVE_YES, EARLIER_MOVE_NO), 0);
  }, []);

  const panels = {
    inventory: (
      <InventoryPanel
        items={inventory.entries.map((e) => e.item)}
        notice={inventory.notice}
        onActivate={(index) => inventory.entries[index]?.actions[0]?.run()}
        onMenu={(index, _item, at) => {
          const entry = inventory.entries[index];
          if (entry) setMenu({ x: at.x, y: at.y, options: entry.actions });
        }}
      />
    ),
    account: <AccountTab wallet={wallet} onRename={() => undefined} />,
    emotes: <EmotesPanel onEmote={() => undefined} />,
    settings: <SettingsPanel settings={{ soundVolume: 0, musicVolume: 0, chatEffects: true, reducedMotion: true }} onChange={() => undefined} />,
    logout: <LogoutPanel onLogout={() => undefined} />,
  };

  return (
    <GameFrame
      viewport={<Backdrop />}
      minimap={{
        canvasRef: drawMinimap,
        compassAngle: 0,
        runEnergy: 100,
        running: true,
        onToggleRun: () => undefined,
        usdcBalance: inventory.usdc,
        onUsdcClick: () => setTab("inventory"),
      }}
      chat={{ lines, playerName: "Zezima", onSend: () => undefined, overlay: confirming ? <ConfirmDialogue /> : undefined }}
      side={{ active: tab, onChange: setTab, panels }}
      menu={
        menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            options={menu.options}
            onSelect={(option) => {
              setMenu(null);
              // Move would read the chain; the harness shows its question instead (state=confirm).
              if (option.verb === "Move") void askConfirm(earlierMoveQuestion("12.34"), EARLIER_MOVE_YES, EARLIER_MOVE_NO);
              else option.run();
            }}
            onClose={() => setMenu(null)}
          />
        )
      }
    />
  );
}

function Harness() {
  switch (screen) {
    case "world":
      return <WorldHarness />;
    case "webgl":
      return <WebGLUnsupported />;
    case "update":
      return (
        <ErrorBoundary>
          <Throws message="Failed to fetch dynamically imported module: /assets/AppRoot-x.js" />
        </ErrorBoundary>
      );
    case "loading-error":
      return <LoadingScreen progress={0.42} label="Loading Varrock West Bank" error="The bank could not be loaded. Check your connection and try again." onRetry={() => undefined} />;
    default:
      return (
        <ErrorBoundary>
          <Throws message="Harness crash" />
        </ErrorBoundary>
      );
  }
}

const queryClient = makeQueryClient();
seedBuyFlow();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    </StrictMode>,
  );
}
