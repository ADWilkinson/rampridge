/** GET /api/cron/prune, called by Vercel Cron with `Authorization: Bearer ${CRON_SECRET}`. */

import type { ApiDeps } from "../deps.js";
import { bearerToken, json, safeEqual, unauthorized, withErrors } from "../http.js";
import { pruneWorld } from "../prune.js";

export function createPruneHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return withErrors(deps.now, async (request) => {
    const expected = deps.cronSecret();
    const provided = bearerToken(request);
    if (!provided || !safeEqual(provided, expected)) throw unauthorized("Not authorised.");
    const now = deps.now();
    const report = await pruneWorld(deps.db(), now);
    return json({ ok: true, report, now });
  });
}
