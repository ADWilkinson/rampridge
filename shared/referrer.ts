/**
 * Where a visit came from, as one coarse class. The browser classifies its
 * own page view (src/lib/telemetry.ts) and /api/log counts page views per
 * class under `ops/referrers/{day}/{class}`. Only the class leaves the
 * browser, never the referring URL or the query string. Dependency-free,
 * like protocol.ts.
 *
 * Order of evidence: a shared trade link (`?from=share`), then `utm_source`,
 * then the referring host. Messaging apps and many in-app browsers send no
 * referrer, so their visits count as direct.
 */

import { FROM_PARAM, FROM_SHARE } from "./share.js";

export const REFERRER_CLASSES = [
  "direct",
  "share",
  "internal",
  "x",
  "github",
  "peer",
  "reddit",
  "search",
  "ai",
  "threejs",
  "newsletter",
  "chat",
  "portfolio",
  "other",
] as const;
export type ReferrerClass = (typeof REFERRER_CLASSES)[number];

const CLASS_SET: ReadonlySet<string> = new Set(REFERRER_CLASSES);

export function isReferrerClass(value: unknown): value is ReferrerClass {
  return typeof value === "string" && CLASS_SET.has(value);
}

/** True when `host` is `domain` or one of its subdomains. */
function within(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** A host's class. Assistants come before search: gemini.google.com is not a Google search. */
const HOSTS: readonly [ReferrerClass, (host: string) => boolean][] = [
  ["x", (h) => ["t.co", "x.com", "twitter.com"].some((d) => within(h, d))],
  ["github", (h) => within(h, "github.com")],
  ["peer", (h) => within(h, "peer.xyz") || within(h, "zkp2p.xyz")],
  ["reddit", (h) => within(h, "reddit.com") || h === "redd.it"],
  ["ai", (h) => ["chatgpt.com", "chat.openai.com", "perplexity.ai", "claude.ai", "gemini.google.com", "copilot.microsoft.com"].some((d) => within(h, d))],
  [
    "search",
    (h) =>
      /(^|\.)(google|bing|yahoo|yandex)\.[a-z.]+$/.test(h) || ["duckduckgo.com", "search.brave.com", "ecosia.org", "kagi.com", "baidu.com"].some((d) => within(h, d)),
  ],
  ["threejs", (h) => within(h, "threejs.org")],
  ["newsletter", (h) => ["javascriptweekly.com", "cooperpress.com", "changelog.com", "jendrikillner.com"].some((d) => within(h, d))],
  ["chat", (h) => ["t.me", "telegram.org", "discord.com", "discord.gg", "discordapp.com"].some((d) => within(h, d))],
  ["portfolio", (h) => within(h, "andrewwilkinson.io") || within(h, "galleonlabs.io")],
];

/** The `utm_source` names links are tagged with, by class. Any other value is read as a host. */
const SOURCES: readonly [ReferrerClass, RegExp][] = [
  ["x", /^(x|twitter)($|[-_])/],
  ["github", /^github$/],
  ["peer", /^peer/],
  ["reddit", /^reddit$/],
  ["threejs", /^three/],
  ["newsletter", /weekly|newsletter|changelog/],
  ["chat", /^(telegram|discord)$/],
  ["portfolio", /^(andrewwilkinson|galleonlabs|portfolio)$/],
];

function hostClass(host: string): ReferrerClass | null {
  const h = host.replace(/^www\./, "");
  return HOSTS.find(([, test]) => test(h))?.[0] ?? null;
}

function sourceClass(source: string): ReferrerClass {
  const s = source.trim().toLowerCase();
  return SOURCES.find(([, pattern]) => pattern.test(s))?.[0] ?? hostClass(s) ?? "other";
}

/**
 * The class of one page view, from `document.referrer`, `location.search`
 * and the site's own host (`location.hostname`).
 */
export function referrerClass({ referrer, search, host }: { referrer: string; search: string; host: string }): ReferrerClass {
  const params = new URLSearchParams(search);
  if (params.get(FROM_PARAM) === FROM_SHARE) return "share";
  const source = params.get("utm_source");
  if (source?.trim()) return sourceClass(source);
  if (!referrer) return "direct";
  let from: URL;
  try {
    from = new URL(referrer);
  } catch {
    return "other";
  }
  const fromHost = from.hostname.toLowerCase();
  if (fromHost === host.toLowerCase()) return from.pathname.startsWith("/t/") ? "share" : "internal";
  return hostClass(fromHost) ?? "other";
}
