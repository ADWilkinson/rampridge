import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";
import { SPRITES, useSprite, useSpriteById, type SpriteName } from "./sprites";

interface SpriteCommon {
  /** Accessible name; omit for decorative sprites. */
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * Draw inside the sprite's full canvas (`mw` x `mh`) at its cache offset,
   * which is how the client positions icons inside their slots.
   */
  canvas?: boolean;
  /** Rendered when the sprite file is missing. Defaults to a flat fill in the sprite's average colour. */
  fallback?: ReactNode;
  /** Integer scale; sprites stay pixel-crisp. */
  scale?: number;
}

export type SpriteProps = SpriteCommon & ({ name: SpriteName; id?: never; frame?: never } | { id: number; frame?: number; name?: never });

/** One cache sprite, pixel-crisp, with a graceful fallback when the file is missing. */
export function Sprite(props: SpriteProps) {
  return props.name !== undefined ? <NamedSprite {...props} name={props.name} /> : <IdSprite {...props} id={props.id} />;
}

function NamedSprite({ name, alt, className, style, canvas, fallback, scale = 1 }: SpriteCommon & { name: SpriteName }) {
  const s = useSprite(name);
  const def = s.def;
  const w = canvas ? def.mw : def.w;
  const h = canvas ? def.mh : def.h;
  const box: CSSProperties = { width: w * scale, height: h * scale, ...style };
  if (s.status === "missing") {
    if (fallback !== undefined) {
      return (
        <span className={cx("rs-sprite rs-sprite--fallback", className)} style={box} role={alt ? "img" : undefined} aria-label={alt} aria-hidden={alt ? undefined : true}>
          {fallback}
        </span>
      );
    }
    return (
      <span
        className={cx("rs-sprite rs-sprite--fallback", className)}
        style={{ ...box, background: canvas ? undefined : def.avg }}
        role={alt ? "img" : undefined}
        aria-label={alt}
        aria-hidden={alt ? undefined : true}
      />
    );
  }
  return (
    <span
      className={cx("rs-sprite", className)}
      style={{
        ...box,
        backgroundImage: s.url ? `url("${s.url}")` : undefined,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${def.w * scale}px ${def.h * scale}px`,
        backgroundPosition: canvas ? `${def.ox * scale}px ${def.oy * scale}px` : "0 0",
      }}
      role={alt ? "img" : undefined}
      aria-label={alt}
      aria-hidden={alt ? undefined : true}
    />
  );
}

function IdSprite({ id, frame = 0, alt, className, style, fallback, scale = 1 }: SpriteCommon & { id: number; frame?: number }) {
  const s = useSpriteById(id, frame);
  if (s.status === "missing") {
    return fallback !== undefined ? (
      <span className={cx("rs-sprite rs-sprite--fallback", className)} style={style} role={alt ? "img" : undefined} aria-label={alt} aria-hidden={alt ? undefined : true}>
        {fallback}
      </span>
    ) : null;
  }
  return (
    <span
      className={cx("rs-sprite", className)}
      style={{
        width: s.width * scale,
        height: s.height * scale,
        backgroundImage: s.url ? `url("${s.url}")` : undefined,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${s.width * scale}px ${s.height * scale}px`,
        ...style,
      }}
      role={alt ? "img" : undefined}
      aria-label={alt}
      aria-hidden={alt ? undefined : true}
    />
  );
}

/** Pixel size of a registered sprite (trimmed, or its full canvas). */
export function spriteSize(name: SpriteName, canvas = false): { w: number; h: number } {
  const d = SPRITES[name];
  return canvas ? { w: d.mw, h: d.mh } : { w: d.w, h: d.h };
}
