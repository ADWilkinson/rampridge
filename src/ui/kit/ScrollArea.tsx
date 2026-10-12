import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cx } from "./cx";
import { screenScaleY } from "./zoom";

export interface ScrollbarProps {
  /** The element that scrolls (overflow-y: auto). */
  target: RefObject<HTMLElement | null>;
  variant?: "stone" | "parchment";
  /** Pixels per arrow click (default 14, one chat line). */
  step?: number;
  className?: string;
}

interface Metrics {
  top: number;
  height: number;
  scrollable: boolean;
}

/**
 * The original vertical scrollbar: arrow buttons, tiled track, three-piece
 * dragger. Drives any scroll container passed as `target`.
 */
export function Scrollbar({ target, variant = "stone", step = 14, className }: ScrollbarProps) {
  const track = useRef<HTMLDivElement>(null);
  const [m, setM] = useState<Metrics>({ top: 0, height: 0, scrollable: false });
  const drag = useRef<{ y: number; scroll: number; scale: number } | null>(null);
  const repeat = useRef<number | undefined>(undefined);

  const measure = useCallback(() => {
    const el = target.current;
    const tr = track.current;
    if (!el || !tr) return;
    const th = tr.clientHeight;
    const ratio = el.scrollHeight > 0 ? el.clientHeight / el.scrollHeight : 1;
    const scrollable = el.scrollHeight - el.clientHeight > 1;
    const height = scrollable ? Math.max(10, Math.round(th * ratio)) : th;
    const max = el.scrollHeight - el.clientHeight;
    const top = scrollable && max > 0 ? Math.round((el.scrollTop / max) * (th - height)) : 0;
    setM((prev) => (prev.top === top && prev.height === height && prev.scrollable === scrollable ? prev : { top, height, scrollable }));
  }, [target]);

  useLayoutEffect(() => {
    const el = target.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (track.current) ro.observe(track.current);
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
      mo.disconnect();
    };
  }, [target, measure]);

  useEffect(() => () => window.clearInterval(repeat.current), []);

  const scrollBy = (dy: number) => target.current?.scrollBy({ top: dy });
  const startRepeat = (dy: number) => {
    scrollBy(dy);
    window.clearInterval(repeat.current);
    const started = Date.now();
    repeat.current = window.setInterval(() => {
      if (Date.now() - started > 300) scrollBy(dy);
    }, 50);
  };
  const stopRepeat = () => window.clearInterval(repeat.current);

  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const el = target.current;
    if (!el) return;
    const r = e.currentTarget.getBoundingClientRect();
    // Screen pixels into the track's own (zoomed or fit-scaled) pixels, where the thumb's top is.
    const y = (e.clientY - r.top) / screenScaleY(e.currentTarget);
    scrollBy(y < m.top ? -el.clientHeight : el.clientHeight);
  };
  const onThumbDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = target.current;
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, scroll: el.scrollTop, scale: track.current ? screenScaleY(track.current) : 1 };
  };
  const onThumbMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = target.current;
    const tr = track.current;
    if (!d || !el || !tr) return;
    const free = tr.clientHeight - m.height;
    if (free <= 0) return;
    const max = el.scrollHeight - el.clientHeight;
    // The pointer moves in screen pixels, the thumb in the track's own pixels.
    el.scrollTop = d.scroll + ((e.clientY - d.y) / d.scale / free) * max;
  };
  const onThumbUp = () => {
    drag.current = null;
  };

  const arrowProps = (dy: number) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      e.preventDefault();
      startRepeat(dy);
    },
    onPointerUp: stopRepeat,
    onPointerLeave: stopRepeat,
    onPointerCancel: stopRepeat,
  });

  const thumbStyle: CSSProperties = { top: m.top, height: m.height };
  return (
    <div className={cx("rs-scrollbar", variant === "parchment" && "rs-scrollbar--parchment", className)} aria-hidden="true">
      <span className="rs-scrollbar__arrow rs-scrollbar__up" {...arrowProps(-step)} />
      <div ref={track} className="rs-scrollbar__track" onPointerDown={onTrackDown}>
        <div className="rs-scrollbar__thumb" style={thumbStyle} onPointerDown={onThumbDown} onPointerMove={onThumbMove} onPointerUp={onThumbUp} onPointerCancel={onThumbUp}>
          <span className="rs-scrollbar__thumb-top" />
          <span className="rs-scrollbar__thumb-mid" />
          <span className="rs-scrollbar__thumb-bottom" />
        </div>
      </div>
      <span className="rs-scrollbar__arrow rs-scrollbar__down" {...arrowProps(step)} />
    </div>
  );
}

export interface ScrollAreaProps {
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
  style?: CSSProperties;
  variant?: "stone" | "parchment";
  /** Keep the view pinned to the newest content while the reader is at the bottom (chat). */
  stickToBottom?: boolean;
  /** Accessible name; the content becomes a focusable region so arrow keys scroll it. */
  label?: string;
  /** Ref to the scrolling element, for callers that need to scroll programmatically. */
  contentRef?: RefObject<HTMLDivElement | null>;
  step?: number;
}

/** Scrollable content with the original scrollbar on the right. */
export function ScrollArea({ children, className, contentClassName, style, variant = "stone", stickToBottom = false, label, contentRef, step }: ScrollAreaProps) {
  const own = useRef<HTMLDivElement>(null);
  const ref = contentRef ?? own;
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !stickToBottom) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.clientHeight - el.scrollTop < 4;
    };
    const pin = () => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    };
    pin();
    el.addEventListener("scroll", onScroll, { passive: true });
    const mo = new MutationObserver(pin);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      mo.disconnect();
      ro.disconnect();
    };
  }, [ref, stickToBottom]);

  return (
    <div className={cx("rs-scroll", `rs-scroll--${variant}`, className)} style={style}>
      <div ref={ref} className={cx("rs-scroll__content", contentClassName)} tabIndex={label ? 0 : undefined} role={label ? "region" : undefined} aria-label={label}>
        {children}
      </div>
      <Scrollbar target={ref} variant={variant} step={step} />
    </div>
  );
}
