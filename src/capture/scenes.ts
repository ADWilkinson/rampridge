/**
 * The launch-video beats. Each beat sets the world up before frame 0
 * (`setup`), then `run` plays it against the clock the recorder steps; every
 * wait is in page time, so a beat replays frame for frame. Clicks go through
 * the real interfaces and the real context menu. `still` marks the frame the
 * recorder also saves as a PNG.
 */
import type { EmoteId, Tile } from "@shared/protocol";
import type { Engine, TargetRef } from "@/game";
import type { LiveMerchant } from "@/app/merchants";
import type { createBuyStore } from "@/peer/buy";
import type { SideTabId } from "@/ui/frame";
import type { OpenInterface } from "@/ui/interfaces/context";
import type { Timing } from "@/ui/interfaces/buy/simulated";
import type { TxSender } from "@/wallet/types";
import { CHAT, CROWD } from "./fixtures";

export type BeatId = "walkin" | "exchange" | "trade" | "payverify" | "sell" | "social" | "orbit";

export interface Director {
  engine: Engine;
  phone: boolean;
  local: { pid: string; name: string };
  merchants: LiveMerchant[];
  wait(ms: number): Promise<void>;
  cue(name: string): void;
  still(name: string): void;
  moveTo(x: number, y: number, ms?: number): Promise<void>;
  moveToTarget(target: TargetRef, ms?: number, dy?: number): Promise<{ x: number; y: number }>;
  rightClick(): Promise<unknown[]>;
  leftClickWorld(): Promise<void>;
  /** Clicks a floor tile: yellow cross and a walk there (no entity under the cursor can steal the click). */
  walkClick(tile: Tile, ms?: number): Promise<void>;
  choose(verb: string, ms?: number): Promise<void>;
  click(target: string, ms?: number): Promise<void>;
  type(selector: string, text: string, perChar?: number): Promise<void>;
  open(target: OpenInterface | null): void;
  tab(tab: SideTabId | null): void;
  hud(visible: boolean): void;
  game(text: string): void;
  news(text: string, name?: string): void;
  say(pid: string, text: string, fx?: string | null): void;
  shout(merchantId: string, text: string): void;
  emote(pid: string, emote: EmoteId): void;
  celebrate(pid: string): void;
  placePlayer(pid: string, tile: Tile): void;
  walkPlayer(pid: string, to: Tile, run?: boolean): void;
  syncPlayers(): void;
  setLocal(tile: Tile): void;
  walkLocal(tile: Tile): void;
  camera(yaw: number, pitch?: number, zoom?: number): void;
  snapCamera(): void;
  titleOrbit(enabled: boolean, angle?: number): void;
  buy: ReturnType<typeof createBuyStore>;
  buyClock: { offset: number; now: () => number };
  buyTiming: Timing;
  sender: TxSender;
}

export interface Beat {
  /** Recorded length in ms. */
  duration: number;
  /** Show the game frame (HUD); false renders the world alone. */
  hud?: boolean;
  /** Draw the mouse cursor (desktop only; phones show taps). */
  cursor?: boolean;
  /** Which fake wallet the shell uses: the buy flow's or the bank world's. */
  wallet?: "buy" | "bank";
  /** USDC in the inventory at the start. */
  usdc?: number;
  warmup?: number;
  setup(d: Director): Promise<void>;
  run(d: Director): Promise<void>;
}

// ---------------------------------------------------------------- crowd

/** Where the crowd stands: the customer side of the hall, clear of the merchants' aisle. */
const CROWD_TILES: Tile[] = [
  { x: 3181, y: 3435 },
  { x: 3184, y: 3435 },
  { x: 3185, y: 3437 },
  { x: 3180, y: 3438 },
  { x: 3185, y: 3443 },
  { x: 3180, y: 3442 },
  { x: 3184, y: 3446 },
  { x: 3181, y: 3446 },
  { x: 3185, y: 3445 },
  { x: 3182, y: 3434 },
  { x: 3180, y: 3444 },
  { x: 3185, y: 3439 },
];

function placeCrowd(d: Director, count = CROWD.length, skip: Tile[] = []): void {
  let i = 0;
  for (const who of CROWD.slice(0, count)) {
    let tile = CROWD_TILES[i++ % CROWD_TILES.length]!;
    while (skip.some((s) => s.x === tile.x && s.y === tile.y)) tile = CROWD_TILES[i++ % CROWD_TILES.length]!;
    d.placePlayer(who.pid, tile);
  }
  d.syncPlayers();
}

/** Background life: chat with effects and emotes on a fixed schedule (the clock is deterministic). */
function ambient(d: Director, until: number, every = 1_100, start = 200): void {
  const emotes: EmoteId[] = ["dance", "cheer", "wave", "laugh", "jump", "clap", "yes", "bow"];
  let n = 0;
  const tick = () => {
    if (performance.now() > until) return;
    const who = CROWD[(n * 5 + 3) % CROWD.length]!;
    if (n % 3 === 2) d.emote(who.pid, emotes[n % emotes.length]!);
    else {
      const [text, fx] = CHAT[n % CHAT.length]!;
      d.say(who.pid, text, fx);
    }
    n++;
    setTimeout(tick, every + ((n * 137) % 400));
  };
  setTimeout(tick, start);
}

const MERCHANT_PREFERENCE = ["revolut:GBP", "revolut:EUR", "wise:GBP", "revolut:USD", "wise:EUR", "zelle:USD", "wise:USD"];

/** The best-known merchant standing in clear view (away from the HUD), Revolut GBP first. */
function visibleMerchant(d: Director): LiveMerchant {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const clear = (m: LiveMerchant) => {
    const at = d.engine.projectTarget({ kind: "merchant", merchantId: m.spec.id });
    return at !== null && at.x > w * 0.12 && at.x < w * (d.phone ? 0.88 : 0.68) && at.y > h * 0.18 && at.y < h * (d.phone ? 0.7 : 0.62);
  };
  const ranked = [...d.merchants].sort((a, b) => {
    const ia = MERCHANT_PREFERENCE.indexOf(a.spec.id);
    const ib = MERCHANT_PREFERENCE.indexOf(b.spec.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return ranked.find(clear) ?? ranked.find((m) => d.engine.projectTarget({ kind: "merchant", merchantId: m.spec.id }) !== null) ?? ranked[0]!;
}

async function placeBuyOrder(d: Director, fiat = "100"): Promise<void> {
  const store = d.buy;
  store.getState().bindSender(d.sender);
  for (let i = 0; i < 100 && store.getState().recovering; i++) await d.wait(20);
  await store.getState().requestQuotes({ fiatAmount: fiat, currency: "GBP", platforms: ["revolut"] });
  const quote = store.getState().quotes[0];
  if (!quote) throw new Error("capture: no fixture quote");
  store.getState().selectQuote(quote.id);
  void store.getState().confirm();
  for (let i = 0; i < 400; i++) {
    const s = store.getState();
    if (s.step === "awaitingPayment" && s.order?.status === "active") return;
    await d.wait(20);
  }
  throw new Error(`capture: buy order did not place (step ${store.getState().step})`);
}

async function clickIfPresent(d: Director, target: string, within = 1_200): Promise<boolean> {
  const end = performance.now() + within;
  while (performance.now() < end) {
    const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
      (b) => !b.disabled && (b.textContent?.trim().startsWith(target) || b.getAttribute("aria-label")?.startsWith(target)),
    );
    if (found) {
      await d.click(target);
      return true;
    }
    await d.wait(50);
  }
  return false;
}

/** Slow continuous camera turn (radians per second) until `until`. */
function spin(d: Director, perSecond: number, until: number): void {
  let last = performance.now();
  const frame = () => {
    const now = performance.now();
    d.camera(perSecond * ((now - last) / 1000));
    last = now;
    if (now < until) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- beats

export const BEATS: Record<BeatId, Beat> = {
  walkin: {
    duration: 8_000,
    cursor: true,
    async setup(d) {
      d.setLocal({ x: 3183, y: 3431 });
      placeCrowd(d);
      d.camera(0.2, 0.12, d.phone ? 1.0 : 1.2);
    },
    async run(d) {
      const end = performance.now() + 8_000;
      ambient(d, end, 900, 300);
      await d.wait(400);
      await d.walkClick({ x: 3183, y: 3437 }, 600);
      spin(d, -0.06, end);
      d.walkPlayer("p6", { x: 3182, y: 3444 });
      await d.wait(1_400);
      d.walkPlayer("p3", { x: 3184, y: 3442 }, true);
      d.still(d.phone ? "07-phone-world" : "01-hero-walkin");
      await d.wait(2_200);
      d.emote("p2", "wave");
      d.say("p2", "welcome to the bank!", "cyan:wave");
      await d.wait(2_800);
    },
  },

  exchange: {
    duration: 12_000,
    cursor: true,
    async setup(d) {
      d.setLocal({ x: 3185, y: 3440 });
      placeCrowd(d, 8, [{ x: 3185, y: 3439 }]);
      d.camera(-0.75, 0.05, 0.95);
    },
    async run(d) {
      ambient(d, performance.now() + 12_000, 1_400, 900);
      await d.wait(200);
      await d.moveToTarget({ kind: "banker", npcIndex: 1 }, 550, -6);
      await d.wait(250);
      await d.rightClick();
      await d.wait(400);
      await d.choose("Exchange");
      await d.wait(700);
      await d.click("Buy USDC (slot 1)", 380);
      await d.wait(450);
      await d.click("Currency:", 350);
      await d.wait(350);
      await d.click("GBP", 350);
      await d.wait(350);
      await d.click("Choose a payment method", 350);
      await d.wait(550);
      await d.click("Revolut", 350);
      await d.wait(1_000);
      await d.click("Confirm", 400);
      await d.wait(1_300);
      d.still(d.phone ? "08-phone-exchange" : "02-exchange");
      const box = document.querySelector(".rb-setup");
      if (box) {
        const r = box.getBoundingClientRect();
        await d.moveTo(r.right - 40, r.bottom - 30, 900);
      }
      await d.wait(1_800);
    },
  },

  trade: {
    duration: 10_000,
    cursor: true,
    async setup(d) {
      d.buyTiming.quoteMs = 600;
      d.buyTiming.txMs = 900;
      d.setLocal({ x: 3184, y: 3436 });
      placeCrowd(d, 8, [{ x: 3184, y: 3435 }]);
      d.camera(0.4, 0.05, 0.9);
    },
    async run(d) {
      ambient(d, performance.now() + 10_000, 1_500, 1_200);
      const merchant = visibleMerchant(d);
      await d.wait(300);
      await d.moveToTarget({ kind: "merchant", merchantId: merchant.spec.id }, 650, -4);
      await d.wait(300);
      await d.rightClick();
      await d.wait(500);
      await d.choose("Trade");
      // Walks to the merchant, then the trade window opens and quotes the shout's amount.
      await d.wait(2_100);
      await d.click("Accept");
      await d.wait(1_000);
      d.still(d.phone ? "trade-phone" : "03-trade");
      await d.click("Accept");
      await d.wait(2_600);
    },
  },

  payverify: {
    duration: 10_500,
    cursor: true,
    warmup: 1_200,
    async setup(d) {
      d.setLocal({ x: 3184, y: 3440 });
      placeCrowd(d, 8);
      d.camera(0.25, 0.05, 0.95);
      await placeBuyOrder(d, "100");
      d.buyTiming.captureMs = 1_100;
      d.buyTiming.txMs = 900;
      d.open({ id: "payment" });
    },
    async run(d) {
      ambient(d, performance.now() + 10_000, 1_600, 2_500);
      await d.wait(500);
      // The scroll shows the payee and "I have paid" once the player ticks that they read the rules.
      await d.click(".rb-pay__ack input");
      await d.wait(300);
      d.still(d.phone ? "payment-phone" : "04-payment");
      await d.wait(700);
      await d.click("I have paid");
      await d.wait(700);
      await clickIfPresent(d, "Verify with Peer", 900);
      // The Peer extension captures the payments, then the list appears.
      for (let i = 0; i < 80 && !document.querySelector('[data-row="0"]'); i++) await d.wait(50);
      await d.wait(400);
      await d.click('[data-row="0"]');
      await d.wait(450);
      await d.click("Verify this payment");
      for (let i = 0; i < 100 && d.buy.getState().step !== "completed"; i++) await d.wait(50);
      await d.wait(450);
      d.still(d.phone ? "congrats-phone" : "05-congrats");
      // Close the window so the fireworks over the player are in view.
      await d.click("Close", 280);
      await d.wait(450);
      d.still(d.phone ? "fireworks-phone" : "05-fireworks");
      await d.wait(2_300);
    },
  },

  sell: {
    duration: 12_500,
    cursor: true,
    wallet: "bank",
    async setup(d) {
      const { useSellStore } = await import("@/peer/sell");
      const store = useSellStore.getState();
      store.setAmount("500");
      const first = useSellStore.getState().legs[0];
      if (first) useSellStore.getState().updateLeg(first.id, { platform: "revolut", currencies: ["GBP"], payee: "" });
      d.setLocal({ x: 3185, y: 3442 });
      placeCrowd(d, 8, [{ x: 3185, y: 3443 }]);
      d.camera(-0.6, 0.05, 0.95);
    },
    async run(d) {
      ambient(d, performance.now() + 12_500, 1_500, 1_500);
      await d.wait(300);
      await d.moveToTarget({ kind: "banker", npcIndex: 2 }, 600, -6);
      await d.wait(300);
      await d.rightClick();
      await d.wait(450);
      await d.choose("Bank");
      await d.wait(800);
      await d.click("Deposit");
      await d.wait(550);
      await d.type(".bk-leg__payee input", "ridgerunner", 45);
      await d.wait(700);
      await d.click("[data-bank-deposit]");
      await d.wait(500);
      await d.click("[data-bank-confirm]");
      for (let i = 0; i < 120 && !Array.from(document.querySelectorAll("p")).some((p) => p.textContent === "Your offer is live."); i++) await d.wait(50);
      await d.wait(350);
      d.still(d.phone ? "sell-phone" : "06-bank");
      await d.click("Advertise", 350);
      await d.wait(850);
      await d.click("Close", 320);
      await d.wait(1_600);
    },
  },

  social: {
    duration: 9_000,
    cursor: false,
    async setup(d) {
      d.setLocal({ x: 3183, y: 3440 });
      placeCrowd(d);
      d.camera(-1.0, 0.1, d.phone ? 1.0 : 1.05);
    },
    async run(d) {
      const end = performance.now() + 9_000;
      spin(d, -0.07, end);
      d.say("p1", "buying usdc gbp", "cyan:wave2");
      d.emote("p4", "dance");
      d.emote("p9", "cheer");
      await d.wait(700);
      d.say("p5", "anyone on revolut?", "yellow:wave");
      d.emote("p7", "dance");
      await d.wait(900);
      d.say("p8", "selling usdc trade me", "glow1:wave");
      d.emote("p11", "jump");
      await d.wait(900);
      d.celebrate("p3");
      d.news("Iron Ozzy bought 250.00 USDC for 189.00 GBP on Revolut.", "Iron Ozzy");
      await d.wait(500);
      d.say("p2", "gz!!", "flash1:wave");
      d.say("p6", "gz", "green:wave2");
      d.emote("p2", "cheer");
      d.emote("p6", "clap");
      d.still(d.phone ? "social-phone" : "01-hero");
      await d.wait(1_200);
      d.say("p10", "this bank never sleeps", "purple:wave");
      d.emote("p12", "dance");
      await d.wait(1_200);
      d.celebrate("p9");
      d.news("Rune Rachel bought 120.00 USDC for 120.00 USD on Zelle.", "Rune Rachel");
      d.say("p4", "lets gooo", "glow2:wave");
      await d.wait(3_000);
    },
  },

  orbit: {
    duration: 10_000,
    hud: false,
    cursor: false,
    async setup(d) {
      d.setLocal({ x: 3183, y: 3440 });
      placeCrowd(d);
      d.camera(1.2, 0.2, 1.5);
    },
    async run(d) {
      const end = performance.now() + 10_000;
      spin(d, -0.16, end);
      ambient(d, end, 1_000, 400);
      await d.wait(10_000);
    },
  },
};
