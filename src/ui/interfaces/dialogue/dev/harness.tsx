/**
 * Dev harness for the npc-ui interfaces (dialogue, intro, how-it-works,
 * terms). Dev only: http://localhost:<port>/dev/dialogue.html.
 *
 * Renders the real interface components inside the real GameFrame with a
 * fake GameContext (fixture player, fake TxSender, the app's public client),
 * over the baked bank scene. The panel switches view, node, login state and
 * placement; every open()/close()/sound call is logged. URL parameters do
 * the same for screenshots:
 *   view=banker|merchant|merchant-none|intro|how-it-works|terms
 *   node=<dialogue node id>   login=0|1 (has a sender)   place=chat|centre
 *   wallet=0|1 (wallet service loaded, `walletReady`; default 1, and always
 *   1 when login=1). A first-visit guest is wallet=1&login=0.
 *   page=buy|sell (how-it-works)   ui=0 (hide the panel)   scene=0 (no 3D)
 *   heads=0 (no chatheads)   banker=<npc id> (the banker's chathead; default 2897)
 */
import "@/styles/index.css";
import "./harness.css";

import { StrictMode, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createWalletClient, custom, type Address, type Hex, type TransactionReceipt } from "viem";
import { base } from "viem/chains";
import { createCharacterFactory, renderCharacterPreview } from "@/game/osrs";
import { mountBankBackdrop } from "@/ui/dev/sceneBackdrop";
import { GameFrame, appendLines, gameMessage, InventoryPanel, type ChatLine, type SideTabId } from "@/ui/frame";
import {
  GameContext,
  type ChatheadHandle,
  type ChatheadOptions,
  type ChatheadSubject,
  type GameContextValue,
  type InterfaceComponent,
  type MerchantTarget,
  type OpenInterface,
} from "@/ui/interfaces/context";
import { HowItWorksScroll } from "@/ui/interfaces/info/HowItWorks";
import { interfaces as infoInterfaces } from "@/ui/interfaces/info";
import { introLoggedIn, introScript } from "@/ui/interfaces/info/introScript";
import { Sprite, coinsSpriteFor, ensureSprites, type ItemData } from "@/ui/kit";
import { publicClient } from "@/wallet/publicClient";
import type { TxSender } from "@/wallet/types";
import { dialogueScriptFor } from "../DialogueInterface";
import { interfaces as dialogueInterfaces } from "../index";
import type { DialogueScript } from "../script";
import { ScriptedDialogue } from "../ScriptedDialogue";

void ensureSprites();

const params = new URLSearchParams(window.location.search);

// ---------------------------------------------------------------------------
// Fixtures (dev only)

const VIEWS = ["banker", "merchant", "merchant-none", "intro", "how-it-works", "terms"] as const;
type View = (typeof VIEWS)[number] | "closed";

const MERCHANT: MerchantTarget = { kind: "merchant", merchantId: "revolut:GBP", name: "Revolut merchant", platform: "revolut", currency: "GBP" };
const DEV_ADDRESS: Address = "0x2a9e8fa175F45b235efDdD97d2727741EF4Eee63";
const DEV_TX: Hex = "0x5f0e0c6b6a5e1f6a0b7d4c3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

/** A TxSender that never touches a wallet: sendCalls resolves a canned receipt after a delay. */
function fakeSender(): TxSender {
  const walletClient = createWalletClient({
    account: DEV_ADDRESS,
    chain: base,
    transport: custom({
      request: () => Promise.reject(new Error("The dev harness has no wallet.")),
    }),
  });
  return {
    address: DEV_ADDRESS,
    kind: "smart",
    sponsored: true,
    walletClient,
    sendCalls: (_calls, opts) =>
      new Promise<TransactionReceipt>((resolve) => {
        console.info("[harness] sendCalls", opts?.label ?? "");
        window.setTimeout(
          () =>
            resolve({
              blockHash: "0x".padEnd(66, "1") as Hex,
              blockNumber: 1n,
              contractAddress: null,
              cumulativeGasUsed: 21_000n,
              effectiveGasPrice: 1n,
              from: DEV_ADDRESS,
              gasUsed: 21_000n,
              logs: [],
              logsBloom: `0x${"0".repeat(512)}`,
              status: "success",
              to: DEV_ADDRESS,
              transactionHash: DEV_TX,
              transactionIndex: 0,
              type: "eip1559",
            }),
          1200,
        );
      }),
    signMessage: () => new Promise<Hex>((resolve) => window.setTimeout(() => resolve(`0x${"ab".repeat(65)}`), 600)),
  };
}

// Chatheads through the real character runtime and preview, as the shell draws them.
const factory = createCharacterFactory();
const factoryLoad = params.get("heads") === "0" ? null : factory.load();
const BANKER_NPC = Number(params.get("banker") ?? 2897);

function harnessChathead(container: HTMLElement, who: ChatheadSubject, options: ChatheadOptions = {}): ChatheadHandle | null {
  if (!factory.isLoaded) return null;
  const source =
    "pid" in who
      ? factory.randomAppearance(who.pid)
      : "merchantId" in who
        ? factory.randomAppearance(who.merchantId)
        : { npcId: "npcId" in who ? who.npcId : BANKER_NPC };
  return renderCharacterPreview(container, source, { factory, framing: "head", label: "Chathead", onError: () => options.onFail?.() });
}

const INVENTORY: ItemData[] = [{ name: "Coins", icon: <Sprite name={coinsSpriteFor(1250)} />, quantity: 1250, stackable: true, examine: "1,250.40 USDC" }];

const START_CHAT: ChatLine[] = [gameMessage("Welcome to RampRidge."), gameMessage("Trades only settle through the bank. Never send money to a player directly.")];

function openFor(view: View): OpenInterface | null {
  switch (view) {
    case "banker":
      return { id: "dialogue", npc: "banker", name: "Banker" };
    case "merchant":
      return { id: "dialogue", npc: "merchant", name: MERCHANT.name, merchant: MERCHANT };
    case "merchant-none":
      return { id: "dialogue", npc: "merchant", name: "Merchant" };
    case "intro":
      return { id: "intro" };
    case "how-it-works":
      return { id: "how-it-works" };
    case "terms":
      return { id: "terms" };
    case "closed":
      return null;
  }
}

function viewFor(target: OpenInterface): View | null {
  switch (target.id) {
    case "dialogue":
      return target.npc === "banker" ? "banker" : target.merchant ? "merchant" : "merchant-none";
    case "intro":
    case "how-it-works":
    case "terms":
      return target.id;
    default:
      return null;
  }
}

function describe(target: OpenInterface): string {
  const { id, ...rest } = target;
  const extra = Object.entries(rest)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? (v as { merchantId?: string }).merchantId ?? "{...}" : String(v)}`)
    .join(", ");
  return extra ? `open({ id: "${id}", ${extra} })` : `open({ id: "${id}" })`;
}

const REGISTRY = { ...dialogueInterfaces, ...infoInterfaces } as Record<string, InterfaceComponent | undefined>;

// ---------------------------------------------------------------------------

function Backdrop() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current && params.get("scene") !== "0" ? mountBankBackdrop(ref.current) : undefined), []);
  return <div ref={ref} className="h-scene" />;
}

function scriptForView(view: View, sender: TxSender | null): DialogueScript | null {
  if (view === "intro") return introScript({ loggedIn: introLoggedIn({ sender }) });
  const open = openFor(view);
  return open?.id === "dialogue" ? dialogueScriptFor(open) : null;
}

function Harness() {
  const initialView = (VIEWS as readonly string[]).includes(params.get("view") ?? "") ? (params.get("view") as View) : "banker";
  const [view, setView] = useState<View>(initialView);
  const [node, setNode] = useState<string>(params.get("node") ?? "");
  const [loggedIn, setLoggedIn] = useState(params.get("login") === "1");
  // The real shell: Privy loads (walletReady) before anyone logs in, so a guest has walletReady and no sender.
  const [walletLoaded, setWalletLoaded] = useState(params.get("wallet") !== "0");
  const walletReady = walletLoaded || loggedIn;
  const [place, setPlace] = useState<"chat" | "centre">(params.get("place") === "centre" ? "centre" : "chat");
  const [showUi, setShowUi] = useState(params.get("ui") !== "0");
  const [log, setLog] = useState<string[]>([]);
  const [lines, setLines] = useState<ChatLine[]>(START_CHAT);
  // Phones show the side panel as a sheet over the chatbox, so it starts closed there.
  const [tab, setTab] = useState<SideTabId | null>(() => (window.matchMedia("(max-width: 767px)").matches ? null : "inventory"));
  const [nonce, setNonce] = useState(0);
  const sender = useMemo(() => (loggedIn ? fakeSender() : null), [loggedIn]);
  const [headsReady, setHeadsReady] = useState(false);
  useEffect(() => {
    void factoryLoad?.then(() => setHeadsReady(true));
  }, []);

  const record = (entry: string) => setLog((l) => [entry, ...l].slice(0, 8));

  const game = useMemo<GameContextValue>(
    () => ({
      sender,
      walletReady,
      login: () => {
        record("login()");
        if (walletReady) window.setTimeout(() => setLoggedIn(true), 800);
      },
      publicClient,
      me: { pid: "dev-player", name: "Zezima", verifiedWallet: loggedIn ? DEV_ADDRESS : null },
      open: (target) => {
        record(describe(target));
        const next = viewFor(target);
        setNode("");
        setView(next ?? "closed");
        if (!next) setLines((l) => appendLines(l, [gameMessage(`(harness) The shell would now show ${target.id}.`)]));
      },
      close: () => {
        record("close()");
        setNode("");
        setView("closed");
      },
      message: (text) => setLines((l) => appendLines(l, [gameMessage(text)])),
      playSound: (name) => record(`playSound("${name}")`),
      celebrate: () => record("celebrate()"),
      announce: (kind, txHash) => {
        record(`announce("${kind}", ${txHash.slice(0, 10)}...)`);
        return Promise.resolve();
      },
      setStall: (depositId) => {
        record(`setStall(${depositId ?? "null"})`);
        return Promise.resolve();
      },
      stallDepositId: null,
      renderChathead: headsReady ? harnessChathead : undefined,
    }),
    [sender, walletReady, loggedIn, headsReady],
  );

  const open = openFor(view);
  const script = scriptForView(view, sender);
  let ui: ReactNode = null;
  if (open) {
    if (script && node && script.nodes[node]) {
      ui = <ScriptedDialogue key={`${script.id}:${node}:${nonce}`} script={script} startAt={node} />;
    } else if (open.id === "how-it-works" && params.get("page") === "sell") {
      ui = <HowItWorksScroll key={nonce} onClose={game.close} initialPage="sell" />;
    } else {
      const Component = REGISTRY[open.id];
      ui = Component ? <Component key={nonce} open={open} /> : null;
    }
  }
  const inChat = place === "chat" && (open?.id === "dialogue" || open?.id === "intro");

  return (
    <GameContext.Provider value={game}>
      <GameFrame
        viewport={<Backdrop />}
        hover={view === "closed" ? { first: { verb: "Talk-to", targetName: "Banker", kind: "npc" }, more: 3 } : null}
        minimap={{ runEnergy: 87, running: true, onToggleRun: () => undefined, usdcBalance: loggedIn ? "1250.40" : null }}
        chat={{
          lines,
          playerName: "Zezima",
          onSend: (text) => setLines((l) => appendLines(l, [gameMessage(`(harness) You said: ${text}`)])),
          overlay: inChat ? ui : undefined,
        }}
        side={{
          active: tab,
          onChange: setTab,
          panels: { inventory: <InventoryPanel items={loggedIn ? INVENTORY : []} notice={loggedIn ? undefined : "Log in to see your USDC."} /> },
        }}
        interfaces={inChat ? null : ui}
      />
      {showUi && (
        <aside className="h-panel" aria-label="Harness controls">
          <div className="h-row">
            <strong>npc-ui harness</strong>
            <button type="button" onClick={() => setShowUi(false)}>
              Hide
            </button>
          </div>
          <label className="h-row">
            View
            <select
              value={view}
              onChange={(e) => {
                setView(e.target.value as View);
                setNode("");
              }}
            >
              {[...VIEWS, "closed"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {script && (
            <label className="h-row">
              Node
              <select value={node} onChange={(e) => setNode(e.target.value)}>
                <option value="">(start)</option>
                {Object.keys(script.nodes).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="h-row">
            <input type="checkbox" checked={walletReady} disabled={loggedIn} onChange={(e) => setWalletLoaded(e.target.checked)} /> Wallet service loaded (walletReady)
          </label>
          <label className="h-row">
            <input type="checkbox" checked={loggedIn} onChange={(e) => setLoggedIn(e.target.checked)} /> Logged in (sender)
          </label>
          <label className="h-row">
            <input type="checkbox" checked={place === "centre"} onChange={(e) => setPlace(e.target.checked ? "centre" : "chat")} /> Dialogue centred (not in chatbox)
          </label>
          <button type="button" onClick={() => setNonce((n) => n + 1)}>
            Restart interface
          </button>
          <ol className="h-log" aria-label="Shell calls">
            {log.length === 0 ? <li>(no calls yet)</li> : log.map((l, i) => <li key={`${i}-${l}`}>{l}</li>)}
          </ol>
        </aside>
      )}
      <output id="h-state" hidden data-view={view} data-wallet-ready={String(walletReady)} data-logged-in={String(loggedIn)} data-log={log.join("|")} />
    </GameContext.Provider>
  );
}

function Ready() {
  useEffect(() => {
    void Promise.all([ensureSprites(), factoryLoad?.catch(() => undefined)]).then(() => {
      document.body.dataset.ready = "1";
    });
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
    <Ready />
  </StrictMode>,
);
