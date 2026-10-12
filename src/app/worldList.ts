import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldListEntry } from "@shared/worlds";
import { fetchWorlds } from "@/net/worlds";

/** How often an open World Switcher asks for fresh counts (the server recounts about every 30 s). */
export const WORLD_LIST_REFRESH_MS = 10_000;

/** One row of the switcher: a listed world, or the player's own world after it was closed (no count). */
export interface WorldRow {
  id: number;
  players: number | null;
  full: boolean;
  /** Not open to arrivals (only shown for the player's own world). */
  closed: boolean;
}

/**
 * The switcher's rows in world order. The player's world is always listed:
 * when the operator closed it while they were inside, it comes first without
 * a count.
 */
export function worldRows(worlds: readonly WorldListEntry[], current: number | null): WorldRow[] {
  const rows: WorldRow[] = worlds.map((w) => ({ id: w.id, players: w.players, full: w.full, closed: false })).sort((a, b) => a.id - b.id);
  if (current !== null && !rows.some((r) => r.id === current)) rows.unshift({ id: current, players: null, full: false, closed: true });
  return rows;
}

/**
 * The list as it reads once a hop from `from` to `to` has landed, until the
 * server's next count arrives: one more player in `to` (full at `cap`), one
 * fewer in `from`.
 */
export function afterHop(worlds: readonly WorldListEntry[], from: number | null, to: number, cap: number): WorldListEntry[] {
  return worlds.map((w) => {
    if (w.id === to) return { ...w, players: w.players + 1, full: w.full || w.players + 1 >= cap };
    if (w.id === from) return { ...w, players: Math.max(0, w.players - 1), full: w.players - 1 >= cap };
    return w;
  });
}

/** The list once a hop to `id` was refused as full or closed: that world shows FULL until the next count. */
export function markFull(worlds: readonly WorldListEntry[], id: number): WorldListEntry[] {
  return worlds.map((w) => (w.id === id ? { ...w, full: true } : w));
}

export interface WorldList {
  rows: WorldRow[] | null;
  error: string | null;
  /** Asks for the list again now; `fresh` skips the edge's cached copy once (after a hop). */
  refresh: (fresh?: boolean) => void;
  /** Shows a hop that just landed at once, before the server's count of it comes back. */
  noteHop: (from: number | null, to: number) => void;
  /** Shows a world that just refused a hop as full. */
  noteFull: (id: number) => void;
}

/** Polls the world list while `active` (the switcher is on screen); idle otherwise. */
export function useWorldList(active: boolean, current: number | null): WorldList {
  const [worlds, setWorlds] = useState<WorldListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loaded = useRef(false);
  const cap = useRef<number | null>(null);
  const fresh = useRef<number | undefined>(undefined);
  const refresh = useCallback((skipEdge = false) => {
    if (skipEdge) fresh.current = Date.now();
    setTick((n) => n + 1);
  }, []);
  const noteHop = useCallback((from: number | null, to: number) => {
    setWorlds((list) => (list && cap.current !== null ? afterHop(list, from, to, cap.current) : list));
  }, []);
  const noteFull = useCallback((id: number) => setWorlds((list) => (list ? markFull(list, id) : list)), []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const load = () => {
      const skipEdge = fresh.current;
      fresh.current = undefined;
      fetchWorlds(controller.signal, skipEdge).then(
        (body) => {
          loaded.current = true;
          cap.current = body.cap;
          setWorlds(body.worlds);
          setError(null);
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          // Keep showing the last list; say so only when there is none.
          if (!loaded.current) setError("The world list didn't load. Try again in a moment.");
          console.warn("[worlds]", err instanceof Error ? err.message : err);
        },
      );
    };
    load();
    const timer = window.setInterval(load, WORLD_LIST_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [active, tick]);

  return { rows: worlds ? worldRows(worlds, current) : null, error, refresh, noteHop, noteFull };
}
