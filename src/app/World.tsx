import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EmoteId, PlayerRecord, StallSummary } from "@shared/protocol";
import type { Engine, EngineEvents, InteractVerb, RemotePlayerView, TargetRef } from "@/game";
import { platformName } from "@/game/menu";
import { postAct } from "@/net/actions";
import { ApiError } from "@/net/http";
import { getSession } from "@/net/session";
import { serverNow, useMe, useWorldStore } from "@/net/store";
import {
  ContextMenu,
  EmotesPanel,
  GameFrame,
  InventoryPanel,
  LogoutPanel,
  SettingsPanel,
  type SideTabId,
} from "@/ui/frame";
import { Dialogue, currentLayoutMode, useIsMobile, useNow } from "@/ui/kit";
import { NameEntry } from "@/ui/screens";
import type { GameRuntime } from "./boot";
import { loadBuyFlow, subscribeBuyFlow } from "./buyFlow";
import { EARLIER_ORDER_WAITING, buyOrderReminder, signalLanded } from "./buyOrders";
import { toChatboxLines } from "./chatLines";
import { earlierCoinsReminder } from "./earlierUsdc";
import type { BuyBinding } from "./earlierWallet";
import { EngineViewport } from "./EngineViewport";
import { ConfirmDialogue, closeInterface, describeError, gameMessage, openInterface, useConfirm, useConfirmHost } from "./gameContext";
import { afterPaintIdle } from "./idle";
import { InterfaceSlot, WorldHooks, loadInterfaces, useHasInterface } from "./interfaces";
import { merchantTarget, type LiveMerchant } from "./merchants";
import { checkNameAvailability, claimName } from "./names";
import { useOpenInterface } from "./openInterface";
import { AccountTab, useInventory, type ItemAction } from "./panels";
import { createDoublingWarning } from "./scamWatch";
import type { WorldSession } from "./session";
import { useSettingsStore } from "./settings";
import { SAFETY_LINE, WELCOME, worldWelcome } from "./share/arrival";
import { loadWalletStack, useAppWallet } from "./wallet";
import { useWorldList } from "./worldList";

/**
 * The game screen: the classic resizable layout over the 3D world, wired to
 * the engine, the realtime world, the market and the wallet.
 */

/** Maps an arrived-at interaction to the interface it opens, like walking up to a booth in the original. */
function interact(verb: InteractVerb, target: TargetRef, merchants: ReadonlyMap<string, LiveMerchant>): void {
  switch (verb) {
    case "talk":
      if (target.kind === "banker") openInterface({ id: "dialogue", npc: "banker", name: "Banker" });
      else if (target.kind === "merchant") {
        const merchant = merchants.get(target.merchantId);
        if (merchant) openInterface({ id: "dialogue", npc: "merchant", name: merchant.spec.name, merchant: merchantTarget(merchant) });
      }
      return;
    case "bank":
      openInterface({ id: "bank" });
      return;
    case "exchange":
      openInterface({ id: "exchange" });
      return;
    case "collect":
      openInterface({ id: "collection" });
      return;
    case "trade": {
      if (target.kind !== "merchant") return;
      const merchant = merchants.get(target.merchantId);
      if (merchant) openInterface({ id: "trade", target: merchantTarget(merchant) });
      else gameMessage("That trader has left the bank.");
      return;
    }
    case "trade-stall": {
      if (target.kind !== "player") return;
      const record = useWorldStore.getState().players[target.pid];
      if (!record?.s) {
        gameMessage("That player isn't selling anything right now.");
        return;
      }
      openInterface({ id: "trade", target: { kind: "stall", pid: target.pid, name: record.n, stall: record.s } });
      return;
    }
    default:
      // follow is driven by the engine; examine and walk need nothing here.
      return;
  }
}

/** Camera yaw for the compass, sampled per frame but only re-rendering when it moves. */
function useCameraYaw(engine: Engine): number {
  const [yaw, setYaw] = useState(() => engine.getCameraYaw());
  useEffect(() => {
    let raf = 0;
    let shown = engine.getCameraYaw();
    let shownAt = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const next = engine.getCameraYaw();
      if (Math.abs(next - shown) > 0.002 && t - shownAt > 60) {
        shown = next;
        shownAt = t;
        setYaw(next);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);
  return yaw;
}

/**
 * The shortest "Please wait..." a hop shows, one game tick: a hop on a fast
 * connection lands in a few frames, and the original never swapped worlds
 * without a moment's wait.
 */
export const HOP_WAIT_MS = 600;

/**
 * The World Switcher: polls the world list while it is open and hops on a
 * click, with a short "Please wait..." and the welcome naming the new world.
 */
function useWorldSwitcher(session: WorldSession, visible: boolean, world: number | null) {
  const [open, setOpen] = useState(false);
  const [hopping, setHopping] = useState<number | null>(null);
  const list = useWorldList(open && visible, world);
  const { refresh, noteHop, noteFull } = list;
  const hop = useCallback(
    (target: number) => {
      if (hopping !== null) return;
      setHopping(target);
      const from = world;
      const started = Date.now();
      session
        .hop(target)
        .then(
          async () => {
            const left = HOP_WAIT_MS - (Date.now() - started);
            if (left > 0) await new Promise((resolve) => window.setTimeout(resolve, left));
            // The list counts the hop at once; the server's own count follows (past the edge's cached copy).
            noteHop(from, target);
            // A hop starts the new world's chatbox afresh, so the safety line comes back with the welcome.
            gameMessage(worldWelcome(WELCOME, target));
            gameMessage(SAFETY_LINE);
          },
          (err: unknown) => {
            if (err instanceof ApiError && err.status === 409) noteFull(target);
            gameMessage(describeError(err));
          },
        )
        .finally(() => {
          setHopping(null);
          refresh(true);
        });
    },
    [session, hopping, world, refresh, noteHop, noteFull],
  );
  return { list, hopping, hop, setOpen };
}

/** Once per two minutes for this page, however often players come and go. */
const doublingWarning = createDoublingWarning();

/** Mirrors the realtime world into the engine: players, stalls, overhead chat and celebrations. */
function useWorldSync(engine: Engine): void {
  useEffect(() => {
    const sync = (players: Record<string, PlayerRecord>) => {
      const self = useWorldStore.getState().me?.pid ?? null;
      const views: RemotePlayerView[] = [];
      const stalls: Record<string, StallSummary | null> = {};
      for (const [pid, record] of Object.entries(players)) {
        stalls[pid] = record.s ?? null;
        if (pid !== self) views.push({ pid, record });
      }
      engine.syncPlayers(views, serverNow());
      engine.setStalls(stalls);
    };
    sync(useWorldStore.getState().players);

    let seenChat = new Set(useWorldStore.getState().chat.map((l) => l.id));
    let seenEvents = new Set(useWorldStore.getState().events.map((e) => e.id));
    return useWorldStore.subscribe((state, prev) => {
      if (state.players !== prev.players) sync(state.players);
      if (state.chat !== prev.chat) {
        const { chatEffects } = useSettingsStore.getState().settings;
        for (const line of state.chat) {
          if (seenChat.has(line.id)) continue;
          seenChat.add(line.id);
          if (line.kind !== "public" || !line.live) continue;
          if (line.pid) engine.showChat({ pid: line.pid }, line.text, chatEffects ? line.fx : null);
          // Doubling talk is the classic bank scam. The warning posts once this store update has reached every
          // listener, so none of them sees the two updates out of order.
          const warning = doublingWarning(line.text, Date.now());
          if (warning) queueMicrotask(() => gameMessage(warning));
        }
        if (seenChat.size > 2_000) seenChat = new Set(state.chat.map((l) => l.id));
      }
      if (state.events !== prev.events) {
        const { reducedMotion } = useSettingsStore.getState().settings;
        for (const event of state.events) {
          if (seenEvents.has(event.id)) continue;
          seenEvents.add(event.id);
          // Your own purchase already celebrated in the interface that completed it. A new sell order gets the
          // merchants' stall line; a settled trade (bought, or a seller's order filled) the trade cheer.
          if (event.live && event.pid && event.pid !== state.me?.pid && !reducedMotion) {
            engine.celebrate(event.pid, event.kind === "listed" ? "listing" : "trade");
          }
        }
        if (seenEvents.size > 500) seenEvents = new Set(state.events.map((e) => e.id));
      }
    });
  }, [engine]);
}

/**
 * Tells the engine where the minimap HUD covers the view, so overhead text
 * (merchant shouts) moves out from under it instead of being cut off. On
 * phones the hall sits right under it.
 */
function useMinimapExclusion(runtime: GameRuntime): void {
  useEffect(() => {
    const { engine, host } = runtime;
    const minimap = document.querySelector<HTMLElement>(".rs-gameframe__minimap");
    if (!minimap) return;
    const update = () => {
      const view = host.getBoundingClientRect();
      const hud = minimap.getBoundingClientRect();
      engine.setOverlayExclusion({ left: hud.left - view.left, top: hud.top - view.top, right: hud.right - view.left, bottom: hud.bottom - view.top });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(minimap);
    ro.observe(host);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      engine.setOverlayExclusion(null);
    };
  }, [runtime]);
}

/** Game messages when the realtime connection drops and comes back. */
function useConnectionMessages(): void {
  useEffect(() => {
    let wasOnline = useWorldStore.getState().status === "online";
    let lost = false;
    return useWorldStore.subscribe((state, prev) => {
      if (state.status === prev.status) return;
      if (state.status === "online") {
        if (lost) gameMessage("Connection restored.");
        lost = false;
        wasOnline = true;
      } else if ((state.status === "offline" || state.status === "error") && wasOnline && !lost) {
        lost = true;
        gameMessage("Connection lost. Trying to reconnect...");
      }
    });
  }, []);
}

const PLAYING_ELSEWHERE_NOTICE = "You are playing RampRidge in another tab, so this one has stopped.";
const PLAYING_HERE_AGAIN = "You are playing in this tab again.";

/**
 * Another tab of this browser took over the player (newest tab wins): say so
 * in the chatbox and offer to play here again, instead of silently freezing.
 */
function usePlayingElsewhere(session: WorldSession): { elsewhere: boolean; resuming: boolean; resume: () => void } {
  const elsewhere = useWorldStore((s) => s.playingElsewhere);
  const [resuming, setResuming] = useState(false);
  useEffect(() => {
    if (elsewhere) gameMessage(PLAYING_ELSEWHERE_NOTICE);
  }, [elsewhere]);
  const resume = useCallback(() => {
    setResuming(true);
    session.resume().then(
      () => gameMessage(PLAYING_HERE_AGAIN),
      (err: unknown) => gameMessage(describeError(err)),
    ).finally(() => setResuming(false));
  }, [session]);
  return { elsewhere, resuming, resume };
}

/** Change display name: Check availability only asks; Set name claims it; Cancel keeps the old name. */
function RenameWindow({ name, onDone }: { name: string; onDone: () => void }) {
  const submit = async (next: string) => {
    const refused = await claimName(next);
    if (refused) return refused;
    // The session holds the name as the server stored it.
    gameMessage(`Your display name is now ${getSession()?.name ?? next}.`);
    onDone();
  };
  return <NameEntry initialName={name} onCheck={checkNameAvailability} onSubmit={submit} onClose={onDone} />;
}

export interface WorldProps {
  runtime: GameRuntime;
  session: WorldSession;
  /** Live merchants by id (from useMerchants), for Trade and Talk-to. */
  merchants: { readonly current: ReadonlyMap<string, LiveMerchant> };
  /** The buy flow's wallet binding (useBuyBinding), for the inventory's Payment scroll and reminders. */
  buy: BuyBinding;
  onLogout: () => void;
}

export function World({ runtime, session, merchants, buy, onLogout }: WorldProps) {
  const { engine } = runtime;
  const mobile = useIsMobile();
  const wallet = useAppWallet();
  const me = useMe();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.update);
  const status = useWorldStore((s) => s.status);
  const chat = useWorldStore((s) => s.chat);
  const events = useWorldStore((s) => s.events);
  const confirming = useConfirm((s) => s.request !== null);
  const chatInterface = useHasInterface("chat");
  // Server time dates the backlog news, which only shows when recent (chatLines.showsNews).
  const lines = useMemo(() => toChatboxLines(chat, events, platformName, serverNow()), [chat, events]);
  const [hover, setHover] = useState<EngineEvents["hover"]>(null);
  const [worldMenu, setWorldMenu] = useState<EngineEvents["menu"] | null>(null);
  const [itemMenu, setItemMenu] = useState<{ x: number; y: number; options: ItemAction[] } | null>(null);
  const [tab, setTab] = useState<SideTabId | null>(() => (window.matchMedia("(max-width: 767px)").matches ? null : "inventory"));
  const [renaming, setRenaming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const minuteNow = useNow(Date.now, 30_000);
  const yaw = useCameraYaw(engine);
  const inventory = useInventory(wallet, buy, minuteNow);
  const switcher = useWorldSwitcher(session, tab === "logout", me?.world ?? null);

  useConfirmHost();
  // Once the world is on screen: the trading interfaces (and the Peer SDKs under them), the shell's view of
  // the buy flow and the wallet stack. Opening an interface or logging in fetches what it needs sooner.
  useEffect(
    () =>
      afterPaintIdle(() => {
        void loadInterfaces();
        void loadBuyFlow().catch(() => undefined);
        void loadWalletStack().catch(() => undefined);
      }),
    [],
  );
  useWorldSync(engine);
  useMinimapExclusion(runtime);
  const elsewhere = usePlayingElsewhere(session);
  // Phones draw the side panel as a sheet over the chatbox: put it away while the chatbox asks a question
  // (e.g. moving USDC from the earlier wallet, picked from the inventory).
  useEffect(() => {
    if (mobile && confirming) setTab(null);
  }, [mobile, confirming]);
  useConnectionMessages();
  // Send and Receive open from the side panel (the coins, the Account tab): on phones its sheet would cover them.
  useEffect(
    () =>
      useOpenInterface.subscribe((state, prev) => {
        const id = state.current?.id;
        if (state.key !== prev.key && (id === "send" || id === "receive") && currentLayoutMode().sheet) setTab(null);
      }),
    [],
  );

  // Engine events: hover text, menus, interactions, movement, examine and clicks into the world.
  useEffect(() => {
    const offs = [
      engine.on("hover", (h) => setHover(h)),
      engine.on("menu", (m) => {
        setItemMenu(null);
        setWorldMenu(m);
      }),
      engine.on("worldClick", () => {
        closeInterface();
        setItemMenu(null);
      }),
      engine.on("examine", ({ text }) => {
        if (text) gameMessage(text);
      }),
      engine.on("move", ({ path, run }) => void session.move(path, run)),
      engine.on("interact", ({ verb, target }) => interact(verb, target, merchants.current)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [engine, session, merchants]);

  // Reminders for orders and funds that need the player, once each. An offer placed in this session
  // isn't one: the interface that placed it has said so and opened its Payment scroll.
  const reminded = useRef(new Set<string>());
  useEffect(
    () =>
      subscribeBuyFlow((state, prev) => {
        if (signalLanded(state, prev) && state.order) reminded.current.add(`${state.order.intentHash.toLowerCase()}:active`);
      }),
    [],
  );
  const buyOrder = inventory.buyOrder;
  useEffect(() => {
    if (!buyOrder) return;
    const key = `${buyOrder.intentHash.toLowerCase()}:${buyOrder.expired ? "expired" : "active"}`;
    if (reminded.current.has(key)) return;
    reminded.current.add(key);
    gameMessage(buyOrderReminder(buyOrder.expired, buyOrder.earlier));
  }, [buyOrder]);
  useEffect(() => {
    if (!buy.waitingEarlierOrder) return;
    const key = `earlier-order:${buy.waitingEarlierOrder}`;
    if (reminded.current.has(key)) return;
    reminded.current.add(key);
    gameMessage(EARLIER_ORDER_WAITING);
  }, [buy.waitingEarlierOrder]);
  const earlierUsdc = inventory.earlierUsdc;
  const earlierEoa = wallet.status === "ready" ? wallet.fallbackEoa : null;
  useEffect(() => {
    if (!earlierUsdc || !earlierEoa) return;
    // Again if the amount changes, e.g. when an order from the earlier wallet releases its USDC there.
    const key = `earlier-usdc:${earlierEoa.toLowerCase()}:${earlierUsdc}`;
    if (reminded.current.has(key)) return;
    reminded.current.add(key);
    gameMessage(earlierCoinsReminder(earlierUsdc));
  }, [earlierUsdc, earlierEoa]);
  useEffect(() => {
    if (!inventory.pendingSell || !wallet.address) return;
    const key = `sell:${wallet.address.toLowerCase()}`;
    if (reminded.current.has(key)) return;
    reminded.current.add(key);
    gameMessage("Your sell order hasn't finished listing. Open the Bank to continue.");
  }, [inventory.pendingSell, wallet.address]);

  // A note when the wallet becomes usable mid-game.
  const walletReady = wallet.status === "ready";
  const wasReady = useRef(walletReady);
  useEffect(() => {
    if (walletReady && !wasReady.current) gameMessage("Your wallet is ready to trade.");
    wasReady.current = walletReady;
  }, [walletReady]);

  const minimapRef = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (canvas) engine.attachMinimap(canvas);
    },
    [engine],
  );

  // Resolves false when the server refused the line (rate limit, filter), so the chatbox can give the draft back.
  const sendChat = useCallback(
    (text: string): Promise<boolean> =>
      postAct({ type: "chat", text }).then(
        () => true,
        (err: unknown) => {
          gameMessage(describeError(err));
          return false;
        },
      ),
    [],
  );

  const emote = useCallback(
    (id: EmoteId) => {
      if (me) engine.playEmote(me.pid, id);
      postAct({ type: "emote", emote: id }).catch((err: unknown) => gameMessage(describeError(err)));
    },
    [engine, me],
  );

  const logout = useCallback(() => {
    setLeaving(true);
    closeInterface();
    onLogout();
  }, [onLogout]);

  const items = inventory.entries.map((e) => e.item);
  const panels = {
    inventory: (
      <InventoryPanel
        items={items}
        notice={inventory.notice}
        onActivate={(index) => inventory.entries[index]?.actions[0]?.run()}
        onMenu={(index, _item, at) => {
          const entry = inventory.entries[index];
          if (!entry) return;
          setWorldMenu(null);
          setItemMenu({ x: at.x, y: at.y, options: entry.actions });
        }}
      />
    ),
    account: <AccountTab wallet={wallet} onRename={() => setRenaming(true)} />,
    emotes: <EmotesPanel onEmote={emote} disabled={!me} />,
    settings: <SettingsPanel settings={settings} onChange={updateSettings} />,
    logout: (
      <LogoutPanel
        onLogout={logout}
        busy={leaving}
        world={me?.world ?? null}
        worlds={switcher.list.rows}
        worldsError={switcher.list.error}
        onSwitcherChange={switcher.setOpen}
        onHop={switcher.hop}
        hopping={switcher.hopping}
      />
    ),
  };

  const menu = worldMenu ? (
    <ContextMenu
      x={worldMenu.x}
      y={worldMenu.y}
      options={worldMenu.options}
      onSelect={(option) => {
        setWorldMenu(null);
        engine.choose(option);
      }}
      onClose={() => setWorldMenu(null)}
    />
  ) : itemMenu ? (
    <ContextMenu
      x={itemMenu.x}
      y={itemMenu.y}
      options={itemMenu.options}
      onSelect={(option) => {
        setItemMenu(null);
        option.run();
      }}
      onClose={() => setItemMenu(null)}
    />
  ) : null;

  const inputDisabledReason = elsewhere.elsewhere
    ? "Playing in another tab"
    : status === "connecting" || status === "idle"
      ? "Connecting..."
      : status === "offline" || status === "error"
        ? "Reconnecting..."
        : undefined;

  const elsewhereDialogue = elsewhere.elsewhere ? (
    <Dialogue
      kind="options"
      title="You are playing in another tab."
      options={[
        { label: elsewhere.resuming ? "Joining..." : "Play here", onSelect: elsewhere.resume, disabled: elsewhere.resuming },
        { label: "Log out", onSelect: logout },
      ]}
    />
  ) : null;

  return (
    <>
    <WorldHooks />
    <GameFrame
      viewport={<EngineViewport runtime={runtime} />}
      hover={worldMenu || itemMenu ? null : hover}
      minimap={{
        canvasRef: minimapRef,
        compassAngle: yaw,
        onCompassClick: () => engine.resetCameraNorth(),
        runEnergy: 100,
        running: settings.running,
        onToggleRun: () => updateSettings({ running: !settings.running }),
        usdcBalance: inventory.usdc,
        onUsdcClick: () => setTab("inventory"),
      }}
      chat={{
        lines,
        playerName: me?.name ?? "",
        onSend: sendChat,
        inputDisabledReason,
        overlay: elsewhereDialogue ?? (confirming ? <ConfirmDialogue /> : chatInterface ? <InterfaceSlot placement="chat" /> : undefined),
      }}
      side={{ active: tab, onChange: setTab, panels, mobile }}
      interfaces={
        <>
          {renaming && me && <RenameWindow name={me.name} onDone={() => setRenaming(false)} />}
          {!renaming && <InterfaceSlot placement="window" />}
        </>
      }
      menu={menu}
      blocking={elsewhere.elsewhere}
    />
    </>
  );
}
