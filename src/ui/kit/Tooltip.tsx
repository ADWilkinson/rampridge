import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "./cx";
import { cssZoomOf, tooltipPlacement } from "./zoom";

export interface TooltipBoxProps {
  children: ReactNode;
  /** Viewport position of the cursor; the box sits below-right and stays on screen. */
  x?: number;
  y?: number;
  className?: string;
  id?: string;
}

/** The pale yellow examine box with a black border and black text. */
export function TooltipBox({ children, x, y, className, id }: TooltipBoxProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (x === undefined || y === undefined) return;
    const el = ref.current;
    // Zoomed on big monitors (kit.css), its left and top are in zoomed pixels.
    setPos(tooltipPlacement(x, y, el?.offsetWidth ?? 0, el?.offsetHeight ?? 0, window.innerWidth, window.innerHeight, el ? cssZoomOf(el) : 1));
  }, [x, y, children]);
  const fixed = x !== undefined && y !== undefined;
  const box = (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={cx("rs-tooltip rs-p12", !fixed && "rs-tooltip--static", className)}
      style={fixed ? { left: pos?.left ?? -9999, top: pos?.top ?? -9999 } : undefined}
    >
      {children}
    </div>
  );
  return fixed ? createPortal(box, document.body) : box;
}

export interface TooltipProps {
  /** Tooltip text; nothing is shown when empty. */
  content: ReactNode;
  /** A single element that receives hover and focus handlers. */
  children: ReactElement<Record<string, unknown>>;
  /** Hover delay in ms (default 400). */
  delay?: number;
}

/**
 * Shows the examine box next to the cursor while hovering (or below the
 * element while it has keyboard focus).
 */
export function Tooltip({ content, children, delay = 400 }: TooltipProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const id = useId();

  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!isValidElement(children)) return children;
  const empty = content === null || content === undefined || content === false || content === "";
  const props = children.props;
  const call = (name: string, e: unknown) => {
    const fn = props[name];
    if (typeof fn === "function") (fn as (e: unknown) => void)(e);
  };

  const show = (x: number, y: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAt({ x, y }), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setAt(null);
  };

  const child = cloneElement(children, {
    "aria-describedby": at && !empty ? id : (props["aria-describedby"] as string | undefined),
    onPointerEnter: (e: ReactPointerEvent) => {
      call("onPointerEnter", e);
      if (e.pointerType === "mouse") {
        show(e.clientX, e.clientY);
      }
    },
    onPointerMove: (e: ReactPointerEvent) => {
      call("onPointerMove", e);
      if (e.pointerType === "mouse" && at) setAt({ x: e.clientX, y: e.clientY });
    },
    onPointerLeave: (e: ReactPointerEvent) => {
      call("onPointerLeave", e);
      hide();
    },
    onPointerDown: (e: ReactPointerEvent) => {
      call("onPointerDown", e);
      hide();
    },
    onFocus: (e: ReactFocusEvent<HTMLElement>) => {
      call("onFocus", e);
      if (!e.currentTarget.matches(":focus-visible")) return;
      const r = e.currentTarget.getBoundingClientRect();
      show(r.left, r.bottom - 8);
    },
    onBlur: (e: ReactFocusEvent) => {
      call("onBlur", e);
      hide();
    },
  });

  return (
    <>
      {child}
      {at && !empty && (
        <TooltipBox x={at.x} y={at.y} id={id}>
          {content}
        </TooltipBox>
      )}
    </>
  );
}
