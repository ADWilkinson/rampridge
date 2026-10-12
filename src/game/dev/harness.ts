/**
 * Engine dev harness (dev/engine.html): runs the real engine against the
 * baked world with simulated remote players walking random routes, two
 * merchants, a player with a stall, the minimap and compass, a plain HTML
 * context menu and a message log. Query parameters:
 *   ?actors=seed   use the research seed models instead of the OSRS runtime
 *   ?debug=1       draw the collision grid and tile coordinates
 *   ?view=default|rotated|zoomed|title|menu   stage a view for screenshots
 *   ?players=N     number of simulated players (default 8)
 *   ?merchants=N   number of merchants, in the shell's list order (default 8)
 *   ?area=aisle4|hall   widen the merchant area (x 3181-3184, or the whole
 *                  customer side) to preview a re-bake
 *   ?reduced=1     turn on the reduced-motion setting
 *   ?spawn=x,y     where the local player enters (default 3184,3439, mid-hall;
 *                  the server's spawn row is y 3435-3436 inside the door)
 *   ?hint=1        forget the banker hint arrow's dismissal so it shows again
 */

import { CHAT_COLORS, CHAT_MOTIONS } from "@shared/chat";
import { EMOTES, encodePath, type PlayerRecord, type Tile } from "@shared/protocol";
import { createCharacterFactory } from "@/game/osrs";
import { createEngine } from "../index";
import { HINT_STORAGE_KEY } from "../overlay/hintArrow";
import type { EngineEventName, MenuOption, MerchantSpec, RemotePlayerView } from "../types";
import { CollisionMap } from "../world/collision";
import { findPath } from "../world/pathfinding";
import { bundledCollision, bundledWorldMeta, parseWorldMeta } from "../world/worldMeta";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "default";
const playerCount = Number(params.get("players") ?? 8);
const merchantCount = Number(params.get("merchants") ?? 8);
const characters = createCharacterFactory();

/** The bundled meta, with the merchant area widened when ?area= asks for it. */
function harnessMeta(): Record<string, unknown> {
  const raw = bundledWorldMeta() as Record<string, unknown>;
  const area = params.get("area");
  const rect =
    area === "aisle4" ? { minX: 3181, minY: 3435, maxX: 3184, maxY: 3445 } : area === "hall" ? { minX: 3180, minY: 3434, maxX: 3185, maxY: 3446 } : null;
  return rect ? { ...raw, merchantArea: rect } : raw;
}

/** The local player's entry tile from ?spawn=x,y. */
function spawnTile(): Tile {
  const [x, y] = (params.get("spawn") ?? "").split(",").map(Number);
  return Number.isInteger(x) && Number.isInteger(y) ? { x: x!, y: y! } : { x: 3184, y: 3439 };
}

if (params.get("hint") === "1") {
  try {
    localStorage.removeItem(HINT_STORAGE_KEY);
  } catch {
    // Storage blocked: the hint shows anyway.
  }
}

const engine = createEngine({ characters, worldMeta: harnessMeta() });
if (params.get("reduced") === "1") engine.setReducedMotion(true);
const host = document.getElementById("world")!;

// ---------------------------------------------------------------- UI chrome

const KIND_COLOURS: Record<MenuOption["kind"], string> = {
  npc: "#ffff00",
  object: "#00ffff",
  player: "#ffffff",
  item: "#ff9040",
  tile: "#ffffff",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: Partial<CSSStyleDeclaration>, parent: HTMLElement = document.body) {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  parent.appendChild(node);
  return node;
}

const font = '16px "RS Bold 12", monospace';
const hover = el("div", { position: "fixed", left: "6px", top: "4px", font, color: "#fff", textShadow: "1px 1px 0 #000", pointerEvents: "none", zIndex: "5" });
const log = el("div", {
  position: "fixed",
  left: "6px",
  bottom: "6px",
  width: "min(480px, calc(100vw - 12px))",
  maxHeight: "120px",
  overflow: "hidden",
  font: '16px "RS Plain 11", monospace',
  color: "#000",
  background: "rgba(214, 196, 158, 0.86)",
  border: "2px solid #3e3529",
  padding: "4px 6px",
  zIndex: "5",
});
const minimapFrame = el("div", {
  position: "fixed",
  right: "8px",
  top: "8px",
  width: "152px",
  height: "152px",
  borderRadius: "50%",
  background: "#000",
  boxShadow: "0 0 0 3px #3e3529, 0 0 0 5px #000",
  zIndex: "5",
});
const minimap = el("canvas", { width: "152px", height: "152px", borderRadius: "50%", display: "block", cursor: "pointer" }, minimapFrame);
const compass = el("canvas", { position: "fixed", right: "158px", top: "6px", width: "34px", height: "34px", cursor: "pointer", zIndex: "6" });
const dpr = Math.min(window.devicePixelRatio || 1, 2);
minimap.width = minimap.height = Math.round(152 * dpr);
compass.width = compass.height = Math.round(34 * dpr);

const controls = el("div", { position: "fixed", right: "8px", bottom: "8px", display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "60vw", zIndex: "5" });
function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { font: '16px "RS Plain 11", monospace', background: "#3e3529", color: "#ff981f", border: "1px solid #000", padding: "4px 8px", cursor: "pointer" }, controls);
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function message(text: string, colour = "#000"): void {
  const line = el("div", { color: colour, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, log);
  line.textContent = text;
  while (log.children.length > 6) log.firstChild?.remove();
}

const menu = el("div", {
  position: "fixed",
  display: "none",
  background: "#5d5447",
  border: "1px solid #000",
  font,
  zIndex: "10",
  minWidth: "120px",
  userSelect: "none",
});

function closeMenu(): void {
  menu.style.display = "none";
}

function optionLabel(o: MenuOption, node: HTMLElement): void {
  node.append(document.createTextNode(o.targetName ? `${o.verb} ` : o.verb));
  if (o.targetName) {
    const name = document.createElement("span");
    name.style.color = KIND_COLOURS[o.kind];
    name.textContent = o.targetName + (o.suffix ? ` ${o.suffix}` : "");
    node.append(name);
  }
}

function openMenu(x: number, y: number, options: MenuOption[]): void {
  menu.replaceChildren();
  const header = el("div", { background: "#000", color: "#5d5447", padding: "1px 4px" }, menu);
  header.textContent = "Choose Option";
  const rows: [string, (() => void) | null, MenuOption | null][] = [
    ...options.map((o): [string, () => void, MenuOption] => ["", () => engine.choose(o), o]),
    ["Cancel", null, null],
  ];
  for (const [label, action, option] of rows) {
    const row = el("div", { color: "#fff", padding: "1px 4px", whiteSpace: "nowrap", cursor: "pointer", textShadow: "1px 1px 0 #000" }, menu);
    if (option) optionLabel(option, row);
    else row.textContent = label;
    row.addEventListener("pointerenter", () => (row.style.color = "#ffff00"));
    row.addEventListener("pointerleave", () => (row.style.color = "#fff"));
    row.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      closeMenu();
      action?.();
    });
  }
  menu.style.display = "block";
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(window.innerWidth - rect.width, x - rect.width / 2))}px`;
  menu.style.top = `${Math.max(0, Math.min(window.innerHeight - rect.height, y))}px`;
}
menu.addEventListener("pointerleave", closeMenu);

// ---------------------------------------------------------------- engine wiring

let titleMode = view === "title";
let running = false;
let soundOn = true;
const LOCAL_PID = "local";

// Every event, recorded for scripted checks (window.__harness).
const events: { name: EngineEventName; payload: unknown; at: number }[] = [];
for (const name of ["move", "interact", "examine", "menu", "worldClick", "hover", "ready"] as const) {
  engine.on(name, (payload: unknown) => events.push({ name, payload, at: performance.now() }));
}
Object.assign(window, { __harness: { engine, events } });

engine.on("progress", ({ fraction, label }) => {
  hover.textContent = `${label} - ${Math.round(fraction * 100)}%`;
});
engine.on("hover", (h) => {
  hover.replaceChildren();
  if (!h) return;
  optionLabel(h.first, hover);
  if (h.more > 0) hover.append(document.createTextNode(` / ${h.more} more options`));
});
engine.on("menu", ({ x, y, options }) => openMenu(x, y, options));
engine.on("worldClick", closeMenu);
engine.on("examine", ({ text }) => message(text));
engine.on("move", ({ path, run }) => message(`move ${path.length - 1} steps${run ? " (run)" : ""} to ${path.at(-1)!.x},${path.at(-1)!.y}`, "#00007f"));
engine.on("interact", ({ verb, target }) => message(`interact: ${verb} ${JSON.stringify(target)}`, "#7f0000"));

button("Title", () => {
  titleMode = !titleMode;
  engine.setTitleMode(titleMode);
});
const runButton = button("Run: off", () => {
  running = !running;
  engine.setRunning(running);
  runButton.textContent = `Run: ${running ? "on" : "off"}`;
});
button("North", () => engine.resetCameraNorth());
button("Celebrate", () => engine.celebrate(LOCAL_PID));
button("Wave", () => engine.playEmote(LOCAL_PID, "wave"));
const soundButton = button("Sound: on", () => {
  soundOn = !soundOn;
  engine.setSoundEnabled(soundOn);
  soundButton.textContent = `Sound: ${soundOn ? "on" : "off"}`;
});

// ---------------------------------------------------------------- simulated world

const NAMES = ["Zezima", "Woox", "B0aty", "Lynx Titan", "Settled", "Torvesta", "Framed", "Mmorpg", "Coxie", "Dino", "Skiddler", "Sick Nerd"];
const CHAT = ["selling gf", "buying usdc", "anyone on revolut?", "lol", "trade me", "nice", "gz!", "venmo seller here", "how long does it take", "first time here"];

interface FakePlayer {
  pid: string;
  record: PlayerRecord;
  nextMove: number;
  nextChat: number;
}

function randomTile(map: CollisionMap, tiles: Tile[]): Tile {
  for (;;) {
    const t = tiles[Math.floor(Math.random() * tiles.length)]!;
    if (map.isWalkable(t.x, t.y)) return t;
  }
}

async function main(): Promise<void> {
  if (titleMode) engine.setTitleMode(true);
  engine.mount(host);
  engine.attachMinimap(minimap);
  engine.attachCompass(compass);
  // Like the game frame: overhead text keeps out from under the minimap.
  const exclude = () => {
    const r = minimapFrame.getBoundingClientRect();
    engine.setOverlayExclusion({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  };
  exclude();
  window.addEventListener("resize", exclude);
  await engine.load();

  const meta = parseWorldMeta(harnessMeta());
  const map = CollisionMap.from(bundledCollision());
  map.setBounds(meta.bounds);
  const floor: Tile[] = [];
  for (let y = meta.bounds.minY; y <= meta.bounds.maxY; y++) {
    for (let x = meta.bounds.minX; x <= meta.bounds.maxX; x++) if (map.isWalkable(x, y)) floor.push({ x, y });
  }

  engine.setLocalPlayer({ pid: LOCAL_PID, name: "You", appearance: characters.randomAppearance("local-player"), tile: spawnTile() });

  // A live-like book in the shell's order (majors first, then by depth), with its shout styles.
  const book: [string, string, string, string, string][] = [
    ["venmo", "USD", "Venmo trader", "3,050", "1.019"],
    ["revolut", "EUR", "Revolut EUR trader", "2,410", "0.9312"],
    ["revolut", "GBP", "Revolut GBP trader", "1,240", "0.7942"],
    ["cashapp", "USD", "Cash App trader", "980", "1.021"],
    ["wise", "EUR", "Wise EUR trader", "760", "0.9355"],
    ["zelle", "USD", "Zelle trader", "640", "1.018"],
    ["wise", "GBP", "Wise GBP trader", "520", "0.7988"],
    ["paypal", "USD", "PayPal trader", "410", "1.032"],
    ["monzo", "GBP", "Monzo trader", "300", "0.801"],
    ["revolut", "USD", "Revolut USD trader", "250", "1.025"],
  ];
  const styles = ["red:wave", "yellow:wave2", "green:wave", "glow1:wave", "cyan:wave2", "flash1:wave", "purple:wave", "white:wave2", "yellow:scroll", "glow2:shake"];
  const merchants: MerchantSpec[] = book.slice(0, Math.max(0, merchantCount)).map(([platform, currency, name, amount, rate], i) => ({
    id: `${platform}:${currency}`,
    name,
    platform,
    currency,
    shout: `${styles[i % styles.length]}:Selling ${amount} USDC @ ${rate} ${currency} on ${name.replace(/ ([A-Z]{3} )?trader$/, "")}!`,
    seed: `${platform}:${currency}`,
  }));
  engine.setMerchants(merchants);

  const players: FakePlayer[] = [];
  const now = Date.now();
  for (let i = 0; i < playerCount; i++) {
    const name = NAMES[i % NAMES.length]! + (i >= NAMES.length ? ` ${i}` : "");
    const tile = randomTile(map, floor);
    players.push({
      pid: `p${i}`,
      record: {
        n: name,
        a: characters.randomAppearance(name),
        p: encodePath([tile]),
        t: now,
        r: false,
        e: null,
        et: null,
        ls: now,
        j: now,
      },
      nextMove: now + Math.random() * 3_000,
      nextChat: now + 1_000 + Math.random() * 6_000,
    });
  }
  const stallPid = players[0]?.pid;
  if (stallPid) {
    engine.setStalls({
      [stallPid]: {
        depositId: "0x2f1b4e7a9c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f_5559",
        escrow: "0x2f1b4e7a9c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f",
        platform: "wise",
        currency: "EUR",
        available: "500.250000",
        rate: "0.9312",
      },
    });
  }

  const sync = () => {
    const t = Date.now();
    for (const p of players) {
      const path = p.record.p.split(";");
      const steps = path.length - 1;
      const done = t >= p.record.t + steps * (p.record.r ? 300 : 600);
      if (done && t >= p.nextMove && p.pid !== stallPid) {
        const last = path.at(-1)!.split(",").map(Number) as [number, number];
        const route = findPath(map, { x: last[0], y: last[1] }, randomTile(map, floor));
        if (route && route.length > 1) {
          p.record = { ...p.record, p: encodePath(route), t, r: Math.random() < 0.3 };
        }
        p.nextMove = t + 1_500 + Math.random() * 5_000;
      }
      if (t >= p.nextChat) {
        p.nextChat = t + 4_000 + Math.random() * 9_000;
        const colour = Math.random() < 0.5 ? null : CHAT_COLORS[Math.floor(Math.random() * CHAT_COLORS.length)]!;
        const motion = Math.random() < 0.5 ? null : CHAT_MOTIONS[Math.floor(Math.random() * CHAT_MOTIONS.length)]!;
        const fx = [colour, motion].filter(Boolean).join(":") || null;
        engine.showChat({ pid: p.pid }, CHAT[Math.floor(Math.random() * CHAT.length)]!, fx);
        if (Math.random() < 0.25) p.record = { ...p.record, e: EMOTES[Math.floor(Math.random() * EMOTES.length)]!, et: t };
      }
    }
    const views: RemotePlayerView[] = players.map((p) => ({ pid: p.pid, record: p.record }));
    engine.syncPlayers(views, t);
  };
  sync();
  setInterval(sync, 400);
  if (stallPid) engine.showChat({ pid: stallPid }, "Selling USDC for EUR, trade me!", "cyan:wave2");

  await stage();
}

/** Stages the requested view for screenshots, then marks the page ready. */
async function stage(): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const target = host.querySelector<HTMLElement>("[data-engine=world]")!;
  const press = (key: string, ms: number) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    return wait(ms).then(() => window.dispatchEvent(new KeyboardEvent("keyup", { key })));
  };
  await wait(2_500);
  if (view === "rotated") {
    await press("ArrowLeft", 1_100);
    await press("ArrowUp", 600);
  } else if (view === "zoomed") {
    for (let i = 0; i < 5; i++) target.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
  } else if (view === "menu") {
    let opened = false;
    const off = engine.on("menu", ({ options }) => {
      opened = options.length > 0 && options[0]!.kind !== "tile";
    });
    const w = window.innerWidth;
    const h = window.innerHeight;
    outer: for (let y = Math.round(h * 0.25); y < h * 0.75; y += 8) {
      for (let x = Math.round(w * 0.35); x < w * 0.75; x += 8) {
        const init = { clientX: x, clientY: y, bubbles: true, pointerType: "mouse" } as const;
        target.dispatchEvent(new PointerEvent("pointermove", init));
        target.dispatchEvent(new PointerEvent("pointerdown", { ...init, button: 2 }));
        if (opened) break outer;
      }
    }
    off();
  }
  await wait(1_500);
  document.body.dataset.ready = "1";
}

main().catch((err: unknown) => {
  console.error(err);
  hover.textContent = `Engine failed: ${err instanceof Error ? err.message : String(err)}`;
});
