import { useEffect, useRef } from "react";
import { cx } from "./cx";
import { formatCountdown, formatDurationWords } from "./format";
import { useNow } from "./hooks";

export interface CountdownTextProps {
  /** Deadline, epoch ms. */
  until: number;
  /** Clock to count against (e.g. the server clock); defaults to Date.now. */
  now?: () => number;
  /** "clock" -> 14:59, "words" -> 14 minutes. */
  format?: "clock" | "words";
  /** Turns red below this many ms (default 5 minutes). */
  warnBelowMs?: number;
  /** Shown once the deadline has passed. */
  expiredText?: string;
  onExpire?: () => void;
  className?: string;
}

/** Remaining time that ticks every second and turns red near expiry. */
export function CountdownText({ until, now = Date.now, format = "clock", warnBelowMs = 5 * 60_000, expiredText = "Expired", onExpire, className }: CountdownTextProps) {
  const t = useNow(now, 1000);
  const left = until - t;
  const expired = left <= 0;
  const fired = useRef(false);
  useEffect(() => {
    if (expired && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
    if (!expired) fired.current = false;
  }, [expired, onExpire]);
  const text = expired ? expiredText : format === "clock" ? formatCountdown(left) : formatDurationWords(left);
  return (
    <time
      className={cx("rs-countdown", !expired && left < warnBelowMs && "rs-countdown--warn", expired && "rs-countdown--expired", className)}
      dateTime={new Date(until).toISOString()}
      aria-live={left < 60_000 ? "polite" : "off"}
    >
      {text}
    </time>
  );
}
