import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

export type ProgressState = "progress" | "complete" | "aborted";

export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  /** Orange while in progress, green when complete, red when aborted. */
  state?: ProgressState;
  width?: number | string;
  height?: number;
  /** Optional centred text, e.g. "50%". */
  label?: ReactNode;
  /** Accessible name, e.g. "Offer progress". */
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/** The Grand Exchange offer bar. */
export function ProgressBar({ value, state = "progress", width = 105, height = 15, label, ariaLabel = "Progress", className, style }: ProgressBarProps) {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const pct = state === "progress" ? v : 1;
  return (
    <div
      className={cx("rs-progress", `rs-progress--${state}`, className)}
      style={{ width, height, ...style }}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-valuetext={state === "aborted" ? "Aborted" : state === "complete" ? "Complete" : `${Math.round(v * 100)}%`}
    >
      <span className="rs-progress__fill" style={{ width: `${pct * 100}%` }} />
      {label !== undefined && <span className="rs-progress__label rs-p11">{label}</span>}
    </div>
  );
}
