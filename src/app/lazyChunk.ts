import { cacheBusted, failedModuleUrl } from "./interfaceLoader";
import { noteChunkFailure } from "./update";

/**
 * A code-split module the shell loads on demand: imported once and shared by
 * every caller. A failed download rejects with `message` (plain English, for
 * the player) and is retried on the next call. Browsers remember a failed
 * module URL for the life of the page, so the retry imports the chunk's URL
 * with a cache-busting query when the error named it (`chunk` matches the
 * chunk's file name); otherwise `load` runs again.
 */
export function lazyChunk<T>(load: () => Promise<T>, options: { chunk: RegExp; message: string; label: string }): () => Promise<T> {
  let pending: Promise<T> | null = null;
  let failedUrl: string | null = null;
  return () => {
    const busted = failedUrl;
    pending ??= (busted ? (import(/* @vite-ignore */ cacheBusted(busted, Date.now())) as Promise<T>) : load()).then(
      (mod) => {
        failedUrl = null;
        return mod;
      },
      (err: unknown) => {
        pending = null;
        const url = failedModuleUrl(err);
        // Keep the first failed URL: a failed retry names the busted one, and busting that again would stack queries.
        if (!failedUrl && url && options.chunk.test(url.split("?")[0] ?? url)) failedUrl = url;
        console.warn(`[${options.label}] did not load`, err);
        void noteChunkFailure();
        throw new Error(options.message, { cause: err });
      },
    );
    return pending;
  };
}
