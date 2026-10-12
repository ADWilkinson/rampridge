import { cx } from "./cx";
import { useReducedMotion, useTick } from "./hooks";

export interface PleaseWaitProps {
  /** Defaults to "Please wait". Dots cycle on the game tick unless motion is reduced. */
  text?: string;
  className?: string;
}

/** The client's "Please wait..." line, announced politely to screen readers. */
export function PleaseWait({ text = "Please wait", className }: PleaseWaitProps) {
  const reduced = useReducedMotion();
  const tick = useTick(!reduced);
  const dots = reduced ? "..." : ".".repeat((tick % 3) + 1);
  return (
    <span className={cx("rs-pleasewait", className)} role="status" aria-live="polite">
      <span className="rs-visually-hidden">{text}...</span>
      <span aria-hidden="true">
        {text}
        <span className="rs-pleasewait__dots">{dots}</span>
      </span>
    </span>
  );
}
