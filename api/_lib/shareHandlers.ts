/**
 * GET /api/share (behind /t/{id}) and GET /api/og: a shared trade's link
 * preview page and its card. Both read `shares/{id}` and fall back to the
 * site's own page and card for an unknown id or a database failure, so a
 * shared link always unfurls and always lands in the game.
 */

import { SITE_ORIGIN, isShareId, shareUrl } from "../../shared/share.js";
import type { ShareRecord } from "../../shared/share.js";
import type { ApiDeps } from "./deps.js";
import { json } from "./http.js";
import { loadShare } from "./share.js";
import { CARD_FILES, loadCardAssets, readPublicFile, renderShareCard } from "./shareCard.js";
import { SITE_META, isPreviewBot, renderSharePage, tradeMeta } from "./sharePage.js";

/** Records never change once written, so a found record's page data and card can be cached for good. */
const IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";
/** An id with no record yet (or a failed read) may resolve later: cache only briefly. */
const BRIEF = "public, max-age=60, s-maxage=60";

type Lookup = { id: string; record: ShareRecord } | { id: string | null; record: null; failed: boolean };

async function lookup(deps: ApiDeps, request: Request): Promise<Lookup> {
  const id = new URL(request.url).searchParams.get("id");
  if (!isShareId(id)) return { id: null, record: null, failed: false };
  try {
    const record = await loadShare(deps.db(), id);
    return record ? { id, record } : { id, record: null, failed: false };
  } catch (err) {
    console.error("Share lookup failed:", err instanceof Error ? err.message : String(err));
    return { id, record: null, failed: true };
  }
}

export function createSharePageHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const found = await lookup(deps, request);

    // ?format=json: whether a trade's record exists yet (the in-game Share button asks before using its link).
    if (url.searchParams.get("format") === "json") {
      if (!found.record) {
        return json({ ok: false, error: "No trade with that id.", code: "not_found", now: deps.now() }, found.failed ? 502 : 404);
      }
      // Existence only: the record's transaction stays off the public API.
      return json({ ok: true, id: found.id, url: shareUrl(found.id), now: deps.now() }, 200, {
        "Cache-Control": "public, max-age=60, s-maxage=31536000",
      });
    }

    const meta = found.record ? tradeMeta(found.id, found.record) : SITE_META;
    const html = renderSharePage(meta, {
      metaRefresh: !isPreviewBot(request.headers.get("user-agent")),
      noindex: found.record !== null,
      world: found.record?.world ?? null,
    });
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // The page differs for crawlers and people (the meta refresh), so it is never cached by the CDN.
        "Cache-Control": "public, max-age=300",
        Vary: "User-Agent",
      },
    });
  };
}

function png(bytes: Uint8Array, cacheControl: string): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": cacheControl, "Content-Length": String(bytes.byteLength) },
  });
}

export function createShareImageHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = requestOrigin(request);
    const found = await lookup(deps, request);
    if (found.record) {
      try {
        const assets = await loadCardAssets(origin);
        return png(await renderShareCard(found.record, assets), IMMUTABLE);
      } catch (err) {
        console.error("Share card render failed:", err instanceof Error ? err.message : String(err));
      }
    }
    // Unknown id, failed read or failed render: the site's own card.
    try {
      return png(await readPublicFile(CARD_FILES.fallback, origin), BRIEF);
    } catch {
      return Response.redirect(`${SITE_ORIGIN}/${CARD_FILES.fallback}`, 302);
    }
  };
}

/** Where public files are fetched from when the function has no copy: this deployment, else production. */
function requestOrigin(request: Request): string {
  try {
    return new URL(request.url).origin;
  } catch {
    return SITE_ORIGIN;
  }
}
