import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { formatStack, showsStack } from "./format";
import { Tooltip } from "./Tooltip";

/** One item for a slot or grid. */
export interface ItemData {
  /** Stable key (defaults to the slot index in grids). */
  key?: string;
  /** Item name, used for the accessible label and menus (drawn orange in menus). */
  name: string;
  /** The item image, drawn centred in the 36x32 slot. */
  icon?: ReactNode;
  /** Stack size. Omitted means a single unstackable item. */
  quantity?: number;
  /** Stackable items always show their count, even 1. */
  stackable?: boolean;
  /** Examine text shown in the yellow box on hover. */
  examine?: ReactNode;
  /** Drawn on top of the icon, e.g. a note-style platform badge. */
  overlay?: ReactNode;
  /** Faded, as the bank draws placeholders. */
  placeholder?: boolean;
  /** White outline, as the client draws an item chosen with "Use". */
  selected?: boolean;
}

export interface ItemSlotProps {
  item: ItemData | null;
  /** Primary action (left click / Enter). Makes the slot a button. */
  onActivate?: (item: ItemData, e: MouseEvent | KeyboardEvent) => void;
  /** Right click / long press with the cursor position. */
  onMenu?: (item: ItemData, at: { x: number; y: number }) => void;
  disabled?: boolean;
  className?: string;
  tabIndex?: number;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
}

/** The stack count in the slot's top-left, with the original colour rules. */
export function StackCount({ quantity }: { quantity: number }) {
  const label = formatStack(quantity);
  return (
    <span className="rs-slot__count" style={{ color: label.color }} aria-hidden="true">
      {label.text}
    </span>
  );
}

const LONG_PRESS_MS = 450;

/** An inventory/bank slot: item image, stack count, examine on hover, menu on right click. */
export function ItemSlot({ item, onActivate, onMenu, disabled = false, className, tabIndex, onKeyDown }: ItemSlotProps) {
  const press = useRef<{ timer: number; fired: boolean } | null>(null);
  if (!item) return <span className={cx("rs-slot rs-slot--empty", className)} aria-hidden="true" />;

  const quantity = item.quantity ?? 1;
  const stackable = item.stackable ?? item.quantity !== undefined;
  const label = `${item.name}${showsStack(quantity, stackable) ? `, ${quantity.toLocaleString("en-US")}` : ""}`;
  const body = (
    <>
      <span className="rs-slot__icon">{item.icon}</span>
      {item.overlay && <span className="rs-slot__overlay">{item.overlay}</span>}
      {showsStack(quantity, stackable) && <StackCount quantity={quantity} />}
    </>
  );
  const classes = cx("rs-slot", item.selected && "rs-slot--selected", item.placeholder && "rs-slot--placeholder", className);

  if (!onActivate && !onMenu) {
    return (
      <Tooltip content={item.examine}>
        <span className={classes} role="img" aria-label={label}>
          {body}
        </span>
      </Tooltip>
    );
  }

  const clearPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };

  return (
    <Tooltip content={item.examine}>
      <button
        type="button"
        className={classes}
        aria-label={label}
        disabled={disabled}
        tabIndex={tabIndex}
        onClick={(e) => {
          if (press.current?.fired) {
            press.current = null;
            return;
          }
          onActivate?.(item, e);
        }}
        onContextMenu={(e) => {
          if (!onMenu) return;
          e.preventDefault();
          onMenu(item, { x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== "touch" || !onMenu) return;
          const { clientX: x, clientY: y } = e;
          press.current = {
            fired: false,
            timer: window.setTimeout(() => {
              if (press.current) press.current.fired = true;
              onMenu(item, { x, y });
            }, LONG_PRESS_MS),
          };
        }}
        onPointerUp={clearPress}
        onPointerCancel={clearPress}
        onPointerLeave={clearPress}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (onMenu && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(item, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
        }}
      >
        {body}
      </button>
    </Tooltip>
  );
}

export interface ItemGridProps {
  items: readonly (ItemData | null)[];
  /** Columns: 4 for the inventory, 8 for the bank. */
  columns: number;
  /** Total slots drawn (pads with empty slots), e.g. 28 for the inventory. */
  slots?: number;
  /** Pixel gap between slots: the inventory spaces slots 42 x 36 apart. */
  gapX?: number;
  gapY?: number;
  onActivate?: (index: number, item: ItemData, e: MouseEvent | KeyboardEvent) => void;
  onMenu?: (index: number, item: ItemData, at: { x: number; y: number }) => void;
  className?: string;
  ariaLabel?: string;
}

/**
 * A grid of item slots with roving keyboard focus (arrow keys move, Enter
 * activates, the context-menu key opens options).
 */
export function ItemGrid({ items, columns, slots, gapX = 6, gapY = 4, onActivate, onMenu, className, ariaLabel }: ItemGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const count = Math.max(slots ?? 0, items.length);
  const cells = Array.from({ length: count }, (_, i) => items[i] ?? null);
  const firstFilled = cells.findIndex(Boolean);

  const move = (from: number, e: KeyboardEvent<HTMLElement>) => {
    const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
    const d = delta[e.key];
    if (d === undefined) return;
    e.preventDefault();
    let i = from + d;
    while (i >= 0 && i < count && !cells[i]) i += d;
    if (i < 0 || i >= count) return;
    ref.current?.querySelectorAll<HTMLElement>("[data-slot]")[i]?.querySelector<HTMLElement>("button")?.focus();
  };

  return (
    <div
      ref={ref}
      className={cx("rs-grid", className)}
      role="group"
      aria-label={ariaLabel}
      style={{ gridTemplateColumns: `repeat(${columns}, 36px)`, columnGap: gapX, rowGap: gapY }}
    >
      {cells.map((item, i) => (
        <div key={item?.key ?? i} data-slot={i}>
          <ItemSlot
            item={item}
            tabIndex={i === firstFilled ? 0 : -1}
            onKeyDown={(e) => move(i, e)}
            onActivate={onActivate ? (it, e) => onActivate(i, it, e) : undefined}
            onMenu={onMenu ? (it, at) => onMenu(i, it, at) : undefined}
          />
        </div>
      ))}
    </div>
  );
}
