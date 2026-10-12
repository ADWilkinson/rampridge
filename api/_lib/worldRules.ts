/**
 * The bake's collision grid and spawn tiles, so the server judges moves by
 * exactly the rules the client pathfinder uses. A malformed bake falls back
 * to the conservative bank-interior box rather than taking the API down.
 */

import collision from "../../shared/collision.json" with { type: "json" };
import meta from "../../shared/world-meta.json" with { type: "json" };
import { FALLBACK_WORLD_RULES, worldRulesFromBake } from "../../shared/world.js";
import type { WorldRules } from "../../shared/world.js";

let cached: WorldRules | null = null;

export function bakedWorldRules(): WorldRules {
  if (cached) return cached;
  try {
    cached = worldRulesFromBake(collision, meta);
  } catch (err) {
    console.error("Baked world rules are invalid; using the fallback grid:", err instanceof Error ? err.message : err);
    cached = FALLBACK_WORLD_RULES;
  }
  return cached;
}
