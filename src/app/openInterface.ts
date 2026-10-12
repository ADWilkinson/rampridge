import { create } from "zustand";
import type { InterfaceId, OpenInterface } from "@/ui/interfaces/context";

/**
 * The one open interface (the original only ever shows one). Kept outside
 * React so engine events and network callbacks can open and close it
 * without stale closures.
 */

/**
 * Interfaces drawn in the chatbox (chat-head dialogues), like the original;
 * everything else is a centred window. Modules can add ids by exporting
 * `chatboxInterfaces`.
 */
const chatboxIds = new Set<InterfaceId>(["dialogue", "intro"]);

export function registerChatboxInterfaces(ids: Iterable<InterfaceId>): void {
  for (const id of ids) chatboxIds.add(id);
}

export function placementOf(id: InterfaceId): "chat" | "window" {
  return chatboxIds.has(id) ? "chat" : "window";
}

interface OpenState {
  current: OpenInterface | null;
  /** Increments on every open so a re-opened interface starts fresh. */
  key: number;
  set(target: OpenInterface | null): void;
}

export const useOpenInterface = create<OpenState>()((set, get) => ({
  current: null,
  key: 0,
  set(target) {
    set(target ? { current: target, key: get().key + 1 } : { current: null });
  },
}));
