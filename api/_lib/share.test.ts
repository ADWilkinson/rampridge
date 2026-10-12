import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getContracts, resolveFiatCurrencyBytes32, resolvePaymentMethodHash } from "@zkp2p/sdk";
import { erc20Abi } from "viem";
import type { Abi } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActResponse, SessionResponse } from "../../shared/protocol";
import { shareIdFor, toShareRecord } from "../../shared/share";
import type { ShareRecord } from "../../shared/share";
import { DEFAULT_APPEARANCE } from "../../shared/world";
import { createActHandler } from "./handlers/act";
import { createSessionHandler } from "./handlers/session";
import { pruneWorld } from "./prune";
import { loadShare } from "./share";
import { CARD_FILES, loadCardAssets, shareCardTree } from "./shareCard";
import type { CardNode } from "./shareCard";
import { fitSize, readFontMetrics, textWidth } from "./shareFont";
import { createShareImageHandler, createSharePageHandler } from "./shareHandlers";
import { isPreviewBot, renderSharePage } from "./sharePage";
import { encodeLog, jsonRequest, testDeps } from "./testing";
import type { TestDeps } from "./testing";

// The card is drawn from the RuneScape fonts and the captured link previews, which are Jagex's art and
// not committed. Where one is missing (a fresh clone, CI) the card reads a stand-in instead: Geist,
// bundled with @vercel/og, for a font and a 1x1 PNG for an image. Tests about the real files skip
// until `bun run setup:assets` and scripts/og have made them.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const publicDir = nodePath.join(process.cwd(), "public");
  const geist = nodePath.join(process.cwd(), "node_modules/@vercel/og/dist/Geist-Regular.ttf");
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const readFile = ((...args: Parameters<typeof actual.readFile>) => {
    const [file] = args;
    if (typeof file === "string" && file.startsWith(publicDir) && !fs.existsSync(file)) {
      if (file.endsWith(".ttf")) return actual.readFile(geist);
      if (file.endsWith(".png")) return Promise.resolve(Buffer.from(pixel));
    }
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

const publicFile = (name: string) => path.join(process.cwd(), "public", name);
const realFonts = [CARD_FILES.bold, CARD_FILES.plain].every((f) => existsSync(publicFile(f)));
const realPreviews = [CARD_FILES.fallback, CARD_FILES.backdrop, CARD_FILES.coins, "og-square.png"].every((f) => existsSync(publicFile(f)));

const wallet = "0x4068d180e4051c7abc91bc17b897738622f1cbbb";
const tx = `0x${"ab".repeat(32)}`;
const { abis } = getContracts(8453, "production");

let deps: TestDeps;
let session: (body: unknown) => Promise<Response>;
let act: (token: string, body: unknown) => Promise<Response>;

beforeEach(() => {
  deps = testDeps();
  const sessionHandler = createSessionHandler(deps);
  const actHandler = createActHandler(deps);
  session = (body) => sessionHandler(jsonRequest("/api/session", body));
  act = (token, body) => actHandler(jsonRequest("/api/act", body, { token }));
});

async function verifiedPlayer(name: string) {
  const player = (await (await session({ name })).json()) as SessionResponse & { token: string; pid: string };
  const joined = await act(player.token, { type: "join", appearance: DEFAULT_APPEARANCE, world: "auto" });
  expect(joined.status).toBe(200);
  player.token = ((await joined.json()) as ActResponse).token!;
  deps.memory.write(`profiles/${player.pid}/w`, wallet);
  return player;
}

function boughtReceipt() {
  const { orchestrators, usdc, verifiers } = deps.chainStub.contracts;
  const intentHash = `0x${"11".repeat(32)}`;
  return {
    status: "success" as const,
    blockTimestampMs: deps.clock.now - 10_000,
    logs: [
      encodeLog(
        abis.unifiedPaymentVerifier as Abi,
        "PaymentVerified",
        {
          intentHash,
          method: resolvePaymentMethodHash("revolut", { env: "production" }),
          currency: resolveFiatCurrencyBytes32("GBP"),
          amount: 10_000n,
          timestamp: 0n,
          paymentId: `0x${"22".repeat(32)}`,
          payeeId: `0x${"33".repeat(32)}`,
        },
        verifiers[0]!,
        5,
      ),
      encodeLog(erc20Abi, "Transfer", { from: orchestrators[0]!, to: wallet, value: 130_470_000n }, usdc, 6),
      encodeLog(
        abis.orchestratorV3 as Abi,
        "IntentFulfilled",
        { intentHash, fundsTransferredTo: wallet, amount: 130_470_000n, isManualRelease: false },
        orchestrators[0]!,
        7,
      ),
    ],
  };
}

const zezima: ShareRecord = {
  kind: "bought",
  name: "Zezima",
  usdc: "130.47",
  fiat: "100",
  currency: "GBP",
  platform: "revolut",
  tx,
  t: 1_800_000_000_000,
};

describe("announce share records", () => {
  it("saves a durable record for a verified purchase and returns its id", async () => {
    const player = await verifiedPlayer("Zezima");
    deps.chainStub.getReceipt = async (hash) => (hash === tx ? boughtReceipt() : null);
    const response = await act(player.token, { type: "announce", kind: "bought", tx });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ActResponse;
    const id = shareIdFor("bought", tx, player.pid);
    expect(body).toMatchObject({ ok: true, shareId: id });

    const stored = deps.memory.read(`shares/${id}`) as Record<string, unknown>;
    // The world it was announced in goes with it: the link asks for that world.
    expect(stored).toEqual({ kind: "bought", name: "Zezima", usdc: "130.47", fiat: "100", currency: "GBP", platform: "revolut", tx, t: deps.clock.now, world: 301 });
    // Small, and no wallet address or player id.
    const json = JSON.stringify(stored);
    expect(json).not.toContain(wallet.slice(2));
    expect(json).not.toContain(player.pid);
    expect(json.length).toBeLessThan(300);
    expect(await loadShare(deps.memory, id)).toEqual(toShareRecord(stored));

    // The cron's sweep leaves share records alone, however old.
    deps.clock.now += 400 * 24 * 60 * 60 * 1000;
    await pruneWorld(deps.memory, deps.clock.now);
    expect(deps.memory.read(`shares/${id}`)).toEqual(stored);
  });

  it("keeps the first record and returns no id for a refused announcement", async () => {
    const player = await verifiedPlayer("Zezima");
    deps.chainStub.getReceipt = async () => boughtReceipt();
    const first = (await (await act(player.token, { type: "announce", kind: "bought", tx })).json()) as ActResponse;
    deps.clock.now += 1_000;
    const again = await act(player.token, { type: "announce", kind: "bought", tx });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ActResponse).shareId).toBeUndefined();
    expect(Object.keys(deps.memory.read("shares") as object)).toEqual([first.shareId]);
  });

  it("still announces when the record can't be saved", async () => {
    const player = await verifiedPlayer("Zezima");
    deps.chainStub.getReceipt = async () => boughtReceipt();
    const transaction = deps.memory.transaction.bind(deps.memory);
    deps.memory.transaction = (async (p: string, update: never) => {
      if (p.startsWith("shares/")) throw new Error("database down");
      return transaction(p, update);
    }) as typeof deps.memory.transaction;
    const response = await act(player.token, { type: "announce", kind: "bought", tx });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ActResponse).shareId).toBeUndefined();
    expect(Object.keys(deps.memory.read("worlds/301/events") as object)).toHaveLength(1);
  });
});

function metaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)) out[m[1]!] = m[2]!;
  return out;
}

describe("GET /api/share", () => {
  const page = (query: string, userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)") =>
    createSharePageHandler(deps)(new Request(`https://www.rampridge.xyz/api/share${query}`, { headers: { "user-agent": userAgent } }));

  it("serves the trade's tags and sends people into the game", async () => {
    const id = "Ab3dE5gH9k";
    deps.memory.write(`shares/${id}`, { kind: "bought", name: "Zezima", usdc: "130.47", fiat: "100", currency: "GBP", platform: "revolut", tx, t: 1 });
    const response = await page(`?id=${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    const tags = metaTags(html);
    expect(tags).toMatchObject({
      "og:type": "website",
      "og:site_name": "RampRidge",
      "og:title": "Zezima bought 130.47 USDC at the Bank of RampRidge",
      "og:url": `https://www.rampridge.xyz/t/${id}`,
      "og:image": `https://www.rampridge.xyz/api/og?id=${id}`,
      "og:image:width": "1200",
      "og:image:height": "630",
      "og:image:type": "image/png",
      "twitter:card": "summary_large_image",
      "twitter:image": `https://www.rampridge.xyz/api/og?id=${id}`,
      robots: "noindex, follow",
    });
    expect(tags["og:description"]).toContain("Zezima bought 130.47 USDC for £100.00 on Revolut.");
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=/?from=share">`);
    expect(html).toContain(`location.replace("/?from=share")`);
  });

  it("sends people to the world the trade was announced in", async () => {
    const id = "Ab3dE5gH9w";
    deps.memory.write(`shares/${id}`, { kind: "bought", name: "Zezima", usdc: "130.47", platform: "revolut", tx, t: 1, world: 302 });
    const html = await (await page(`?id=${id}`)).text();
    expect(html).toContain(`<meta http-equiv="refresh" content="0; url=/?from=share&amp;world=302">`);
    expect(html).toContain(`location.replace("/?from=share&world=302")`);
    // Anything but a world number is ignored.
    deps.memory.write(`shares/${id}/world`, "302\"><x>");
    const hostile = await (await page(`?id=${id}`)).text();
    expect(hostile).toContain(`location.replace("/?from=share")`);
    expect(hostile).not.toContain("<x>");
  });

  it("gives link-preview crawlers no meta refresh to follow", async () => {
    for (const ua of ["Twitterbot/1.0", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "Slackbot-LinkExpanding 1.0", "Mozilla/5.0 (compatible; Discordbot/2.0)", "WhatsApp/2.23.20.0", "TelegramBot (like TwitterBot)"]) {
      expect(isPreviewBot(ua)).toBe(true);
      const html = await (await page("?id=Ab3dE5gH9k", ua)).text();
      expect(html).not.toContain("http-equiv");
      expect(html).toContain("og:title");
    }
    expect(isPreviewBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36")).toBe(false);
    expect(isPreviewBot(null)).toBe(false);
  });

  it("falls back to the site's tags for unknown, malformed and hostile ids", async () => {
    for (const query of ["?id=Zz9Zz9Zz9Z", "", "?id=<script>", `?id=${encodeURIComponent('"><img src=x>')}`]) {
      const html = await (await page(query)).text();
      const tags = metaTags(html);
      expect(tags["og:url"]).toBe("https://www.rampridge.xyz/");
      expect(tags["og:image"]).toBe("https://www.rampridge.xyz/og.png");
      expect(tags.robots).toBeUndefined();
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<img");
    }
  });

  it("answers whether a record exists as JSON", async () => {
    deps.memory.write("shares/Ab3dE5gH9k", { kind: "listed", name: "Lynx", usdc: "250", currency: "EUR", platform: "wise", tx, t: 1 });
    const found = await page("?id=Ab3dE5gH9k&format=json");
    expect(found.status).toBe(200);
    const body = (await found.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, id: "Ab3dE5gH9k", url: "https://www.rampridge.xyz/t/Ab3dE5gH9k" });
    expect(JSON.stringify(body)).not.toContain(tx);
    const missing = await page("?id=Zz9Zz9Zz9Z&format=json");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  it("escapes every value it writes into the page", () => {
    const html = renderSharePage(
      {
        title: `</title><script>alert(1)</script>`,
        description: `" onload="alert(1)`,
        url: `https://www.rampridge.xyz/t/"><x>`,
        image: `javascript:'alert(1)'`,
        imageAlt: "a & b",
      },
      { metaRefresh: true, noindex: true },
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain(`" onload="`);
    expect(html).not.toContain(`"><x>`);
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot; onload=&quot;alert(1)");
    expect(html).toContain("javascript:&#39;alert(1)&#39;");
    expect(html).toContain("a &amp; b");
    // The only script is the fixed redirect.
    expect(html.match(/<script>/g)).toHaveLength(1);
  });
});

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("GET /api/og", () => {
  const image = (query: string) => createShareImageHandler(deps)(new Request(`http://localhost/api/og${query}`));

  it("draws a 1200x630 card for a trade, cached for good", async () => {
    deps.memory.write("shares/Ab3dE5gH9k", { kind: "bought", name: "Zezima", usdc: "130.47", fiat: "100", currency: "GBP", platform: "revolut", tx, t: 1 });
    const response = await image("?id=Ab3dE5gH9k");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, s-maxage=31536000, immutable");
    expect(pngSize(new Uint8Array(await response.arrayBuffer()))).toEqual({ width: 1200, height: 630 });
  }, 30_000);

  it("serves the site's card, briefly cached, for an unknown id", async () => {
    const response = await image("?id=Zz9Zz9Zz9Z");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(await readFile(publicFile(CARD_FILES.fallback))));
  });
});

function texts(node: CardNode | string | null): string[] {
  if (node === null) return [];
  if (typeof node === "string") return [node];
  const children = node.props.children;
  const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
  return list.flatMap((c) => texts(c));
}

describe("share card", () => {
  it("says who traded what, and fits long lines into the centre", async () => {
    const assets = await loadCardAssets("http://localhost");
    expect(texts(shareCardTree(zezima, assets))).toEqual(["Zezima", "bought 130.47 USDC", "for £100.00 on Revolut", "rampridge.xyz", "Settled on Base by Peer"]);
    const listing = texts(shareCardTree({ ...zezima, kind: "listed", fiat: null, currency: "EUR", platform: "wise" }, assets));
    expect(listing).toContain("is selling 130.47 USDC");
    expect(listing).toContain("for EUR on Wise");

    const metrics = assets.boldMetrics;
    const long = "bought 1,234,567.89 USDC";
    const size = fitSize(metrics, long, 600, [64, 48, 32]);
    expect(textWidth(metrics, long, size)).toBeLessThanOrEqual(600);
  });

  it.skipIf(!realFonts)("measures the RuneScape font one pixel per unit at 16 px", () => {
    const metrics = readFontMetrics(readFileSync(publicFile(CARD_FILES.bold)));
    expect(metrics.unitsPerEm).toBe(16);
    expect(textWidth(metrics, "A", 16)).toBe(metrics.advance(65));
    expect(textWidth(metrics, "AA", 32)).toBe(metrics.advance(65) * 4);
    expect(fitSize(metrics, "bought 1,234,567.89 USDC", 600, [64, 48, 32])).toBe(48);
  });

  it.skipIf(!realPreviews)("ships the link preview images at the sizes scripts/og makes them", () => {
    const pngSize = (name: string) => {
      const b = readFileSync(publicFile(name));
      expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    };
    expect(pngSize(CARD_FILES.fallback)).toEqual({ w: 1200, h: 630 });
    expect(pngSize(CARD_FILES.backdrop)).toEqual({ w: 1200, h: 630 });
    expect(pngSize(CARD_FILES.coins)).toEqual({ w: 108, h: 96 });
    expect(pngSize("og-square.png")).toEqual({ w: 1200, h: 1200 });
  });
});
