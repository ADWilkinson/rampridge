// Lays the logo and the copy over a captured scene (compose.html) and saves
// the card at 1x:
//   node scripts/og/compose.mjs wide   <scene.png> public/og.png          (1200x630)
//   node scripts/og/compose.mjs square <scene.png> public/og-square.png   (1200x1200)
import { readFileSync } from "node:fs";
import { launch, sleep } from "./cdp.mjs";

/** Card size, the dark vignettes behind the logo and the copy, and the type sizes. */
const LAYOUTS = {
  wide: {
    width: 1200,
    height: 630,
    topH: 200,
    bottomH: 200,
    logoW: 600,
    logoTop: 22,
    linesBottom: 36,
    topBg: "radial-gradient(ellipse 470px 150px at 50% 60px, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.66) 55%, rgba(0,0,0,0) 100%)",
    bottomBg: "radial-gradient(ellipse 480px 150px at 50% 150px, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.72) 55%, rgba(0,0,0,0) 100%)",
  },
  square: {
    width: 1200,
    height: 1200,
    topH: 330,
    bottomH: 380,
    logoW: 880,
    logoTop: 40,
    linesBottom: 54,
    l1: 64,
    l2: 48,
    gap: 18,
    extra: "Revolut, Venmo, Wise, Cash App and more",
    topBg: "radial-gradient(ellipse 680px 230px at 50% 100px, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.62) 55%, rgba(0,0,0,0) 100%)",
    bottomBg: "radial-gradient(ellipse 700px 300px at 50% 290px, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.74) 55%, rgba(0,0,0,0) 100%)",
  },
};

const [layoutName, scene, out] = process.argv.slice(2);
const layout = LAYOUTS[layoutName];
if (!layout || !scene || !out) {
  console.error(`usage: node scripts/og/compose.mjs <${Object.keys(LAYOUTS).join("|")}> <scene.png> <out.png>`);
  process.exit(2);
}

/** Runs in the page: applies the layout and waits for the scene, logo and font. */
async function applyLayout({ L, sceneUrl }) {
  const c = document.getElementById("c");
  c.style.width = `${L.width}px`;
  c.style.height = `${L.height}px`;
  const s = document.getElementById("scene");
  s.src = sceneUrl;
  await s.decode();
  const top = document.getElementById("top");
  top.style.height = `${L.topH}px`;
  top.style.background = L.topBg;
  const bottom = document.getElementById("bottom");
  bottom.style.height = `${L.bottomH}px`;
  bottom.style.background = L.bottomBg;
  if (L.l1) document.querySelector(".l1").style.fontSize = `${L.l1}px`;
  if (L.l2) document.querySelector(".l2").style.fontSize = `${L.l2}px`;
  const lines = document.getElementById("lines");
  if (L.gap) lines.style.gap = `${L.gap}px`;
  const logo = document.getElementById("logo");
  logo.style.width = `${L.logoW}px`;
  logo.style.top = `${L.logoTop}px`;
  await logo.decode();
  lines.style.bottom = `${L.linesBottom}px`;
  if (L.extra) {
    const d = document.createElement("div");
    d.className = "l l3";
    d.textContent = L.extra;
    lines.appendChild(d);
  }
  await document.fonts.ready;
  return [...document.fonts].map((f) => `${f.family}: ${f.status}`);
}

const browser = await launch({ extraArgs: ["--allow-file-access-from-files"] });
try {
  await browser.viewport(layout.width, layout.height, 1);
  await browser.goto(new URL("./compose.html", import.meta.url).href);
  const sceneUrl = `data:image/png;base64,${readFileSync(scene).toString("base64")}`;
  const fonts = await browser.eval(`(${applyLayout.toString()})(${JSON.stringify({ L: layout, sceneUrl })})`);
  if (!fonts.some((f) => f === "RS Bold 12: loaded")) throw new Error(`RS Bold 12 did not load (${fonts.join(", ")})`);
  await sleep(300);
  console.log(await browser.screenshot(out));
} finally {
  await browser.close();
}
