/**
 * Reduced motion for the world: on when the player turns it on in Settings
 * or the system asks for it (prefers-reduced-motion), and re-evaluated when
 * either changes. `onChange` fires only when the combined value flips.
 */

/** The part of MediaQueryList this needs (a fake in tests). */
export interface MotionQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (event: { matches: boolean }) => void): void;
}

function systemQuery(): MotionQuery | null {
  return typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
}

export class ReducedMotion {
  private setting = false;
  private system: boolean;
  private current: boolean;
  private readonly query: MotionQuery | null;
  private readonly onChange: (reduced: boolean) => void;

  constructor(onChange: (reduced: boolean) => void, query: MotionQuery | null = systemQuery()) {
    this.onChange = onChange;
    this.query = query;
    this.system = query?.matches ?? false;
    this.current = this.system;
    query?.addEventListener("change", this.onQuery);
  }

  /** True when motion should be reduced (the setting or the system preference). */
  get reduced(): boolean {
    return this.current;
  }

  /** The player's Settings choice. */
  setSetting(enabled: boolean): void {
    this.setting = enabled;
    this.update();
  }

  dispose(): void {
    this.query?.removeEventListener("change", this.onQuery);
  }

  private readonly onQuery = (event: { matches: boolean }): void => {
    this.system = event.matches;
    this.update();
  };

  private update(): void {
    const next = this.setting || this.system;
    if (next === this.current) return;
    this.current = next;
    this.onChange(next);
  }
}
