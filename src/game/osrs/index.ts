/**
 * OSRS character runtime: identity-kit players and cache NPCs, merged,
 * recoloured, lit and animated in the browser the way the client does.
 * See ./types.ts for the CharacterFactory/CharacterHandle contract.
 */
export { createCharacterFactory, OsrsCharacterFactory, loadActors, ACTOR_DATA_URL } from "./factory";
export type { CharacterFactoryOptions, LoadedActors } from "./factory";
export { DESIGNER_SWAY_SECONDS, renderCharacterPreview } from "./preview";
export type { CharacterPreview, CharacterPreviewOptions } from "./preview";
export { isValidAppearance } from "./appearance";
export { DESIGNER_COLOR_COUNTS, DESIGNER_KIT_COUNTS } from "./catalog.generated";
export { BANKER_NPC_IDS, EMOTE_SEQUENCES, PLAYER_ANIMS } from "./sequences";
export { MODEL_UNITS_PER_TILE } from "./mesh";
export type {
  CharacterFactory,
  CharacterHandle,
  DesignerCatalog,
  DesignerOption,
  Locomotion,
} from "./types";
