import type { Appearance, EmoteId, PlayerRecord, StallSummary, Tile } from "@shared/protocol";

/**
 * Engine contract between the three.js world (src/game) and the React shell
 * (src/app, src/ui). The engine never imports React or network code; the
 * shell feeds it world state and reacts to its events.
 */

/** Colour classes from the original menus: NPC yellow, object cyan, player white, item orange. */
export type TargetKind = "npc" | "object" | "player" | "item" | "tile";

/** A merchant NPC standing in for live Peer liquidity. */
export interface MerchantSpec {
  /** Stable id, e.g. "revolut:GBP". */
  id: string;
  name: string;
  platform: string;
  currency: string;
  /** Text shouted every few seconds (may carry chat effect prefixes). */
  shout: string;
  /** Seed for a deterministic appearance. */
  seed: string;
}

export type TargetRef =
  | { kind: "banker"; npcIndex: number }
  | { kind: "booth"; boothIndex: number }
  | { kind: "merchant"; merchantId: string }
  | { kind: "player"; pid: string }
  | { kind: "tile"; tile: Tile };

/** Interaction verbs the shell understands. */
export type InteractVerb =
  | "talk"
  | "bank"
  | "exchange"
  | "collect"
  | "trade"
  | "trade-stall"
  | "follow"
  | "examine"
  | "walk";

export interface MenuOption {
  /** e.g. "Bank" */
  verb: string;
  /** e.g. "Banker" — rendered in the colour of `kind`. */
  targetName: string;
  kind: TargetKind;
  /** Optional suffix like "(level-3)" or stall info. */
  suffix?: string;
  interact: InteractVerb;
  target: TargetRef;
}

export interface EngineEvents {
  /** Loading progress 0..1 for the loading screen. */
  progress: { fraction: number; label: string };
  ready: void;
  /** Top-left mouseover text; null clears it. */
  hover: { first: MenuOption; more: number } | null;
  /** Right-click / long-press menu at viewport coordinates. */
  menu: { x: number; y: number; options: MenuOption[] };
  /** Fired when the local player has walked to the target and the action should happen. */
  interact: { verb: InteractVerb; target: TargetRef };
  /** The local player chose a new path; the shell posts it to the server. */
  move: { path: Tile[]; run: boolean };
  /** Any click into the world (the shell closes open interfaces, like the original). */
  worldClick: void;
  /** Examine text for the chatbox. */
  examine: { text: string };
}

export type EngineEventName = keyof EngineEvents;

export interface LocalPlayerInit {
  pid: string;
  name: string;
  appearance: Appearance;
  /** Where the player stands (from the server record, or spawn). */
  tile: Tile;
}

export interface RemotePlayerView {
  pid: string;
  record: PlayerRecord;
}

/**
 * What a celebration marks: a settled trade (a buy, or a seller's order
 * filled) or a new sell order going live, a stall. Both get the fireworks;
 * the merchants nearby say a line that fits.
 */
export type CelebrationKind = "trade" | "listing";

export interface EngineApi {
  /** Loads world and actor assets, reporting progress. */
  load(): Promise<void>;
  /** Attaches the canvas to `container` and starts rendering. */
  mount(container: HTMLElement): void;
  unmount(): void;
  on<K extends EngineEventName>(event: K, fn: (payload: EngineEvents[K]) => void): () => void;

  /** Title-screen mode: slow orbit, no local player, no input. */
  setTitleMode(enabled: boolean): void;

  setLocalPlayer(init: LocalPlayerInit): void;
  setLocalAppearance(appearance: Appearance): void;
  /** Full replace of remote players; the engine diffs internally. `serverNow` is ms. */
  syncPlayers(players: RemotePlayerView[], serverNow: number): void;
  /** Server clock (ms) used to replay paths deterministically. */
  setClock(serverNow: () => number): void;
  setMerchants(merchants: MerchantSpec[]): void;
  /** Stall summaries of players, used for menus and overhead tags. */
  setStalls(stalls: Record<string, StallSummary | null>): void;

  /** Overhead public chat for a player (pid) or merchant (merchantId). */
  showChat(actor: { pid: string } | { merchantId: string }, text: string, fx?: string | null): void;
  playEmote(pid: string, emote: EmoteId): void;
  /**
   * Level-up style fireworks on a player, and a line from the merchants
   * nearest them that fits `kind` (default "trade": "gz!" or "Nice trade!";
   * "listing": "New stall!" or "gl with the sale!").
   */
  celebrate(pid: string, kind?: CelebrationKind): void;

  setRunning(running: boolean): void;
  walkTo(tile: Tile): void;
  /** Perform a menu option chosen in the React context menu. */
  choose(option: MenuOption): void;
  /** Minimap: the engine draws into this canvas every frame. */
  attachMinimap(canvas: HTMLCanvasElement): void;
  resetCameraNorth(): void;
  /** Mute/unmute world sound effects. */
  setSoundEnabled(enabled: boolean): void;
  /**
   * The player's reduced-motion setting. The engine reduces motion (still
   * overhead text, no fireworks, no title orbit) when this or the system's
   * prefers-reduced-motion is on, and follows later changes to either.
   */
  setReducedMotion(enabled: boolean): void;
  /** Disable world input while a modal blocks (e.g. title screen dialogs). */
  setInputEnabled(enabled: boolean): void;
}
