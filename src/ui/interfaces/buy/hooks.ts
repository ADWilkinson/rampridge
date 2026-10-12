import { useEffect, useRef, useState } from "react";

/** `value`, updated only after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** Calls `handler` when the window regains focus (e.g. back from the Chrome Web Store tab). */
export function useWindowFocus(handler: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [handler, active]);
}

function handlesEnterItself(el: Element | null): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLButtonElement ||
    el instanceof HTMLAnchorElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/**
 * Enter runs the interface's main action (Confirm, Accept, Verify) unless
 * focus is on something that handles Enter itself: a button, link or field
 * such as the chatbox or the amount prompt.
 */
export function useEnterKey(action: (() => void) | null): void {
  const ref = useRef(action);
  ref.current = action;
  const enabled = action !== null;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (handlesEnterItself(document.activeElement)) return;
      const run = ref.current;
      if (!run) return;
      e.preventDefault();
      run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
