import { cx } from "@/ui/kit/cx";
import { TARGET_COLORS, type MenuEntry } from "./menu";

export interface MouseoverTextProps {
  /** The first (left-click) option under the cursor, as the engine's `hover` event gives it. */
  first: MenuEntry | null;
  /** How many further options a right click would show. */
  more?: number;
  className?: string;
}

/**
 * Top-left mouseover line: "Bank Banker / 3 more options", verb in white,
 * target in its kind colour.
 */
export function MouseoverText({ first, more = 0, className }: MouseoverTextProps) {
  if (!first) return null;
  return (
    <div className={cx("rs-mouseover rs-b12 rs-shadow", className)} aria-hidden="true">
      <span>{first.verb}</span>
      {first.targetName && (
        <>
          {" "}
          <span style={{ color: TARGET_COLORS[first.kind ?? "tile"] }}>{first.targetName}</span>
        </>
      )}
      {first.suffix && <span> {first.suffix}</span>}
      {more > 0 && <span> / {more} more option{more === 1 ? "" : "s"}</span>}
    </div>
  );
}
