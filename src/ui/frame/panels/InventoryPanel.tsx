import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { ItemGrid, type ItemData } from "@/ui/kit/ItemSlot";

export const INVENTORY_SLOTS = 28;

export interface InventoryPanelProps {
  /** Up to 28 items in slot order; null for an empty slot. */
  items: readonly (ItemData | null)[];
  /** Left click / Enter on an item (its first option). */
  onActivate?: (index: number, item: ItemData, e: MouseEvent | KeyboardEvent) => void;
  /** Right click / long press: the integrator opens a ContextMenu with the item's options. */
  onMenu?: (index: number, item: ItemData, at: { x: number; y: number }) => void;
  /** Shown over the empty grid, e.g. "Log in to see your USDC." */
  notice?: ReactNode;
}

/** The 28-slot inventory (4 x 7, slots 42 x 36 apart). */
export function InventoryPanel({ items, onActivate, onMenu, notice }: InventoryPanelProps) {
  const empty = items.every((i) => !i);
  return (
    <div className="rs-panel rs-inventory">
      <ItemGrid items={items.slice(0, INVENTORY_SLOTS)} slots={INVENTORY_SLOTS} columns={4} gapX={6} gapY={4} onActivate={onActivate} onMenu={onMenu} ariaLabel="Inventory" />
      {empty && notice && <p className="rs-panel__notice rs-p12">{notice}</p>}
    </div>
  );
}
