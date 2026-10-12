import type { WorldRequest } from "@shared/protocol";
import { FROM_PARAM, FROM_SHARE } from "@shared/share";
import { parseWorldId, WORLD_PARAM } from "@shared/worlds";

/**
 * How a visit arrived: through a shared trade link (/t/{id} sends people to
 * /?from=share, plus &world=302 for the world the trade was announced in), or
 * with ?world=302 asking for a world. Both are read once when the shell loads
 * and taken out of the address bar, so a reload or a copied address doesn't
 * carry them; the first welcome in the chatbox then says how they got here
 * and which world they are on.
 */

export const WELCOME = "Welcome to RampRidge.";
export const SHARE_WELCOME = "You followed a trade to the Bank of RampRidge.";
/** Posted with every welcome (entering, and after a hop, which starts the chatbox afresh). */
export const SAFETY_LINE = "Trades only settle through the bank. Never send money to a player directly.";

export interface Arrival {
  fromShare: boolean;
  /** The world asked for (?world=302), or null. */
  world: number | null;
  /** The query string without the markers ("" when nothing is left). */
  search: string;
}

/** Reads the share marker and the world request from `search`, and the query string without them. */
export function parseArrival(search: string): Arrival {
  const params = new URLSearchParams(search);
  const fromShare = params.get(FROM_PARAM) === FROM_SHARE;
  if (fromShare) params.delete(FROM_PARAM);
  const world = parseWorldId(params.get(WORLD_PARAM));
  if (params.has(WORLD_PARAM)) params.delete(WORLD_PARAM);
  const rest = params.toString();
  return { fromShare, world, search: rest ? `?${rest}` : "" };
}

function readArrival(): Arrival {
  const none: Arrival = { fromShare: false, world: null, search: "" };
  if (typeof window === "undefined") return none;
  try {
    const arrival = parseArrival(window.location.search);
    if (arrival.search !== window.location.search) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${arrival.search}${window.location.hash}`);
    }
    return arrival;
  } catch {
    return none;
  }
}

const arrival = readArrival();
let pending = arrival.fromShare;
let worldRequest: number | null = arrival.world;

/** True when this visit came from a shared trade. */
export function arrivedFromShare(): boolean {
  return pending;
}

/** The world the first entry of this visit asks for: the link's world once, then "auto" (the server picks). */
export function takeWorldRequest(): WorldRequest {
  const world = worldRequest;
  worldRequest = null;
  return world ?? "auto";
}

/** The first welcome line: the share welcome once for a shared-trade arrival, the usual one after that. */
export function takeWelcome(): string {
  if (!pending) return WELCOME;
  pending = false;
  return SHARE_WELCOME;
}

/**
 * The chatbox line naming the player's world: "Welcome to RampRidge. You are
 * on World 302." When a link asked for another world that had no room (full,
 * or no longer open), it says so: "Welcome to RampRidge. World 302 has no
 * room, so you are on World 303."
 */
export function worldWelcome(welcome: string, world: number, requested: WorldRequest = "auto"): string {
  if (typeof requested === "number" && requested !== world) return `${welcome} World ${requested} has no room, so you are on World ${world}.`;
  return `${welcome} You are on World ${world}.`;
}

/** After a welcome that moved the player off the world a link asked for: where to try it again. */
export const WORLD_SWITCHER_HINT = "Use the World Switcher in the Logout tab to try it again.";
