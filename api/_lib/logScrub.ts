/**
 * Redaction for client error reports before they are stored or logged. A
 * browser error can quote anything the page touched, so the server assumes
 * the worst: wallet addresses and other long hex, session and API tokens,
 * emails, payee handles (Venmo/Revolut @names, Cash App $cashtags), long
 * numbers (phones, bank and CVU numbers) and every query string are removed.
 * Third-party URLs keep only their origin, because RPC and bundler URLs
 * carry API keys in their path.
 */

/** Hosts whose URL paths are kept: our own pages and build output. */
const OWN_HOSTS = /^(?:www\.)?rampridge\.xyz$|^localhost$|^127\.0\.0\.1$|\.vercel\.app$/i;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()\]]+/gi;

function scrubUrl(raw: string): string {
  // Stack frames end in ":line:col", which URL parsing would fold into the path; keep it aside.
  const position = /(:\d+){1,2}$/.exec(raw)?.[0] ?? "";
  const bare = position ? raw.slice(0, -position.length) : raw;
  let url: URL;
  try {
    url = new URL(bare);
  } catch {
    return "[url]";
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (!OWN_HOSTS.test(url.hostname)) return `${url.origin}/…`;
    return `${url.origin}${url.pathname}${position}`;
  }
  // chrome-extension://, blob:, webpack:// and the like: scheme and host only.
  return `${url.protocol}//${url.host}/…`;
}

/** Rules shared by messages and stack frames. Order matters: URLs first so their parts are not re-matched. */
function scrubCommon(text: string): string {
  return (
    text
      .replace(URL_PATTERN, scrubUrl)
      // JWTs (session tokens, Privy tokens).
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, "[jwt]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [token]")
      // Addresses, hashes, keys, calldata.
      .replace(/\b0x[0-9a-f]{40}(?![0-9a-f])/gi, "0x[address]")
      .replace(/\b0x[0-9a-f]{16,}/gi, "0x[hex]")
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
      // Opaque tokens: long runs mixing letters and digits (API keys, Privy ids). Not path or host segments.
      .replace(/(?<![\w/.-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}/g, "[token]")
  );
}

/**
 * Scrubs free text (an error message). On top of the common rules: payee
 * handles and long numbers, which only free text can contain.
 */
export function scrubText(text: string, maxLength: number): string {
  const out = scrubCommon(text)
    // Payment links written without a scheme: keep the service, drop the account.
    .replace(/\b((?:revolut|monzo|paypal)\.me|cash\.app|venmo\.com|wise\.com|chime\.com)\/\S+/gi, "$1/…")
    // @handles (Venmo, Revolut, Wise, Monzo), but not scoped packages (@privy-io/...) or Safari's "@https://" frames.
    .replace(/(^|[^\w@])@(?![a-z][a-z0-9+.-]*:\/\/)(?![\w.-]*\/)[A-Za-z0-9][\w.-]{1,}/g, "$1@[handle]")
    // $cashtags (Cash App, Chime) and £ / € handles.
    .replace(/(^|[^\w$])[$£€][A-Za-z][\w-]{1,}/g, "$1$[handle]")
    // Phone, account and CVU numbers: nine or more digits, allowing separators.
    .replace(/\+?\d(?:[\d\s().-]{7,})\d/g, (match) => ((match.match(/\d/g)?.length ?? 0) >= 9 ? "[number]" : match));
  return truncate(out.replace(/\s+/g, " ").trim(), maxLength);
}

/**
 * Keeps the first `maxFrames` frame lines of a stack (V8 "at ..." lines, or
 * Safari/Firefox "fn@url:line:col" lines) and scrubs each. Everything else,
 * notably the message lines a V8 stack starts with, is dropped: the message
 * is stored separately and gets the stricter free-text rules.
 */
export function scrubStack(stack: string, maxFrames: number, maxLength: number): string {
  const lines = stack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const v8 = lines.some((line) => /^at\s/.test(line));
  const frames = lines
    .filter((line) => (v8 ? /^at\s/.test(line) : /:\d+:\d+$/.test(line) || line === "[native code]"))
    .slice(0, maxFrames)
    .map(scrubCommon);
  return truncate(frames.join("\n"), maxLength);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** User agent families the launch cares about. In-app browsers (X, Instagram, TikTok) are where wallets struggle. */
export type UaClass = `${"ios" | "android" | "mac" | "windows" | "linux" | "chromeos" | "other"}-${
  | "inapp"
  | "chrome"
  | "safari"
  | "firefox"
  | "edge"
  | "opera"
  | "other"}`;

/** A coarse, non-identifying label for a User-Agent: platform and browser family only. "bot" for automation. */
export function uaClass(ua: string | null | undefined): UaClass | "bot" | "unknown" {
  if (!ua) return "unknown";
  if (/bot\b|crawler|spider|headless|lighthouse|preview|facebookexternalhit|slurp|python-requests|curl\//i.test(ua)) {
    return "bot";
  }
  const os = /iphone|ipad|ipod/i.test(ua)
    ? "ios"
    : /android/i.test(ua)
      ? "android"
      : /cros/i.test(ua)
        ? "chromeos"
        : /macintosh|mac os x/i.test(ua)
          ? "mac"
          : /windows/i.test(ua)
            ? "windows"
            : /linux/i.test(ua)
              ? "linux"
              : "other";
  // Named in-app browsers, Android WebViews ("; wv)"), and iOS WebViews, which drop the "Safari/" token every iOS browser sends.
  const inApp =
    /twitter|\bx\.com|fban|fbav|instagram|\bline\/|tiktok|bytedance|musical_ly|snapchat|linkedinapp|discord|telegram|; wv\)/i.test(ua) ||
    (os === "ios" && !/safari\//i.test(ua));
  const browser = inApp
    ? "inapp"
    : /edg(e|a|ios)?\//i.test(ua)
      ? "edge"
      : /opr\/|opera/i.test(ua)
        ? "opera"
        : /firefox|fxios/i.test(ua)
          ? "firefox"
          : /crios|chrome|chromium/i.test(ua)
            ? "chrome"
            : /safari/i.test(ua)
              ? "safari"
              : "other";
  return `${os}-${browser}`;
}
