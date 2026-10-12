import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { Sprite } from "./Sprite";
import { useSprite, type SpriteName } from "./sprites";

type ButtonAttrs = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type">;

export interface CloseButtonProps extends ButtonAttrs {
  label?: string;
  /** "parchment" is the scroll's curled close button. */
  variant?: "stone" | "parchment";
}

/** The interface close button (CloseButtons sprite, highlight on hover). */
export function CloseButton({ label = "Close", variant = "stone", className, ...rest }: CloseButtonProps) {
  const s = useSprite(variant === "parchment" ? "closeButtonParchment" : "closeButton");
  return (
    <button
      type="button"
      aria-label={label}
      className={cx("rs-close", variant === "parchment" && "rs-close--parchment", s.status === "missing" && "rs-close--fallback", className)}
      {...rest}
    >
      <span className="rs-close__x rs-b12" aria-hidden="true">
        X
      </span>
    </button>
  );
}

export interface NineSliceTiles {
  nw: SpriteName;
  n: SpriteName;
  ne: SpriteName;
  w: SpriteName;
  c: SpriteName;
  e: SpriteName;
  sw: SpriteName;
  s: SpriteName;
  se: SpriteName;
}

const GREY: NineSliceTiles = {
  nw: "buttonGreyNW",
  n: "buttonGreyN",
  ne: "buttonGreyNE",
  w: "buttonGreyW",
  c: "buttonGreyC",
  e: "buttonGreyE",
  sw: "buttonGreySW",
  s: "buttonGreyS",
  se: "buttonGreySE",
};

const RED: NineSliceTiles = {
  nw: "buttonRedNW",
  n: "buttonRedN",
  ne: "buttonRedNE",
  w: "buttonRedW",
  c: "buttonRedC",
  e: "buttonRedE",
  sw: "buttonRedSW",
  s: "buttonRedS",
  se: "buttonRedSE",
};

/** Stone button tiles: grey normally, red when selected or pressed. */
export const BUTTON_TILES = { grey: GREY, red: RED } as const;

/**
 * Nine tiles stretched over the parent (position: relative). Edges and the
 * centre repeat; corners do not. A missing tile falls back to a flat fill
 * shaded light on the top-left edges and dark on the bottom-right ones.
 */
export function NineSlice({ tiles, base, light, dark, className }: { tiles: NineSliceTiles; base: string; light: string; dark: string; className?: string }) {
  const bg = (name: SpriteName, fallback: string): CSSProperties => ({
    backgroundImage: `var(--spr-${name}, linear-gradient(${fallback}, ${fallback}))`,
  });
  return (
    <span className={cx("rs-nine", className)} aria-hidden="true">
      <span style={{ backgroundImage: `var(--spr-${tiles.nw}, none)` }} />
      <span style={bg(tiles.n, light)} />
      <span style={{ backgroundImage: `var(--spr-${tiles.ne}, none)` }} />
      <span style={bg(tiles.w, light)} />
      <span style={bg(tiles.c, base)} />
      <span style={bg(tiles.e, dark)} />
      <span style={{ backgroundImage: `var(--spr-${tiles.sw}, none)` }} />
      <span style={bg(tiles.s, dark)} />
      <span style={{ backgroundImage: `var(--spr-${tiles.se}, none)` }} />
    </span>
  );
}

export interface StoneButtonProps extends ButtonAttrs {
  children?: ReactNode;
  /** Red tiles, as the client draws a selected toggle (e.g. "Note" in the bank). */
  selected?: boolean;
  size?: "normal" | "big";
  wide?: boolean;
  /** Use type="submit" inside forms. */
  submit?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The stone interface button: grey nine-slice, orange label that turns white
 * on hover, red tiles when selected, dimmed when disabled.
 */
export function StoneButton({ children, selected = false, size = "normal", wide = false, submit = false, className, ...rest }: StoneButtonProps) {
  return (
    <button
      type={submit ? "submit" : "button"}
      className={cx("rs-btn rs-p12", size === "big" && "rs-btn--big", wide && "rs-btn--wide", selected && "rs-btn--selected", className)}
      aria-pressed={rest["aria-pressed"] ?? (selected ? true : undefined)}
      {...rest}
    >
      <NineSlice tiles={selected ? RED : GREY} base={selected ? "#811e1c" : "#50504c"} light={selected ? "#a2342f" : "#6e6c66"} dark={selected ? "#4e100e" : "#2e2d2a"} />
      <span className="rs-btn__label">{children}</span>
    </button>
  );
}

export type TextTone = "orange" | "yellow" | "white" | "blue" | "black";

export interface TextButtonProps extends ButtonAttrs {
  children?: ReactNode;
  tone?: TextTone;
  font?: "p11" | "p12" | "b12";
}

/** A text-only option ("Click here to logout", "Check availability"), white on hover. */
export function TextButton({ children, tone = "orange", font = "p12", className, ...rest }: TextButtonProps) {
  return (
    <button type="button" className={cx("rs-textbtn", `rs-${font}`, `rs-textbtn--${tone}`, className)} {...rest}>
      {children}
    </button>
  );
}

export interface ArrowButtonProps extends ButtonAttrs {
  direction: "left" | "right";
  label: string;
}

/** The stone arrow buttons from the character designer. */
export function ArrowButton({ direction, label, className, ...rest }: ArrowButtonProps) {
  const name: SpriteName = direction === "left" ? "arrowLeft" : "arrowRight";
  const hover: SpriteName = direction === "left" ? "arrowLeftHover" : "arrowRightHover";
  return (
    <button type="button" aria-label={label} className={cx("rs-arrowbtn", className)} {...rest}>
      <Sprite name={name} className="rs-arrowbtn__img" fallback={<span className="rs-arrowbtn__fallback rs-b12">{direction === "left" ? "<" : ">"}</span>} />
      <Sprite name={hover} className="rs-arrowbtn__hover" fallback={null} />
    </button>
  );
}
