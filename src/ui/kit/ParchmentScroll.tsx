import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import { CloseButton } from "./buttons";
import { ChatPromptScope } from "./ChatPrompt";
import { cx } from "./cx";
import { useCompactLandscape, useEscapeLayer, useFitScale, useFocusTrap } from "./hooks";
import { needsUpright } from "./layout";
import { useSprite } from "./sprites";
import { UprightNotice } from "./UprightNotice";

export interface ParchmentScrollProps {
  /** Dark red title in the quill hand. */
  title?: ReactNode;
  children?: ReactNode;
  onClose?: () => void;
  width?: number;
  className?: string;
  style?: CSSProperties;
  /** Scale down to fit small screens (default true). */
  fit?: boolean;
  ariaLabel?: string;
}

/**
 * A parchment scroll, like a clue scroll: black text on the scroll sprite
 * (stretched to the content), with the curled close button. Falls back to a
 * CSS parchment with rolls when the sprite is missing. Used for the Payment
 * scroll and How it works. On a phone held sideways a scroll that would scale
 * below MIN_LEGIBLE_SCALE is hidden behind a notice to turn the phone upright.
 */
export function ParchmentScroll({ title, children, onClose, width = 420, className, style, fit = true, ariaLabel }: ParchmentScrollProps) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const scale = useFitScale(ref, fit);
  const upright = needsUpright(useCompactLandscape(), scale);
  const art = useSprite("parchmentScroll");
  const drawn = art.status !== "missing";
  useEscapeLayer(onClose, Boolean(onClose));
  useFocusTrap(ref, true);
  return (
    <>
    <section
      ref={ref}
      className={cx("rs-scrollpaper rs-game rs-p12", drawn ? "rs-scrollpaper--art" : "rs-scrollpaper--css", upright && "rs-fit-hidden", className)}
      style={{ width: `min(${width}px, calc(100vw - 16px))`, transform: scale !== 1 ? `scale(${scale})` : undefined, ...({ "--rs-fit-scale": scale } as CSSProperties), ...style }}
      role="dialog"
      aria-modal="false"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : ariaLabel}
      tabIndex={-1}
    >
      {!drawn && <span className="rs-scrollpaper__roll rs-scrollpaper__roll--top" aria-hidden="true" />}
      <div className="rs-scrollpaper__sheet">
        {title && (
          <h2 id={titleId} className="rs-scrollpaper__title rs-quill">
            {title}
          </h2>
        )}
        <ChatPromptScope>{children}</ChatPromptScope>
        {onClose && <CloseButton variant="parchment" className="rs-scrollpaper__close" onClick={onClose} />}
      </div>
      {!drawn && <span className="rs-scrollpaper__roll rs-scrollpaper__roll--bottom" aria-hidden="true" />}
    </section>
    {upright && <UprightNotice onClose={onClose} />}
    </>
  );
}
