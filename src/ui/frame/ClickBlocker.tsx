import type { ReactNode } from "react";
import { cx } from "@/ui/kit/cx";

export interface ClickBlockerProps {
  /** Called on a click that lands on the blocker (not its children). */
  onClick?: () => void;
  /** Darken the world behind (default false, the client never dims). */
  dim?: boolean;
  children?: ReactNode;
  className?: string;
}

/**
 * A full-window layer that swallows pointer input so the world behind cannot
 * be clicked, e.g. while a transaction is pending.
 */
export function ClickBlocker({ onClick, dim = false, children, className }: ClickBlockerProps) {
  return (
    <div
      className={cx("rs-clickblocker rs-game", dim && "rs-clickblocker--dim", className)}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClick?.();
      }}
    >
      {children}
    </div>
  );
}
