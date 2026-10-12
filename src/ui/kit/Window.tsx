import { useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { CloseButton } from "./buttons";
import { ChatPromptScope } from "./ChatPrompt";
import { cx } from "./cx";
import { Frame } from "./Frame";
import { useEscapeLayer, useFitScale, useFocusTrap, useLayoutMode, useMediaQuery } from "./hooks";
import { needsUpright } from "./layout";
import { UprightNotice } from "./UprightNotice";
import { cssZoomOf } from "./zoom";

export { Frame };

export interface WindowProps {
  /** Orange title centred in the title bar. Omit for a frame without a title bar. */
  title?: ReactNode;
  /** Close button, Esc and the Choose Option "Close" all call this. Omit to hide the close button. */
  onClose?: () => void;
  /** Natural size in pixels (the original interfaces are fixed size). */
  width: number;
  height: number;
  /** "stone" is the modern bank frame, "steel" the 2007 trade/bank border. */
  variant?: "stone" | "steel";
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  /** Scale down to fit the host on small screens (default true). */
  fit?: boolean;
  /** Allow dragging by the title bar on desktop. */
  draggable?: boolean;
  /** Element focused on open; defaults to the window itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Keep Tab focus inside the window (default true). */
  trapFocus?: boolean;
  /** Accessible label when there is no visible title. */
  ariaLabel?: string;
  closeLabel?: string;
}

/**
 * An interface window drawn with the original border sprites: stone or steel
 * frame, tiled brown backing, orange title and the close button. Esc closes
 * the top-most window; Tab stays inside it. Place it inside a
 * `.rs-window-host` (or GameFrame's interface layer) to centre it.
 *
 * A chatbox prompt opened from inside the window closes when the window
 * closes. On small screens the window scales down to fit (`fit`); it
 * publishes the scale as `--rs-fit-scale` and the kit's coarse-pointer hit
 * areas grow by its inverse, so touch targets stay at least 36px. Interfaces
 * that are dense on phones should still pass a mobile `width`/`height`
 * (useIsMobile) that fits a 360px screen rather than rely on scaling.
 *
 * On a phone held sideways a window that would scale below MIN_LEGIBLE_SCALE
 * is hidden (still mounted) behind a notice asking to turn the phone upright.
 */
export function Window({
  title,
  onClose,
  width,
  height,
  variant = "stone",
  children,
  className,
  bodyClassName,
  style,
  fit = true,
  draggable = false,
  initialFocus,
  trapFocus = true,
  ariaLabel,
  closeLabel = "Close",
}: WindowProps) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const layout = useLayoutMode();
  const finePointer = useMediaQuery("(pointer: fine)");
  const scale = useFitScale(ref, fit);
  const upright = needsUpright(layout.compact, scale);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; zoom: number } | null>(null);
  useEscapeLayer(onClose, Boolean(onClose));
  useFocusTrap(ref, trapFocus, initialFocus);

  const canDrag = draggable && !layout.mobile && finePointer;
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!canDrag || e.button !== 0) return;
    // The translate comes before the fit scale, so it moves in the host's pixels: screen pixels over the host's CSS zoom.
    const host = ref.current?.parentElement;
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y, zoom: host ? cssZoomOf(host) : 1 };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.px) / d.zoom, y: d.oy + (e.clientY - d.py) / d.zoom });
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  const titled = title !== undefined && title !== null;
  const transform = `translate(${offset.x}px, ${offset.y}px)${scale !== 1 ? ` scale(${scale})` : ""}`;
  // Published for kit.css so touch hit areas stay at least 36px after scaling.
  const fitScale = { "--rs-fit-scale": scale } as CSSProperties;

  return (
    <>
    <section
      ref={ref}
      className={cx(
        "rs-window rs-game rs-p12",
        `rs-window--${variant}`,
        titled && "rs-window--titled",
        canDrag && "rs-window--draggable",
        dragging && "rs-window--dragging",
        upright && "rs-fit-hidden",
        className,
      )}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titled ? titleId : undefined}
      aria-label={titled ? undefined : ariaLabel}
      tabIndex={-1}
      style={{ width, height, transform, ...fitScale, ...style }}
    >
      <Frame variant={variant} titled={titled} />
      {titled && (
        <header className="rs-window__title rs-b12" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <h2 id={titleId}>{title}</h2>
        </header>
      )}
      {onClose && <CloseButton className="rs-window__close" onClick={onClose} label={closeLabel} />}
      <div className={cx("rs-window__body", bodyClassName)}>
        <ChatPromptScope>{children}</ChatPromptScope>
      </div>
    </section>
    {upright && <UprightNotice onClose={onClose} />}
    </>
  );
}

/** Centres interface windows in the area it covers (absolute, inset 0). */
export function WindowHost({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cx("rs-window-host", className)}>{children}</div>;
}
