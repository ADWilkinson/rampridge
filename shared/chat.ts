/**
 * Chat rules shared by the API (which filters before writing) and the client
 * (which parses effects for rendering). Mirrors the original game's public
 * chat: 80 characters, colour and motion prefixes, a blunt profanity filter.
 */

import { CHAT_MAX_LENGTH, NAME_MAX_LENGTH } from "./protocol.js";

export const CHAT_COLORS = [
  "yellow",
  "red",
  "green",
  "cyan",
  "purple",
  "white",
  "flash1",
  "flash2",
  "flash3",
  "glow1",
  "glow2",
  "glow3",
] as const;
export const CHAT_MOTIONS = ["wave", "wave2", "shake", "scroll", "slide"] as const;

export type ChatColor = (typeof CHAT_COLORS)[number];
export type ChatMotion = (typeof CHAT_MOTIONS)[number];

export interface ChatEffects {
  color: ChatColor;
  motion: ChatMotion | null;
}

/** Splits leading "red:wave:" style prefixes off a message. */
export function parseEffects(raw: string): { effects: ChatEffects; text: string } {
  let color: ChatColor = "yellow";
  let motion: ChatMotion | null = null;
  let text = raw;
  for (let i = 0; i < 2; i++) {
    const match = /^([a-z0-9]+):/i.exec(text);
    if (!match) break;
    const key = match[1]!.toLowerCase();
    if ((CHAT_COLORS as readonly string[]).includes(key)) {
      color = key as ChatColor;
    } else if ((CHAT_MOTIONS as readonly string[]).includes(key)) {
      motion = key as ChatMotion;
    } else {
      break;
    }
    text = text.slice(match[0].length);
  }
  return { effects: { color, motion }, text };
}

export function encodeEffects(effects: ChatEffects): string | null {
  const parts: string[] = [];
  if (effects.color !== "yellow") parts.push(effects.color);
  if (effects.motion) parts.push(effects.motion);
  return parts.length ? parts.join(":") : null;
}

export function decodeEffects(fx: string | null | undefined): ChatEffects {
  return parseEffects(`${fx ?? ""}${fx ? ":" : ""}`).effects;
}

// Words are matched one at a time after normalising leetspeak and squeezing
// repeated letters, the same blunt approach as the original filter. Strong
// terms are masked anywhere inside a word ("motherf..."); ambiguous stems only
// at the start or end of a word, so place names and trading talk
// ("Scunthorpe", "Matsushita", "assets", "cocktail", "grape") pass.
const ANYWHERE = ["fuck", "nigger", "nigga", "faggot", "whore", "bitch", "tranny", "retard"];
const AT_EDGES = ["cunt", "shit", "slut", "pussy", "chink"];
const WHOLE_WORD = ["fag", "kys", "dick", "rape", "spic", "kike"];

const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "i",
};

/** Leet-mapped letters only; `squeeze` collapses runs ("fuuuck" -> "fuck"). */
function normaliseWord(word: string, squeeze: boolean): string {
  let out = "";
  for (const ch of word.toLowerCase()) {
    const mapped = LEET[ch] ?? ch;
    if (!/[a-z]/.test(mapped)) continue;
    if (squeeze && out.endsWith(mapped)) continue;
    out += mapped;
  }
  return out;
}

/** Stems with doubled letters ("faggot", "pussy") must match unsqueezed, or "Niger" would match. */
function hasDouble(stem: string): boolean {
  return /(.)\1/.test(stem);
}

const WHOLE_WORD_SUFFIXES = ["", "s"];

function isBlocked(word: string): boolean {
  const raw = normaliseWord(word, false);
  const squeezed = normaliseWord(word, true);
  if (raw.length < 3) return false;
  const form = (stem: string) => (hasDouble(stem) ? raw : squeezed);
  if (ANYWHERE.some((stem) => form(stem).includes(stem))) return true;
  if (AT_EDGES.some((stem) => form(stem).startsWith(stem) || form(stem).endsWith(stem))) return true;
  return WHOLE_WORD.some((stem) => WHOLE_WORD_SUFFIXES.some((s) => form(stem) === stem + s));
}

// ---------------------------------------------------------------------------
// Matching works on a folded copy of the text with exactly one UTF-16 unit per
// code point, so a match at index i masks the i-th code point of the original.
// Folding maps look-alike letters (Cyrillic "о", Greek "ο", accented "ó") to
// ASCII, because a reader retypes "scаm.cоm" as "scam.com".

/** Pairs of [look-alike, ASCII letter]: Cyrillic, Greek and a few Latin variants. */
const CONFUSABLE_PAIRS =
  "аaвbеeёeкkмmнhоoрpсcтtуyхxѕsіiїiјjһhԁdԛqԝwӏlАaВbЕeЁeКkМmНhОoРpСcТtУyХxЅsІiЇiЈjҺhԚqԜwӀl" +
  "αaβbεeιiκkνvοoρpτtυuχxΑaΒbΕeΖzΗhΙiΚkΜmΝnΟoΡpΤtΥyΧxıiɑaɡgʟlᴅdᴏoꞮi" +
  // Ideographic and small full stops are read as dots.
  "。.﹒.";
const CONFUSABLES: ReadonlyMap<string, string> = (() => {
  const chars = [...CONFUSABLE_PAIRS];
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < chars.length; i += 2) map.set(chars[i]!, chars[i + 1]!);
  return map;
})();

function foldChar(ch: string): string {
  const mapped = CONFUSABLES.get(ch);
  if (mapped) return mapped;
  // Astral characters (emoji) become one placeholder unit; no rule matches it.
  if (ch.length > 1) return "�";
  const base = ch.normalize("NFD").charAt(0);
  return base <= "\u007f" ? base : ch;
}

/** One folded unit per code point of `chars`. */
function fold(chars: readonly string[]): string {
  return chars.map(foldChar).join("");
}

/** Masks the original code points wherever `maskedFolded` (same length as `chars`) gained an asterisk. */
function applyMask(chars: readonly string[], folded: string, maskedFolded: string): string {
  return chars.map((ch, i) => (maskedFolded[i] === "*" && folded[i] !== "*" ? "*" : ch)).join("");
}

function maskProfanityFolded(text: string): string {
  // Tokens are runs of letters, digits and leet symbols.
  const tokens: { start: number; end: number }[] = [];
  const re = /[A-Za-z0-9@$!|]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    tokens.push({ start: m.index, end: m.index + m[0].length });
  }
  const masked = [...text];
  const mask = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (masked[i] !== " ") masked[i] = "*";
  };
  for (const t of tokens) {
    if (isBlocked(text.slice(t.start, t.end))) mask(t.start, t.end);
  }
  // Spaced-out letters ("f u c k") are joined and checked as one word.
  for (let i = 0; i < tokens.length; ) {
    let j = i;
    while (j < tokens.length && tokens[j]!.end - tokens[j]!.start === 1 && (j === i || tokens[j]!.start - tokens[j - 1]!.end <= 2)) j++;
    if (j - i >= 3) {
      const joined = tokens.slice(i, j).map((t) => text.slice(t.start, t.end)).join("");
      if (isBlocked(joined)) mask(tokens[i]!.start, tokens[j - 1]!.end);
      i = j;
    } else {
      i++;
    }
  }
  return masked.join("");
}

/** Replaces blocked words with asterisks, one per character, seeing through look-alike letters. */
export function filterProfanity(text: string): string {
  const chars = [...text];
  const folded = fold(chars);
  return applyMask(chars, folded, maskProfanityFolded(folded));
}

// ---------------------------------------------------------------------------
// Contact details. Off-protocol trading is the main scam vector in a P2P room,
// so links, domains, emails, phone numbers, wallet addresses and payment or
// messenger handles are masked. Trades happen through the bank interface,
// which settles on-chain. The rules favour masking: trade talk such as
// "Selling 1,606 USDC @ 0.7705 GBP on Wise!" or "$100" still passes.

interface ContactRule {
  re: RegExp;
  /** Masks this capture group instead of the whole match (needs the `d` flag). */
  group?: number;
  /** Rejects a candidate match. */
  accept?: (match: RegExpExecArray) => boolean;
}

/** Words that often follow "@" or "$" in trade talk ("@ market rate"). */
const SIGIL_STOPWORDS = new Set(
  (
    "the this that these those my your our their his her its any all some same each every one best better good great " +
    "fair market rate rates price prices cost par peg spot mid around about least most once only low lower lowest high " +
    "higher highest current live home work bank booth noon night"
  ).split(" "),
);

/** Words after "<platform> me" or "<payment> tag" that are not a handle ("venmo me now", "my revtag is below"). */
const HANDLE_STOPWORDS = new Set(
  (
    "now please pls plz back later asap first then and the here there too also instead directly it that this money cash " +
    "usdc usd gbp eur when after before if for with via through again pay paid sent send " +
    "or not isnt are was a an of in from your yours mine what which same only fine ok okay wrong right correct " +
    "changed different below above required needed work works working button"
  ).split(" "),
);

const PAY_PLATFORMS =
  "venmo|cash\\s*app|zelle|paypal|revolut|wise|monzo|chime|n26|luxon|mercado\\s*pago|monobank|x\\s*money|apple\\s*pay|google\\s*pay";
const MESSENGERS =
  "telegram|tg|whatsapp|signal|discord|snapchat|snap|instagram|insta|ig|kik|wechat|skype|viber|email|e-mail|gmail";
/** Filler between a platform and the handle: "venmo me at", "zelle: ", "tg id". */
const HANDLE_FILLER = "(?:[\\s:=>#-]+(?:me|to|at|on|is|via|my|id|tag|handle|user|username|name|account|acc|number|no)\\b)*[\\s:=>#@$-]+";
/** A handle that cannot be an ordinary word: it has a digit, underscore, "#", or an inner dot or hyphen. */
const HANDLE_LIKE = "([a-z](?=[a-z0-9_.#-]*(?:[0-9_#]|[.-][a-z0-9]))[a-z0-9_.#-]{2,})";
/** Sign-offs written after "gg/" that are not a Discord invite ("gg/wp"). */
const GG_SIGNOFFS = new Set(["wp", "ez", "gl", "hf", "glhf", "ty", "no", "re", "go"]);
/** Names for a payment handle ("revtag", "Wise tag", "cashtag"): any word after one is a handle. */
const PAY_TAGS = "(?:rev(?:olut)?|wise|cash(?:\\s*app)?|pay|zelle|venmo|monzo|paypal)\\s*tags?";

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
/** "[.]", "(dot)", "{.}" and a dot with a space before it ("scam .com", "scam . com"). */
const OBFUSCATED_DOT = "(?:\\s*(?:\\[\\s*(?:\\.|dot)\\s*\\]|\\(\\s*(?:\\.|dot)\\s*\\)|\\{\\s*(?:\\.|dot)\\s*\\})\\s*|\\s+\\.\\s*)";
const SPELLED_TLDS = "com|net|org|io|xyz|me|gg|app|co|cash|eth|link|info|biz|ly|sh|to|tv|cc|ai|so|uk|us|ru";

/** Whitespace-separated tokens that are rates or amounts, not a phone number ("0.77 0.78 0.79", "10000.00"). */
function isNumericTalk(candidate: string): boolean {
  const tokens = candidate.trim().split(/\s+/);
  if (tokens.length === 1 && /^\d+\.\d+$/.test(tokens[0]!)) return tokens[0]!.length <= 10;
  return tokens.every((t) => /^(?:0|[1-9]\d?)\.\d{1,6}$/.test(t));
}

const CONTACT_RULES: readonly ContactRule[] = [
  // Wallet addresses and hashes, including spaced-out hex ("0x 5555 5555 ...").
  { re: /\b0x(?:[\s._-]*[a-f0-9]){6,}/gi },
  // Long letter-and-digit strings: addresses without 0x (BTC, Solana, Tron), keys, hashes.
  { re: /\b(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{26,}\b/gi },
  // Emails, including "name (at) host (dot) com".
  { re: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi },
  {
    re: /[a-z0-9._%+-]+\s*(?:\(\s*at\s*\)|\[\s*at\s*\]|\{\s*at\s*\})\s*[a-z0-9-]+(?:(?:\.|\s*(?:\(\s*dot\s*\)|\[\s*(?:dot|\.)\s*\]|\{\s*dot\s*\})\s*)[a-z0-9-]+)+/gi,
  },
  // Links: http(s), hxxp and www.
  { re: /\b(?:h[tx]{2}ps?|ftp)\s*:\s*\/\s*\/\S*/gi },
  { re: /\bwww\s*\.\s*\S+/gi },
  // Domains with any alphabetic TLD ("example.cash", "t.me/x"); decimals ("0.7705") have no letters after the dot.
  { re: new RegExp(`\\b${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,24}\\b\\S*`, "gi") },
  { re: new RegExp(`\\b${LABEL}(?:${OBFUSCATED_DOT}${LABEL})*${OBFUSCATED_DOT}[a-z]{2,24}\\b\\S*`, "gi") },
  { re: new RegExp(`\\b${LABEL}\\s*(?:\\s|[-_])dot(?:\\s|[-_])\\s*(?:${SPELLED_TLDS})\\b\\S*`, "gi") },
  // Phone numbers: 7+ digits with separators ("+1 (555) 010-0199", "07700 900123").
  { re: /\+?\(?\d(?:[\s().-]*\d){6,}\)?/g, accept: (m) => m[0].startsWith("+") || !isNumericTalk(m[0]) },
  // @handles and $cashtags. A cashtag starts with a letter, so "$100" survives; an @handle
  // must contain a letter or underscore, so "@0.7705" survives.
  { re: /(?<![a-z0-9_])@(?=[a-z0-9_.-]*[a-z_])[a-z0-9_.-]{3,}/gi },
  { re: /(?<![a-z0-9_])\$[a-z][a-z0-9_.-]{2,}/gi },
  // Spaced sigils ("$ alice", "@ alice"), but not "@ market rate".
  {
    re: /(?<![a-z0-9_])[@$]\s+([a-z_][a-z0-9_.-]{2,})/dgi,
    accept: (m) => !SIGIL_STOPWORDS.has(m[1]!.toLowerCase()),
  },
  // Payment and messenger handles named next to the platform ("venmo me bobsmith22", "tg: bob_1").
  { re: new RegExp(`\\b(?:${PAY_PLATFORMS}|${MESSENGERS})\\b${HANDLE_FILLER}${HANDLE_LIKE}`, "dgi"), group: 1 },
  {
    re: new RegExp(`\\b(?:${PAY_PLATFORMS})\\s*[:=-]?\\s*me\\s+(?:at\\s+|on\\s+|to\\s+)?([a-z][a-z0-9_.-]{2,})`, "dgi"),
    group: 1,
    accept: (m) => !HANDLE_STOPWORDS.has(m[1]!.toLowerCase()),
  },
  // The word after a payment tag ("my wisetag is bobsmith", "revtag zezima", "cashtag: bob").
  {
    re: new RegExp(`\\b${PAY_TAGS}\\b${HANDLE_FILLER}([a-z][a-z0-9_.-]{2,})`, "dgi"),
    group: 1,
    accept: (m) => !HANDLE_STOPWORDS.has(m[1]!.toLowerCase()),
  },
  // Discord tags ("bob#1234") and invites ("discord.gg/abc", "discord gg/abc", "gg/abc").
  { re: /\b[a-z][a-z0-9_.]{1,31}#\d{4}\b/gi },
  { re: /\bdiscord(?:app)?\s*(?:\.|\s)\s*(?:gg|com)\b(?:\s*\/\s*(?:invite\s*\/\s*)?[a-z0-9-]+)?/gi },
  { re: /\bgg\s*\/\s*([a-z0-9-]{2,})/dgi, accept: (m) => !GG_SIGNOFFS.has(m[1]!.toLowerCase()) },
  // Messenger invitations.
  { re: /\b(?:telegram|whatsapp)\S*/gi },
];

/** Masks contact details with one asterisk per character, seeing through look-alike letters. */
export function maskContactDetails(text: string): string {
  const chars = [...text];
  const folded = fold(chars);
  const masked = [...folded];
  for (const rule of CONTACT_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(folded); m; m = rule.re.exec(folded)) {
      if (m[0].length === 0) {
        rule.re.lastIndex += 1;
        continue;
      }
      if (rule.accept && !rule.accept(m)) continue;
      const [start, end] = rule.group !== undefined ? (m.indices?.[rule.group] ?? [m.index, m.index]) : [m.index, m.index + m[0].length];
      for (let i = start; i < end; i++) masked[i] = "*";
    }
  }
  return applyMask(chars, folded, masked.join(""));
}

export interface SanitisedChat {
  text: string;
  fx: string | null;
}

/**
 * Invisible and formatting characters: controls, zero-width spaces and joiners,
 * bidi overrides, BOMs, private use, unassigned and lone surrogates, and the
 * default-ignorable fillers (Hangul fillers, variation selectors). They split
 * words so the filters miss them while the text still reads normally.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
/** Glyphs that render as blank space. */
const BLANK = /[⠀]/gu;
/** Combining marks on ASCII ("s̸cam") are dropped; elsewhere stacks are capped (no Zalgo). */
const MARKS_ON_ASCII = /(?<=[\x21-\x7e])\p{M}+/gu;
const MARK_STACK = /(\p{M}{3})\p{M}+/gu;

/** Full server-side pipeline: normalise, strip invisibles, trim, cap, parse effects, filter. */
export function sanitiseChat(raw: string): SanitisedChat | null {
  const visible = raw
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(BLANK, " ")
    .replace(MARKS_ON_ASCII, "")
    .replace(MARK_STACK, "$1");
  const collapsed = visible.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const { effects, text } = parseEffects(collapsed);
  const body = [...text.trim()].slice(0, CHAT_MAX_LENGTH).join("");
  if (!body) return null;
  return {
    text: maskContactDetails(filterProfanity(body)),
    fx: encodeEffects(effects),
  };
}

// ---------------------------------------------------------------------------
// Display names.

/** Folded name keys start with these: staff, the bank and the protocol. */
const RESERVED_PREFIXES = ["mod", "jmod", "admin", "jagex", "peer", "system", "staff", "banker", "bank", "teller", "official"];
/** ...or contain these: support staff, the brands and the merchant NPCs ("Wise trader"). */
const RESERVED_PARTS = ["support", "admin", "moderator", "rampridge", "zkp", "galleon", "official", "trader", "banker"];
const RESERVED_EXACT = ["news"];
const NAME_LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" };

/** Lowercase letters with leet digits mapped, read once with 1/I as "i" and once as "l" ("Ga11eon"). */
function reservedKeys(name: string): string[] {
  const letters = [...name.toLowerCase()].map((ch) => NAME_LEET[ch] ?? ch).join("").replace(/[^a-z]/g, "");
  const asL = [...name.toLowerCase()]
    .map((ch) => (ch === "1" || ch === "i" ? "l" : (NAME_LEET[ch] ?? ch)))
    .join("")
    .replace(/[^a-z]/g, "");
  return [letters, asL];
}

/** True for names that impersonate staff, the bank, the protocol or a merchant NPC. */
export function isReservedName(name: string): boolean {
  return reservedKeys(name).some(
    (key) =>
      RESERVED_EXACT.includes(key) ||
      RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      RESERVED_PARTS.some((part) => key.includes(part)),
  );
}

/** Display names: 1-12 of letters, digits, space, hyphen, underscore; not offensive or reserved. */
export function normaliseName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > NAME_MAX_LENGTH) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) return null;
  if (filterProfanity(name) !== name) return null;
  if (isReservedName(name)) return null;
  return name;
}

/** Key used for uniqueness: case- and separator-insensitive, like the original. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[ _-]+/g, "_");
}
