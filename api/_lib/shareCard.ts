/**
 * The 1200x630 card for a shared trade (GET /api/og?id=...): the bank
 * backdrop, the RampRidge logo, the player's name as overhead text, the
 * trade in the chatbox's news wording, and the address. Drawn with satori
 * (@vercel/og) in the RuneScape fonts at pixel-exact sizes (multiples of
 * 16 px). Everything that matters sits in the centre 600 px, so a square
 * crop of the card still reads.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "@vercel/og";
import type { ReactElement } from "react";
import { formatAmount, shareDetail } from "../../shared/share.js";
import type { ShareRecord } from "../../shared/share.js";
import { fitSize, readFontMetrics } from "./shareFont.js";
import type { FontMetrics } from "./shareFont.js";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
/** Text never runs wider than this, centred, so a square crop keeps it. */
const SAFE_WIDTH = 600;

/** Files under public/ the card is drawn from (vercel.json includes them in the function). */
export const CARD_FILES = {
  bold: "game/fonts/RuneScape-Bold-12.ttf",
  plain: "game/fonts/RuneScape-Plain-12.ttf",
  backdrop: "og-bg.png",
  logo: "game/ui/logo.png",
  coins: "og-coins.png",
  fallback: "og.png",
} as const;

export type CardFile = keyof typeof CARD_FILES;

export interface CardAssets {
  bold: ArrayBuffer;
  plain: ArrayBuffer;
  backdrop: string;
  logo: string;
  coins: string;
  boldMetrics: FontMetrics;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pngDataUri(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Reads a public file: from the function's own copy (cwd is the project
 * root locally and on Vercel), or from the site when that copy is missing.
 */
export async function readPublicFile(name: string, origin: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path.join(process.cwd(), "public", name)));
  } catch {
    const response = await fetch(new URL(`/${name}`, origin));
    if (!response.ok) throw new Error(`Couldn't load ${name} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

let cached: Promise<CardAssets> | null = null;

export function loadCardAssets(origin: string): Promise<CardAssets> {
  cached ??= (async () => {
    const [bold, plain, backdrop, logo, coins] = await Promise.all(
      (["bold", "plain", "backdrop", "logo", "coins"] as const).map((key) => readPublicFile(CARD_FILES[key], origin)),
    );
    return {
      bold: toArrayBuffer(bold!),
      plain: toArrayBuffer(plain!),
      backdrop: pngDataUri(backdrop!),
      logo: pngDataUri(logo!),
      coins: pngDataUri(coins!),
      boldMetrics: readFontMetrics(bold!),
    };
  })();
  // A failed load is retried on the next request instead of being remembered.
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

// ---------------------------------------------------------------------------
// The element tree. satori takes React-shaped objects; building them by hand
// keeps the API free of JSX and React at runtime.

type Child = CardNode | string | null;

export interface CardNode {
  type: string;
  key: null;
  props: Record<string, unknown> & { children?: Child | Child[] };
}

function h(type: string, props: Record<string, unknown>, ...children: Child[]): CardNode {
  const kids = children.filter((c) => c !== null);
  return { type, key: null, props: { ...props, ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) } };
}

/** The client's text shadow: one black pixel down and right, scaled with the font. */
const shadow = (size: number) => `${size / 16}px ${size / 16}px 0 #000000`;

function line(text: string, size: number, color: string, font: "RS Bold 12" | "RS Plain 12" = "RS Bold 12"): CardNode {
  return h(
    "div",
    {
      style: {
        display: "flex",
        fontFamily: font,
        fontSize: size,
        lineHeight: 1,
        color,
        textShadow: shadow(size),
        whiteSpace: "nowrap",
      },
    },
    text,
  );
}

const SIZES = [80, 64, 48, 32] as const;

/** The card for one trade. */
export function shareCardTree(record: ShareRecord, assets: CardAssets): CardNode {
  const m = assets.boldMetrics;
  const amount = `${formatAmount(record.usdc)} USDC`;
  const verb = record.kind === "bought" ? "bought" : "is selling";
  const action = `${verb} ${amount}`;
  const detail = shareDetail(record);
  const nameSize = fitSize(m, record.name, SAFE_WIDTH, [80, 64, 48]);
  const actionSize = fitSize(m, action, SAFE_WIDTH, [64, 48, 32]);
  const detailSize = Math.min(actionSize, fitSize(m, detail, SAFE_WIDTH, SIZES.slice(2)));

  return h(
    "div",
    {
      style: {
        position: "relative",
        display: "flex",
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        backgroundColor: "#000000",
      },
    },
    h("img", { src: assets.backdrop, width: CARD_WIDTH, height: CARD_HEIGHT, style: { position: "absolute", left: 0, top: 0 } }),
    // Dims the hall, most of all behind the text, and fades out towards the edges of the scene.
    h("div", {
      style: {
        position: "absolute",
        left: 0,
        top: 0,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        backgroundColor: "rgba(0,0,0,0.28)",
        backgroundImage: "radial-gradient(ellipse 720px 380px at 50% 56%, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.6) 50%, rgba(0,0,0,0) 100%)",
      },
    }),
    h(
      "div",
      {
        style: {
          position: "absolute",
          left: 0,
          top: 0,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        },
      },
      h("img", { src: assets.logo, width: 560, height: 87, style: { marginTop: 28 } }),
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", flexGrow: 1, justifyContent: "center", paddingBottom: 6 } },
        h("img", { src: assets.coins, width: 108, height: 96, style: { marginBottom: 14 } }),
        line(record.name, nameSize, "#ffff00"),
        h("div", { style: { display: "flex", height: 18 } }),
        line(action, actionSize, "#ffffff"),
        h("div", { style: { display: "flex", height: 14 } }),
        line(detail, detailSize, "#ff981f"),
      ),
      h(
        "div",
        { style: { display: "flex", alignItems: "center", marginBottom: 32 } },
        line("rampridge.xyz", 32, "#ffff00"),
        h("div", { style: { display: "flex", width: 22 } }),
        line("Settled on Base by Peer", 32, "#ffffff", "RS Plain 12"),
      ),
    ),
  );
}

/** Renders the card to PNG bytes (throws if rendering fails, so callers can fall back). */
export async function renderShareCard(record: ShareRecord, assets: CardAssets): Promise<Uint8Array> {
  const response = new ImageResponse(shareCardTree(record, assets) as unknown as ReactElement, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: [
      { name: "RS Bold 12", data: assets.bold, weight: 400, style: "normal" },
      { name: "RS Plain 12", data: assets.plain, weight: 400, style: "normal" },
    ],
  });
  return new Uint8Array(await response.arrayBuffer());
}
