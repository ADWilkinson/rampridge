import { StoneButton } from "@/ui/kit/buttons";
import { cx } from "@/ui/kit/cx";

export interface LoadingScreenProps {
  /** 0..1 */
  progress: number;
  /** What is loading, e.g. "Loading world". Defaults to "Loading". */
  label?: string;
  /** Plain-English failure; shows a retry button when `onRetry` is given. */
  error?: string | null;
  onRetry?: () => void;
  className?: string;
}

/**
 * The client loader: black screen, "RampRidge is loading - please wait..."
 * above the red-bordered bar with "<label> - 45%" inside it.
 */
export function LoadingScreen({ progress, label = "Loading", error = null, onRetry, className }: LoadingScreenProps) {
  const pct = Math.max(0, Math.min(100, Math.floor((Number.isFinite(progress) ? progress : 0) * 100)));
  return (
    <div className={cx("rs-loading rs-game", className)} role="status" aria-live="polite" aria-busy={!error}>
      <p className="rs-loading__headline rs-b12">{error ? "RampRidge could not load." : "RampRidge is loading - please wait..."}</p>
      <div
        className={cx("rs-loading__bar", error && "rs-loading__bar--error")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={label}
      >
        <span className="rs-loading__fill" style={{ width: (error ? 100 : pct) * 3 }} />
        <span className="rs-loading__text rs-b12">{error ? "Error" : `${label} - ${pct}%`}</span>
      </div>
      {error && (
        <div className="rs-loading__error">
          <p className="rs-p12" role="alert">
            {error}
          </p>
          {onRetry && <StoneButton onClick={onRetry}>Try again</StoneButton>}
        </div>
      )}
    </div>
  );
}
