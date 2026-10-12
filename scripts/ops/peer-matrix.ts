/**
 * Read-only live probe of the Peer buy and sell matrix RampRidge offers
 * (docs/design.md, "Currencies and payment methods"). Per platform x currency
 * it records what each source answers right now:
 *
 *   (a) attestation service GET /buyer/supported, diffed against the app's
 *       BUYER_TEE_VERIFIERS (a live buy platform needs every verify method served);
 *   (b) the SDK catalogue (getPaymentMethodsCatalog(8453, "production")): every
 *       live buy platform and every sell platform x currency resolves and every
 *       sell currency has an SDK oracle; the app's own buy platforms and Sell form
 *       (sellCapabilities: @zkp2p/cash's capabilities narrowed to the major
 *       currencies in shared/currencies.ts) match the documented matrix below,
 *       and @zkp2p/cash still offers every documented sell pair;
 *   (c) Curator: quotes at about 20 and 250 USD for every buy platform x currency,
 *       through src/peer/market.ts's own getBuyQuotes (mode eligible,
 *       PREFER_BUYER_TEE, the 50 bps referrer fee, the SDK's EscrowV2 filter), at
 *       most 2 in flight, backing off on 429/5xx, sized and graded against the
 *       Peer Cash oracle rate; Alipay quotes also check that Curator holds the
 *       maker's Alipay PID (present/missing, never printed);
 *   (d) Peer Cash: every currency the app trades prices from its oracle now (the
 *       sell rate: market, 0% spread unless the seller sets one).
 *
 * Read-only: no wallet, no signing, no makers/create, no database.
 *
 *   bun scripts/ops/peer-matrix.ts                 # or: bun run ops:matrix
 *   bun scripts/ops/peer-matrix.ts --json out.json # where the JSON goes (default: $TMPDIR)
 *   bun scripts/ops/peer-matrix.ts --amounts 20,250 --no-quotes
 *
 * Exits 0 when nothing failed. A pair with no liquidity is reported, not failed:
 * the book changes by the minute. Drift between the app and the documented matrix
 * below, a verifier or catalogue entry gone, an unpriced corridor or a request that
 * kept failing exits 1.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(ROOT, "src");
const SHARED = path.join(ROOT, "shared");

// ---------------------------------------------------------------------------
// The documented matrix (docs/design.md). The probe fails when the app drifts from it.

/** Peer web's buy platforms (zkp2p-clients WEB_ONRAMP_PAYMENT_PLATFORMS) with a major currency: all live in RampRidge. */
const DOC_BUY_LIVE = [
  "venmo", "cashapp", "chime", "revolut", "wise", "zelle", "paypal", "monzo", "alipay", "upi", "xmoney",
] as const;
/**
 * Listed in src/peer/platforms.ts, never live: no buyer TEE verifier, not in the
 * SDK catalogue, or no major currency (Monobank UAH, Mercado Pago ARS).
 */
const DOC_BUY_NEVER_LIVE = ["n26", "luxon", "mercadopago", "monobank"] as const;

/**
 * What the Sell form offers: @zkp2p/cash's capabilities narrowed to the major
 * currencies (shared/currencies.ts), every pair at Peer Cash's oracle market
 * rate. Peer Cash also lists non-major currencies (Revolut TRY, ZAR; Wise IDR,
 * PHP, ...): those are left out on purpose and only reported.
 */
const DOC_SELL: Record<string, readonly string[]> = {
  alipay: ["CNY"],
  cashapp: ["USD"],
  chime: ["USD"],
  monzo: ["GBP"],
  paypal: ["AUD", "CAD", "EUR", "GBP", "NZD", "SGD", "USD"],
  revolut: ["AUD", "CAD", "CHF", "CNY", "EUR", "GBP", "MXN", "NZD", "SGD", "USD"],
  upi: ["INR"],
  venmo: ["USD"],
  wise: ["AUD", "CAD", "CHF", "CNY", "EUR", "GBP", "INR", "MXN", "NZD", "SGD", "USD"],
  xmoney: ["USD"],
  zelle: ["USD"],
};

const ATTESTATION_SUPPORTED_URL = "https://attestation-service.zkp2p.xyz/buyer/supported";
const MAX_IN_FLIGHT = 2;
const PAUSE_MS = 150;

// ---------------------------------------------------------------------------
// Arguments

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const JSON_PATH = path.resolve(argValue("--json") ?? path.join(os.tmpdir(), "rampridge-peer-matrix.json"));
const AMOUNTS_USD = (argValue("--amounts") ?? "20,250")
  .split(",")
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0);
const QUOTES = !process.argv.includes("--no-quotes");

// ---------------------------------------------------------------------------
// Loading src/ under bun: rewrite the "@/" and "@shared/" aliases (tsconfig.app.json
// paths, which bun does not read from a project reference) to absolute paths.

type BunLoader = "ts" | "tsx";
interface BunRuntime {
  plugin(plugin: {
    name: string;
    setup(build: {
      onLoad(options: { filter: RegExp }, load: (args: { path: string }) => { contents: string; loader: BunLoader }): void;
    }): void;
  }): void;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasSourceImports(): void {
  const bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!bun) throw new Error("Run this with bun: bun scripts/ops/peer-matrix.ts");
  const filter = new RegExp(`^(?:${escapeRegExp(SRC)}|${escapeRegExp(SHARED)})/.+\\.tsx?$`);
  const specifier = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])@(shared)?\//g;
  bun.plugin({
    name: "rampridge-source-aliases",
    setup(build) {
      build.onLoad({ filter }, ({ path: file }) => ({
        contents: readFileSync(file, "utf8").replace(specifier, (_m, lead: string, quote: string, shared?: string) =>
          `${lead}${quote}${shared ? SHARED : SRC}/`,
        ),
        loader: file.endsWith(".tsx") ? "tsx" : "ts",
      }));
    },
  });
}

aliasSourceImports();

const sdk = await import("@zkp2p/sdk");
const cashSdk = await import("@zkp2p/cash");
const config: typeof import("../../src/config") = await import("../../src/config");
const majors: typeof import("../../shared/currencies") = await import("../../shared/currencies");
const platforms: typeof import("../../src/peer/platforms") = await import("../../src/peer/platforms");
const market: typeof import("../../src/peer/market") = await import("../../src/peer/market");
const peerClient: typeof import("../../src/peer/client") = await import("../../src/peer/client");

// ---------------------------------------------------------------------------
// Findings

const errors: string[] = [];
const warnings: string[] = [];
const fail = (message: string) => errors.push(message);
const warn = (message: string) => warnings.push(message);

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 160);
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status ??
    (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" ? status : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries 429, 5xx and timeouts with exponential backoff (1, 2, 4, 8 s plus jitter). */
async function withBackoff<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const status = statusOf(error);
      const retryable =
        status === 429 || (status !== null && status >= 500) || /timed? ?out|ETIMEDOUT|ECONNRESET|fetch failed/i.test(messageOf(error));
      if (!retryable || attempt >= 4) throw error;
      await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
    }
  }
}

async function getJson(url: string): Promise<unknown> {
  return withBackoff(async () => {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw Object.assign(new Error(`${url} answered ${response.status}`), { status: response.status });
    return response.json();
  });
}

// ---------------------------------------------------------------------------
// (a) Attestation service buyer verifiers vs BUYER_TEE_VERIFIERS

interface AttestationResult {
  ok: boolean;
  error?: string;
  served: string[];
  /** Served by the service, not listed in the app. */
  unlisted: string[];
  /** Listed in the app, no longer served. */
  notServed: string[];
}

async function probeAttestation(): Promise<AttestationResult> {
  const listed = [...platforms.BUYER_TEE_VERIFIERS].sort();
  try {
    const body = (await getJson(ATTESTATION_SUPPORTED_URL)) as {
      responseObject?: { verifiers?: { platform?: string; actionType?: string }[] };
    };
    const served = (body.responseObject?.verifiers ?? [])
      .filter((v) => v.platform && v.actionType)
      .map((v) => `${v.platform}/${v.actionType}`)
      .sort();
    if (served.length === 0) throw new Error("no verifiers in the response");
    const servedSet = new Set(served);
    const unlisted = served.filter((key) => !platforms.BUYER_TEE_VERIFIERS.has(key));
    const notServed = listed.filter((key) => !servedSet.has(key));
    for (const key of unlisted) warn(`attestation: serves ${key}, which BUYER_TEE_VERIFIERS doesn't list`);
    for (const key of notServed) fail(`attestation: BUYER_TEE_VERIFIERS lists ${key}, which the service no longer serves`);
    for (const platform of Object.values(platforms.BUY_PLATFORMS)) {
      if (!platform.live) continue;
      for (const method of platform.verifyMethods) {
        const key = `${method.actionPlatform}/${method.actionType}`;
        if (!servedSet.has(key)) fail(`attestation: live buy platform ${platform.id} can't be verified (${key} not served)`);
      }
    }
    return { ok: notServed.length === 0, served, unlisted, notServed };
  } catch (error) {
    fail(`attestation: ${ATTESTATION_SUPPORTED_URL} unavailable (${messageOf(error)})`);
    return { ok: false, error: messageOf(error), served: [], unlisted: [], notServed: [] };
  }
}

// ---------------------------------------------------------------------------
// (b) SDK catalogue, app drift and oracle coverage

interface CatalogueRow {
  side: "buy" | "sell";
  platform: string;
  currency: string;
  inCatalogue: boolean;
  /** isMarketRateSupported, for sell rows. */
  oracle?: boolean;
}

const catalogue = sdk.getPaymentMethodsCatalog(config.CHAIN_ID, "production");

function catalogueHas(platform: string, currency: string): boolean {
  try {
    sdk.resolvePaymentMethodHashFromCatalog(platform, catalogue);
  } catch {
    return false;
  }
  const hash = sdk.resolveFiatCurrencyBytes32(currency).toLowerCase();
  return (catalogue[platform]?.currencies ?? []).some((c) => c.toLowerCase() === hash);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

interface AppSell {
  /** What the Sell form offers (sellCapabilities), per platform; null when it can't be read. */
  matrix: Record<string, string[]> | null;
  note: string;
}

/** The app's own sell matrix: sellCapabilities(), what the Sell form offers. */
async function appSell(): Promise<AppSell> {
  try {
    const sell: typeof import("../../src/peer/sell/cash") = await import("../../src/peer/sell/cash");
    const matrix: Record<string, string[]> = {};
    for (const p of sell.sellCapabilities().platforms) matrix[p.platform] = [...p.currencies].sort();
    return { matrix, note: "sellCapabilities(): @zkp2p/cash x major currencies, oracle market rate" };
  } catch (error) {
    return { matrix: null, note: `src/peer/sell/cash.ts failed to load (${messageOf(error)})` };
  }
}

function diffMatrix(label: string, app: Record<string, readonly string[]>, doc: Record<string, readonly string[]>): void {
  for (const platform of new Set([...Object.keys(app), ...Object.keys(doc)])) {
    const got = app[platform] ?? [];
    const want = doc[platform] ?? [];
    if (!sameList(got, want)) fail(`drift: ${label} ${platform} in the app is ${got.join(" ") || "none"}; docs say ${want.join(" ") || "none"}`);
  }
}

interface CatalogueResult {
  rows: CatalogueRow[];
  app: AppSell;
  /** @zkp2p/cash's own sell capabilities, per platform. */
  cashCaps: Record<string, string[]>;
  /** Currencies @zkp2p/cash sells that the app leaves out (not major), per platform. */
  leftOut: Record<string, string[]>;
}

async function probeCatalogue(): Promise<CatalogueResult> {
  const rows: CatalogueRow[] = [];

  // Buy: the app's live set is the documented one, and every live pair is in the catalogue.
  const live = Object.values(platforms.BUY_PLATFORMS).filter((p) => p.live);
  const liveIds = live.map((p) => p.id as string);
  for (const id of DOC_BUY_LIVE) if (!liveIds.includes(id)) fail(`drift: ${id} should be live for buying, the app has it ${id in platforms.BUY_PLATFORMS ? "not live" : "unlisted"}`);
  for (const id of liveIds) if (!(DOC_BUY_LIVE as readonly string[]).includes(id)) fail(`drift: ${id} is live for buying but not in the documented matrix`);
  for (const id of DOC_BUY_NEVER_LIVE) if (platforms.isBuyPlatformId(id) && platforms.isPlatformLive(id)) fail(`drift: ${id} is live for buying; docs say never live`);
  for (const platform of live) {
    for (const currency of platform.currencies) {
      const inCatalogue = catalogueHas(platform.id, currency);
      if (!inCatalogue) fail(`catalogue: buy ${platform.id} ${currency} is not in the SDK catalogue`);
      if (!majors.isMajorCurrency(currency)) fail(`drift: buy ${platform.id} ${currency} is live but not a major currency`);
      rows.push({ side: "buy", platform: platform.id, currency, inCatalogue });
    }
  }

  // Sell: @zkp2p/cash still offers every documented pair; what it sells beyond the majors is left out on purpose.
  const caps = cashSdk.createCashClient({ environment: "production" }).capabilities();
  const cashCaps: Record<string, string[]> = {};
  const leftOut: Record<string, string[]> = {};
  for (const p of caps.platforms) {
    cashCaps[p.platform] = [...p.currencies].sort();
    const minor = p.currencies.filter((c) => !majors.isMajorCurrency(c)).sort();
    if (minor.length) leftOut[p.platform] = minor;
  }
  for (const [platform, currencies] of Object.entries(DOC_SELL)) {
    const got = cashCaps[platform];
    const gone = currencies.filter((c) => !got?.includes(c));
    if (!got) fail(`drift: @zkp2p/cash no longer offers ${platform} for selling`);
    else if (gone.length) fail(`drift: @zkp2p/cash no longer sells ${platform} ${gone.join(" ")}`);
  }

  // What the Sell form offers is the documented matrix: majors only, every one at the oracle rate.
  const app = await appSell();
  if (app.matrix) diffMatrix("selling", app.matrix, DOC_SELL);
  else fail(`app sell matrix unreadable: ${app.note}`);

  for (const [platform, currencies] of Object.entries(DOC_SELL)) {
    for (const currency of currencies) {
      const inCatalogue = catalogueHas(platform, currency);
      const oracle = cashSdk.isMarketRateSupported(currency as never);
      if (!inCatalogue) fail(`catalogue: sell ${platform} ${currency} is not in the SDK catalogue`);
      if (!oracle) fail(`oracle: sell ${platform} ${currency} has no SDK oracle`);
      if (!majors.isMajorCurrency(currency)) fail(`docs: sell ${platform} ${currency} is not a major currency`);
      rows.push({ side: "sell", platform, currency, inCatalogue, oracle });
    }
  }
  return { rows, app, cashCaps, leftOut };
}

// ---------------------------------------------------------------------------
// (d) Peer Cash oracle rates for every currency the app trades

interface OracleRow {
  currency: string;
  ok: boolean;
  /** Fiat per 1 USDC at the oracle (the 0% spread sell rate). */
  rate?: number;
  asOf?: number;
  stale?: boolean;
  error?: string;
}

/** Every sell currency and every live buy currency (all majors): the sell rate, and what sizes and grades buy quotes. */
async function probeOracle(): Promise<OracleRow[]> {
  const cash = cashSdk.createCashClient({ environment: "production", rpcUrl: config.BASE_RPC_URL });
  const buyCurrencies = Object.values(platforms.BUY_PLATFORMS).filter((p) => p.live).flatMap((p) => [...p.currencies]);
  const currencies = [...new Set([...Object.values(DOC_SELL).flat(), ...buyCurrencies])].sort();
  const rows: OracleRow[] = [];
  for (const currency of currencies) {
    try {
      const estimate = await withBackoff(() =>
        cash.estimate({ amount: 1_000_000n, currency: currency as never }, { includeEta: false }),
      );
      const stale = estimate.stale === true;
      if (stale) warn(`oracle: ${currency} reading is over a day old`);
      rows.push({ currency, ok: true, rate: estimate.rate, asOf: estimate.asOf, stale });
    } catch (error) {
      fail(`oracle: ${currency} has no market rate now (${messageOf(error)})`);
      rows.push({ currency, ok: false, error: messageOf(error) });
    }
    await sleep(PAUSE_MS);
  }
  return rows;
}

/** Fiat per 1 USDC by currency, from the oracle rows (USD is 1). */
function oracleRates(rows: readonly OracleRow[]): Record<string, number> {
  const rates: Record<string, number> = { USD: 1 };
  for (const row of rows) if (row.ok && row.rate && row.rate > 0) rates[row.currency] = row.rate;
  return rates;
}

// ---------------------------------------------------------------------------
// (c) Curator quotes per buy platform x currency

type QuoteStatus = "quote" | "none" | "error" | "skipped";

interface QuoteCell {
  usd: number;
  /** Fiat amount asked for, decimal string. */
  fiat: string;
  status: QuoteStatus;
  /** Usable quotes (after the app's own filters). */
  count?: number;
  /** Best USDC out for the buyer, decimal. */
  usdc?: string;
  /** Fiat per USDC the best quote signals at. */
  rate?: number;
  /** Percent above the Peer Cash oracle rate the buyer pays. */
  premium?: number | null;
  /** Nearby fillable amounts Curator suggested when nothing fills exactly. */
  nearby?: string[];
  /** Alipay: Curator holds the best maker's PID (needed for the pay link). */
  alipayPid?: "present" | "missing" | "error";
  /** The platform is not live in the app, so the quote went through the raw client. */
  raw?: boolean;
  error?: string;
}

interface BuyRow {
  platform: string;
  currency: string;
  live: boolean;
  minExtension: string;
  cells: QuoteCell[];
}

function fiatFor(usd: number, currency: string, rates: Readonly<Record<string, number>>): string | null {
  if (currency === "USD") return String(usd);
  const rate = rates[currency];
  if (!rate) return null;
  const decimals = platforms.isFiatCode(currency) ? platforms.FIAT_CURRENCIES[currency].decimals : 2;
  const amount = usd * rate;
  // Whole units read better and are what a player types; keep cents only below 10.
  return amount >= 10 || decimals === 0 ? String(Math.round(amount)) : amount.toFixed(2);
}

const toDecimal = (value: bigint, decimals: number) => {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
};

async function alipayPidStatus(payeeDetailsHash: string): Promise<"present" | "missing" | "error"> {
  try {
    const response = await withBackoff(() =>
      sdk.apiGetPayeeDetails({ hashedOnchainId: payeeDetailsHash, processorName: "alipay" }, config.PEER_API_URL, peerClient.PEER_API_TIMEOUT_MS),
    );
    const pid = (response.responseObject?.metadata as Record<string, unknown> | null | undefined)?.alipayPid;
    return typeof pid === "string" && /^\d{16}$/.test(pid.trim()) ? "present" : "missing";
  } catch (error) {
    return statusOf(error) === 404 ? "missing" : "error";
  }
}

/**
 * A documented platform the app doesn't have live yet: the same request market.ts
 * sends (getBuyQuotes), through the same read-only client, filtered by policy only.
 */
async function rawQuote(platform: string, currency: string, fiat: string): Promise<{ quotes: { usdc: bigint; rate: bigint; payeeDetailsHash: string }[]; nearby: string[] }> {
  const client = peerClient.getReadOnlyPeerClient();
  let response;
  try {
    response = await client.getQuote({
      paymentPlatforms: [platform],
      fiatCurrency: currency,
      user: peerClient.READ_ONLY_ACCOUNT,
      recipient: peerClient.READ_ONLY_ACCOUNT,
      destinationChainId: config.CHAIN_ID,
      destinationToken: config.USDC_ADDRESS,
      amount: (BigInt(Math.round(Number(fiat) * 100)) * 10_000n).toString(),
      isExactFiat: true,
      quotesToReturn: 5,
      includeNearbyQuotes: true,
      nearbyQuotesCount: 3,
      mode: "eligible",
      quotePreference: "PREFER_BUYER_TEE",
      referrerFeeConfig: { ...config.BUY_REFERRER_FEE },
    });
  } catch (error) {
    if (statusOf(error) === 404) return { quotes: [], nearby: [] };
    throw error;
  }
  const body = response.responseObject;
  const quotes = (body?.quotes ?? [])
    .filter((q) => !market.requiresTakerPermission(q) && q.intent?.payeeDetails)
    .map((q) => ({
      usdc: BigInt(q.tokenAmount ?? "0"),
      rate: market.preferredRate(q) ?? 0n,
      payeeDetailsHash: q.intent.payeeDetails,
    }))
    .filter((q) => q.usdc > 0n)
    .sort((a, b) => (a.usdc === b.usdc ? 0 : a.usdc > b.usdc ? -1 : 1));
  const nearby = [...(body?.nearbySuggestions?.below ?? []), ...(body?.nearbySuggestions?.above ?? [])]
    .map((s) => (s.suggestedFiatAmount ? toDecimal(BigInt(s.suggestedFiatAmount), 6) : null))
    .filter((s): s is string => s !== null);
  return { quotes, nearby };
}

async function quoteCell(
  platform: string,
  currency: string,
  usd: number,
  live: boolean,
  rates: Readonly<Record<string, number>>,
): Promise<QuoteCell> {
  const fiat = fiatFor(usd, currency, rates);
  if (fiat === null) {
    fail(`quote: no oracle rate to size ${usd} USD in ${currency}`);
    return { usd, fiat: "", status: "error", error: "no oracle rate" };
  }
  const mid = rates[currency];
  const premiumOf = (rate: number) => (mid ? (rate / mid - 1) * 100 : null);
  try {
    if (live && platforms.isBuyPlatformId(platform) && platforms.isFiatCode(currency)) {
      const result = await withBackoff(() => market.getBuyQuotes({ fiatAmount: fiat, currency, platforms: [platform], quotesToReturn: 5 }));
      const best = result.quotes[0];
      if (!best) {
        const nearby = [...result.nearby.below, ...result.nearby.above].map((n) => toDecimal(n.fiatAmount, 6));
        return { usd, fiat, status: "none", count: 0, nearby };
      }
      const rate = Number(toDecimal(best.rate, 18));
      const cell: QuoteCell = {
        usd, fiat, status: "quote", count: result.quotes.length, usdc: toDecimal(best.usdcAmount, 6), rate, premium: premiumOf(rate),
      };
      if (platform === "alipay") cell.alipayPid = await alipayPidStatus(best.payeeDetailsHash);
      return cell;
    }
    const result = await withBackoff(() => rawQuote(platform, currency, fiat));
    const best = result.quotes[0];
    if (!best) return { usd, fiat, status: "none", count: 0, nearby: result.nearby, raw: true };
    const rate = Number(toDecimal(best.rate, 18));
    const cell: QuoteCell = {
      usd, fiat, status: "quote", count: result.quotes.length, usdc: toDecimal(best.usdc, 6), rate, premium: premiumOf(rate), raw: true,
    };
    if (platform === "alipay") cell.alipayPid = await alipayPidStatus(best.payeeDetailsHash);
    return cell;
  } catch (error) {
    fail(`quote: ${platform} ${currency} ${fiat} failed (${statusOf(error) ?? "no status"}: ${messageOf(error)})`);
    return { usd, fiat, status: "error", error: messageOf(error) };
  }
}

async function probeQuotes(rates: Readonly<Record<string, number>>): Promise<BuyRow[]> {
  const rows: BuyRow[] = [];
  for (const id of DOC_BUY_LIVE) {
    const known = platforms.isBuyPlatformId(id);
    const live = known && platforms.isPlatformLive(id);
    // A documented platform the app doesn't list yet: its catalogue currencies, so it still gets quoted.
    const currencies: readonly string[] = known
      ? platforms.BUY_PLATFORMS[id].currencies
      : platforms.FIAT_CODES.filter((code) => catalogueHas(id, code));
    for (const currency of currencies) {
      rows.push({
        platform: id,
        currency,
        live,
        minExtension: known ? platforms.minExtensionVersion(id) : "?",
        cells: AMOUNTS_USD.map((usd) => ({ usd, fiat: "", status: "skipped" as const })),
      });
    }
  }
  if (!QUOTES) return rows;

  const jobs = rows.flatMap((row) => row.cells.map((_, index) => ({ row, index })));
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (!job) break;
      const usd = AMOUNTS_USD[job.index] ?? 0;
      job.row.cells[job.index] = await quoteCell(job.row.platform, job.row.currency, usd, job.row.live, rates);
      done += 1;
      if (process.stderr.isTTY) process.stderr.write(`\r  quotes ${done}/${jobs.length}`);
      await sleep(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: MAX_IN_FLIGHT }, worker));
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  return rows;
}

// ---------------------------------------------------------------------------
// Output

function cellText(cell: QuoteCell): string {
  switch (cell.status) {
    case "quote": {
      const premium = cell.premium === null || cell.premium === undefined ? "" : ` ${cell.premium >= 0 ? "+" : ""}${cell.premium.toFixed(1)}%`;
      const pid = cell.alipayPid ? ` pid:${cell.alipayPid}` : "";
      return `${Number(cell.usdc).toFixed(2)} USDC${premium} x${cell.count}${pid}`;
    }
    case "none":
      return cell.nearby?.length ? `none (nearby ${cell.nearby.slice(0, 2).map((n) => Number(n).toFixed(0)).join("/")})` : "none";
    case "error":
      return `ERROR ${cell.error ?? ""}`.slice(0, 34);
    default:
      return "-";
  }
}

const pad = (text: string, width: number) => (text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length));

function printReport(report: {
  attestation: AttestationResult;
  catalogue: Awaited<ReturnType<typeof probeCatalogue>>;
  oracle: OracleRow[];
  buy: BuyRow[];
}): void {
  const { attestation, catalogue: cat, oracle, buy } = report;
  const out = (line = "") => console.log(line);

  out(`RampRidge Peer matrix, ${new Date().toISOString()}`);
  out();
  out(`(a) Attestation service: ${attestation.served.length} buyer verifiers served${attestation.error ? `, ERROR ${attestation.error}` : ""}`);
  if (attestation.unlisted.length) out(`    served, not in BUYER_TEE_VERIFIERS: ${attestation.unlisted.join(", ")}`);
  if (attestation.notServed.length) out(`    in BUYER_TEE_VERIFIERS, not served: ${attestation.notServed.join(", ")}`);
  if (!attestation.unlisted.length && !attestation.notServed.length && !attestation.error) out("    matches BUYER_TEE_VERIFIERS");

  const missing = cat.rows.filter((r) => !r.inCatalogue);
  out(`(b) SDK catalogue: ${cat.rows.filter((r) => r.side === "buy").length} buy and ${cat.rows.filter((r) => r.side === "sell").length} sell pairs checked, ${missing.length} missing`);
  out(`    app sell matrix: ${cat.app.note}`);
  const leftOut = Object.entries(cat.leftOut).map(([platform, currencies]) => `${platform} ${currencies.join(" ")}`);
  if (leftOut.length) out(`    @zkp2p/cash also sells, left out (not major): ${leftOut.join("; ")}`);

  const oracleOk = oracle.filter((o) => o.ok).length;
  out(`(d) Peer Cash oracle: ${oracleOk}/${oracle.length} currencies priced (fiat per USDC)`);
  out(`    ${oracle.map((o) => `${o.currency} ${o.ok ? Number(o.rate?.toPrecision(6)) : "ERROR"}${o.stale ? " (stale)" : ""}`).join("  ")}`);
  out();

  const amounts = AMOUNTS_USD.map((usd) => `~${usd} USD`);
  out(`(c) BUY: Curator quotes, mode eligible, 50 bps referrer fee (USDC out, premium over the Peer Cash oracle, quotes)`);
  out(`${pad("platform", 10)}${pad("cur", 5)}${pad("ext", 7)}${amounts.map((a) => pad(a, 40)).join("")}`);
  for (const row of buy) {
    const cells = row.cells.map((cell) => pad(`${cell.fiat ? `${cell.fiat} ` : ""}${cellText(cell)}`, 40)).join("");
    out(`${pad(row.platform, 10)}${pad(row.currency, 5)}${pad(row.minExtension, 7)}${cells}${row.live ? "" : "  [not live in app]"}`);
  }
  out();

  out("SELL: the Sell form per platform x currency, majors only, at the Peer Cash oracle rate (fiat per USDC, 0% spread)");
  const sellRows = cat.rows.filter((r) => r.side === "sell");
  for (const platform of new Set(sellRows.map((r) => r.platform))) {
    const cells = sellRows
      .filter((r) => r.platform === platform)
      .map((r) => {
        const rate = oracle.find((o) => o.currency === r.currency)?.rate;
        const flags = `${r.inCatalogue ? "" : "!cat"}${r.oracle ? "" : "!oracle"}`;
        return `${r.currency}${rate ? `@${Number(rate.toPrecision(5))}` : "@?"}${flags}`;
      });
    out(`${pad(platform, 10)}${cells.join(" ")}`);
  }
  out();

  const cells = buy.flatMap((row) => row.cells.map((cell) => ({ row, cell })));
  const byAmount = QUOTES
    ? AMOUNTS_USD.map((usd) => {
        const at = cells.filter((c) => c.cell.usd === usd);
        return `~${usd} USD: ${at.filter((c) => c.cell.status === "quote").length}/${at.length} quoted`;
      })
    : ["quotes skipped"];
  out(`Summary: ${buy.length} buy pairs (${byAmount.join(", ")}), ${sellRows.length} sell pairs (oracle market rate, majors only)`);
  // No liquidity, grouped per platform: currencies with nothing at any size, then those empty at some sizes.
  const empty = new Map<string, { all: string[]; some: string[] }>();
  for (const row of buy) {
    const sizes = row.cells.filter((c) => c.status === "none").map((c) => c.usd);
    if (!sizes.length) continue;
    const entry = empty.get(row.platform) ?? { all: [], some: [] };
    if (sizes.length === row.cells.length) entry.all.push(row.currency);
    else entry.some.push(`${row.currency}@${sizes.join("/")}`);
    empty.set(row.platform, entry);
  }
  if (empty.size) {
    out("No liquidity (reported, not failed; @ = only at that USD size):");
    for (const [platform, { all, some }] of empty) out(`  ${pad(platform, 9)}${[...all, ...some].join(" ")}`);
  }
  for (const line of warnings) out(`WARN  ${line}`);
  for (const line of errors) out(`ERROR ${line}`);
  out(errors.length ? `${errors.length} error(s).` : "No errors.");
}

// ---------------------------------------------------------------------------

const started = Date.now();
const attestation = await probeAttestation();
const catalogueResult = await probeCatalogue();
const oracle = await probeOracle();
const buy = await probeQuotes(oracleRates(oracle));

printReport({ attestation, catalogue: catalogueResult, oracle, buy });

mkdirSync(path.dirname(JSON_PATH), { recursive: true });
writeFileSync(
  JSON_PATH,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      sources: {
        attestation: ATTESTATION_SUPPORTED_URL,
        curator: config.PEER_API_URL,
        oracle: "@zkp2p/cash estimate() (on-chain oracle via BASE_RPC_URL)",
        catalogue: "getPaymentMethodsCatalog(8453, 'production')",
      },
      amountsUsd: AMOUNTS_USD,
      documented: { buyLive: DOC_BUY_LIVE, buyNeverLive: DOC_BUY_NEVER_LIVE, sell: DOC_SELL },
      attestation,
      catalogue: catalogueResult,
      oracle,
      buy,
      warnings,
      errors,
    },
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  )}\n`,
);
console.log(`JSON: ${JSON_PATH} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
process.exit(errors.length ? 1 : 0);
