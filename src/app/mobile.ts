/**
 * Page-level behaviour for phones and tablets, installed once at boot:
 *
 * - The page itself never scrolls, bounces or zooms. A touch drag only
 *   scrolls an element that can scroll that way (chat history, long
 *   interfaces); anything else would rubber-band the whole game in iOS
 *   Safari and in-app browsers (X, Instagram), or pull to refresh on Android.
 *   Two-finger gestures never zoom the page (the world uses them for the
 *   camera; main.tsx also stops iOS's own pinch gesture).
 * - The on-screen keyboard. Browsers keep the layout the same size and pan
 *   the visible area to the focused field instead. `--rr-kb` on <html> holds
 *   how much of the layout the keyboard covers (0 when closed) and
 *   `rr-keyboard` is set while it is open, so the frame can lift the
 *   chatbox onto the keyboard. When the keyboard closes, any pan the browser
 *   left behind is undone.
 */

/** A smaller visible-area loss than this is browser chrome (toolbars), not a keyboard. */
export const KEYBOARD_MIN_PX = 120;

/** How much of a layout `layoutHeight` tall the keyboard covers, given the visual viewport. */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualTop: number): number {
  const covered = Math.round(layoutHeight - visualHeight - visualTop);
  return covered >= KEYBOARD_MIN_PX ? covered : 0;
}

function canScrollFrom(start: EventTarget | null): boolean {
  for (let node = start instanceof Element ? start : null; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    // Text fields: dragging moves the caret or the selection.
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && node.isContentEditable)) return true;
    const style = getComputedStyle(node);
    const y = style.overflowY;
    const x = style.overflowX;
    if ((y === "auto" || y === "scroll") && node.scrollHeight > node.clientHeight + 1) return true;
    if ((x === "auto" || x === "scroll") && node.scrollWidth > node.clientWidth + 1) return true;
  }
  return false;
}

let installed = false;

export function installMobileGuards(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;

  // Decided once per gesture, when it starts: per-move style reads would cost frames on slow phones.
  let scrollable = false;
  document.addEventListener(
    "touchstart",
    (e) => {
      scrollable = e.touches.length === 1 && canScrollFrom(e.target);
    },
    { passive: true, capture: true },
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!e.cancelable) return;
      if (e.touches.length > 1 || !scrollable) e.preventDefault();
    },
    { passive: false, capture: true },
  );

  const root = document.documentElement;
  const resetPan = () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  const vv = window.visualViewport;
  let open = false;
  const update = () => {
    const view = window.visualViewport ?? vv;
    const kb = view ? keyboardInset(window.innerHeight, view.height, view.offsetTop) : 0;
    root.style.setProperty("--rr-kb", `${kb}px`);
    if ((kb > 0) !== open) {
      open = kb > 0;
      root.classList.toggle("rr-keyboard", open);
      // Closed: the browser may leave the page panned up by the height it scrolled for the field.
      if (!open) resetPan();
    }
  };
  if (vv) {
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
  }
  window.addEventListener("resize", update);
  // A field losing focus can close the keyboard before the viewport reports it.
  document.addEventListener("focusout", () => window.setTimeout(() => {
    update();
    if (!open && !(document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)) resetPan();
  }, 50));
  update();
}
