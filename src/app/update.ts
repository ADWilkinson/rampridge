import { createStore } from "zustand/vanilla";
import { onOutdated } from "@/net/http";

/**
 * Notices a new release while the page is open. Code-split parts of the app
 * (the Privy login and signing screens, the trading interfaces) download on
 * first use; once a newer build is live, a chunk this page names can be gone
 * from the server. When a chunk fails, the page asks the server which build
 * it is serving now: if that differs from the build this page runs, a reload
 * is the only fix and the shell says so. A failure with the same build live
 * is a connection problem, left to the loaders' own retries. The API can
 * also say this build is too old for it (an "outdated" answer), which needs
 * the same reload.
 */

export const updateStore = createStore<{ updated: boolean }>(() => ({ updated: false }));

/** The entry script a built index.html loads ("/assets/index-abc123.js"), or null (dev server, or no build). */
export function entryFromHtml(html: string): string | null {
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const attrs = tag[0];
    if (!/\btype\s*=\s*["']?module["']?/i.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (src && /\/assets\/[^/]+\.js$/.test(src)) return src;
  }
  return null;
}

/** The entry script this page was built with, read from its own markup. */
export function runningEntry(doc: Pick<Document, "querySelectorAll">): string | null {
  for (const script of doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const src = script.getAttribute("src");
    if (src && /\/assets\/[^/]+\.js$/.test(src)) return src;
  }
  return null;
}

/**
 * True when the server now serves a different build from the one running
 * here. Any failure to tell (offline, an error page) reads as no update.
 */
export async function isNewBuildLive(
  running: string | null,
  fetchHtml: () => Promise<string> = async () => {
    const res = await fetch("/", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error(`index.html answered ${res.status}`);
    return res.text();
  },
): Promise<boolean> {
  if (!running) return false;
  try {
    const live = entryFromHtml(await fetchHtml());
    return live !== null && live !== running;
  } catch {
    return false;
  }
}

let checking: Promise<void> | null = null;

/** Called when a code chunk fails to load: checks (once at a time) whether a new build is the reason. */
export function noteChunkFailure(): Promise<void> {
  if (updateStore.getState().updated) return Promise.resolve();
  checking ??= isNewBuildLive(runningEntry(document))
    .then((updated) => {
      if (updated) updateStore.setState({ updated: true });
    })
    .finally(() => {
      checking = null;
    });
  return checking;
}

/** The server refused a request as coming from an older build: only a reload helps. */
export function noteServerOutdated(): void {
  if (!updateStore.getState().updated) updateStore.setState({ updated: true });
}

/**
 * Vite reports every failed lazy chunk (ours and Privy's) as
 * `vite:preloadError` on window; the API's "outdated" answers come through
 * the fetch helper.
 */
export function watchForUpdates(target: Pick<Window, "addEventListener"> = window): () => void {
  target.addEventListener("vite:preloadError", () => void noteChunkFailure());
  return onOutdated(noteServerOutdated);
}
