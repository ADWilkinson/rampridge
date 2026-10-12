/**
 * The tiny HTML page behind a trade link (/t/{id} -> /api/share?id={id}):
 * the trade's Open Graph and Twitter tags for link previews, then straight
 * into the game. People get a meta refresh and a script redirect; preview
 * crawlers get no meta refresh (some follow it and would show the site's
 * card instead of the trade's) and do not run the script.
 */

import {
  arrivalPath,
  SITE_DESCRIPTION,
  SITE_IMAGE,
  SITE_IMAGE_ALT,
  SITE_NAME,
  SITE_TITLE,
  SITE_URL,
  escapeHtml,
  shareDescription,
  shareImageAlt,
  shareImageUrl,
  shareTitle,
  shareUrl,
} from "../../shared/share.js";
import type { ShareRecord } from "../../shared/share.js";

export interface PageMeta {
  title: string;
  description: string;
  url: string;
  image: string;
  imageAlt: string;
}

export const IMAGE_WIDTH = 1200;
export const IMAGE_HEIGHT = 630;

export const SITE_META: PageMeta = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  image: SITE_IMAGE,
  imageAlt: SITE_IMAGE_ALT,
};

export function tradeMeta(id: string, record: ShareRecord): PageMeta {
  return {
    title: shareTitle(record),
    description: shareDescription(record),
    url: shareUrl(id),
    image: shareImageUrl(id),
    imageAlt: shareImageAlt(record),
  };
}

/** Link-preview fetchers (X, Meta, Apple, Slack, Discord, Telegram and the like) and search crawlers. */
const PREVIEW_BOT =
  /bot\b|bot\/|crawler|spider|facebookexternalhit|facebot|whatsapp|telegram|slack|discord|embedly|iframely|skypeuripreview|vkshare|pinterest|redditbot|mastodon|bluesky|cardyb|snapchat|viber|linkedin|preview/i;

export function isPreviewBot(userAgent: string | null): boolean {
  return userAgent !== null && PREVIEW_BOT.test(userAgent);
}

export function renderSharePage(
  meta: PageMeta,
  options: { metaRefresh: boolean; noindex: boolean; world?: number | null },
): string {
  const e = escapeHtml;
  // A trade link asks for the world the trade was announced in (honoured when it has room).
  const destination = arrivalPath(options.world);
  const arrival = e(destination);
  const tags = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${e(meta.title)}</title>`,
    `<meta name="description" content="${e(meta.description)}">`,
    options.noindex ? `<meta name="robots" content="noindex, follow">` : null,
    `<link rel="canonical" href="${e(meta.url)}">`,
    `<meta name="theme-color" content="#000000">`,
    `<link rel="icon" type="image/png" sizes="32x32" href="/game/ui/favicon.png">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="/game/ui/apple-touch-icon.png">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${e(SITE_NAME)}">`,
    `<meta property="og:title" content="${e(meta.title)}">`,
    `<meta property="og:description" content="${e(meta.description)}">`,
    `<meta property="og:url" content="${e(meta.url)}">`,
    `<meta property="og:image" content="${e(meta.image)}">`,
    `<meta property="og:image:width" content="${IMAGE_WIDTH}">`,
    `<meta property="og:image:height" content="${IMAGE_HEIGHT}">`,
    `<meta property="og:image:type" content="image/png">`,
    `<meta property="og:image:alt" content="${e(meta.imageAlt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(meta.title)}">`,
    `<meta name="twitter:description" content="${e(meta.description)}">`,
    `<meta name="twitter:image" content="${e(meta.image)}">`,
    `<meta name="twitter:image:alt" content="${e(meta.imageAlt)}">`,
    options.metaRefresh ? `<meta http-equiv="refresh" content="0; url=${arrival}">` : null,
    // The destination is a constant path plus at most a validated world number; nothing else from the record reaches the script.
    `<script>location.replace(${JSON.stringify(destination)});</script>`,
    `<style>html,body{margin:0;height:100%;background:#000}body{display:flex;align-items:center;justify-content:center;font:bold 16px/1.4 ui-monospace,monospace}a{color:#ff981f}</style>`,
  ].filter((tag): tag is string => tag !== null);
  return `<!doctype html>
<html lang="en">
<head>
${tags.join("\n")}
</head>
<body>
<a href="${arrival}">Enter the Bank of RampRidge</a>
</body>
</html>
`;
}
