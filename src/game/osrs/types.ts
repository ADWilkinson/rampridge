import type { Object3D } from "three";
import type { Appearance, EmoteId } from "@shared/protocol";

/**
 * Character runtime contract. Implemented by src/game/osrs (OSRS model
 * decoding, identity-kit merging, recolouring, lighting and frame
 * animation); consumed by the engine. World units: 1 unit = 1 tile, y up.
 */

/** Locomotion the engine asks for every frame; the runtime picks sequences. */
export type Locomotion = "idle" | "walk" | "run" | "turn";

export interface CharacterHandle {
  /** Root object to add to the scene. Origin at the tile centre on the floor. */
  readonly object: Object3D;
  /** Model height in tiles, for overhead text placement. */
  readonly height: number;
  setLocomotion(mode: Locomotion): void;
  /**
   * Signed angle in radians (rotation.y sense) from the facing direction to
   * the movement direction. While walking or running, the runtime then picks
   * walk-back/left/right like the client does for an actor moving while
   * facing elsewhere. Optional; 0 (forward) when never called.
   */
  setHeadingOffset?(radians: number): void;
  /** Plays a one-shot emote, then returns to locomotion. */
  playEmote(emote: EmoteId): void;
  /** Plays an arbitrary cache sequence once (e.g. a banker gesture). */
  playSequence(seqId: number): void;
  /** Advance animation by `dt` seconds. */
  update(dt: number): void;
  /** Rebuild the model for a new appearance (players only). */
  setAppearance(appearance: Appearance): void;
  dispose(): void;
}

export interface DesignerOption {
  /** Index stored in Appearance.kits[slot] or Appearance.colors[channel]. */
  index: number;
  /** Swatch colour for colour channels (CSS hex), undefined for kits. */
  swatch?: string;
}

export interface DesignerCatalog {
  /** Kit options per body type and slot (hair, jaw, torso, arms, hands, legs, feet). */
  kits: Record<0 | 1, DesignerOption[][]>;
  /** Colour options per channel (hair, torso, legs, feet, skin). */
  colors: DesignerOption[][];
  /**
   * The client's default kits per body type: the look a new character starts
   * with and the one the 2007 designer resets every slot to when the body
   * type changes (body B gets the clean-shaven chin, never a beard). Optional
   * so other catalogs stay compatible; the OSRS factory always provides it.
   */
  defaults?: Record<0 | 1, Appearance["kits"]>;
}

export interface CharacterFactory {
  /** Loads the baked actor data. Resolves when characters can be created. */
  load(onProgress?: (fraction: number) => void): Promise<void>;
  createPlayer(appearance: Appearance): CharacterHandle;
  /** Cache NPC id (e.g. 2897 banker). */
  createNpc(npcId: number): CharacterHandle;
  /** Appearance used for guests and merchants, deterministic from a seed. */
  randomAppearance(seed: string): Appearance;
  designer(): DesignerCatalog;
  /** True when `appearance` only references valid kit and colour indices. */
  isValidAppearance(appearance: Appearance): boolean;
}
