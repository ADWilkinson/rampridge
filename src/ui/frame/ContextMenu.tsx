import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "@/ui/kit/cx";
import { useEscapeLayer } from "@/ui/kit/hooks";
import { cssZoomOf, menuPlacement } from "@/ui/kit/zoom";
import { MenuPressGuard, TARGET_COLORS, consumesOutsidePress, entryText, type MenuEntry } from "./menu";

/** Touch and pen contacts down right now, so a menu knows whether a finger opened it. */
const heldPointers = new Set<number>();
if (typeof window !== "undefined") {
  const opts = { capture: true, passive: true };
  window.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") heldPointers.add(e.pointerId);
  }, opts);
  const lift = (e: PointerEvent) => heldPointers.delete(e.pointerId);
  window.addEventListener("pointerup", lift, opts);
  window.addEventListener("pointercancel", lift, opts);
  // A lift that happens while the page is in the background is never seen.
  window.addEventListener("blur", () => heldPointers.clear());
}

/**
 * Drops the click that follows a consumed press (touch fires one after the
 * finger lifts), so a HUD button under the finger does not fire. Gives up at
 * the next press or after a second, whichever comes first.
 */
function swallowNextClick(): void {
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const done = () => {
    window.removeEventListener("click", stop, true);
    window.removeEventListener("pointerdown", done, true);
    window.clearTimeout(timer);
  };
  const timer = window.setTimeout(done, 1000);
  window.addEventListener("click", stop, true);
  // Added while the consumed press is dispatching, so it only sees the next one.
  window.addEventListener("pointerdown", done, true);
}

export interface ContextMenuProps<T extends MenuEntry> {
  /** Cursor position in viewport pixels (the menu's top edge is centred on it). */
  x: number;
  y: number;
  options: readonly T[];
  onSelect: (option: T) => void;
  /**
   * Called on Cancel, Esc, a press outside, or the cursor leaving the menu. A
   * left click or tap outside only closes the menu (it does not reach the
   * world or the HUD); a mouse right-click outside passes through.
   */
  onClose: () => void;
  /** Close when the mouse moves this far outside the menu (the client uses about 10px). */
  leaveMargin?: number;
}

/**
 * The "Choose Option" menu: header in the menu colour on black, one row per
 * option (verb white, target coloured by kind), "Cancel" last. Positioned so
 * the cursor sits on the header's centre, clamped to the viewport; closes when
 * the mouse leaves it, like the original.
 */
export function ContextMenu<T extends MenuEntry>({ x, y, options, onSelect, onClose, leaveMargin = 10 }: ContextMenuProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(0);
  const rows = options.length + 1; // + Cancel
  // A long-press opens the menu under a finger that is still down: its release must not pick an option.
  const [guard] = useState(() => new MenuPressGuard(heldPointers, performance.now()));
  useEscapeLayer(onClose);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Zoomed on big monitors (frame.css), its left and top are in zoomed pixels.
    const place = () => {
      const next = menuPlacement(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight, cssZoomOf(el));
      setPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    place();
    // Placed again if its size changes after opening (the menu font arriving), so the header stays centred on the cursor.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [x, y, options]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [pos === null]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      if (e.clientX < r.left - leaveMargin || e.clientX > r.right + leaveMargin || e.clientY < r.top - leaveMargin || e.clientY > r.bottom + leaveMargin) onClose();
    };
    const onDown = (e: PointerEvent) => {
      guard.down(performance.now());
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      if (consumesOutsidePress(e.pointerType, e.button)) {
        e.preventDefault();
        e.stopPropagation();
        swallowNextClick();
      }
      onClose();
    };
    const onUp = (e: PointerEvent) => guard.up(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [onClose, leaveMargin, guard]);

  const focusRow = (i: number) => {
    const next = (i + rows) % rows;
    setActive(next);
    ref.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(active - 1);
    } else if (e.key === "Tab") {
      e.preventDefault();
      focusRow(active + (e.shiftKey ? -1 : 1));
    }
  };

  return (
    <div
      ref={ref}
      className="rs-menu rs-game rs-b12"
      role="menu"
      aria-label="Choose Option"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="rs-menu__header" aria-hidden="true">
        Choose Option
      </div>
      <div className="rs-menu__list">
        {options.map((o, i) => (
          <button
            key={`${i}-${entryText(o)}`}
            type="button"
            role="menuitem"
            className={cx("rs-menu__row", active === i && "is-active")}
            onPointerEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onClick={(e) => {
              if (guard.accepts(e.detail)) onSelect(o);
            }}
            aria-label={entryText(o)}
          >
            <span className="rs-menu__verb">{o.verb}</span>
            {o.targetName && (
              <>
                {" "}
                <span style={{ color: TARGET_COLORS[o.kind ?? "tile"] }}>{o.targetName}</span>
              </>
            )}
            {o.suffix && <span> {o.suffix}</span>}
          </button>
        ))}
        <button
          type="button"
          role="menuitem"
          className={cx("rs-menu__row", active === options.length && "is-active")}
          onPointerEnter={() => setActive(options.length)}
          onFocus={() => setActive(options.length)}
          onClick={(e) => {
            if (guard.accepts(e.detail)) onClose();
          }}
        >
          <span className="rs-menu__verb">Cancel</span>
        </button>
      </div>
    </div>
  );
}
