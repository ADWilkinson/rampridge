/**
 * Dev harness for the Send and Receive interfaces (dev only, never imported
 * by the app). Open http://localhost:<port>/dev/send.html?state=<scenario>.
 * Each scenario runs the real interfaces and the real `sendUsdc` against a
 * fake chain and a fake TxSender (canned receipts or wallet failures after a
 * delay). `ui=0` hides the scenario switcher (screenshots); `scene=0` skips
 * the 3D bank backdrop.
 */
import "@/styles/index.css";
import "./harness.css";

import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { walletQueryKeys } from "@/wallet/balances";
import { publicClient } from "@/wallet/publicClient";
import { createPendingSendStore, formatSendAmount } from "@/wallet/send";
import { Sprite, coinsSpriteFor, ensureSprites, type ItemData } from "@/ui/kit";
import {
  AccountPanel,
  ContextMenu,
  GameFrame,
  InventoryPanel,
  appendLines,
  chatLine,
  gameMessage,
  type ChatLine,
  type MenuEntry,
  type SideTabId,
} from "@/ui/frame";
import { GameContext, type GameContextValue, type InterfaceComponent, type OpenInterface, type SoundName } from "../../context";
import { SendDepsProvider } from "../deps";
import { interfaces } from "../index";
import { FakeWorld, createFakeChain, createFakeSender } from "./fakes";
import { PLAYER, SCENARIOS, findScenario, type Scenario } from "./scenarios";

void ensureSprites();

const params = new URLSearchParams(window.location.search);
const scenario = findScenario(params.get("state"));
const showUi = params.get("ui") !== "0";
const showScene = params.get("scene") !== "0";
const wallet = scenario.wallet ?? { kind: "smart" as const, sponsored: true, usdc: 125_400_000n, eth: 0n };

const world = new FakeWorld({
  address: PLAYER,
  kind: wallet.kind,
  sponsored: wallet.sponsored,
  usdc: wallet.usdc,
  eth: wallet.eth,
  chainUsdc: wallet.chainUsdc,
  sendDelayMs: scenario.sendDelayMs ?? 1_500,
  fault: scenario.fault ?? null,
  landed: scenario.landed,
  historyDown: scenario.historyDown,
  bundler: scenario.bundler,
});
const chain = createFakeChain(world);
const sender = createFakeSender(world);
// Fresh per load: no unconfirmed send from another scenario.
const pending = createPendingSendStore(null);
if (scenario.pending) pending.write(scenario.pending(Date.now()));

const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 100, refetchOnWindowFocus: false } } });
// The wallet's balance hooks read the real chain; in the harness they show the fixture balance.
queryClient.setQueryDefaults(walletQueryKeys.all, { enabled: false });
const syncBalance = () => queryClient.setQueryData(walletQueryKeys.usdcBalance(PLAYER), world.usdc);
syncBalance();
world.subscribe(syncBalance);

function renderInterface(open: OpenInterface) {
  const Component = interfaces[open.id] as InterfaceComponent | undefined;
  return Component ? <Component key={open.id} open={open} /> : null;
}

function useAutoClick(selectors: readonly string[] | undefined) {
  useEffect(() => {
    if (!selectors?.length) return;
    let index = 0;
    const timer = window.setInterval(() => {
      const selector = selectors[index];
      if (!selector) {
        window.clearInterval(timer);
        return;
      }
      const el = document.querySelector<HTMLButtonElement>(selector);
      if (el && !el.disabled) {
        el.click();
        index += 1;
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [selectors]);
}

function Backdrop() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !showScene) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;
    import("@/ui/dev/sceneBackdrop")
      .then((m) => {
        if (!cancelled) dispose = m.mountBankBackdrop(el, { orbit: false });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  return <div ref={ref} className="sh-backdrop" />;
}

interface ItemOption extends MenuEntry {
  run: () => void;
}

function Harness() {
  const [loggedIn, setLoggedIn] = useState(scenario.wallet !== null);
  const [current, setCurrent] = useState<OpenInterface | null>(scenario.open);
  const [lines, setLines] = useState<ChatLine[]>(() => [gameMessage("Welcome to RampRidge.")]);
  const desktop = window.innerWidth >= 768 && window.innerHeight > 500;
  const [side, setSide] = useState<SideTabId | null>(scenario.side ?? (desktop ? "inventory" : null));
  const [usdc, setUsdc] = useState(world.usdc);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => world.subscribe(() => setUsdc(world.usdc)), []);
  // Phones start with the sheet put away (GameFrame); a scenario that shows a tab opens it once mounted.
  useEffect(() => {
    if (!scenario.side || desktop) return;
    const timer = window.setTimeout(() => setSide(scenario.side ?? null), 150);
    return () => window.clearTimeout(timer);
  }, [desktop]);
  useAutoClick(loggedIn ? scenario.autoClick : undefined);

  const push = useCallback((line: ChatLine) => setLines((prev) => appendLines(prev, [line])), []);
  const message = useCallback((text: string) => push(gameMessage(text)), [push]);
  const open = useCallback((target: OpenInterface) => {
    // As the game does: Send and Receive put the phone's side sheet away.
    if (!desktop) setSide(null);
    setCurrent(target);
  }, [desktop]);

  const ctx = useMemo<GameContextValue>(
    () => ({
      sender: loggedIn ? sender : null,
      walletReady: true,
      login: () => {
        setLoggedIn(true);
        message("You are logged in.");
      },
      publicClient,
      me: { pid: "p-harness", name: "Zezima", verifiedWallet: null },
      open,
      close: () => setCurrent(null),
      message,
      playSound: (name: SoundName) => console.debug(`[sound] ${name}`),
      celebrate: () => undefined,
      announce: async () => undefined,
      setStall: async () => undefined,
      stallDepositId: null,
    }),
    [loggedIn, message, open],
  );

  const examine = `${formatSendAmount(usdc)} USDC in your wallet on Base.`;
  const coins: ItemData = {
    name: "Coins",
    icon: <Sprite name={coinsSpriteFor(Number(usdc / 1_000_000n))} />,
    quantity: Number(usdc / 1_000_000n),
    stackable: true,
    examine,
  };
  // The same options the game gives the coins (src/app/panels.tsx).
  const options: ItemOption[] = [
    { verb: "Examine", targetName: "Coins", kind: "item", run: () => message(examine) },
    { verb: "Sell", targetName: "Coins", kind: "item", run: () => message("(The Sell interface lives in the bank harness.)") },
    { verb: "Send", targetName: "Coins", kind: "item", run: () => open({ id: "send" }) },
  ];

  // Show the coins' menu where the coins are, as a right-click on them would.
  useLayoutEffect(() => {
    if (!scenario.itemMenu || !loggedIn) return;
    const timer = window.setTimeout(() => {
      const slot = document.querySelector(".rs-inventory .rs-slot");
      const rect = slot?.getBoundingClientRect();
      if (rect) setMenu({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [loggedIn]);

  const panels = {
    inventory: (
      <InventoryPanel
        items={loggedIn ? [coins] : []}
        notice={loggedIn ? undefined : "Log in to see your wallet."}
        onActivate={() => options[0]?.run()}
        onMenu={(_index, _item, at) => setMenu(at)}
      />
    ),
    account: (
      <AccountPanel
        displayName="Zezima"
        onRename={() => undefined}
        address={loggedIn ? PLAYER : null}
        walletKind={wallet.kind}
        sponsored={wallet.sponsored}
        verified={scenario.id !== "account-unverified"}
        onLogin={() => setLoggedIn(true)}
        onVerify={() => undefined}
        onLogoutWallet={() => setLoggedIn(false)}
        onSend={loggedIn ? () => open({ id: "send" }) : undefined}
        onReceive={loggedIn ? () => open({ id: "receive" }) : undefined}
      />
    ),
  };

  return (
    <GameContext.Provider value={ctx}>
      <GameFrame
        viewport={<Backdrop />}
        minimap={{
          runEnergy: 100,
          running: false,
          onToggleRun: () => undefined,
          usdcBalance: loggedIn ? formatUnits(usdc, 6) : null,
          onUsdcClick: () => setSide("inventory"),
        }}
        chat={{ lines, playerName: "Zezima", onSend: (text) => push(chatLine("public", text, { name: "Zezima" })), captureTyping: true }}
        side={{ active: side, onChange: setSide, panels }}
        interfaces={current ? renderInterface(current) : null}
        menu={
          menu ? (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              options={options}
              onSelect={(option) => {
                setMenu(null);
                option.run();
              }}
              onClose={() => setMenu(null)}
            />
          ) : null
        }
      />
      {showUi && <Switcher current={scenario} onOpen={setCurrent} />}
    </GameContext.Provider>
  );
}

function Switcher({ current, onOpen }: { current: Scenario; onOpen: (open: OpenInterface) => void }) {
  const groups = ["Form", "Review", "Send", "Receive", "Panels"] as const;
  return (
    <div className="sh-switcher rs-game rs-p12">
      <label className="sh-switcher__row">
        <span>State</span>
        <select
          value={current.id}
          onChange={(e) => {
            const next = new URLSearchParams(window.location.search);
            next.set("state", e.target.value);
            window.location.search = next.toString();
          }}
        >
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {SCENARIOS.filter((s) => s.group === g).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <div className="sh-switcher__row">
        <span>Open</span>
        <button type="button" onClick={() => onOpen({ id: "send" })}>
          Send
        </button>
        <button type="button" onClick={() => onOpen({ id: "receive" })}>
          Receive
        </button>
        <button type="button" onClick={() => window.location.reload()}>
          Reset
        </button>
      </div>
    </div>
  );
}

// Survives a module re-run (HMR) without a second createRoot on the same node.
const container = document.getElementById("root") as HTMLElement & { __sendRoot?: Root };
container.__sendRoot ??= createRoot(container);
container.__sendRoot.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SendDepsProvider value={{ chain, pending, initial: scenario.initial }}>
        <Harness />
      </SendDepsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
