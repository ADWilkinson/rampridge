import type { CameraKey } from "./render/camera";

/**
 * Mouse, touch and keyboard input for the world view, mapped to the
 * original client's controls: left press acts, right press opens the menu,
 * the middle button drags the camera, the wheel zooms and the arrow keys
 * rotate. On touch screens a tap is a left click, a 450 ms long-press is a
 * right click, two fingers rotate and pinch zooms.
 */

export interface InputHandlers {
  hover(x: number, y: number): void;
  leave(): void;
  click(x: number, y: number): void;
  menu(x: number, y: number): void;
  /** Camera drag in CSS pixels. */
  drag(dx: number, dy: number): void;
  /** Wheel or pinch zoom; positive zooms out. */
  zoom(steps: number): void;
  /** Arrow key press or release; returns whether the camera used a press (its default is then prevented). */
  key(key: CameraKey, down: boolean): boolean;
  /** Any pointer press, used to unlock audio. */
  gesture(): void;
}

const LONG_PRESS_MS = 450;
const TAP_SLOP_PX = 10;

const KEY_MAP: Record<string, CameraKey> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

interface TouchPoint {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

/** Widgets whose keyboard model uses the arrow keys (WAI-ARIA composite roles). */
const ARROW_WIDGETS = [
  "[data-ui-keys]",
  "[role=menu]",
  "[role=menubar]",
  "[role=menuitem]",
  "[role=menuitemradio]",
  "[role=menuitemcheckbox]",
  "[role=listbox]",
  "[role=option]",
  "[role=radiogroup]",
  "[role=radio]",
  "[role=tablist]",
  "[role=tab]",
  "[role=slider]",
  "[role=spinbutton]",
  "[role=scrollbar]",
  "[role=grid]",
  "[role=treegrid]",
  "[role=tree]",
  "[role=treeitem]",
  "[role=combobox]",
].join(",");

/** True when `el` or an ancestor below <body> can scroll along the key's axis. */
function inScroller(el: HTMLElement, vertical: boolean): boolean {
  const { body, documentElement } = el.ownerDocument;
  for (let node: HTMLElement | null = el; node && node !== body && node !== documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    const overflow = vertical ? style.overflowY : style.overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (vertical ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth) return true;
  }
  return false;
}

/**
 * Whether an arrow key belongs to the focused page control rather than the
 * world camera: text fields, arrow-driven widgets, scroll panes and
 * `[data-ui-keys]` opt-outs keep their keys; `[data-world-keys]` hands them
 * to the camera regardless.
 */
export function keyBelongsToUi(target: EventTarget | null, key: CameraKey): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.closest("[data-world-keys]")) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return true;
  if (target.closest(ARROW_WIDGETS)) return true;
  return inScroller(target, key === "up" || key === "down");
}

export class InputController {
  enabled = true;
  private readonly el: HTMLElement;
  private readonly h: InputHandlers;
  private dragging = false;
  private dragId = -1;
  private lastX = 0;
  private lastY = 0;
  private readonly touches = new Map<number, TouchPoint>();
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private tapCandidate = false;
  private pinchDistance = 0;
  private midX = 0;
  private midY = 0;
  private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions | undefined][] = [];

  constructor(el: HTMLElement, handlers: InputHandlers) {
    this.el = el;
    this.h = handlers;
    this.listen(el, "pointerdown", this.onPointerDown as EventListener);
    this.listen(el, "pointermove", this.onPointerMove as EventListener);
    this.listen(el, "pointerup", this.onPointerUp as EventListener);
    this.listen(el, "pointercancel", this.onPointerUp as EventListener);
    this.listen(el, "pointerleave", this.onPointerLeave as EventListener);
    this.listen(el, "wheel", this.onWheel as EventListener, { passive: false });
    this.listen(el, "contextmenu", ((e: Event) => e.preventDefault()) as EventListener);
    this.listen(el, "auxclick", ((e: Event) => e.preventDefault()) as EventListener);
    this.listen(window, "keydown", this.onKeyDown as EventListener);
    this.listen(window, "keyup", this.onKeyUp as EventListener);
    this.listen(window, "blur", this.onBlur as EventListener);
  }

  dispose(): void {
    this.cancelLongPress();
    for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    this.touches.clear();
  }

  private listen(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const rect = this.el.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.h.gesture();
    if (!this.enabled) return;
    const [x, y] = this.local(e);
    if (e.pointerType === "touch") {
      e.preventDefault();
      this.touches.set(e.pointerId, { x, y, startX: x, startY: y });
      this.capture(e.pointerId);
      if (this.touches.size === 1) {
        this.tapCandidate = true;
        this.cancelLongPress();
        this.longPressTimer = setTimeout(() => {
          this.longPressTimer = null;
          if (!this.tapCandidate || this.touches.size !== 1) return;
          this.tapCandidate = false;
          const t = this.touches.values().next().value;
          if (t) this.h.menu(t.x, t.y);
        }, LONG_PRESS_MS);
      } else {
        this.tapCandidate = false;
        this.cancelLongPress();
        this.startGesture();
      }
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      this.dragging = true;
      this.dragId = e.pointerId;
      this.lastX = x;
      this.lastY = y;
      this.capture(e.pointerId);
      return;
    }
    if (e.button === 0) this.h.click(x, y);
    else if (e.button === 2) this.h.menu(x, y);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled) return;
    const [x, y] = this.local(e);
    if (e.pointerType === "touch") {
      const t = this.touches.get(e.pointerId);
      if (!t) return;
      t.x = x;
      t.y = y;
      if (this.touches.size === 1) {
        if (Math.hypot(x - t.startX, y - t.startY) > TAP_SLOP_PX) {
          this.tapCandidate = false;
          this.cancelLongPress();
        }
      } else if (this.touches.size >= 2) {
        this.moveGesture();
      }
      return;
    }
    if (this.dragging && e.pointerId === this.dragId) {
      this.h.drag(x - this.lastX, y - this.lastY);
      this.lastX = x;
      this.lastY = y;
      return;
    }
    this.h.hover(x, y);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      const t = this.touches.get(e.pointerId);
      this.touches.delete(e.pointerId);
      if (t && this.touches.size === 0 && this.tapCandidate && this.enabled) {
        this.cancelLongPress();
        this.tapCandidate = false;
        if (e.type === "pointerup") this.h.click(t.x, t.y);
      } else if (this.touches.size >= 2) {
        this.startGesture();
      } else if (this.touches.size === 0) {
        this.cancelLongPress();
      }
      return;
    }
    if (this.dragging && e.pointerId === this.dragId) {
      this.dragging = false;
      this.dragId = -1;
    }
  };

  private readonly onPointerLeave = (e: PointerEvent): void => {
    if (e.pointerType !== "touch" && !this.dragging) this.h.leave();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (!this.enabled) return;
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const delta = e.deltaY * unit;
    this.h.zoom(Math.max(-3, Math.min(3, delta / 100)));
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const key = KEY_MAP[e.key];
    if (!key || !this.enabled) return;
    // A control that handled the key, or a shortcut chord, keeps it.
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (keyBelongsToUi(e.target, key)) return;
    if (this.h.key(key, true)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    const key = KEY_MAP[e.key];
    if (key) this.h.key(key, false);
  };

  private readonly onBlur = (): void => {
    for (const key of Object.values(KEY_MAP)) this.h.key(key, false);
    this.dragging = false;
  };

  /** Keeps receiving a pointer's moves outside the element; the pointer may already be gone. */
  private capture(pointerId: number): void {
    try {
      this.el.setPointerCapture?.(pointerId);
    } catch {
      // Released before capture (or synthetic); events still arrive while over the element.
    }
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private gesturePoints(): [TouchPoint, TouchPoint] | null {
    const it = this.touches.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? [a, b] : null;
  }

  private startGesture(): void {
    const pts = this.gesturePoints();
    if (!pts) return;
    const [a, b] = pts;
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    this.midX = (a.x + b.x) / 2;
    this.midY = (a.y + b.y) / 2;
  }

  private moveGesture(): void {
    const pts = this.gesturePoints();
    if (!pts) return;
    const [a, b] = pts;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    this.h.drag(mx - this.midX, my - this.midY);
    if (this.pinchDistance > 0 && distance > 0) {
      // Spreading the fingers zooms in.
      this.h.zoom(Math.log(this.pinchDistance / distance) / Math.log(1.12));
    }
    this.pinchDistance = distance;
    this.midX = mx;
    this.midY = my;
  }
}
