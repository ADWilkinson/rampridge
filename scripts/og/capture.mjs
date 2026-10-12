// Captures the bank scene behind the link preview cards from the engine dev
// harness (dev/engine.html) on a running dev server: simulated players, the
// merchants shouting the live Peer offers from /api/market, a few chat lines
// and level-up fireworks. Writes <out>-0.png ... <out>-<frames-1>.png; pick
// the frame that reads best. See README.md for the settings each card uses.
import { parseArgs } from "node:util";
import { launch, sleep } from "./cdp.mjs";

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    size: { type: "string", default: "600x315" },
    dpr: { type: "string", default: "2" },
    camera: { type: "string", default: "-1.5708,0.9,1.3" },
    mode: { type: "string", default: "chat" },
    frames: { type: "string", default: "6" },
    players: { type: "string", default: "16" },
    "no-stall": { type: "boolean", default: false },
    origin: { type: "string", default: process.env.OG_ORIGIN ?? "http://localhost:5173" },
  },
});
const MODES = ["chat", "fireworks", "quiet"];
if (!args.out || !MODES.includes(args.mode)) {
  console.error(
    "usage: node scripts/og/capture.mjs --out <prefix> [--size 600x315] [--dpr 2] [--camera=yaw,pitch,zoom]\n" +
      "         [--mode chat|fireworks|quiet] [--frames 6] [--players 16] [--no-stall] [--origin http://localhost:5173]",
  );
  process.exit(2);
}
const [width, height] = args.size.split("x").map(Number);
const [yaw, pitch, zoom] = args.camera.split(",").map(Number);
const frames = Number(args.frames);

/**
 * Runs in the page. Hides the harness chrome, silences its random chat,
 * swaps its merchants for eight that shout the best live offers (chat mode
 * only), optionally clears the player stall, and fixes the camera.
 */
async function stageScene({ mode, stall, camera }) {
  for (const el of document.body.children) if (el.id !== "world") el.style.display = "none";
  const e = window.__harness.engine;
  e.setSoundEnabled(false);
  window.__say = e.showChat.bind(e);
  e.showChat = () => {};
  const market = await (await fetch("/api/market")).json();
  const names = { venmo: "Venmo", revolut: "Revolut", wise: "Wise", cashapp: "Cash App", zelle: "Zelle", paypal: "PayPal", monzo: "Monzo", chime: "Chime" };
  const want = [["wise", "USD"], ["revolut", "GBP"], ["revolut", "EUR"], ["zelle", "USD"], ["wise", "GBP"], ["revolut", "USD"], ["chime", "USD"], ["wise", "EUR"]];
  const styles = ["red:wave", "yellow:wave2", "green:wave", "cyan:wave2", "glow1:wave", "purple:wave", "white:wave2", "flash1:wave"];
  // The merchants' own rate format: rounded up, at least three significant figures.
  const fmtRate = (n) => {
    const d = n >= 100 ? 2 : Math.max(0, 3 - Math.floor(Math.log10(n)));
    const f = 10 ** d;
    const t = (Math.ceil(Math.round(n * f * 1e6) / 1e6) / f).toFixed(d);
    return d > 2 ? t.replace(/(\.\d{2}\d*?)0+$/, "$1") : t;
  };
  const specs = [];
  want.forEach(([p, c], i) => {
    const book = market.books.find((x) => x.platform === p && x.currency === c);
    if (!book) return;
    const amount = Math.floor(Number(book.best.available)).toLocaleString("en-US");
    const name = c === "USD" && p !== "revolut" && p !== "wise" ? `${names[p]} trader` : `${names[p]} ${c} trader`;
    const shout = mode === "chat" ? `${styles[i % styles.length]}:Selling ${amount} USDC @ ${fmtRate(Number(book.best.rate))} ${c} on ${names[p]}!` : "";
    specs.push({ id: `${p}:${c}`, name, platform: p, currency: c, shout, seed: `${p}:${c}` });
  });
  e.setMerchants(specs);
  if (!stall) e.setStalls({ p0: null });
  const cam = e.cam;
  cam.targetYaw = camera.yaw;
  cam.targetPitch = camera.pitch;
  cam.targetZoom = camera.zoom;
  cam.snap();
  return specs.map((s) => s.shout || s.name);
}

/** Runs in the page: a few players say something in the chat colours and effects. */
function sayLines() {
  const e = window.__harness.engine;
  const lines = [
    ["buying usdc", "yellow:wave"],
    ["anyone on revolut?", null],
    ["gz!", "cyan"],
    ["first trade done", "green:wave2"],
    ["selling for GBP", "white"],
    ["trade me", "red:wave"],
  ];
  const pids = [...e.remotes.keys()];
  pids.slice(0, lines.length).forEach((pid, i) => window.__say({ pid }, lines[i][0], lines[i][1]));
  return pids.length;
}

/** Runs in the page: level-up fireworks on one player and on the local player. */
function celebrate() {
  const e = window.__harness.engine;
  const pids = [...e.remotes.keys()];
  e.celebrate(pids[3]);
  e.celebrate("local");
  return true;
}

const call = (fn, arg) => `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;

const browser = await launch();
try {
  await browser.viewport(width, height, Number(args.dpr));
  await browser.goto(`${args.origin}/dev/engine.html?players=${Number(args.players)}&merchants=0`);
  await browser.waitFor("document.body.dataset.ready === '1'", 90000);
  const staged = await browser.eval(call(stageScene, { mode: args.mode, stall: !args["no-stall"], camera: { yaw, pitch, zoom } }));
  console.log(staged.join("\n"));
  // Let the merchants walk in and their shout schedule start.
  await sleep(9000);
  if (args.mode === "chat") await browser.eval(call(sayLines));
  for (let i = 0; i < frames; i++) {
    if (i === 1 && args.mode !== "quiet") await browser.eval(call(celebrate));
    await sleep(700);
    console.log(await browser.screenshot(`${args.out}-${i}.png`));
  }
  const errors = browser.errors();
  if (errors.length) console.error(errors.slice(-5).join("\n"));
} finally {
  await browser.close();
}
