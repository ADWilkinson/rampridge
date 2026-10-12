/**
 * Component gallery for the OSRS interface kit, frame and screens.
 * Dev only: open http://localhost:<port>/dev/ui.html. `?only=<section>`
 * renders one section full-window (used for screenshots); the frame section
 * also takes `tab`, `dialogue`, `window`, `menu`, `prompt`, `closed`,
 * `yaw` (radians), `blocking` and `compass=canvas` (the engine's compass
 * canvas slot, drawn here the way Engine.attachCompass draws it); the design
 * screen takes `body`.
 */
import "@/styles/index.css";
import "./gallery.css";

import { StrictMode, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMOTES, type Appearance, type EmoteId } from "@shared/protocol";
import type { DesignerCatalog, DesignerOption } from "@/game/osrs/types";
import {
  AmountPad,
  ArrowButton,
  ChatArea,
  ChatboxPrompt,
  Checkbox,
  CloseButton,
  CountdownText,
  Dialogue,
  ItemGrid,
  ItemSlot,
  NumberInput,
  ParchmentScroll,
  PleaseWait,
  ProgressBar,
  QrCode,
  ScrollArea,
  Sprite,
  StoneButton,
  Tabs,
  TextButton,
  Toggle,
  TooltipBox,
  VolumeSlider,
  Window,
  coinsSpriteFor,
  SPRITE_BASE,
  ensureSprites,
  formatDecimal,
  useChatPrompt,
  useSpritesReady,
  type ItemData,
} from "@/ui/kit";
import {
  AccountPanel,
  ContextMenu,
  EmotesPanel,
  GameFrame,
  InventoryPanel,
  LogoutPanel,
  COMPASS_CANVAS_SIZE,
  MINIMAP_SIZE,
  SettingsPanel,
  appendLines,
  chatLine,
  fromWorldEvent,
  gameMessage,
  type ChatLine,
  type GameSettings,
  type MenuEntry,
  type SideTabId,
} from "@/ui/frame";
import { CharacterDesign, HowItWorks, LoadingScreen, NameEntry, TitleScreen, type NameAvailability } from "@/ui/screens";
import { mountBankBackdrop } from "./sceneBackdrop";

void ensureSprites();

const params = new URLSearchParams(window.location.search);
const only = params.get("only");

// ---------------------------------------------------------------------------
// Demo data (dev only)

const NOW = Date.now();

function coinsItem(quantity: number, extra: Partial<ItemData> = {}): ItemData {
  return {
    name: "Coins",
    icon: <Sprite name={coinsSpriteFor(quantity)} />,
    quantity,
    stackable: true,
    examine: `${quantity.toLocaleString("en-US")} USDC on Base.`,
    ...extra,
  };
}

const scrollItem: ItemData = {
  name: "Payment scroll",
  icon: <Sprite name="itemClueScroll" />,
  examine: "Pay £101.50 on Revolut, then verify with Peer.",
};

const noteItem: ItemData = {
  name: "Sell order",
  icon: <Sprite name="itemBankNote" />,
  quantity: 500,
  stackable: true,
  examine: "500.00 USDC listed for GBP on Revolut. 120.00 filled.",
};

const INVENTORY: (ItemData | null)[] = [coinsItem(1250), scrollItem, noteItem, null, coinsItem(3, { name: "Coins", examine: "3 USDC." })];

const BANK: (ItemData | null)[] = [
  coinsItem(1),
  coinsItem(4),
  coinsItem(99_999),
  coinsItem(100_000),
  coinsItem(9_999_999),
  coinsItem(10_000_000),
  coinsItem(2_147_483_647),
  { ...noteItem, placeholder: true, quantity: 0, examine: "An empty sell order." },
  { ...coinsItem(250), selected: true },
  scrollItem,
];

function demoChat(): ChatLine[] {
  const t = NOW - 60_000;
  return appendLines(
    [],
    [
      gameMessage("Welcome to RampRidge.", t),
      gameMessage("Trades only settle through the bank. Never send money to a player directly.", t + 1000),
      chatLine("public", "anyone selling usdc for gbp?", { name: "Zezima", time: t + 5000, id: "c1" }),
      chatLine("public", "revolut merchant by the far booth has the best rate", { name: "Lynx Titan", time: t + 9000, id: "c2" }),
      fromWorldEvent("e1", { kind: "bought", pid: "p1", n: "Alice", usdc: "125.4", fiat: "101.5", currency: "GBP", platform: "revolut", tx: "0x1", t: t + 20000 }),
      chatLine("trade", "wishes to trade with you.", { name: "Bob", time: t + 30000, id: "c3" }),
      gameMessage("Your offer has been placed.", t + 40000),
      chatLine("public", "x".repeat(20) + " a very long message that runs right up against the eighty character cap", {
        name: "Woox",
        time: t + 50000,
        id: "c4",
      }),
    ],
  );
}

/** Designer option counts for the demo catalog (the real one comes from CharacterFactory.designer()). */
const DEMO_KIT_COUNTS: readonly [readonly number[], readonly number[]] = [
  [71, 16, 20, 17, 2, 22, 2],
  [73, 15, 20, 17, 2, 22, 2],
];
const DEMO_COLOR_COUNTS: readonly number[] = [25, 29, 29, 6, 8];

const SWATCHES = ["#5a3a1a", "#2a2a2a", "#d8b04a", "#8a2a1a", "#c0c0b0", "#3a5a8a", "#6a8a3a", "#8a3a8a", "#d07a2a", "#e8d8b0", "#3a3a6a", "#a05a3a"];

function demoCatalog(): DesignerCatalog {
  const kits = ([0, 1] as const).map((body) => DEMO_KIT_COUNTS[body].map((n) => Array.from({ length: n }, (_, i): DesignerOption => ({ index: i })))) as unknown as Record<0 | 1, DesignerOption[][]>;
  const colors = DEMO_COLOR_COUNTS.map((n, c) => Array.from({ length: n }, (_, i): DesignerOption => ({ index: i, swatch: SWATCHES[(i + c * 3) % SWATCHES.length] })));
  // Like CharacterFactory.designer(): option 0 is the client default of every slot.
  const defaults = { 0: [0, 0, 0, 0, 0, 0, 0], 1: [0, 0, 0, 0, 0, 0, 0] } as Record<0 | 1, Appearance["kits"]>;
  return { kits, colors, defaults };
}

const DEMO_APPEARANCE: Appearance = { body: params.get("body") === "1" ? 1 : 0, kits: [0, 0, 0, 0, 0, 0, 0], colors: [0, 3, 5, 0, 0] };

const TAKEN = new Set(["zezima", "woox", "lynx titan"]);
const checkName = (name: string): Promise<NameAvailability> =>
  new Promise((resolve) => window.setTimeout(() => resolve(TAKEN.has(name.toLowerCase()) ? { available: false, reason: `${name} is taken.` } : { available: true }), 500));

// ---------------------------------------------------------------------------
// Pieces

function Section({ id, title, children, note }: { id: string; title: string; children: ReactNode; note?: string }) {
  if (only && only !== id) return null;
  return (
    <section id={id} className={only ? "g-only" : "g-section"}>
      {!only && (
        <header className="g-head">
          <h2 className="rs-b12">{title}</h2>
          {note && <p className="rs-p12">{note}</p>}
        </header>
      )}
      <div className="g-body">{children}</div>
    </section>
  );
}

function Demo({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <figure className={wide ? "g-demo g-demo--wide" : "g-demo"}>
      <figcaption className="rs-p11">{label}</figcaption>
      <div className="g-demo__stage">{children}</div>
    </figure>
  );
}

function Backdrop({ orbit = false }: { orbit?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? mountBankBackdrop(ref.current, { orbit }) : undefined), [orbit]);
  return <div ref={ref} className="g-scene" />;
}

/** Draws the baked minimap image around a tile, rotated by the camera yaw, with dots. */
function useDemoMinimap(canvas: RefObject<HTMLCanvasElement | null>, yaw: number) {
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const img = new Image();
    img.src = "/game/world/minimap.png";
    img.onload = () => {
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const s = el.width / MINIMAP_SIZE.width;
      // minimap.json: minX 3164, maxY 3462, 4 px per tile.
      const px = (3184 + 0.5 - 3164) * 4;
      const py = (3462 + 1 - (3439 + 0.5)) * 4;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, el.width, el.height);
      ctx.imageSmoothingEnabled = false;
      ctx.translate(el.width / 2, el.height / 2);
      ctx.scale(s, s);
      ctx.rotate(yaw);
      ctx.drawImage(img, -px, -py);
      const dot = (tx: number, ty: number, color: string) => {
        ctx.fillStyle = "#000";
        ctx.fillRect((tx + 0.5 - 3164) * 4 - px - 1, (3462 + 1 - (ty + 0.5)) * 4 - py - 1, 4, 4);
        ctx.fillStyle = color;
        ctx.fillRect((tx + 0.5 - 3164) * 4 - px - 1, (3462 + 1 - (ty + 0.5)) * 4 - py - 1, 3, 3);
      };
      for (const y of [3438, 3440, 3442, 3444, 3446]) dot(3187, y, "#ffff00");
      dot(3182, 3441, "#ffffff");
      dot(3183, 3436, "#ffffff");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(el.width / 2 - 1.5 * s, el.height / 2 - 1.5 * s, 3 * s, 3 * s);
    };
  }, [canvas, yaw]);
}

/** Draws the compass the way Engine.attachCompass does: the whole sprite fitted to the canvas, turned by the yaw. */
function useDemoCompass(canvas: RefObject<HTMLCanvasElement | null>, yaw: number, enabled: boolean) {
  useEffect(() => {
    const el = canvas.current;
    if (!enabled || !el) return;
    const img = new Image();
    img.src = `${SPRITE_BASE}compass.png`;
    img.onload = () => {
      const ctx = el.getContext("2d");
      if (!ctx) return;
      const w = el.width;
      const h = el.height;
      const scale = Math.min(w / COMPASS_CANVAS_SIZE, h / COMPASS_CANVAS_SIZE);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(yaw);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, (-img.width / 2) * scale, (-img.height / 2) * scale, img.width * scale, img.height * scale);
      ctx.restore();
    };
  }, [canvas, yaw, enabled]);
}

function BankWindowDemo({ onClose, children }: { onClose?: () => void; children?: ReactNode }) {
  const [tab, setTab] = useState("all");
  return (
    <Window title="The Bank of RampRidge" width={488} height={334} onClose={onClose ?? (() => undefined)} draggable>
      {children}
      <div className="g-bank">
        <Tabs
          label="Bank tabs"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "all", label: "All orders" },
            { id: "open", label: "Open" },
            { id: "done", label: "Completed" },
            { id: "x", label: "Disabled", disabled: true },
          ]}
        />
        <ScrollArea className="g-bank__scroll" label="Bank items">
          <ItemGrid items={BANK} columns={8} gapX={12} gapY={4} ariaLabel="Bank" onActivate={() => undefined} onMenu={() => undefined} />
        </ScrollArea>
        <div className="g-bank__foot">
          <StoneButton>Deposit</StoneButton>
          <StoneButton selected>Item</StoneButton>
          <StoneButton>Note</StoneButton>
          <span className="rs-p12 rs-c-orange rs-shadow">Wallet: {formatDecimal("1250.4", 2)} USDC</span>
        </div>
      </div>
    </Window>
  );
}

function TradeWindowDemo() {
  return (
    <Window title="Trading with: Revolut GBP merchant" width={488} height={300} variant="steel" onClose={() => undefined}>
      <div className="g-trade">
        <div className="g-trade__col">
          <p className="rs-p12 rs-c-orange rs-shadow">Your offer:</p>
          <div className="g-trade__pane">
            <span className="rs-p12 rs-c-white rs-shadow">£100.00 (Revolut)</span>
          </div>
        </div>
        <div className="g-trade__col">
          <p className="rs-p12 rs-c-orange rs-shadow">Their offer:</p>
          <div className="g-trade__pane">
            <ItemSlot item={coinsItem(125, { examine: "125.40 USDC." })} />
          </div>
        </div>
      </div>
      <p className="g-trade__status rs-p12 rs-c-white rs-shadow">Other player has accepted.</p>
      <div className="g-trade__buttons">
        <StoneButton>Accept</StoneButton>
        <StoneButton>Decline</StoneButton>
      </div>
    </Window>
  );
}

// ---------------------------------------------------------------------------
// Sections

function TypeSection() {
  const swatches: [string, string][] = [
    ["--rs-orange", "Title orange"],
    ["--rs-yellow", "Yellow"],
    ["--rs-cyan", "Cyan"],
    ["--rs-green", "Green"],
    ["--rs-red", "Red"],
    ["--rs-chat-public", "Chat blue"],
    ["--rs-chat-trade", "Trade purple"],
    ["--rs-chat-news", "News"],
    ["--rs-dark-red", "Dialogue name"],
    ["--rs-target-item", "Item orange"],
    ["--rs-interface-bg", "Interface"],
    ["--rs-parchment", "Parchment"],
  ];
  return (
    <Section id="type" title="Type and colour" note="RS fonts at 16px are pixel-exact.">
      <Demo label="Fonts">
        <div className="g-stack">
          <p className="rs-p11 rs-c-white rs-shadow">RS Plain 11 - 1,234,567 coins / 100K / 10M</p>
          <p className="rs-p12 rs-c-orange rs-shadow">RS Plain 12 - The quick brown fox jumps over the lazy dog.</p>
          <p className="rs-b12 rs-c-yellow rs-shadow">RS Bold 12 - Bank Banker / 3 more options</p>
          <p className="rs-q8 rs-c-darkred">RS Quill 8 - Treasure Trail</p>
          <p className="rs-quill rs-c-darkred">RS Quill - How it works</p>
        </div>
      </Demo>
      <Demo label="Colour tokens">
        <div className="g-swatches">
          {swatches.map(([v, label]) => (
            <span key={v} className="g-swatch">
              <span style={{ background: `var(${v})` }} />
              <span className="rs-p11 rs-c-white rs-shadow">{label}</span>
            </span>
          ))}
        </div>
      </Demo>
    </Section>
  );
}

function WindowsSection() {
  return (
    <Section id="windows" title="Windows" note="Stone (bank) and steel (2007 trade) frames; Esc closes the top window.">
      <Demo label="Stone window with tabs, scrolling grid, buttons" wide>
        <BankWindowDemo />
      </Demo>
      <Demo label="Steel window" wide>
        <TradeWindowDemo />
      </Demo>
      <Demo label="Long title (overflow)">
        <Window title="Trading with: an extremely long merchant name that will not fit" width={300} height={110} onClose={() => undefined}>
          <p className="rs-window__pad rs-p12 rs-c-orange rs-shadow">The title truncates; the frame keeps its shape.</p>
        </Window>
      </Demo>
      <Demo label="Loading state">
        <Window title="Exchange" width={300} height={110} onClose={() => undefined}>
          <div className="g-center rs-p12 rs-c-yellow rs-shadow">
            <PleaseWait text="Fetching offers" />
          </div>
        </Window>
      </Demo>
      <Demo label="Empty state">
        <Window title="Collection box" width={300} height={110} onClose={() => undefined}>
          <div className="g-center rs-p12 rs-c-orange rs-shadow">You have nothing to collect.</div>
        </Window>
      </Demo>
      <Demo label="Error state">
        <Window title="Exchange" width={300} height={130} onClose={() => undefined}>
          <div className="g-center g-stack rs-p12">
            <span className="rs-c-red rs-shadow">No offers for Wise EUR right now.</span>
            <StoneButton>Try again</StoneButton>
          </div>
        </Window>
      </Demo>
      <Demo label="Untitled frame">
        <Window width={220} height={80} ariaLabel="Untitled">
          <div className="g-center rs-p12 rs-c-orange rs-shadow">No title bar.</div>
        </Window>
      </Demo>
    </Section>
  );
}

function ControlsSection() {
  const [check, setCheck] = useState(true);
  const [toggle, setToggle] = useState(true);
  const [vol, setVol] = useState(3);
  const [tab, setTab] = useState("buy");
  return (
    <Section id="controls" title="Buttons and controls">
      <Demo label="StoneButton: normal, hover, pressed, selected, disabled, big">
        <div className="g-row">
          <StoneButton>Confirm</StoneButton>
          <StoneButton className="is-hover">Hover</StoneButton>
          <StoneButton className="is-active" selected>
            Pressed
          </StoneButton>
          <StoneButton selected>Selected</StoneButton>
          <StoneButton disabled>Disabled</StoneButton>
          <StoneButton size="big">Confirm offer</StoneButton>
        </div>
      </Demo>
      <Demo label="TextButton tones (hover turns white)">
        <div className="g-row">
          <TextButton tone="orange">Orange option</TextButton>
          <TextButton tone="yellow">Check availability</TextButton>
          <TextButton tone="white">White option</TextButton>
          <TextButton tone="yellow" className="is-hover">
            Hovered
          </TextButton>
          <TextButton disabled>Disabled</TextButton>
        </div>
      </Demo>
      <Demo label="Close buttons, arrows">
        <div className="g-row">
          <CloseButton />
          <CloseButton className="is-hover" />
          <CloseButton variant="parchment" />
          <ArrowButton direction="left" label="Previous" />
          <ArrowButton direction="right" label="Next" />
          <ArrowButton direction="right" label="Next" disabled />
        </div>
      </Demo>
      <Demo label="Checkbox, settings toggle, volume bar">
        <div className="g-row">
          <Checkbox checked={check} onChange={setCheck} label="Accept trades" />
          <Checkbox checked={false} onChange={() => undefined} label="Disabled" disabled />
          <Toggle label="Chat effects" icon="optionIconChatEffects" fallbackText="Abc" pressed={toggle} onChange={setToggle} />
          <Toggle label="Reduced motion" icon="optionIconWalk" fallbackText="RM" pressed={false} onChange={() => undefined} />
          <VolumeSlider label="Music" icon="optionIconMusic" mutedIcon="optionIconMusicOff" value={vol} onChange={setVol} />
        </div>
      </Demo>
      <Demo label="Tabs">
        <Tabs
          label="Exchange"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "buy", label: "Buy" },
            { id: "sell", label: "Sell" },
            { id: "history", label: "History" },
          ]}
        />
      </Demo>
    </Section>
  );
}

function ItemsSection() {
  return (
    <Section id="items" title="Item slots" note="Yellow below 100K, white K below 10M, green M. Hover for examine.">
      <Demo label="Stack counts: 1, 4, 99999, 100K, 9999K, 10M, 2147M, placeholder, selected, scroll">
        <div className="g-row g-slots">
          {BANK.map((it, i) => (
            <ItemSlot key={i} item={it} />
          ))}
          <ItemSlot item={null} />
        </div>
      </Demo>
      <Demo label="Inventory panel (28 slots)">
        <div className="g-panel">
          <InventoryPanel items={INVENTORY} onActivate={() => undefined} onMenu={() => undefined} />
        </div>
      </Demo>
      <Demo label="Inventory: empty with notice">
        <div className="g-panel">
          <InventoryPanel items={[]} notice="Log in to see your USDC." />
        </div>
      </Demo>
      <Demo label="Examine box">
        <TooltipBox>125.40 USDC on Base. The wallet balance in whole dollars.</TooltipBox>
      </Demo>
    </Section>
  );
}

function ScrollSection() {
  const rows = Array.from({ length: 30 }, (_, i) => `Offer ${i + 1}: ${(980 - i * 7).toLocaleString("en-US")} USDC @ ${(0.79 + i * 0.001).toFixed(3)} GBP`);
  return (
    <Section id="scroll" title="Scrollbars">
      <Demo label="Stone list (drag the dragger, click the track or arrows)">
        <div className="g-boxed">
          <ScrollArea style={{ height: 160, width: 300 }} label="Offers">
            <ul className="g-list rs-p12">
              {rows.map((r) => (
                <li key={r} className="rs-c-orange rs-shadow">
                  {r}
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      </Demo>
      <Demo label="Parchment list">
        <div className="g-boxed g-boxed--parchment">
          <ScrollArea style={{ height: 160, width: 300 }} variant="parchment" label="Rules">
            <ul className="g-list rs-p12">
              {rows.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      </Demo>
      <Demo label="Empty list (not scrollable)">
        <div className="g-boxed">
          <ScrollArea style={{ height: 80, width: 300 }} label="Empty">
            <p className="rs-p12 rs-c-orange rs-shadow g-pad">No offers yet.</p>
          </ScrollArea>
        </div>
      </Demo>
    </Section>
  );
}

function DialogueSection() {
  const head = (
    <span className="g-head-demo">
      <Sprite name="tabIconAccount" canvas scale={2} />
    </span>
  );
  return (
    <Section id="dialogue" title="Dialogue" note="Space continues, number keys pick options.">
      <Demo label="NPC with chathead slot" wide>
        <ChatArea>
          <Dialogue speaker={{ name: "Banker", head }} text="Good day, how may I help you?" onContinue={() => undefined} />
        </ChatArea>
      </Demo>
      <Demo label="Select an Option" wide>
        <ChatArea>
          <Dialogue
            kind="options"
            options={[
              { label: "I'd like to access my bank account, please.", onSelect: () => undefined },
              { label: "I'd like to buy some coins.", onSelect: () => undefined },
              { label: "I'd like to sell my coins.", onSelect: () => undefined },
              { label: "What is this place?", onSelect: () => undefined },
            ]}
          />
        </ChatArea>
      </Demo>
      <Demo label="Player speaks (head on the right), long text" wide>
        <ChatArea>
          <Dialogue
            speaker={{ name: "Zezima", side: "right", head }}
            text="I sent exactly £101.50 to the handle shown on the scroll, from my own account, using Friends & Family, and did not mention crypto in the note."
            onContinue={() => undefined}
          />
        </ChatArea>
      </Demo>
      <Demo label="Message without speaker" wide>
        <ChatArea>
          <Dialogue text="Your offer has been placed. The seller has 15 minutes to be paid." onContinue={() => undefined} />
        </ChatArea>
      </Demo>
      <Demo label="Chatbox prompt" wide>
        <ChatArea>
          <ChatboxPrompt request={{ title: "Enter amount:", kind: "amount", decimals: 2, initial: "101.5", hint: "Between £10.00 and £1,000.00", onSubmit: () => undefined }} onDone={() => undefined} />
        </ChatArea>
      </Demo>
    </Section>
  );
}

function InputsSection() {
  const [qty, setQty] = useState(250);
  const [fiat, setFiat] = useState(101.5);
  return (
    <Section id="inputs" title="Amounts and progress">
      <Demo label="AmountPad (whole USDC)">
        <div className="g-boxed g-pad" style={{ width: 300 }}>
          <AmountPad label="Quantity:" value={qty} onChange={setQty} rules={{ min: 0, max: 100_000 }} />
        </div>
      </Demo>
      <Demo label="AmountPad (fiat, two decimals)">
        <div className="g-boxed g-pad" style={{ width: 300 }}>
          <AmountPad label="Amount (GBP):" value={fiat} onChange={setFiat} rules={{ min: 10, max: 1000, decimals: 2 }} steps={[10, 100, 1000]} format={(v) => `£${formatDecimal(v, 2)}`} promptHint="Between £10.00 and £1,000.00" />
        </div>
      </Demo>
      <Demo label="Disabled pad and value box">
        <div className="g-boxed g-pad g-stack" style={{ width: 300 }}>
          <AmountPad label="Quantity:" value={0} onChange={() => undefined} disabled />
          <NumberInput display="1,250 USDC" ariaLabel="Balance" />
        </div>
      </Demo>
      <Demo label="Offer bars: waiting, half, complete, aborted">
        <div className="g-stack">
          <ProgressBar value={0} ariaLabel="Waiting" />
          <ProgressBar value={0.5} label="50%" ariaLabel="Half" />
          <ProgressBar value={1} state="complete" ariaLabel="Complete" />
          <ProgressBar value={0.3} state="aborted" ariaLabel="Aborted" />
        </div>
      </Demo>
    </Section>
  );
}

function MiscSection() {
  return (
    <Section id="misc" title="Status, QR, countdowns, scrolls">
      <Demo label="Please wait">
        <p className="rs-p12 rs-c-yellow rs-shadow">
          <PleaseWait />
        </p>
      </Demo>
      <Demo label="Countdowns: normal, under 5 minutes, expired, words">
        <div className="g-stack rs-p12 rs-c-orange rs-shadow">
          <span>
            Expires in <CountdownText until={NOW + 14 * 60_000 + 59_000} />
          </span>
          <span>
            Expires in <CountdownText until={NOW + 4 * 60_000 + 5_000} />
          </span>
          <span>
            Order: <CountdownText until={NOW - 1000} />
          </span>
          <span>
            About <CountdownText until={NOW + 3 * 3_600_000} format="words" /> left
          </span>
        </div>
      </Demo>
      <Demo label="QR code (scannable)">
        <QrCode value="https://revolut.me/rampridge?amount=101.50" label="QR code to pay with Revolut" size={140} />
      </Demo>
      <Demo label="Parchment scroll" wide>
        <ParchmentScroll title="Payment" width={400} onClose={() => undefined} fit={false}>
          <p className="rs-p12">Send exactly £101.50 to @revtag on Revolut.</p>
          <p className="rs-p12 g-red">Only pay the exact amount shown, to this handle, from your own account.</p>
        </ParchmentScroll>
      </Demo>
      <Demo label="Missing sprite falls back">
        <div className="g-row">
          <Sprite id={99999} fallback={<span className="rs-p11 rs-c-grey rs-shadow">(missing sprite)</span>} />
          <Sprite name="optionBox" />
        </div>
      </Demo>
    </Section>
  );
}

const WORLD_MENU: MenuEntry[] = [
  { verb: "Talk-to", targetName: "Banker", kind: "npc" },
  { verb: "Bank", targetName: "Banker", kind: "npc" },
  { verb: "Exchange", targetName: "Banker", kind: "npc" },
  { verb: "Examine", targetName: "Banker", kind: "npc" },
  { verb: "Bank", targetName: "Bank booth", kind: "object" },
  { verb: "Trade with", targetName: "Zezima", kind: "player", suffix: "(stall)" },
  { verb: "Withdraw-All", targetName: "Coins", kind: "item" },
  { verb: "Walk here" },
];

function MenuSection() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(only === "menu" ? { x: 280, y: 120 } : null);
  return (
    <Section id="menu" title="Choose Option menu" note="Right-click the box; the menu closes when the mouse leaves it.">
      <div
        className="g-menu-target rs-p12 rs-c-orange rs-shadow"
        onContextMenu={(e) => {
          e.preventDefault();
          setAt({ x: e.clientX, y: e.clientY });
        }}
        onClick={(e) => setAt({ x: e.clientX, y: e.clientY })}
      >
        Click or right-click here
      </div>
      {at && <ContextMenu x={at.x} y={at.y} options={WORLD_MENU} onSelect={() => setAt(null)} onClose={() => setAt(null)} />}
    </Section>
  );
}

const DEMO_WORLDS = [
  { id: 301, players: 184, full: false, closed: false },
  { id: 302, players: 96, full: false, closed: false },
  { id: 303, players: 200, full: true, closed: false },
  { id: 304, players: 12, full: false, closed: false },
  { id: 305, players: 0, full: false, closed: false },
];

function FrameDemo({ contained }: { contained: boolean }) {
  const initialTab = (params.get("tab") as SideTabId | null) ?? "inventory";
  const [tab, setTab] = useState<SideTabId | null>(params.get("closed") ? null : initialTab);
  // Phones start with the side sheet put away (GameFrame closes it on mount); an explicit ?tab= reopens it.
  useEffect(() => {
    const asked = params.get("tab") as SideTabId | null;
    if (asked) setTab(asked);
  }, []);
  const [lines, setLines] = useState(demoChat);
  const [running, setRunning] = useState(true);
  const [settings, setSettings] = useState<GameSettings>({ soundVolume: 4, musicVolume: 2, chatEffects: true, reducedMotion: false });
  const [dialogue, setDialogue] = useState(params.get("dialogue") === "1");
  const [bank, setBank] = useState(params.get("window") === "bank");
  const [scroll, setScroll] = useState(params.get("window") === "scroll");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(params.get("menu") ? { x: 620, y: 330 } : null);
  const [yaw] = useState(() => Number(params.get("yaw") ?? 0.35));
  const canvas = useRef<HTMLCanvasElement>(null);
  const compassCanvas = useRef<HTMLCanvasElement>(null);
  const compassOnCanvas = params.get("compass") === "canvas";
  useDemoMinimap(canvas, yaw);
  useDemoCompass(compassCanvas, yaw, compassOnCanvas);

  const panels = useMemo(
    () => ({
      inventory: <InventoryPanel items={INVENTORY} onActivate={() => setBank(true)} onMenu={(_i, _it, p) => setMenu(p)} />,
      account: (
        <AccountPanel
          displayName="Zezima"
          onRename={() => undefined}
          address="0x2a9e8fa175F45b235efDdD97d2727741EF4Eee63"
          walletKind="smart"
          sponsored
          verified={false}
          onLogin={() => undefined}
          onVerify={() => undefined}
          onLogoutWallet={() => undefined}
          onSend={() => undefined}
          onReceive={() => undefined}
          loginMethod="Logged in with email: zezima.the.legend@example.com"
        />
      ),
      emotes: <EmotesPanel onEmote={(e: EmoteId) => setLines((l) => appendLines(l, [gameMessage(`You do the ${e} emote.`)]))} />,
      settings: <SettingsPanel settings={settings} onChange={(p) => setSettings((s) => ({ ...s, ...p }))} />,
      logout: <LogoutPanel onLogout={() => undefined} world={302} worlds={DEMO_WORLDS} onHop={() => undefined} />,
    }),
    [settings],
  );

  return (
    <GameFrame
      contained={contained}
      viewport={<Backdrop />}
      blocking={params.get("blocking") === "1"}
      hover={{ first: { verb: "Bank", targetName: "Banker", kind: "npc" }, more: 3 }}
      minimap={{
        canvasRef: canvas,
        compassCanvasRef: compassOnCanvas ? compassCanvas : undefined,
        compassAngle: yaw,
        onCompassClick: () => undefined,
        runEnergy: 87,
        running,
        onToggleRun: () => setRunning((r) => !r),
        usdcBalance: "1250.40",
        onUsdcClick: () => setTab("inventory"),
      }}
      chat={{
        lines,
        playerName: "Zezima",
        onSend: (text) => setLines((l) => appendLines(l, [chatLine("public", text, { name: "Zezima" })])),
        overlay: dialogue ? (
          <Dialogue
            kind="options"
            options={[
              {
                label: "I'd like to access my bank account, please.",
                onSelect: () => {
                  setDialogue(false);
                  setBank(true);
                },
              },
              { label: "I'd like to buy some coins.", onSelect: () => setDialogue(false) },
              { label: "I'd like to sell my coins.", onSelect: () => setDialogue(false) },
              {
                label: "What is this place?",
                onSelect: () => {
                  setDialogue(false);
                  setScroll(true);
                },
              },
            ]}
          />
        ) : undefined,
      }}
      side={{ active: tab, onChange: setTab, panels }}
      interfaces={
        <>
          {/* With the bank open, ?prompt=1 is asked by the bank, so it closes with it. */}
          {bank && (
            <BankWindowDemo onClose={() => setBank(false)}>
              <PromptOpener />
            </BankWindowDemo>
          )}
          {scroll && <HowItWorks onClose={() => setScroll(false)} />}
          {params.get("window") !== "bank" && <PromptOpener />}
        </>
      }
      menu={menu && <ContextMenu x={menu.x} y={menu.y} options={WORLD_MENU} onSelect={() => setMenu(null)} onClose={() => setMenu(null)} />}
    />
  );
}

/** Opens the chatbox amount prompt when ?prompt=1 (inside GameFrame's provider, or the window it sits in). */
function PromptOpener() {
  const prompt = useChatPrompt();
  useEffect(() => {
    if (params.get("prompt") === "1") prompt?.open({ title: "Enter amount:", kind: "amount", decimals: 2, onSubmit: () => undefined });
    // Open once on mount.
  }, []);
  return null;
}

function FrameSection() {
  if (only === "frame") return <FrameDemo contained={false} />;
  return (
    <Section id="frame" title="Game frame" note="Resizable classic layout over the baked bank scene. Phones: see ?only=frame at 390px.">
      <div className="g-frame-box">
        <FrameDemo contained />
      </div>
    </Section>
  );
}

function ScreensSection() {
  const [appearance, setAppearance] = useState<Appearance>(DEMO_APPEARANCE);
  const [name, setName] = useState("Zezima");
  const catalog = useMemo(demoCatalog, []);
  const screen = only;
  const loading = (
    <LoadingScreen
      progress={params.get("error") ? 0.3 : 0.45}
      label="Loading world"
      error={params.get("error") ? "The world data did not download. Check your connection." : null}
      onRetry={() => undefined}
    />
  );
  const title = (
    <>
      <Backdrop orbit />
      <TitleScreen
        onPlay={() => undefined}
        onExistingUser={() => undefined}
        onHowItWorks={() => undefined}
        busy={params.get("busy") === "1" ? "play" : null}
        error={params.get("error") ? "Could not reach the world server. Try again." : null}
      />
    </>
  );
  const design = (
    <>
      <Backdrop />
      <div className="rs-window-host">
        <CharacterDesign
          appearance={appearance}
          onChange={setAppearance}
          catalog={catalog}
          preview={
            <span className="g-preview">
              <Sprite name="emoteCheer" canvas scale={3} />
            </span>
          }
          name={name}
          onNameChange={setName}
          onCheckName={checkName}
          onAccept={() => undefined}
          onSkip={() => undefined}
        />
      </div>
    </>
  );
  const rename = (
    <>
      <Backdrop />
      <div className="rs-window-host">
        <NameEntry initialName="Zezima" onCheck={checkName} onSubmit={() => undefined} onClose={() => undefined} />
      </div>
    </>
  );
  const howto = (
    <>
      <Backdrop />
      <div className="rs-window-host">
        <HowItWorks onClose={() => undefined} />
      </div>
    </>
  );
  const map: Record<string, ReactNode> = { loading, title, design, rename, howto };
  if (screen && map[screen]) return <div className="g-screen">{map[screen]}</div>;
  if (only) return null;
  return (
    <Section id="screens" title="Screens">
      {Object.entries(map).map(([k, node]) => (
        <Demo key={k} label={k} wide>
          <div className="g-screen g-screen--boxed">{node}</div>
        </Demo>
      ))}
    </Section>
  );
}

function EmotesSection() {
  return (
    <Section id="panels" title="Side panels">
      <Demo label="Emotes">
        <div className="g-panel">
          <EmotesPanel onEmote={() => undefined} />
        </div>
      </Demo>
      <Demo label="Settings">
        <div className="g-panel">
          <SettingsPanel settings={{ soundVolume: 4, musicVolume: 0, chatEffects: true, reducedMotion: true }} onChange={() => undefined} />
        </div>
      </Demo>
      <Demo label="Account: guest">
        <div className="g-panel">
          <AccountPanel displayName="Guest 4821" address={null} verified={false} onLogin={() => undefined} onVerify={() => undefined} onLogoutWallet={() => undefined} />
        </div>
      </Demo>
      <Demo label="Account: verified, error">
        <div className="g-panel">
          <AccountPanel
            displayName="Zezima"
            onRename={() => undefined}
            address="0x2a9e8fa175F45b235efDdD97d2727741EF4Eee63"
            walletKind="external"
            verified
            error="Your wallet rejected the signature."
            onLogin={() => undefined}
            onVerify={() => undefined}
            onLogoutWallet={() => undefined}
          />
        </div>
      </Demo>
      <Demo label="Logout">
        <div className="g-panel">
          <LogoutPanel onLogout={() => undefined} />
        </div>
      </Demo>
      <Demo label="Emote ids">
        <p className="rs-p11 rs-c-white rs-shadow">{EMOTES.join(", ")}</p>
      </Demo>
    </Section>
  );
}

function Gallery() {
  const ready = useSpritesReady();
  useEffect(() => {
    document.documentElement.dataset.spritesReady = ready ? "1" : "0";
  }, [ready]);
  if (only && ["frame", "loading", "title", "design", "rename", "howto"].includes(only)) {
    return (
      <div className="rs-game g-full">
        {only === "frame" ? <FrameSection /> : <ScreensSection />}
      </div>
    );
  }
  return (
    <main className="rs-game g-root">
      {!only && (
        <header className="g-title">
          <h1 className="rs-b12 rs-c-orange rs-shadow">RampRidge interface kit</h1>
          <nav className="rs-p12">
            {["type", "windows", "controls", "items", "scroll", "dialogue", "inputs", "misc", "menu", "panels", "frame", "screens"].map((id) => (
              <a key={id} href={`#${id}`} className="rs-textbtn rs-textbtn--yellow">
                {id}
              </a>
            ))}
          </nav>
        </header>
      )}
      <TypeSection />
      <WindowsSection />
      <ControlsSection />
      <ItemsSection />
      <ScrollSection />
      <DialogueSection />
      <InputsSection />
      <MiscSection />
      <MenuSection />
      <EmotesSection />
      <FrameSection />
      <ScreensSection />
    </main>
  );
}

// Reuse the root across hot reloads of this module.
const host = window as unknown as { __rsGalleryRoot?: Root };
host.__rsGalleryRoot ??= createRoot(document.getElementById("root")!);
host.__rsGalleryRoot.render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
