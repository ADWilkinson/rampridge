import { StoneButton } from "./buttons";
import { Frame } from "./Frame";

export interface UprightNoticeProps {
  /** Closes the interface the notice stands in for. */
  onClose?: () => void;
}

/**
 * Stands in for an interface that would be too small to read on a phone held
 * sideways: a small stone panel asking the player to turn the phone upright.
 * Rendered next to the hidden interface inside a `.rs-window-host`, so the
 * interface keeps its state (and reappears) when the phone turns.
 */
export function UprightNotice({ onClose }: UprightNoticeProps) {
  return (
    <div className="rs-upright">
      <div className="rs-upright__panel rs-game" role="alert">
        <Frame variant="stone" />
        <p className="rs-upright__title rs-b12">Turn your phone upright to trade.</p>
        <p className="rs-upright__text rs-p12">This window is too small to read sideways.</p>
        {onClose && <StoneButton onClick={onClose}>Close</StoneButton>}
      </div>
    </div>
  );
}
