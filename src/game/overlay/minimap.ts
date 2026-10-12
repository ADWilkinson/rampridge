import type { Tile } from "@shared/protocol";
import { joinUrl, loadImage, type SpriteFrame } from "../assets";

/**
 * The minimap: the cache-rendered map image (4 px per tile, north up) drawn
 * in a circle around the local player, rotated with the camera, with the
 * baked map function icons (bank, anvil, shops) upright on their tiles, the
 * client's dots (white for players, yellow for NPCs), the local player as a
 * white square in the centre and the red flag on the walk destination.
 */

export interface MinimapGeo {
  /** World tile at the image's south-west corner. */
  originX: number;
  originY: number;
  widthTiles: number;
  heightTiles: number;
  /** Image pixels per tile. */
  pxPerTile: number;
}

/**
 * The seed image public/game/world/minimap.png is map square (49, 53):
 * world 3136..3199 x 3392..3455 at 4 px per tile.
 */
export const SEED_MINIMAP_GEO: MinimapGeo = { originX: 3136, originY: 3392, widthTiles: 64, heightTiles: 64, pxPerTile: 4 };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads the bake's minimap.json, tolerating the common key spellings. */
export function parseMinimapGeo(raw: unknown, imageWidth: number, imageHeight: number): MinimapGeo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const px = num(r.pxPerTile) ?? num(r.pixelsPerTile) ?? num(r.tilePx) ?? num(r.scale) ?? 4;
  let originX = num(r.originX) ?? num(r.baseX) ?? num(r.minX) ?? num(r.x);
  let originY = num(r.originY) ?? num(r.baseY) ?? num(r.minY) ?? num(r.y);
  const regionId = num(r.regionId) ?? num(r.region);
  if ((originX === null || originY === null) && regionId !== null) {
    originX = (regionId >> 8) * 64;
    originY = (regionId & 0xff) * 64;
  }
  const mapX = num(r.mapX);
  const mapY = num(r.mapY);
  if ((originX === null || originY === null) && mapX !== null && mapY !== null) {
    originX = mapX * 64;
    originY = mapY * 64;
  }
  if (originX === null || originY === null || px <= 0) return null;
  const widthTiles = num(r.widthTiles) ?? num(r.tilesWide) ?? imageWidth / px;
  const heightTiles = num(r.heightTiles) ?? num(r.tilesHigh) ?? imageHeight / px;
  return { originX, originY, widthTiles, heightTiles, pxPerTile: px };
}

/** A map function icon from the bake (minimap.json `icons`), drawn upright centred on its tile. */
export interface MinimapIcon {
  name: string;
  tileX: number;
  tileY: number;
  /** Icon size in minimap pixels (4 per tile). */
  w: number;
  h: number;
  image: CanvasImageSource;
}

/** An `icons` entry of minimap.json before its image is loaded; `file` is relative to the JSON. */
export interface MinimapIconSpec {
  name: string;
  file: string;
  tileX: number;
  tileY: number;
  w: number | null;
  h: number | null;
}

/** Reads the bake's `icons` array; malformed entries are skipped. */
export function parseMinimapIcons(raw: unknown): MinimapIconSpec[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as Record<string, unknown>).icons;
  if (!Array.isArray(list)) return [];
  const out: MinimapIconSpec[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const tile = typeof e.tile === "object" && e.tile !== null ? (e.tile as Record<string, unknown>) : e;
    const tileX = num(tile.x);
    const tileY = num(tile.y);
    if (typeof e.file !== "string" || e.file === "" || tileX === null || tileY === null) continue;
    out.push({
      name: typeof e.name === "string" ? e.name : e.file,
      file: e.file,
      tileX,
      tileY,
      w: num(e.w),
      h: num(e.h),
    });
  }
  return out;
}

/** Loads the icon images next to minimap.json (`baseUrl` is its directory); missing images are dropped. */
export async function loadMinimapIcons(baseUrl: string, specs: MinimapIconSpec[]): Promise<MinimapIcon[]> {
  const loaded = await Promise.all(
    specs.map(async (spec): Promise<MinimapIcon | null> => {
      const image = await loadImage(joinUrl(baseUrl, spec.file)).catch(() => null);
      if (!image) return null;
      return { name: spec.name, tileX: spec.tileX, tileY: spec.tileY, w: spec.w ?? image.width, h: spec.h ?? image.height, image };
    }),
  );
  return loaded.filter((icon): icon is MinimapIcon => icon !== null);
}

/** Minimap dots, filled by the engine each frame without allocating. */
export class DotBuffer {
  xs = new Float32Array(64);
  ys = new Float32Array(64);
  npc = new Uint8Array(64);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  push(x: number, y: number, isNpc: boolean): void {
    if (this.count === this.xs.length) {
      const grow = (a: Float32Array) => {
        const b = new Float32Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.xs = grow(this.xs);
      this.ys = grow(this.ys);
      const n = new Uint8Array(this.npc.length * 2);
      n.set(this.npc);
      this.npc = n;
    }
    this.xs[this.count] = x;
    this.ys[this.count] = y;
    this.npc[this.count] = isNpc ? 1 : 0;
    this.count++;
  }
}

/** Tiles are 4 of the canvas's own CSS px across, like the client's minimap. */
const CSS_TILE_PX = 4;

/** An element's on-screen box (getBoundingClientRect), in screen px. */
export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The tile a press at (`clientX`, `clientY`) on the minimap points at, or
 * null outside the map's circle. `rect` is the canvas's on-screen box and
 * `cssWidth` x `cssHeight` its own CSS size (clientWidth, clientHeight):
 * under CSS zoom (the 2x interface on big monitors) or a scale transform a
 * CSS px covers more than one screen px, so the offset from the centre is
 * divided by that scale before it becomes tiles. `x`, `y` are the
 * (fractional) tile at the map's centre and `yaw` the camera's (the map
 * turns with it).
 */
export function minimapTileAt(
  clientX: number,
  clientY: number,
  rect: ScreenRect,
  cssWidth: number,
  cssHeight: number,
  x: number,
  y: number,
  yaw: number,
): Tile | null {
  const scaleX = cssWidth > 0 && rect.width > 0 ? rect.width / cssWidth : 1;
  const scaleY = cssHeight > 0 && rect.height > 0 ? rect.height / cssHeight : 1;
  const px = (clientX - rect.left - rect.width / 2) / scaleX;
  const py = (clientY - rect.top - rect.height / 2) / scaleY;
  const radius = Math.min(rect.width / scaleX, rect.height / scaleY) / 2;
  if (!(px * px + py * py <= radius * radius)) return null;
  const cos = Math.cos(-yaw);
  const sin = Math.sin(-yaw);
  const ux = px * cos - py * sin;
  const uy = px * sin + py * cos;
  return { x: Math.floor(x + ux / CSS_TILE_PX), y: Math.floor(y - uy / CSS_TILE_PX) };
}

/** Cache sprites the minimap draws with; any may be missing from an older bake. */
export interface MinimapSprites {
  compass: SpriteFrame | null;
  /** mapdots (300): frame 1 NPC, frame 2 player. */
  npcDot: SpriteFrame | null;
  playerDot: SpriteFrame | null;
  /** The red flag map marker (422). */
  marker: SpriteFrame | null;
}

export class Minimap {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private compass: HTMLCanvasElement | null = null;
  private compassCtx: CanvasRenderingContext2D | null = null;
  private cx = 0;
  private cy = 0;
  private yaw = 0;
  private readonly onWalk: (tile: Tile) => void;
  private readonly onCompass: () => void;

  constructor(
    private readonly image: HTMLImageElement,
    private readonly geo: MinimapGeo,
    private readonly sprites: MinimapSprites,
    onWalk: (tile: Tile) => void,
    onCompass: () => void,
    private readonly icons: readonly MinimapIcon[] = [],
  ) {
    this.onWalk = onWalk;
    this.onCompass = onCompass;
  }

  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("contextmenu", this.preventMenu);
  }

  detach(): void {
    if (this.canvas) {
      this.canvas.removeEventListener("pointerdown", this.onPointerDown);
      this.canvas.removeEventListener("contextmenu", this.preventMenu);
    }
    this.canvas = null;
    this.ctx = null;
  }

  attachCompass(canvas: HTMLCanvasElement): void {
    this.detachCompass();
    this.compass = canvas;
    this.compassCtx = canvas.getContext("2d");
    canvas.addEventListener("pointerdown", this.onCompassDown);
  }

  detachCompass(): void {
    this.compass?.removeEventListener("pointerdown", this.onCompassDown);
    this.compass = null;
    this.compassCtx = null;
  }

  private readonly preventMenu = (e: Event): void => e.preventDefault();

  private readonly onCompassDown = (e: PointerEvent): void => {
    if (e.button === 0) this.onCompass();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    const canvas = this.canvas;
    if (e.button !== 0 || !canvas) return;
    // Screen px per CSS px comes from the on-screen box over the canvas's own size (2 under the 2x interface zoom).
    const rect = canvas.getBoundingClientRect();
    const tile = minimapTileAt(e.clientX, e.clientY, rect, canvas.clientWidth, canvas.clientHeight, this.cx, this.cy, this.yaw);
    if (!tile) return;
    e.preventDefault();
    this.onWalk(tile);
  };

  /**
   * Draws around the local player. `x`/`y` are fractional tile coordinates
   * of the player (integer = standing on that tile).
   */
  draw(x: number, y: number, yaw: number, dots: DotBuffer, flag: Tile | null): void {
    this.cx = x + 0.5;
    this.cy = y + 0.5;
    this.yaw = yaw;
    if (this.compassCtx && this.compass && this.sprites.compass) this.drawCompass(yaw);
    const { ctx, canvas } = this;
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    const s = w / (canvas.clientWidth || w);
    const tilePx = CSS_TILE_PX * s;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2;
    const { geo, image } = this;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(yaw);
    ctx.imageSmoothingEnabled = false;
    const k = tilePx / geo.pxPerTile;
    const u = (this.cx - geo.originX) * geo.pxPerTile;
    const v = (geo.originY + geo.heightTiles - this.cy) * geo.pxPerTile;
    ctx.drawImage(image, -u * k, -v * k, image.width * k, image.height * k);
    ctx.restore();

    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const dot = Math.max(1, Math.round(s));

    // Map functions stay upright over the rotated map, centred on their tile,
    // drawn before the dots like the client (the circle clip trims edge icons).
    for (const icon of this.icons) {
      const dx = (icon.tileX - x) * tilePx;
      const dy = -(icon.tileY - y) * tilePx;
      const ix = dx * cos - dy * sin;
      const iy = dx * sin + dy * cos;
      const hw = (icon.w * dot) / 2;
      const hh = (icon.h * dot) / 2;
      const reach = radius + Math.max(hw, hh);
      if (ix * ix + iy * iy > reach * reach) continue;
      ctx.drawImage(icon.image, Math.round(cx + ix - hw), Math.round(cy + iy - hh), icon.w * dot, icon.h * dot);
    }

    const { npcDot, playerDot, marker } = this.sprites;
    for (let i = 0; i < dots.count; i++) {
      const dx = (dots.xs[i]! - x) * tilePx;
      const dy = -(dots.ys[i]! - y) * tilePx;
      const sx = Math.round(cx + dx * cos - dy * sin - 2 * dot);
      const sy = Math.round(cy + dx * sin + dy * cos - 2 * dot);
      const isNpc = dots.npc[i] === 1;
      const sprite = isNpc ? npcDot : playerDot;
      if (sprite) ctx.drawImage(sprite.image, sx, sy, sprite.w * dot, sprite.h * dot);
      else this.drawDot(ctx, sx, sy, dot, isNpc ? "#ffff00" : "#ffffff");
    }

    if (flag) {
      const dx = (flag.x - x) * tilePx;
      const dy = -(flag.y - y) * tilePx;
      const fx = Math.round(cx + dx * cos - dy * sin);
      const fy = Math.round(cy + dx * sin + dy * cos);
      if (marker) {
        // The marker canvas is centred on the pole's foot.
        ctx.drawImage(
          marker.image,
          fx + (marker.offsetX - marker.maxWidth / 2) * dot,
          fy + (marker.offsetY - marker.maxHeight / 2) * dot,
          marker.w * dot,
          marker.h * dot,
        );
      } else {
        this.drawFlag(ctx, fx, fy, dot);
      }
    }

    // The local player: a white square in the centre.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(Math.round(cx - 1.5 * dot), Math.round(cy - 1.5 * dot), 3 * dot, 3 * dot);
    ctx.restore();
  }

  private drawDot(ctx: CanvasRenderingContext2D, x: number, y: number, p: number, colour: string): void {
    // The client's 4x4 map dot with its dark outline.
    ctx.fillStyle = "#000000";
    ctx.fillRect(x + p, y + p, 3 * p, 4 * p);
    ctx.fillRect(x + p, y + 4 * p, 2 * p, p);
    ctx.fillStyle = colour;
    ctx.fillRect(x + p, y, 2 * p, 4 * p);
    ctx.fillRect(x, y + p, 4 * p, 2 * p);
  }

  private drawFlag(ctx: CanvasRenderingContext2D, x: number, y: number, p: number): void {
    // Pole rising from the destination with a red pennant, like the client's map marker.
    ctx.fillStyle = "#000000";
    ctx.fillRect(x, y - 11 * p, p * 2, 11 * p);
    ctx.fillStyle = "#c8c8c8";
    ctx.fillRect(x, y - 11 * p, p, 11 * p);
    ctx.fillStyle = "#000000";
    ctx.fillRect(x + p, y - 11 * p, 7 * p, 6 * p);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(x + p, y - 11 * p, 6 * p, 5 * p);
    ctx.fillStyle = "#a00000";
    ctx.fillRect(x + p, y - 7 * p, 6 * p, p);
  }

  private drawCompass(yaw: number): void {
    const ctx = this.compassCtx!;
    const canvas = this.compass!;
    const sprite = this.sprites.compass!;
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(yaw);
    ctx.imageSmoothingEnabled = false;
    const scale = Math.min(w / sprite.maxWidth, h / sprite.maxHeight);
    ctx.drawImage(
      sprite.image,
      (-sprite.maxWidth / 2 + sprite.offsetX) * scale,
      (-sprite.maxHeight / 2 + sprite.offsetY) * scale,
      sprite.w * scale,
      sprite.h * scale,
    );
    ctx.restore();
  }
}
