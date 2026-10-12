import type { Appearance } from "@shared/protocol";
import type { DesignerCatalog, DesignerOption } from "@/game/osrs/types";

/** Kit slot of the jaw (beard) in Appearance.kits. */
export const JAW_SLOT = 1;

/** Next option index in a designer list, wrapping; returns `current` when the list is empty. */
export function cycleOption(options: readonly DesignerOption[], current: number, dir: 1 | -1): number {
  if (options.length === 0) return current;
  const at = options.findIndex((o) => o.index === current);
  const next = at < 0 ? (dir === 1 ? 0 : options.length - 1) : (at + dir + options.length) % options.length;
  return options[next]!.index;
}

/**
 * Appearance for the other body type. Like the 2007 designer, changing the
 * body resets every kit to that body's defaults (body B gets the clean chin,
 * never a beard); colours are kept. Kit options are positional per body, so
 * carrying an index across would pick an unrelated kit.
 */
export function switchBody(appearance: Appearance, catalog: DesignerCatalog, body: 0 | 1): Appearance {
  if (appearance.body === body) return appearance;
  const kits = catalog.defaults?.[body] ?? (catalog.kits[body].map((opts) => opts[0]?.index ?? 0) as Appearance["kits"]);
  return { ...appearance, body, kits: [...kits] as Appearance["kits"] };
}

/**
 * Whether a kit slot can be changed for `body`. The 2007 designer had no
 * body-B jaw, so the Jaw arrows do nothing for body B.
 */
export function kitSlotEditable(catalog: DesignerCatalog, body: 0 | 1, slot: number): boolean {
  if (body === 1 && slot === JAW_SLOT) return false;
  return (catalog.kits[body][slot]?.length ?? 0) >= 2;
}
