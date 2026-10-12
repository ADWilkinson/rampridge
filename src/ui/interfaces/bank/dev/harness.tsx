/**
 * Dev harness for the bank interfaces (dev only, never imported by the app).
 * Open http://localhost:<port>/dev/bank.html?state=<scenario>. Each scenario
 * runs the real interfaces and the real sell hooks against a fake Peer Cash
 * client, a fake TxSender (canned receipts after a delay) and the src/wallet
 * public client with the fixture wallet's reads faked. `ui=0` hides the
 * scenario switcher (screenshots); `scene=0` skips the 3D bank backdrop;
 * `keep=1` keeps the bank's order locks from the last load.
 */
import "@/styles/index.css";
import "./harness.css";

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { browserStorage, createPendingSellStore, useSellStore, type SellExtensionDeps } from "@/peer/sell";
import { walletQueryKeys } from "@/wallet/balances";
import { publicClient as realPublicClient } from "@/wallet/publicClient";
import { Sprite, coinsSpriteFor, ensureSprites, type ItemData } from "@/ui/kit";
import { GameFrame, InventoryPanel, appendLines, chatLine, gameMessage, type ChatLine, type SideTabId } from "@/ui/frame";
import { GameContext, type GameContextValue, type InterfaceComponent, type OpenInterface, type SoundName } from "../../context";
import { BankDepsProvider } from "../deps";
import { usdcText } from "../helpers";
import { interfaces } from "../index";
import { FakeWorld, USDC, createFakeCashClient, createFakePublicClient, createFakeSender, depositIdOf, installNetworkGuard } from "./fakes";
import { SCENARIOS, findScenario, scenarioAddress, type Scenario } from "./scenarios";

void ensureSprites();

const params = new URLSearchParams(window.location.search);
const scenario = findScenario(params.get("state"));
// Before anything can fetch: payee registration answers from fixtures, never Curator.
installNetworkGuard();
const showUi = params.get("ui") !== "0";
const showScene = params.get("scene") !== "0";
const address = scenarioAddress(scenario.id);
const wallet = scenario.wallet ?? { kind: "smart" as const, sponsored: true, usdc: USDC(1250.4), eth: 0n };

// Fresh local state per load: no pending deposit or order lock from another
// scenario. `keep=1` keeps the bank's order locks, to check they survive a reload.
const keepLocks = params.get("keep") === "1";
try {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("rampridge:sell:") || (!keepLocks && key.startsWith("rampridge:bank:"))) localStorage.removeItem(key);
  }
} catch {
  // Storage blocked: the sell module falls back to memory.
}
if (scenario.pending) createPendingSellStore(browserStorage()).write(scenario.pending(address));

const world = new FakeWorld({
  address,
  kind: wallet.kind,
  sponsored: wallet.sponsored,
  usdc: wallet.usdc,
  eth: wallet.eth,
  orders: scenario.orders ?? [],
  ordersMode: scenario.ordersMode ?? "ok",
  sendDelayMs: scenario.sendDelayMs ?? 1_500,
  sendFailure: scenario.sendFailure ?? null,
});
const cashClient = createFakeCashClient(world);
const sender = createFakeSender(world);
const fakePublic = createFakePublicClient(world, realPublicClient);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retryDelay: 100, refetchOnWindowFocus: false } },
});
// The wallet's balance hooks read the real chain; in the harness they show the fixture balance.
queryClient.setQueryDefaults(walletQueryKeys.all, { enabled: false });
const syncBalance = () => queryClient.setQueryData(walletQueryKeys.usdcBalance(address), world.usdc);
syncBalance();
world.subscribe(syncBalance);

// A typed draft, as if the player had filled the form before this moment.
if (scenario.draft) {
  const store = useSellStore.getState();
  store.setOwner(address);
  store.setAmount(scenario.draft.amount);
  const first = useSellStore.getState().legs[0];
  scenario.draft.legs.forEach((leg, i) => {
    const id = i === 0 && first ? first.id : useSellStore.getState().addLeg();
    useSellStore.getState().updateLeg(id, {
      platform: leg.platform,
      currencies: leg.currencies,
      payee: leg.payee,
      ...(leg.enrolledFor ? { enrolledFor: leg.enrolledFor } : {}),
    });
  });
  if (scenario.draft.spreadBps) useSellStore.getState().setSpread(scenario.draft.spreadBps);
}

/**
 * PeerAuth as the scenario needs it: missing, installed a few seconds after
 * the install page opens, unavailable (a phone) or ready. Undefined uses the
 * real `window.peer`.
 */
function fakeExtension(mode: Scenario["extension"]): SellExtensionDeps | undefined {
  if (!mode) return undefined;
  let openedAt: number | null = null;
  return {
    canInstall: mode !== "unsupported",
    openInstallPage: () => {
      openedAt = Date.now();
    },
    status: async () => {
      if (mode === "unsupported") return "unsupported_browser";
      if (mode === "ready") return "ready";
      if (mode === "installs" && openedAt !== null && Date.now() - openedAt > 3_000) return "needs_connection";
      return "needs_install";
    },
  };
}
const sellExtension = fakeExtension(scenario.extension);

function renderInterface(open: OpenInterface) {
  const Component = interfaces[open.id] as InterfaceComponent | undefined;
  return Component ? <Component key={open.id} open={open} /> : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An element by CSS selector, or `selector|text` for the first match whose text contains `text`. */
function findTarget(target: string): HTMLButtonElement | null {
  const [selector = target, text] = target.split("|");
  const all = Array.from(document.querySelectorAll<HTMLButtonElement>(selector));
  return (text === undefined ? all[0] : all.find((el) => el.textContent?.includes(text))) ?? null;
}

/**
 * Clicks the scenario's targets in order, each once it is enabled, then marks
 * the page ready for screenshots (`body[data-ready="1"]`) once the payee
 * checks and rate reads have had time to land.
 */
function useAutoClick(selectors: readonly string[] | undefined) {
  useEffect(() => {
    document.body.dataset.ready = "0";
    let readyTimer = 0;
    const markReady = () => {
      readyTimer = window.setTimeout(() => {
        if (scenario.reveal) document.querySelector(scenario.reveal)?.scrollIntoView({ block: "center" });
        document.body.dataset.ready = "1";
      }, scenario.settleMs ?? 2_500);
    };
    if (!selectors?.length) {
      markReady();
      return () => window.clearTimeout(readyTimer);
    }
    let index = 0;
    const timer = window.setInterval(() => {
      const selector = selectors[index];
      if (!selector) {
        window.clearInterval(timer);
        markReady();
        return;
      }
      const el = findTarget(selector);
      if (el && !el.disabled) {
        el.click();
        index += 1;
      }
    }, 250);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(readyTimer);
    };
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
  return <div ref={ref} className="bh-backdrop" />;
}

function Harness() {
  const [loggedIn, setLoggedIn] = useState(scenario.wallet !== null);
  const [current, setCurrent] = useState<OpenInterface | null>(scenario.open);
  const [lines, setLines] = useState<ChatLine[]>(() => [
    gameMessage("Welcome to RampRidge."),
    gameMessage("Trades only settle through the bank. Never send money to a player directly."),
  ]);
  const [stall, setStallState] = useState<string | null>(scenario.stall ? depositIdOf(scenario.stall) : null);
  const [side, setSide] = useState<SideTabId | null>(window.innerWidth >= 768 ? "inventory" : null);
  const [usdc, setUsdc] = useState(world.usdc);
  useEffect(() => world.subscribe(() => setUsdc(world.usdc)), []);
  useAutoClick(loggedIn ? scenario.autoClick : undefined);

  const push = useCallback((line: ChatLine) => setLines((prev) => appendLines(prev, [line])), []);
  const message = useCallback((text: string) => push(gameMessage(text)), [push]);

  const ctx = useMemo<GameContextValue>(
    () => ({
      sender: loggedIn ? sender : null,
      walletReady: loggedIn,
      login: () => {
        setLoggedIn(true);
        message("You are logged in.");
      },
      publicClient: fakePublic,
      me: { pid: "p-harness", name: "Zezima", verifiedWallet: scenario.verified ? address : null },
      open: (target) => setCurrent(target),
      close: () => setCurrent(null),
      message,
      playSound: (name: SoundName) => console.debug(`[sound] ${name}`),
      celebrate: () => console.debug("[celebrate]"),
      announce: async (kind, tx) => {
        await sleep(400);
        push(chatLine("news", `Zezima ${kind === "listed" ? "listed USDC for sale" : "bought USDC"} (tx ${tx.slice(0, 10)}...).`));
      },
      setStall: async (depositId) => {
        await sleep(700);
        setStallState(depositId);
      },
      stallDepositId: stall,
    }),
    [loggedIn, message, push, stall],
  );

  const inventory: (ItemData | null)[] = loggedIn
    ? [
        {
          name: "Coins",
          icon: <Sprite name={coinsSpriteFor(Number(usdc / 1_000_000n))} />,
          quantity: Number(usdc / 1_000_000n),
          stackable: true,
          examine: `${usdcText(usdc)} USDC on Base.`,
        },
      ]
    : [];

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
        chat={{ lines, playerName: "Zezima", onSend: (text) => push(chatLine("public", text, { name: "Zezima" })), captureTyping: false }}
        side={{
          active: side,
          onChange: setSide,
          panels: { inventory: <InventoryPanel items={inventory} notice={loggedIn ? undefined : "Log in to see your USDC."} /> },
        }}
        interfaces={current ? renderInterface(current) : null}
      />
      {showUi && <Switcher current={scenario} onOpen={setCurrent} />}
    </GameContext.Provider>
  );
}

function Switcher({ current, onOpen }: { current: Scenario; onOpen: (open: OpenInterface) => void }) {
  const groups = ["Bank", "Sell", "Collection"] as const;
  return (
    <div className="bh-switcher rs-game rs-p12">
      <label className="bh-switcher__row">
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
      <div className="bh-switcher__row">
        <span>Open</span>
        <button type="button" onClick={() => onOpen({ id: "bank" })}>
          Bank
        </button>
        <button type="button" onClick={() => onOpen({ id: "sell" })}>
          Sell
        </button>
        <button type="button" onClick={() => onOpen({ id: "collection" })}>
          Collection
        </button>
        <button type="button" onClick={() => window.location.reload()}>
          Reset
        </button>
      </div>
      <p className="bh-switcher__hint">
        Handles: "unknown..." not found, Wise/PayPal/Alipay "new..." needs verification, "slow..." never answers. Zelle, Chime, UPI and X Money handles are accepted but never
        confirmed. Payee registration answers from fixtures; nothing reaches Curator.
      </p>
    </div>
  );
}

// Survives a module re-run (HMR) without a second createRoot on the same node.
const container = document.getElementById("root") as HTMLElement & { __bankRoot?: Root };
container.__bankRoot ??= createRoot(container);
container.__bankRoot.render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BankDepsProvider value={{ cashClient, ...(sellExtension ? { sellExtension } : {}) }}>
        <Harness />
      </BankDepsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
