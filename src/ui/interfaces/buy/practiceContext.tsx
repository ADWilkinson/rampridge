import { createContext, useContext } from "react";
import { cx } from "@/ui/kit";

/**
 * True inside a practice trade (Practice.tsx). The buy interfaces read it to
 * say so on every screen and to leave out what only a real order has: the
 * pay link and QR code, help with the order, sharing, the world announcement.
 */
export const PracticeContext = createContext(false);

export function usePractice(): boolean {
  return useContext(PracticeContext);
}

/** Said on every practice screen. */
const PRACTICE_NOTE = "Practice trade: no money moves.";

export function PracticeNote({ tone = "stone", className }: { tone?: "stone" | "parchment"; className?: string }) {
  return (
    <p className={cx("rb-practice rs-b12", tone === "parchment" ? "rb-ink-red" : "rs-c-yellow rs-shadow", className)} role="note">
      {PRACTICE_NOTE}
    </p>
  );
}
