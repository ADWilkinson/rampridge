/**
 * Branding art rendered at bake time:
 * - public/game/ui/logo.png: the RampRidge wordmark in the RuneScape title
 *   style (gold bevelled small caps, dark outline), 2x.
 * - public/game/ui/privy-logo.png: the same wordmark, small, for the Privy
 *   login modal.
 * - public/game/ui/favicon.png (32x32) and apple-touch-icon.png (180x180):
 *   the client-rendered coin stack icon.
 * - public/game/ui/icon-192.png, icon-512.png and icon-maskable-512.png (the
 *   web app manifest's icons) and public/og-coins.png (the coin stack on each
 *   trade's share card): the same icon scaled up, nearest neighbour.
 *
 * The wordmark is RampRidge's own art (Cinzel, OFL) and is committed; it is
 * drawn by headless Chrome from scripts/bake/render/logo.html served off the
 * repository root. Without Chrome the committed files are kept. Everything
 * else here is Jagex's coin art and stays out of git. The link preview cards
 * (public/og.png, og-square.png, og-bg.png) are not baked: scripts/og captures
 * them from the running game.
 */
import fs from "node:fs";
import path from "node:path";

import type { BakeCache } from "../lib/cache";
import { CHROME_PATH, openChrome, serveDir } from "../lib/chrome";
import { ICON_HEIGHT, ICON_WIDTH, iconToArgb, renderItemIcon } from "../lib/item-icons";
import { PUBLIC_DIR, REPO_DIR, UI_DIR, rel, writeIfChanged } from "../lib/paths";
import { type Rgba, blank, decodePng, drawOver, encodePng, fromArgb, opaqueBounds, scaleNearest, trim } from "../lib/png";

/** Wordmark font size in px for logo.png (2x of a ~100px display size). */
const LOGO_SIZE = 200;
const PRIVY_LOGO_SIZE = 64;
/** The interface backing brown (sprite 297) behind the touch icon. */
const TOUCH_BACKGROUND: [number, number, number, number] = [0x3e, 0x35, 0x29, 0xff];
/** Behind the manifest icons: TOUCH_BACKGROUND with blue one level lower, as the shipped icons were first made. */
const APP_ICON_BACKGROUND: [number, number, number, number] = [0x3e, 0x35, 0x28, 0xff];
/** Manifest icons: the whole 36x32 icon scaled and centred; the maskable one keeps the coins in the safe zone. */
const APP_ICONS = [
  { file: "icon-192.png", size: 192, scale: 4 },
  { file: "icon-512.png", size: 512, scale: 12 },
  { file: "icon-maskable-512.png", size: 512, scale: 8 },
] as const;
const OG_COINS_SCALE = 3;

function centred(size: number, icon: Rgba, background: [number, number, number, number]): Rgba {
  const out = blank(size, size, background);
  drawOver(out, icon, Math.floor((size - icon.width) / 2), Math.floor((size - icon.height) / 2));
  return out;
}

export async function bakeUi(cache: BakeCache): Promise<void> {
  // Favicons from the 10,000-coin stack icon, exactly as the client draws it.
  const coins = fromArgb(iconToArgb(renderItemIcon(cache, 995, 10000)), ICON_WIDTH, ICON_HEIGHT);
  const b = opaqueBounds(coins);
  if (b.w > 32 || b.h > 32) throw new Error(`coin icon ${b.w}x${b.h} does not fit a 32px favicon`);
  const fav = blank(32, 32);
  drawOver(fav, trim(coins), Math.floor((32 - b.w) / 2), Math.floor((32 - b.h) / 2));
  writeIfChanged(path.join(UI_DIR, "favicon.png"), encodePng(fav));
  writeIfChanged(path.join(UI_DIR, "apple-touch-icon.png"), encodePng(centred(180, scaleNearest(trim(coins), 4), TOUCH_BACKGROUND)));
  for (const icon of APP_ICONS) {
    writeIfChanged(path.join(UI_DIR, icon.file), encodePng(centred(icon.size, scaleNearest(coins, icon.scale), APP_ICON_BACKGROUND)));
  }
  writeIfChanged(path.join(PUBLIC_DIR, "og-coins.png"), encodePng(scaleNearest(coins, OG_COINS_SCALE)));
  const icons = ["favicon.png", "apple-touch-icon.png", ...APP_ICONS.map((i) => i.file)].join(", ");
  console.log(`  ui: ${icons} -> ${rel(UI_DIR)}; og-coins.png -> ${rel(PUBLIC_DIR)}`);

  const logos = ["logo.png", "privy-logo.png"].map((f) => path.join(UI_DIR, f));
  if (!fs.existsSync(CHROME_PATH) && logos.every((f) => fs.existsSync(f))) {
    console.log(`  ui: no Chrome at ${CHROME_PATH} (set CHROME_PATH), kept the committed logo.png and privy-logo.png`);
    return;
  }
  const server = await serveDir(REPO_DIR);
  const chrome = await openChrome();
  try {
    const wordmark = async (size: number) => {
      const r = await chrome.capture(`${server.origin}/scripts/bake/render/logo.html?size=${size}`, {
        width: Math.round(size * 10),
        height: Math.round(size * 1.6),
        transparent: true,
      });
      return encodePng(trim(decodePng(r.png), Math.ceil(size * 0.04)));
    };
    writeIfChanged(path.join(UI_DIR, "logo.png"), await wordmark(LOGO_SIZE));
    writeIfChanged(path.join(UI_DIR, "privy-logo.png"), await wordmark(PRIVY_LOGO_SIZE));
  } finally {
    chrome.close();
    await server.close();
  }
  console.log(`  ui: logo.png, privy-logo.png -> ${rel(UI_DIR)}`);
}
