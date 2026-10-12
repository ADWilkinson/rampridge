import { createCharacterFactory } from "@/game/osrs";
import { GameEngine, type Engine, type EngineOptions } from "./engine";
import type { CharacterFactory } from "./osrs/types";

/**
 * The world engine. `createEngine()` wires the OSRS character runtime from
 * src/game/osrs; pass `characters` only to substitute it (tools, tests).
 */
export interface CreateEngineOptions extends EngineOptions {
  characters?: CharacterFactory;
}

export function createEngine(options: CreateEngineOptions = {}): Engine {
  return new GameEngine(options.characters ?? createCharacterFactory(), options);
}

export type { Engine, EngineOptions, EngineStats } from "./engine";
export type * from "./types";
export { formatUsdc, platformName, stallSuffix, stallTag } from "./menu";
