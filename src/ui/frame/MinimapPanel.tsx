import type { ReactNode, Ref } from "react";
import { cx } from "@/ui/kit/cx";
import { formatDecimal, orbTextColor, STACK_COLORS } from "@/ui/kit/format";
import { Sprite } from "@/ui/kit/Sprite";
import { coinsSpriteFor } from "@/ui/kit/sprites";
import type { MenuEntry } from "./menu";

/** Size of the visible map area inside the frame (the FIXED_MAP_MASK sprite). */
export const MINIMAP_SIZE = { width: 145, height: 151 } as const;

/**
 * CSS size of the compass canvas (the COMPASS sprite is 51x51). The canvas
 * sits behind the 33px compass hole, centred on the sprite's middle, so a
 * renderer that draws the whole sprite to fit the canvas draws it 1:1 and the
 * hole shows the middle 33px, like the client.
 */
export const COMPASS_CANVAS_SIZE = 51;

export interface MinimapPanelProps {
  /** The engine draws the map into this canvas every frame (EngineApi.attachMinimap). */
  canvasRef?: Ref<HTMLCanvasElement>;
  /** Backing-store size of the canvas; defaults to the CSS size times devicePixelRatio. */
  canvasWidth?: number;
  canvasHeight?: number;
  /**
   * The engine draws the rotating compass into this canvas
   * (Engine.attachCompass), in the same frame as the map. When set it replaces
   * the DOM needle and `compassAngle` is ignored. Its backing store is
   * COMPASS_CANVAS_SIZE times devicePixelRatio (at most 2).
   */
  compassCanvasRef?: Ref<HTMLCanvasElement>;
  /**
   * Camera yaw in radians for the DOM needle, the engine's getCameraYaw():
   * 0 faces north and positive turns the needle clockwise on screen, the
   * same way the engine turns the minimap. Ignored with `compassCanvasRef`.
   */
  compassAngle?: number;
  /**
   * Pressing the compass faces the camera north (also the keyboard path when
   * the engine handles pointer presses on its compass canvas).
   */
  onCompassClick?: () => void;
  /** 0..100 */
  runEnergy: number;
  running: boolean;
  onToggleRun: () => void;
  /** Wallet USDC (decimal string) or null when no wallet is connected. */
  usdcBalance: string | null;
  onUsdcClick?: () => void;
  /** Mouseover line for the HUD ("Toggle Run"), or null when the pointer leaves. */
  onHover?: (entry: MenuEntry | null) => void;
  className?: string;
}

/** Whole-dollar orb label: "125", "12K", "3M". */
export function orbBalanceLabel(balance: string | null): { text: string; color: string } {
  if (balance === null) return { text: "--", color: "#9f9f9f" };
  const n = Math.floor(Number(balance));
  if (!Number.isFinite(n) || n < 0) return { text: "0", color: STACK_COLORS.units };
  if (n < 1_000) return { text: String(n), color: STACK_COLORS.units };
  if (n < 100_000) return { text: `${Math.floor(n / 1_000)}K`, color: STACK_COLORS.units };
  if (n < 10_000_000) return { text: `${Math.floor(n / 1_000)}K`, color: STACK_COLORS.thousands };
  return { text: `${Math.floor(n / 1_000_000)}M`, color: STACK_COLORS.millions };
}

interface OrbProps {
  label: string;
  value: string;
  color: string;
  fill: "orbFillRun" | "orbFillRunActive" | "orbFillUsdc" | "orbEmpty";
  /** 0..1 of the orb that is filled (drains from the top). */
  level: number;
  icon: ReactNode;
  onClick?: () => void;
  pressed?: boolean;
  hover: MenuEntry;
  onHover?: (entry: MenuEntry | null) => void;
  className?: string;
}

function Orb({ label, value, color, fill, level, icon, onClick, pressed, hover, onHover, className }: OrbProps) {
  const lv = Math.min(1, Math.max(0, level));
  return (
    <button
      type="button"
      className={cx("rs-orb", className)}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      onPointerEnter={() => onHover?.(hover)}
      onPointerLeave={() => onHover?.(null)}
    >
      <span className="rs-orb__frame" aria-hidden="true" />
      <span className="rs-orb__value rs-p11" style={{ color }} aria-hidden="true">
        {value}
      </span>
      <span className="rs-orb__well" aria-hidden="true">
        <span className="rs-orb__empty" />
        <span className="rs-orb__fill" style={{ clipPath: `inset(${Math.round((1 - lv) * 26)}px 0 0 0)`, backgroundImage: `var(--spr-${fill})` }} data-fill={fill} />
        <span className="rs-orb__icon">{icon}</span>
      </span>
    </button>
  );
}

/**
 * Top-right minimap: the stone frame over a canvas the engine draws into,
 * the compass (click to face north) and two orbs: Run energy (click toggles
 * run) and the USDC balance (click opens the inventory).
 */
export function MinimapPanel({
  canvasRef,
  canvasWidth,
  canvasHeight,
  compassCanvasRef,
  compassAngle = 0,
  onCompassClick,
  runEnergy,
  running,
  onToggleRun,
  usdcBalance,
  onUsdcClick,
  onHover,
  className,
}: MinimapPanelProps) {
  const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const energy = Math.max(0, Math.min(100, Math.floor(runEnergy)));
  const bal = orbBalanceLabel(usdcBalance);
  const usdcLabel = usdcBalance === null ? "USDC balance: no wallet connected" : `USDC balance: ${formatDecimal(usdcBalance, 2)}`;
  return (
    <div className={cx("rs-minimap rs-game", className)}>
      <div className="rs-minimap__map">
        <canvas
          ref={canvasRef}
          className="rs-minimap__canvas"
          width={canvasWidth ?? Math.round(MINIMAP_SIZE.width * dpr)}
          height={canvasHeight ?? Math.round(MINIMAP_SIZE.height * dpr)}
          aria-label="Minimap"
        />
      </div>
      <Sprite name="minimapFrame" className="rs-minimap__frame" fallback={<span className="rs-minimap__frame-fallback" />} />
      <button
        type="button"
        className="rs-minimap__compass"
        aria-label="Face north"
        onClick={onCompassClick}
        onPointerEnter={() => onHover?.({ verb: "Face North" })}
        onPointerLeave={() => onHover?.(null)}
      >
        <span className="rs-minimap__disc" aria-hidden="true">
          {compassCanvasRef ? (
            <canvas
              ref={compassCanvasRef}
              className="rs-minimap__compass-canvas"
              width={Math.round(COMPASS_CANVAS_SIZE * dpr)}
              height={Math.round(COMPASS_CANVAS_SIZE * dpr)}
            />
          ) : (
            <span className="rs-minimap__needle" style={{ transform: `rotate(${compassAngle}rad)` }}>
              <Sprite name="compass" fallback={<span className="rs-minimap__needle-fallback rs-b12">N</span>} />
            </span>
          )}
        </span>
      </button>
      <Orb
        className="rs-orb--usdc"
        label={usdcLabel}
        value={bal.text}
        color={bal.color}
        fill={usdcBalance === null ? "orbEmpty" : "orbFillUsdc"}
        level={1}
        icon={<Sprite name={coinsSpriteFor(Number(usdcBalance ?? 0))} className="rs-orb__coins" fallback={<span className="rs-orb__glyph rs-b12">$</span>} />}
        onClick={onUsdcClick}
        hover={{ verb: "View", targetName: "USDC", kind: "item" }}
        onHover={onHover}
      />
      <Orb
        className="rs-orb--run"
        label={`Run energy ${energy}%. ${running ? "Running" : "Walking"}`}
        value={String(energy)}
        color={orbTextColor(energy / 100)}
        fill={running ? "orbFillRunActive" : "orbFillRun"}
        level={energy / 100}
        icon={<Sprite name={running ? "orbIconRun" : "orbIconWalk"} canvas fallback={<span className="rs-orb__glyph rs-b12">{running ? "R" : "W"}</span>} />}
        onClick={onToggleRun}
        pressed={running}
        hover={{ verb: "Toggle Run" }}
        onHover={onHover}
      />
    </div>
  );
}
