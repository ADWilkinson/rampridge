/*
 * Fixed-step page clock for the capture recorder (scripts/capture/record.mjs).
 * Injected with Page.addScriptToEvaluateOnNewDocument before any page script,
 * it replaces performance.now, Date, setTimeout/setInterval and
 * requestAnimationFrame with a virtual clock that only moves when the
 * recorder calls window.__clock.advance(ms). Each advance runs the timers
 * that fall due (draining microtasks and React's MessageChannel work between
 * them), then one animation frame, then pins every CSS/Web animation to the
 * virtual time. Math.random is seeded so crowds and shouts repeat exactly.
 * Capture only: the app never loads this.
 */
(() => {
  if (window.__clock) return;
  const realSetTimeout = window.setTimeout.bind(window);
  const EPOCH = Date.parse("2026-10-11T18:30:00Z");
  let now = 1000;

  // ------------------------------------------------------------------ random
  let seed = 0x5eed1234;
  Math.random = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ------------------------------------------------------------------ time
  performance.now = () => now;
  const RealDate = Date;
  function FakeDate(...args) {
    if (!(this instanceof FakeDate)) return new RealDate(EPOCH + now).toString();
    return args.length === 0 ? new RealDate(EPOCH + now) : new RealDate(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => EPOCH + Math.floor(now);
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;

  // ------------------------------------------------------------------ timers
  let seq = 1;
  const timers = new Map();
  const schedule = (fn, ms, args, repeat) => {
    const id = seq++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { at: now + delay, fn, args, repeat: repeat ? Math.max(1, delay) : 0, order: id });
    return id;
  };
  window.setTimeout = (fn, ms, ...args) => schedule(fn, ms, args, false);
  window.setInterval = (fn, ms, ...args) => schedule(fn, ms, args, true);
  window.clearTimeout = window.clearInterval = (id) => void timers.delete(id);

  let rafSeq = 1;
  let frames = new Map();
  window.requestAnimationFrame = (fn) => {
    const id = rafSeq++;
    frames.set(id, fn);
    return id;
  };
  window.cancelAnimationFrame = (id) => void frames.delete(id);

  /** Lets promise chains and React's scheduler (MessageChannel) run. */
  const yieldTask = () =>
    new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    });

  const run = (fn, args) => {
    try {
      // String timers (legacy eval form) are not used by the app and are ignored.
      if (typeof fn === "function") fn(...args);
    } catch (err) {
      console.error("[clock] callback failed", err);
    }
  };

  // ------------------------------------------------------------------ animations
  const started = new WeakMap();
  const pinAnimations = () => {
    if (!document.getAnimations) return;
    for (const anim of document.getAnimations()) {
      let start = started.get(anim);
      if (start === undefined) {
        start = now;
        started.set(anim, start);
        try {
          anim.pause();
        } catch {
          // Already finished and removed.
        }
      }
      try {
        anim.currentTime = now - start;
      } catch {
        // Animations without a timeline.
      }
    }
  };

  async function advance(ms) {
    const target = now + ms;
    for (let guard = 0; guard < 5000; guard++) {
      let next = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!next || t.at < next[1].at || (t.at === next[1].at && t.order < next[1].order))) next = [id, t];
      }
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.at);
      if (t.repeat) {
        t.at = now + t.repeat;
        t.order = seq++;
      } else timers.delete(id);
      run(t.fn, t.args);
      await yieldTask();
    }
    now = target;
    const due = frames;
    frames = new Map();
    for (const fn of due.values()) run(fn, [now]);
    await yieldTask();
    pinAnimations();
    await yieldTask();
    return now;
  }

  window.__clock = {
    advance,
    now: () => now,
    realSetTimeout,
    pending: () => timers.size,
  };
})();
