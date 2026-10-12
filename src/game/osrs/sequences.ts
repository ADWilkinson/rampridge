import type { EmoteId } from "@shared/protocol";

/**
 * Cache sequence (animation) ids. Names follow RuneLite's AnimationID; each
 * one is baked by scripts/bake/actors and checked by the harness.
 */

/** The player's base animation set (human_ready, human_walk_f, ...). */
export const PLAYER_ANIMS = {
  idle: 808,
  walk: 819,
  walkBack: 820,
  walkLeft: 821,
  walkRight: 822,
  turn: 823,
  run: 824,
} as const;

/** Emote tab sequences, keyed by the wire EmoteId. */
export const EMOTE_SEQUENCES: Readonly<Record<EmoteId, number>> = {
  yes: 855,
  no: 856,
  bow: 858,
  angry: 859,
  think: 857,
  wave: 863,
  shrug: 2113,
  cheer: 862,
  beckon: 864,
  laugh: 861,
  jump: 2109,
  dance: 866,
  clap: 865,
  cry: 860,
};

/** Varrock West Bank bankers: 2897/2898 stand behind the booths, 8666 at the north booth. */
export const BANKER_NPC_IDS = [2897, 2898, 8666] as const;

/** Every sequence the bake must include for players (NPC sequences are added from their definitions). */
export const BAKED_PLAYER_SEQUENCES: readonly number[] = [
  ...Object.values(PLAYER_ANIMS),
  ...Object.values(EMOTE_SEQUENCES),
];
