import { cx } from "./cx";

/** The interface border pieces alone (stone or steel), for custom layouts that need the frame. */
export function Frame({ variant = "stone", titled = false }: { variant?: "stone" | "steel"; titled?: boolean }) {
  return (
    <div className={cx("rs-frame", `rs-frame--${variant}`)} aria-hidden="true">
      <span className="rs-frame__t" />
      <span className="rs-frame__b" />
      <span className="rs-frame__l" />
      <span className="rs-frame__r" />
      {titled && <span className="rs-frame__div" />}
      {titled && variant === "stone" && <span className="rs-frame__divl" />}
      {titled && variant === "stone" && <span className="rs-frame__divr" />}
      <span className="rs-frame__tl" />
      <span className="rs-frame__tr" />
      <span className="rs-frame__bl" />
      <span className="rs-frame__br" />
    </div>
  );
}
