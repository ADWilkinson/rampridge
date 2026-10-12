import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { COMPACT_LANDSCAPE_QUERY, NARROW_QUERY, TOUCH_QUERY, fitScale, layoutMode, type LayoutMode } from "./layout";

/**
 * Escape handling across stacked interfaces: only the most recently opened
 * layer (menu, prompt, window) receives Esc, so closing a context menu does
 * not also close the bank behind it.
 */
const escapeStack: { id: number; handler: () => void }[] = [];
let nextLayer = 1;
let escapeBound = false;

function onDocumentKey(e: KeyboardEvent): void {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.handler();
}

export function useEscapeLayer(handler: (() => void) | undefined, active = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active || !ref.current) return;
    if (!escapeBound && typeof document !== "undefined") {
      document.addEventListener("keydown", onDocumentKey);
      escapeBound = true;
    }
    const id = nextLayer++;
    escapeStack.push({ id, handler: () => ref.current?.() });
    return () => {
      const i = escapeStack.findIndex((l) => l.id === id);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, [active]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true" && el.offsetParent !== null,
  );
}

/**
 * Keeps Tab inside `ref` while active, focuses the container (or
 * `initialFocus`) on open and restores the previous focus on close. Focus is
 * never pulled back from elsewhere (typing in the chatbox stays possible).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true, initialFocus?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocus?.current ?? root;
    target.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusableIn(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (previous && root.contains(document.activeElement) && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [ref, active, initialFocus]);
}

/** A counter that advances every game tick (600 ms) while `active`. */
export function useTick(active = true, ms = 600): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setN((v) => v + 1), ms);
    return () => window.clearInterval(id);
  }, [active, ms]);
  return n;
}

/** Current time from `now` (default Date.now), refreshed every `ms`. */
export function useNow(now: () => number = Date.now, ms = 1000): number {
  const [t, setT] = useState(() => now());
  const nowRef = useRef(now);
  nowRef.current = now;
  useEffect(() => {
    const id = window.setInterval(() => setT(nowRef.current()), ms);
    setT(nowRef.current());
    return () => window.clearInterval(id);
  }, [ms]);
  return t;
}

function mediaMatches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** Whether a CSS media query matches, kept current. */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => mediaMatches(query));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** The current layout mode (see layout.ts): portrait phone, phone held sideways, or desktop. */
export function useLayoutMode(): LayoutMode {
  const narrow = useMediaQuery(NARROW_QUERY);
  const compact = useMediaQuery(COMPACT_LANDSCAPE_QUERY);
  return layoutMode(narrow, compact);
}

/** The layout mode right now, outside React (e.g. for initial state). */
export function currentLayoutMode(): LayoutMode {
  return layoutMode(mediaMatches(NARROW_QUERY), mediaMatches(COMPACT_LANDSCAPE_QUERY));
}

/**
 * True for the portrait phone layout: narrower than 768px and not a phone
 * held sideways. Interfaces pick their tall phone sizes from it. A phone held
 * sideways gets the wide desktop sizes, which fit its short screen, while
 * GameFrame still draws its phone chatbox and side-panel sheet there.
 */
export function useIsMobile(): boolean {
  return useLayoutMode().mobile;
}

/** True on a phone held sideways (a touch screen under 500px tall). */
export function useCompactLandscape(): boolean {
  return useLayoutMode().compact;
}

/** True when touch input is available (any coarse pointer). */
export function useTouch(): boolean {
  return useMediaQuery(TOUCH_QUERY);
}

/** True when the OS asks for reduced motion or <html> carries `rs-reduced-motion`. */
export function useReducedMotion(): boolean {
  const read = () =>
    typeof window !== "undefined" &&
    (window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("rs-reduced-motion"));
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(read());
    mq.addEventListener("change", on);
    const mo = new MutationObserver(on);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      mq.removeEventListener("change", on);
      mo.disconnect();
    };
  }, []);
  return reduced;
}

/**
 * Scale that fits an element of natural size (w, h) into its parent's
 * content box (inside its padding, e.g. safe-area insets) with a margin,
 * never enlarging. Used so interfaces fit phone screens.
 */
export function useFitScale(ref: RefObject<HTMLElement | null>, enabled = true, margin = 8): number {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!enabled || !el || !parent) {
      setScale(1);
      return;
    }
    const measure = () => {
      const cs = getComputedStyle(parent);
      const pw = parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      const ph = parent.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
      const s = fitScale(el.offsetWidth, el.offsetHeight, pw, ph, margin);
      if (s !== null) setScale(s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled, margin]);
  return scale;
}
