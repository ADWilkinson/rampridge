import type { ComponentType } from "react";
import type { InterfaceId, InterfaceModule, InterfaceProps } from "@/ui/interfaces/context";

/**
 * Loads the interface modules (each its own chunk) and assembles the
 * registry from whichever have loaded. A module whose chunk fails (a dropped
 * connection, or a deploy landing between index.html and the chunk) is
 * recorded and retried on the next load() instead of staying missing for the
 * whole session.
 *
 * Browsers remember a failed module URL for the rest of the page's life
 * (Chrome 155 answers a repeat import() of it with the same error without
 * fetching), so when the error names the chunk the retry imports that URL
 * with a cache-busting query. Without a URL (Safari's message has none) the
 * module's own loader is called again.
 */

export type AnyInterface = ComponentType<InterfaceProps<InterfaceId>>;

/**
 * Optional module exports the shell understands besides `interfaces`:
 * - `chatboxInterfaces`: ids drawn in the chatbox rather than as windows;
 * - hooks named in the loader's `hookNames`, mounted once while the player is
 *   in the world (e.g. the buy flow's "Your offer has been placed.").
 */
export type LoadedModule = InterfaceModule & { chatboxInterfaces?: readonly InterfaceId[] } & Record<string, unknown>;

export interface WorldHook {
  name: string;
  use: () => void;
}

export interface RegistrySnapshot {
  components: Partial<Record<InterfaceId, AnyInterface>>;
  worldHooks: WorldHook[];
  chatboxIds: InterfaceId[];
  /** Module paths whose chunk failed on the last attempt. */
  failed: string[];
  /** Most attempts any still-failing module has had (0 when none is failing). */
  attempts: number;
  /** Every module has been tried at least once (each has loaded, or failed on its last attempt). */
  complete: boolean;
}

export interface InterfaceLoader {
  /**
   * Loads the given module paths (every module when omitted) that are not
   * loaded yet, retrying earlier failures among them. Concurrent calls share
   * each module's attempt. Unknown paths are ignored.
   */
  load(paths?: readonly string[]): Promise<RegistrySnapshot>;
  /** The module paths this loader knows, in registration order. */
  readonly paths: readonly string[];
}

/** The chunk URL a failed dynamic import names (Chrome and Firefox), or null. */
export function failedModuleUrl(err: unknown): string | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const match = /dynamically imported module:?\s+(\S+)/i.exec(message);
  return match?.[1]?.replace(/[.,;)]+$/, "") ?? null;
}

/** `url` with a query the browser has never seen, so a failed import is fetched again. */
export function cacheBusted(url: string, now: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}retry=${now}`;
}

/** Native import of a URL, outside Vite's static analysis. */
const importUrl = (url: string): Promise<LoadedModule> => import(/* @vite-ignore */ url) as Promise<LoadedModule>;

export interface LoaderOptions {
  log?: Pick<Console, "error" | "warn">;
  /** Imports a module by URL (tests replace it). */
  importUrl?: (url: string) => Promise<LoadedModule>;
  now?: () => number;
}

export function createInterfaceLoader(
  modules: Record<string, () => Promise<LoadedModule>>,
  hookNames: readonly string[],
  options: LoaderOptions = {},
): InterfaceLoader {
  const { log = console, importUrl: importByUrl = importUrl, now = Date.now } = options;
  // Glob order is the registration order, so "first module wins" stays stable across retries.
  const paths = Object.keys(modules).sort();
  const loaded = new Map<string, LoadedModule>();
  /** Each module's attempt in progress, shared by concurrent loads. */
  const inflight = new Map<string, Promise<void>>();
  const warned = new Set<string>();
  /** Failed modules: how many attempts so far and the chunk URL the error named. */
  const failures = new Map<string, { attempts: number; url: string | null }>();

  const snapshot = (): RegistrySnapshot => {
    const components: Partial<Record<InterfaceId, AnyInterface>> = {};
    const worldHooks: WorldHook[] = [];
    const chatboxIds: InterfaceId[] = [];
    for (const path of paths) {
      const mod = loaded.get(path);
      if (!mod) continue;
      if (Array.isArray(mod.chatboxInterfaces)) chatboxIds.push(...mod.chatboxInterfaces);
      for (const name of hookNames) {
        const hook = mod[name];
        if (typeof hook === "function" && !worldHooks.some((h) => h.name === name)) worldHooks.push({ name, use: hook as () => void });
      }
      for (const [id, component] of Object.entries(mod.interfaces ?? {}) as [InterfaceId, unknown][]) {
        if (!component) continue;
        if (components[id]) {
          if (!warned.has(id)) log.warn(`[interfaces] "${id}" is registered twice; keeping the first (${path} ignored)`);
          warned.add(id);
          continue;
        }
        // Safe by construction: each module registers a component under the id it renders.
        components[id] = component as AnyInterface;
      }
    }
    const failed = paths.filter((path) => failures.has(path));
    const attempts = Math.max(0, ...failed.map((path) => failures.get(path)?.attempts ?? 0));
    const complete = paths.every((path) => loaded.has(path) || failures.has(path));
    return { components, worldHooks, chatboxIds, failed, attempts, complete };
  };

  const loadModule = (path: string): Promise<LoadedModule> => {
    const url = failures.get(path)?.url;
    if (url) return importByUrl(cacheBusted(url, now()));
    const load = modules[path];
    return load ? load() : Promise.reject(new Error(`no loader for ${path}`));
  };

  const attempt = (path: string): Promise<void> => {
    const running = inflight.get(path);
    if (running) return running;
    const run = loadModule(path).then(
      (mod) => {
        loaded.set(path, mod);
        failures.delete(path);
      },
      (err: unknown) => {
        const previous = failures.get(path);
        // The first URL is kept: later errors name the cache-busted one.
        failures.set(path, { attempts: (previous?.attempts ?? 0) + 1, url: previous?.url ?? failedModuleUrl(err) });
        log.error(`[interfaces] ${path} failed to load`, err);
      },
    );
    const settled = run.finally(() => inflight.delete(path));
    inflight.set(path, settled);
    return settled;
  };

  return {
    paths,
    async load(only) {
      const wanted = only ? paths.filter((path) => only.includes(path)) : paths;
      await Promise.all(wanted.filter((path) => !loaded.has(path)).map(attempt));
      return snapshot();
    },
  };
}