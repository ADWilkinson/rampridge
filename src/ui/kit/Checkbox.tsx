import { useRef, type ReactNode } from "react";
import { cx } from "./cx";
import { sliderLevelAt } from "./slider";
import { Sprite } from "./Sprite";
import { useSprite, type SpriteName } from "./sprites";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** The settings checkbox (stone box, green tick), label in orange. */
export function Checkbox({ checked, onChange, label, disabled = false, className }: CheckboxProps) {
  const s = useSprite("checkbox");
  return (
    <label className={cx("rs-check rs-p12", s.status === "missing" && "rs-check--fallback", disabled && "rs-check--disabled", className)}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="rs-check__box" aria-hidden="true">
        <span className="rs-check__tick rs-b12">✓</span>
      </span>
      <span>{label}</span>
    </label>
  );
}

export interface ToggleProps {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  /** Accessible name, e.g. "Chat effects". */
  label: string;
  /** Icon sprite drawn on the box (OptionsIcons). */
  icon?: SpriteName;
  /** Text shown on the box when the icon sprite is missing. */
  fallbackText?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * The classic settings toggle: a 40x40 stone box with an icon that turns red
 * while the option is on.
 */
export function Toggle({ pressed, onChange, label, icon, fallbackText, disabled = false, className }: ToggleProps) {
  return (
    <button type="button" className={cx("rs-toggle", className)} aria-pressed={pressed} aria-label={label} disabled={disabled} onClick={() => onChange(!pressed)}>
      {icon ? (
        <Sprite name={icon} canvas fallback={<span className="rs-toggle__fallback rs-b12">{fallbackText ?? label.slice(0, 3)}</span>} />
      ) : (
        <span className="rs-toggle__fallback rs-b12">{fallbackText ?? label.slice(0, 3)}</span>
      )}
    </button>
  );
}

const SEGMENTS: readonly [SpriteName, SpriteName][] = [
  ["sliderLeft", "sliderLeftKnob"],
  ["sliderMiddleA", "sliderMiddleAKnob"],
  ["sliderMiddleB", "sliderMiddleBKnob"],
  ["sliderRight", "sliderRightKnob"],
];

export interface VolumeSliderProps {
  /** 0 (muted) to 4. */
  value: number;
  onChange: (value: number) => void;
  label: string;
  icon: SpriteName;
  mutedIcon: SpriteName;
  disabled?: boolean;
  className?: string;
}

/**
 * The classic settings volume bar: an icon that mutes, then four notches.
 * Arrow keys change the level when the bar has focus.
 */
export function VolumeSlider({ value, onChange, label, icon, mutedIcon, disabled = false, className }: VolumeSliderProps) {
  const lastLevel = useRef(value > 0 ? value : 4);
  if (value > 0) lastLevel.current = value;
  const level = Math.max(0, Math.min(4, Math.round(value)));
  const set = (v: number) => {
    if (!disabled) onChange(Math.max(0, Math.min(4, v)));
  };
  const left = useSprite("sliderLeft");
  const fallback = left.status === "missing";
  return (
    <div className={cx("rs-slider", className)}>
      <button
        type="button"
        className="rs-slider__icon"
        aria-label={level === 0 ? `Unmute ${label.toLowerCase()}` : `Mute ${label.toLowerCase()}`}
        aria-pressed={level === 0}
        disabled={disabled}
        onClick={() => set(level === 0 ? lastLevel.current : 0)}
      >
        <Sprite name={level === 0 ? mutedIcon : icon} canvas fallback={<span className="rs-slider__mute rs-p11">{level === 0 ? "Off" : "Mute"}</span>} />
      </button>
      <div
        className="rs-slider__track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${label} volume`}
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={level}
        aria-valuetext={level === 0 ? "Off" : `${level} of 4`}
        aria-disabled={disabled || undefined}
        onPointerDown={(e) => {
          // The whole track (and its enlarged touch area) picks the notch under the pointer.
          const r = e.currentTarget.getBoundingClientRect();
          if (r.width > 0) set(sliderLevelAt(e.clientX - r.left, r.width, SEGMENTS.length));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            set(level - 1);
          } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            set(level + 1);
          } else if (e.key === "Home") {
            e.preventDefault();
            set(0);
          } else if (e.key === "End") {
            e.preventDefault();
            set(4);
          }
        }}
      >
        {SEGMENTS.map(([plain, knob], i) => {
          const on = level === i + 1;
          return (
            <span
              key={plain}
              className={cx("rs-slider__seg", fallback && "rs-slider__seg--fallback", fallback && on && "rs-slider__seg--on")}
              style={{ width: 32, height: 16, backgroundImage: fallback ? undefined : `var(--spr-${on ? knob : plain})`, backgroundPosition: on ? "0 0" : "0 1px" }}
            />
          );
        })}
      </div>
    </div>
  );
}
