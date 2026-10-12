import type { ReactNode } from "react";
import { lazyChunk } from "./lazyChunk";
import { loadWorldClient } from "./session";
import { preloadPublicClient } from "./wallet";
import type { WorldProps } from "./World";

/**
 * The code entering the world needs beyond the title: the realtime client
 * (./session) and the world screen. Neither is in the title's download; they
 * are the first thing fetched once the title is up, ahead of everything else
 * the shell loads in the background, so pressing Play now rarely waits.
 */

export type WorldView = (props: WorldProps) => ReactNode;

/** The world screen (game frame, side panel, inventory and its balance reads) as its own chunk. */
export const loadWorldScreen = lazyChunk(() => import("./World").then((m): WorldView => m.World), {
  chunk: /\/World-[^/]*\.js$/,
  message: "The game didn't finish loading. Check your connection and try again.",
  label: "world screen",
});

let entryCode: Promise<void> | null = null;

/** Downloads the entry code once; resolves when it has loaded or failed (entering retries a failure). */
export function prefetchEntryCode(): Promise<void> {
  entryCode ??= Promise.allSettled([loadWorldClient(), loadWorldScreen().then(preloadPublicClient)]).then(() => undefined);
  return entryCode;
}
