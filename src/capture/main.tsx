/**
 * Launch-video capture harness (dev/capture.html?beat=<id>). Composes the
 * REAL engine (createEngine), OSRS characters, GameFrame, context menu and
 * buy/bank interfaces over fixture data: the frozen live market, the buy
 * harness's fake Peer client, chain and extension, and the bank harness's
 * fake Peer Cash world. A scripted director (scenes.ts) drives the world and
 * clicks the real interfaces. scripts/capture/record.mjs steps the page with
 * a fixed clock and grabs every frame. Capture only; the app never imports it.
 *
 * Query: ?beat=walkin|exchange|trade|payverify|sell|social|orbit
 *        ?auto=1 starts the beat without the recorder (real time preview).
 */
import "@/lib/polyfills";
import "@/styles/index.css";
import "./capture.css";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { formatUnits } from "viem";
import { encodePath, type EmoteId, type PlayerRecord, type StallSummary, type Tile } from "@shared/protocol";
import { createEngine, type EngineEvents, type InteractVerb, type MenuOption, type RemotePlayerView, type TargetRef } from "@/game";
import { createCharacterFactory } from "@/game/osrs";
import { CollisionMap } from "@/game/world/collision";
import { findPath } from "@/game/world/pathfinding";
import { bundledCollision, bundledWorldMeta, parseWorldMeta } from "@/game/world/worldMeta";
import { merchantTarget, type LiveMerchant } from "@/app/merchants";
import { createBuyStore, memoryOrderStorage } from "@/peer/buy";
import { resolveVerifyMethod } from "@/peer/platforms";
import { useSellStore } from "@/peer/sell";
import { walletQueryKeys } from "@/wallet/balances";
import { publicClient as realPublicClient } from "@/wallet/publicClient";
import type { TxSender } from "@/wallet/types";
import { ContextMenu, EmotesPanel, GameFrame, InventoryPanel, appendLines, chatLine, gameMessage, type ChatLine, type SideTabId } from "@/ui/frame";
import { Sprite, coinsSpriteFor, ensureSprites } from "@/ui/kit";
import { GameContext, type GameContextValue, type OpenInterface, type SoundName } from "@/ui/interfaces/context";
import { interfaces as bankInterfaces } from "@/ui/interfaces/bank";
import { BankDepsProvider } from "@/ui/interfaces/bank/deps";
import { FakeWorld, USDC, createFakeCashClient, createFakePublicClient, createFakeSender } from "@/ui/interfaces/bank/dev/fakes";
import { interfaces as buyInterfaces } from "@/ui/interfaces/buy";
import { BuyUiDepsProvider, type BuyUiDeps } from "@/ui/interfaces/buy/deps";
import { BUYER, fakeChain, fakeCash, fakeExtension, revolutRows, type Timing } from "@/ui/interfaces/buy/simulated";
import { CROWD, LIQUID, LOCAL, captureMerchants } from "./fixtures";
import { DEMO_HANDLE, captureMarket } from "./market";
import { BEATS, type BeatId, type Director } from "./scenes";

void ensureSprites();

const params = new URLSearchParams(location.search);
const BEAT = (params.get("beat") ?? "exchange") as BeatId;
const AUTO = params.get("auto") === "1";
const beat = BEATS[BEAT] ?? BEATS.exchange;
const PHONE = window.innerWidth < 768;

try {
  for (const key of Object.keys(localStorage)) if (key.startsWith("rampridge:")) localStorage.removeItem(key);
} catch {
  // Storage blocked: nothing to clear.
}

// ---------------------------------------------------------------- capture bus

interface Cue {
  t: number;
  name: string;
}
const bus = {
  ready: false,
  started: -1,
  done: false,
  duration: beat.duration,
  cues: [] as Cue[],
  stills: [] as { t: number; name: string }[],
  errors: [] as string[],
  start: () => undefined as void,
};
function cue(name: string): void {
  if (bus.started >= 0) bus.cues.push({ t: performance.now() - bus.started, name });
}
Object.assign(window, { __capture: bus });
window.addEventListener("error", (e) => bus.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => bus.errors.push(String((e as PromiseRejectionEvent).reason)));

// ---------------------------------------------------------------- shell state

interface ShellState {
  lines: ChatLine[];
  current: OpenInterface | null;
  menu: EngineEvents["menu"] | null;
  hover: EngineEvents["hover"];
  tab: SideTabId | null;
  hud: boolean;
  stall: string | null;
  usdc: bigint;
  yaw: number;
}
let state: ShellState = {
  lines: [gameMessage("Welcome to RampRidge."), gameMessage("Trades only settle through the bank. Never send money to a player directly.")],
  current: null,
  menu: null,
  hover: null,
  tab: PHONE ? null : "inventory",
  hud: beat.hud !== false,
  stall: null,
  usdc: USDC(beat.usdc ?? 1250.4),
  yaw: 0,
};
const listeners = new Set<() => void>();
function setState(patch: Partial<ShellState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
const useShell = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

// ---------------------------------------------------------------- engine

interface EngineInternals {
  pointer: { x: number; y: number; inside: boolean; moved: boolean; lastPick: number };
  onMenu(x: number, y: number): void;
  onClick(x: number, y: number): void;
  resize(): void;
  cam: { rotateBy(dYaw: number, dPitch: number): void; zoomTo(f: number): void; snap(): void; titleAngle: number };
  sound: { play(name: string, volume?: number): void };
  renderer: { setPixelRatio(r: number): void; setSize(w: number, h: number, style: boolean): void } | null;
  overlay: { resize(w: number, h: number, r: number): void } | null;
  wrapper: HTMLElement | null;
  governor: unknown;
  pixelRatio: number;
}

const characters = createCharacterFactory();
const engine = createEngine({ characters });
const internals = engine as unknown as EngineInternals;
const RENDER_RATIO = Math.min(3, window.devicePixelRatio || 1);
{
  // Capture-only hook: full device resolution on every layout (the app caps phones at 1.5x and steps down
  // while frames are slow; under the fixed clock every frame reads as slow).
  const original = internals.resize.bind(engine);
  internals.resize = () => {
    original();
    internals.governor = null;
    const { renderer, overlay, wrapper } = internals;
    if (!renderer || !overlay || !wrapper) return;
    const w = Math.max(1, wrapper.clientWidth);
    const h = Math.max(1, wrapper.clientHeight);
    internals.pixelRatio = RENDER_RATIO;
    renderer.setPixelRatio(RENDER_RATIO);
    renderer.setSize(w, h, false);
    overlay.resize(w, h, RENDER_RATIO);
  };
}
const engineHost = document.createElement("div");
Object.assign(engineHost.style, { position: "absolute", inset: "0" });
let mounted = false;

const meta = parseWorldMeta(bundledWorldMeta());
const collision = CollisionMap.from(bundledCollision());
collision.setBounds(meta.bounds);

// ---------------------------------------------------------------- world: players and merchants

const merchants: LiveMerchant[] = captureMerchants(PHONE ? 6 : 8);
const merchantById = new Map(merchants.map((m) => [m.spec.id, m]));
const records = new Map<string, PlayerRecord>();

function syncPlayers(): void {
  const views: RemotePlayerView[] = [...records].map(([pid, record]) => ({ pid, record }));
  engine.syncPlayers(views, Date.now());
}

function placePlayer(pid: string, tile: Tile): void {
  const who = CROWD.find((c) => c.pid === pid);
  if (!who) return;
  const now = Date.now();
  records.set(pid, { n: who.name, a: characters.randomAppearance(who.seed), p: encodePath([tile]), t: now - 60_000, r: false, e: null, et: null, ls: now, j: now - 60_000 });
}

function walkPlayer(pid: string, to: Tile, run = false): void {
  const record = records.get(pid);
  if (!record) return;
  const now = Date.now();
  const last = record.p.split(";").at(-1)!.split(",").map(Number);
  const steps = record.p.split(";").length - 1;
  const from = now >= record.t + steps * (record.r ? 300 : 600) ? { x: last[0]!, y: last[1]! } : { x: last[0]!, y: last[1]! };
  const route = findPath(collision, from, to);
  if (!route || route.length < 2) return;
  records.set(pid, { ...record, p: encodePath(route), t: now, r: run });
  syncPlayers();
}

// ---------------------------------------------------------------- trading fakes

const buyTiming: Timing = { txMs: 0, quoteMs: 0, captureMs: 0 };
const market = captureMarket(buyTiming);
const buyClock = { offset: 0, now: () => Date.now() + buyClock.offset };
const chain = fakeChain({ lockMs: 6 * 3_600_000, fulfil: "ok", signal: "ok", readMs: 0 }, buyTiming, buyClock.now);
const buyStorage = memoryOrderStorage();
const extension = fakeExtension({ installed: true, state: "ready" }, buyTiming, () => {
  const order = buyStore.getState().order;
  const method = order ? resolveVerifyMethod(order.platform, order.verifyMethodId) : null;
  const rows = order ? revolutRows(order.fiatToSendText, order.currency).map((r) => (r.recipient === "revtag" ? { ...r, recipient: DEMO_HANDLE } : r)) : [];
  return { platform: method?.actionPlatform ?? "revolut", rows };
});
const buyStore = createBuyStore({
  getClient: () => chain.client,
  extension,
  storage: buyStorage,
  quotes: market.quotes,
  fetchPayeeHandle: async () => DEMO_HANDLE,
  canInstallExtension: () => true,
  now: buyClock.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5_000))),
  random: () => 0.31,
  indexerTimeoutMs: 1_500,
  signalReconcileMs: 90_000,
});
const cash = fakeCash("none");
const buyDeps: Partial<BuyUiDeps> = {
  store: buyStore,
  getBuyQuotes: market.quotes,
  getBestPricesByPlatform: market.getBestPricesByPlatform as BuyUiDeps["getBestPricesByPlatform"],
  getDepositQuote: market.getDepositQuote,
  cashClient: () => cash,
  now: buyClock.now,
};

const SELLER_WALLET = "0x5e11e45e11e45e11e45e11e45e11e45e11e45e1" as const;
const bankWorld = new FakeWorld({
  address: SELLER_WALLET,
  kind: "smart",
  sponsored: true,
  usdc: state.usdc,
  eth: 0n,
  orders: [],
  ordersMode: "ok",
  sendDelayMs: 380,
  sendFailure: null,
});
const cashClient = createFakeCashClient(bankWorld);
const bankSender = createFakeSender(bankWorld);
const fakePublic = createFakePublicClient(bankWorld, realPublicClient);
const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 100, retry: false, refetchOnWindowFocus: false } } });
queryClient.setQueryDefaults(walletQueryKeys.all, { enabled: false });
const syncBalance = () => {
  queryClient.setQueryData(walletQueryKeys.usdcBalance(SELLER_WALLET), bankWorld.usdc);
  setState({ usdc: bankWorld.usdc });
};
syncBalance();
bankWorld.subscribe(syncBalance);

const sender: TxSender = beat.wallet === "bank" ? bankSender : chain.sender;

// ---------------------------------------------------------------- director

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const cursor = { x: PHONE ? 180 : 480, y: PHONE ? 300 : 270, el: null as HTMLDivElement | null, tap: null as HTMLDivElement | null };
function drawCursor(): void {
  if (cursor.el) cursor.el.style.transform = `translate(${cursor.x}px, ${cursor.y}px)`;
}

function tween(ms: number, step: (t: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      step(ease(t));
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

function moveCursor(x: number, y: number, ms = 450): Promise<void> {
  const fx = cursor.x;
  const fy = cursor.y;
  if (PHONE) {
    cursor.x = x;
    cursor.y = y;
    return sleep(Math.min(ms, 120));
  }
  return tween(ms, (t) => {
    cursor.x = fx + (x - fx) * t;
    cursor.y = fy + (y - fy) * t;
    drawCursor();
    pointWorld();
  });
}

/** Feeds the cursor to the engine's hover picking while it is over the world, as a real mouse would. */
function pointWorld(): void {
  if (state.menu) return;
  const under = document.elementFromPoint(cursor.x, cursor.y);
  const overWorld = !!under?.closest("[data-engine=world]");
  if (overWorld) Object.assign(internals.pointer, { x: cursor.x, y: cursor.y, inside: true, moved: true });
  else if (internals.pointer.inside) {
    internals.pointer.inside = false;
    setState({ hover: null });
  }
}

function tapRipple(): void {
  const el = cursor.tap;
  if (!el) return;
  el.style.left = `${cursor.x}px`;
  el.style.top = `${cursor.y}px`;
  void tween(380, (t) => {
    el.style.opacity = String(0.9 * (1 - t));
    el.style.transform = `translate(-50%, -50%) scale(${0.4 + t * 0.9})`;
  });
}

function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** A visible, enabled button or link by aria-label or text (exact, then prefix), or an element by selector. */
function findTarget(target: string): HTMLElement | null {
  if (/^[[#.]/.test(target)) {
    const el = document.querySelector<HTMLElement>(target);
    return el && !(el as HTMLButtonElement).disabled ? el : null;
  }
  const all = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button], [role=menuitem], [role=option]")).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
  );
  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return (
    all.find((el) => el.getAttribute("aria-label") === target || text(el) === target) ??
    all.find((el) => (el.getAttribute("aria-label") ?? "").startsWith(target) || text(el).startsWith(target)) ??
    all.find((el) => el.querySelector(".rb-pick__name")?.textContent?.trim().startsWith(target)) ??
    null
  );
}

async function waitForTarget(target: string, ms = 3_000): Promise<HTMLElement> {
  for (let waited = 0; waited < ms; waited += 50) {
    const el = findTarget(target);
    if (el) return el;
    await sleep(50);
  }
  throw new Error(`capture: nothing to click for "${target}"`);
}

function interact(verb: InteractVerb, target: TargetRef): void {
  switch (verb) {
    case "bank":
      setState({ current: { id: "bank" } });
      return;
    case "exchange":
      setState({ current: { id: "exchange" } });
      return;
    case "collect":
      setState({ current: { id: "collection" } });
      return;
    case "trade": {
      if (target.kind !== "merchant") return;
      const m = merchantById.get(target.merchantId);
      if (m) setState({ current: { id: "trade", target: merchantTarget(m) } });
      return;
    }
    default:
      return;
  }
}

const director: Director = {
  engine,
  phone: PHONE,
  local: LOCAL,
  merchants,
  wait: sleep,
  cue,
  still: (name) => bus.stills.push({ t: bus.started >= 0 ? performance.now() - bus.started : 0, name }),
  async moveTo(x, y, ms) {
    await moveCursor(x, y, ms);
  },
  async moveToTarget(target, ms = 500, dy = 0) {
    const first = engine.projectTarget(target);
    if (!first) throw new Error(`capture: ${JSON.stringify(target)} is off screen`);
    if (PHONE) {
      await sleep(Math.min(ms, 120));
      const at = engine.projectTarget(target) ?? first;
      cursor.x = at.x;
      cursor.y = at.y + dy;
      return at;
    }
    // Follows the target while it moves (merchants walk), like a hand tracking it.
    const fx = cursor.x;
    const fy = cursor.y;
    let last = first;
    await tween(ms, (t) => {
      last = engine.projectTarget(target) ?? last;
      cursor.x = fx + (last.x - fx) * t;
      cursor.y = fy + (last.y + dy - fy) * t;
      drawCursor();
      pointWorld();
    });
    return last;
  },
  async walkClick(tile, ms = 600) {
    const at = engine.projectTarget({ kind: "tile", tile });
    if (at) await moveCursor(at.x, at.y, ms);
    tapRipple();
    (internals as unknown as { cross: unknown }).cross = { x: cursor.x, y: cursor.y, red: false, startedAt: performance.now() };
    engine.walkTo(tile);
  },
  async rightClick() {
    tapRipple();
    internals.onMenu(cursor.x, cursor.y);
    await sleep(60);
    return state.menu?.options ?? [];
  },
  async leftClickWorld() {
    tapRipple();
    internals.onClick(cursor.x, cursor.y);
  },
  async choose(verb, ms = 380) {
    const menu = state.menu;
    if (!menu) throw new Error("capture: no menu open");
    const option = menu.options.find((o) => o.verb === verb) as MenuOption | undefined;
    if (!option) throw new Error(`capture: no "${verb}" in ${menu.options.map((o) => o.verb).join(", ")}`);
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".rs-menu [role=menuitem], .rs-menu li, .rs-menu button"));
    const row = rows.find((r) => r.textContent?.trim().startsWith(verb));
    if (row) {
      const c = centerOf(row);
      await moveCursor(Math.min(c.x, cursor.x + 60), c.y, ms);
      row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      row.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: c.x, clientY: c.y }));
      await sleep(PHONE ? 220 : 160);
    }
    tapRipple();
    setState({ menu: null });
    engine.choose(option);
  },
  async click(target, ms = 420) {
    const el = await waitForTarget(target);
    el.scrollIntoView({ block: "nearest" });
    const c = centerOf(el);
    await moveCursor(c.x, c.y, ms);
    await sleep(PHONE ? 140 : 90);
    tapRipple();
    el.click();
    await sleep(30);
  },
  async type(selector, text, perChar = 70) {
    const el = (await waitForTarget(selector)) as HTMLInputElement;
    const c = centerOf(el);
    await moveCursor(c.x, c.y, 380);
    tapRipple();
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    let value = "";
    for (const ch of text) {
      value += ch;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(perChar);
    }
  },
  open: (target) => setState({ current: target }),
  tab: (tab) => setState({ tab }),
  hud: (visible) => setState({ hud: visible }),
  game: (text) => setState({ lines: appendLines(state.lines, [gameMessage(text)]) }),
  news: (text, name) => setState({ lines: appendLines(state.lines, [chatLine("news", text, name ? { name } : {})]) }),
  say(pid, text, fx = null) {
    const name = pid === LOCAL.pid ? LOCAL.name : (CROWD.find((c) => c.pid === pid)?.name ?? pid);
    engine.showChat({ pid }, text, fx);
    setState({ lines: appendLines(state.lines, [chatLine("public", text, { name, fx })]) });
  },
  shout(merchantId, text) {
    engine.showChat({ merchantId }, text, null);
  },
  emote: (pid, emote: EmoteId) => engine.playEmote(pid, emote),
  celebrate(pid) {
    engine.celebrate(pid);
    cue("levelup");
  },
  placePlayer,
  walkPlayer,
  syncPlayers,
  setLocal(tile) {
    engine.setLocalPlayer({ pid: LOCAL.pid, name: LOCAL.name, appearance: characters.randomAppearance(LOCAL.seed), tile });
  },
  walkLocal(tile) {
    engine.walkTo(tile);
  },
  camera(yaw, pitch = 0, zoom) {
    internals.cam.rotateBy(yaw, pitch);
    if (zoom !== undefined) internals.cam.zoomTo(zoom);
  },
  snapCamera: () => internals.cam.snap(),
  titleOrbit(enabled, angle) {
    engine.setTitleMode(enabled);
    if (angle !== undefined) internals.cam.titleAngle = angle;
  },
  buy: buyStore,
  buyClock,
  buyTiming,
  sender: chain.sender,
};

// Engine sounds become cues; the recorder mixes the originals in afterwards.
internals.sound.play = (name: string) => cue(name);

// ---------------------------------------------------------------- React shell

function Viewport() {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el) return;
    el.appendChild(engineHost);
    if (!mounted) {
      mounted = true;
      engine.mount(engineHost);
    }
  }, []);
  return <div ref={slot} className="cap-viewport" />;
}

function useCameraYaw(): number {
  const [yaw, setYaw] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const next = engine.getCameraYaw();
      setYaw((prev) => (Math.abs(next - prev) > 0.002 ? next : prev));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return yaw;
}

const ALL_INTERFACES = { ...buyInterfaces, ...bankInterfaces } as Record<string, ComponentType<{ open: OpenInterface }> | undefined>;

function Shell() {
  const s = useShell();
  const yaw = useCameraYaw();
  const minimapRef = useMemo(
    () => (canvas: HTMLCanvasElement | null) => {
      if (canvas) engine.attachMinimap(canvas);
    },
    [],
  );

  const game = useMemo<GameContextValue>(
    () => ({
      sender,
      walletReady: true,
      login: () => undefined,
      publicClient: fakePublic,
      me: { pid: LOCAL.pid, name: LOCAL.name, verifiedWallet: (beat.wallet === "bank" ? SELLER_WALLET : BUYER).toLowerCase() },
      open: (target) => setState({ current: target }),
      close: () => setState({ current: null }),
      message: (text) => setState({ lines: appendLines(state.lines, [gameMessage(text)]) }),
      playSound: (name: SoundName) => cue(name),
      celebrate: () => {
        engine.celebrate(LOCAL.pid);
        cue("levelup");
        const done = buyStore.getState().completion;
        if (done) setState({ usdc: state.usdc + done.usdcReceived });
      },
      announce: async (kind) => {
        await sleep(500);
        const done = buyStore.getState().completion;
        const text =
          kind === "bought" && done ? `${LOCAL.name} bought ${formatUnits(done.usdcReceived, 6).replace(/(\.\d\d)\d*$/, "$1")} USDC for 100.00 GBP on Revolut.` : `${LOCAL.name} is selling 500.00 USDC for GBP on Revolut.`;
        setState({ lines: appendLines(state.lines, [chatLine("news", text, { name: LOCAL.name })]) });
      },
      setStall: async (depositId) => {
        await sleep(600);
        setState({ stall: depositId });
        const stall: StallSummary | null = depositId
          ? { depositId, escrow: "capture", platform: "revolut", currency: "GBP", available: "500.000000", rate: "0.7600" }
          : null;
        engine.setStalls({ [LOCAL.pid]: stall });
      },
      stallDepositId: s.stall,
      liquidCurrencies: LIQUID,
    }),
    [s.stall],
  );

  const Component = s.current ? ALL_INTERFACES[s.current.id] : undefined;
  const iface = s.current && Component ? <Component key={JSON.stringify(s.current)} open={s.current} /> : null;
  const coins = Number(s.usdc / 1_000_000n);

  const menu = s.menu ? (
    <ContextMenu
      x={s.menu.x}
      y={s.menu.y}
      options={s.menu.options}
      onSelect={(option) => {
        setState({ menu: null });
        engine.choose(option);
      }}
      onClose={() => setState({ menu: null })}
    />
  ) : null;

  const frame = s.hud ? (
    <GameFrame
      viewport={<Viewport />}
      hover={s.menu ? null : s.hover}
      minimap={{
        canvasRef: minimapRef,
        compassAngle: yaw,
        onCompassClick: () => engine.resetCameraNorth(),
        runEnergy: 100,
        running: false,
        onToggleRun: () => undefined,
        usdcBalance: formatUnits(s.usdc, 6),
        onUsdcClick: () => undefined,
      }}
      chat={{ lines: s.lines, playerName: LOCAL.name, onSend: () => undefined, captureTyping: false }}
      side={{
        active: s.tab,
        onChange: (tab) => setState({ tab }),
        mobile: PHONE,
        panels: {
          inventory: (
            <InventoryPanel
              items={[{ name: "Coins", icon: <Sprite name={coinsSpriteFor(coins)} />, quantity: coins, stackable: true, examine: `${formatUnits(s.usdc, 6)} USDC on Base.` }]}
            />
          ),
          emotes: <EmotesPanel onEmote={(id) => engine.playEmote(LOCAL.pid, id)} />,
        },
      }}
      interfaces={iface}
      menu={menu}
    />
  ) : (
    <div className="cap-bare">
      <Viewport />
    </div>
  );

  return (
    <GameContext.Provider value={game}>
      {frame}
      <div ref={(el) => void (cursor.el = el)} className={PHONE || !beat.cursor ? "cap-cursor cap-cursor--hidden" : "cap-cursor"} aria-hidden="true">
        <svg width="22" height="30" viewBox="0 0 22 30">
          <path d="M1 1 L1 24 L7 18 L11 28 L15 26 L11 17 L19 17 Z" fill="#fff" stroke="#000" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      </div>
      <div ref={(el) => void (cursor.tap = el)} className={PHONE ? "cap-tap" : "cap-tap cap-tap--mouse"} aria-hidden="true" />
    </GameContext.Provider>
  );
}

// Engine events, as World.tsx wires them (the move event needs no server here).
engine.on("hover", (h) => setState({ hover: h }));
engine.on("menu", (m) => setState({ menu: m }));
engine.on("worldClick", () => setState({ current: null }));
engine.on("examine", ({ text }) => text && director.game(text));
engine.on("interact", ({ verb, target }) => interact(verb, target));

async function boot(): Promise<void> {
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <QueryClientProvider client={queryClient}>
      <BankDepsProvider value={{ cashClient }}>
        <BuyUiDepsProvider value={buyDeps}>
          <Shell />
        </BuyUiDepsProvider>
      </BankDepsProvider>
    </QueryClientProvider>,
  );
  if (beat.wallet === "bank") useSellStore.getState().setOwner(SELLER_WALLET);
  engine.setMerchants(merchants.map((m) => m.spec));
  await engine.load();
  await beat.setup(director);
  syncPlayers();
  internals.cam.snap();
  drawCursor();
  // Let merchants reach their spots and models settle before frame 0.
  await sleep(beat.warmup ?? 1_500);
  bus.start = () => {
    bus.started = performance.now();
    void beat
      .run(director)
      .catch((e: unknown) => bus.errors.push(e instanceof Error ? e.message : String(e)))
      .finally(() => (bus.done = true));
  };
  bus.ready = true;
  document.body.dataset.ready = "1";
  if (AUTO) bus.start();
}

boot().catch((e: unknown) => {
  console.error(e);
  bus.errors.push(e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
});
