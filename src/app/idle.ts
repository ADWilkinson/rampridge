/**
 * Runs `task` once the current screen has been painted and the browser has a
 * moment to spare (or after `timeoutMs` at the latest), so downloads that can
 * wait never compete with the screen being drawn. Returns a cancel function
 * for an effect cleanup.
 */
export function afterPaintIdle(task: () => void, timeoutMs = 2_000): () => void {
  let idle = 0;
  let timer = 0;
  // The second frame starts after the first has been painted.
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(task, { timeout: timeoutMs });
      else timer = window.setTimeout(task, 250);
    });
  });
  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (idle) window.cancelIdleCallback(idle);
    if (timer) window.clearTimeout(timer);
  };
}
