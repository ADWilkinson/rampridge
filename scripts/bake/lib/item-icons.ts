/**
 * Inventory item icons rendered the way the OSRS client does it
 * (ObjType.getItemSprite): the lit item model is rotated by the item's 2D
 * angles, projected with the client's fixed 512 focal length into a 36x32
 * canvas centred at (16, 16), painted with the client's depth/priority face
 * ordering and Gouraud rasteriser, then outlined (1 px, near-black) and
 * given the inventory drop shadow. Noted items draw the note template with
 * the unnoted icon on top, scaled down via zoom2d * 1.5.
 */
import { SINE, COSINE } from "../vendor/rs-map-viewer/src/rs/MathConstants";
import type { ObjType } from "../vendor/rs-map-viewer/src/rs/config/objtype/ObjType";
import { Rasterizer2D } from "../vendor/rs-map-viewer/src/rs/graphics/Rasterizer2D";
import { Rasterizer3D } from "../vendor/rs-map-viewer/src/rs/graphics/Rasterizer3D";
import type { Model } from "../vendor/rs-map-viewer/src/rs/model/Model";
import type { BakeCache } from "./cache";

export const ICON_WIDTH = 36;
export const ICON_HEIGHT = 32;
/** The client's inventory icon shadow colour. */
export const INVENTORY_SHADOW = 0x302020;
const FOCAL = 512;

export interface IconOptions {
  /** 0 none, 1 black outline, 2 black + white outline (selected). */
  border?: number;
  /** Drop shadow colour, 0 for none. */
  shadow?: number;
}

/** Resolves the definition the client would draw for a stack of `quantity`. */
function resolveStack(cache: BakeCache, id: number, quantity: number): ObjType {
  const objTypes = cache.factory.getObjTypeLoader();
  let obj = objTypes.load(id);
  if (quantity > 1 && obj.countObj) {
    let countId = -1;
    for (let i = 0; i < 10; i++) {
      if (quantity >= obj.countCo[i]! && obj.countCo[i] !== 0) countId = obj.countObj[i]!;
    }
    if (countId !== -1) obj = objTypes.load(countId);
  }
  return obj;
}

/** Item icon as ARGB pixels (0 = transparent), 36x32. */
export function renderItemIcon(cache: BakeCache, id: number, quantity: number, opts: IconOptions = {}): Uint32Array {
  return render(cache, id, quantity, opts.border ?? 1, opts.shadow ?? INVENTORY_SHADOW, false);
}

/**
 * Icon of `id` as a bank note, exactly as the client draws a noted item:
 * the note template's model, then the unnoted item drawn over it smaller.
 * Works for any item, including ones the game never notes (coins).
 */
export function renderNotedIcon(cache: BakeCache, unnotedId: number, templateId: number, opts: IconOptions = {}): Uint32Array {
  const objTypes = cache.factory.getObjTypeLoader();
  const template = objTypes.load(templateId);
  const aux = render(cache, unnotedId, 10, 1, 0, true);
  const base = draw(cache, template, cache.objModelLoader.getModel(templateId, 1), opts.border ?? 1, opts.shadow ?? INVENTORY_SHADOW, false);
  // aux sprite drawn over the finished note (drawTransBgAt: only non-zero pixels)
  for (let i = 0; i < base.length; i++) if (aux[i] !== 0) base[i] = aux[i]!;
  return base;
}

function render(cache: BakeCache, id: number, quantity: number, border: number, shadow: number, noted: boolean): Uint32Array {
  const obj = resolveStack(cache, id, quantity);
  if (obj.noteTemplate !== -1) {
    return renderNotedIcon(cache, obj.note, obj.noteTemplate, { border, shadow });
  }
  const model = cache.objModelLoader.getModel(obj.id, 1);
  return draw(cache, obj, model, border, shadow, noted);
}

function draw(cache: BakeCache, obj: ObjType, model: Model | undefined, border: number, shadow: number, noted: boolean): Uint32Array {
  if (!model) throw new Error(`item ${obj.id} (${obj.name}) has no model`);
  let zoom = obj.zoom2d;
  if (noted) zoom = Math.trunc(zoom * 1.5);
  else if (border === 2) zoom = Math.trunc(zoom * 1.04);
  let out = renderModelSprite(cache, model, {
    width: ICON_WIDTH,
    height: ICON_HEIGHT,
    centerX: 16,
    centerY: 16,
    xan: obj.xan2d,
    yan: obj.yan2d,
    zan: obj.zan2d,
    zoom,
    offsetX: obj.offsetX2d,
    offsetY: obj.offsetY2d,
  });
  if (border >= 1) out = outline(out, 1);
  if (border >= 2) out = outline(out, 0xffffff);
  if (shadow !== 0) dropShadow(out, shadow);
  return out;
}

export interface ModelSpriteParams {
  width: number;
  height: number;
  /** Projection centre inside the canvas. */
  centerX: number;
  centerY: number;
  xan: number;
  yan: number;
  zan: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/**
 * A lit model drawn the way the client draws item icons and interface model
 * components (Widget type 6): RGB pixels, 0 = transparent.
 */
export function renderModelSprite(cache: BakeCache, model: Model, p: ModelSpriteParams): Uint32Array {
  const pixels = new Int32Array(p.width * p.height);
  Rasterizer2D.setRaster(pixels, p.width, p.height);
  Rasterizer3D.setClip();
  Rasterizer3D.setViewport(p.centerX, p.centerY);
  Rasterizer3D.rasterGouraudLowRes = false;
  const sin = (SINE[p.xan]! * p.zoom) >> 16;
  const cos = (COSINE[p.xan]! * p.zoom) >> 16;
  model.calculateBoundsCylinder();
  project(cache, model, 0, p.yan, p.zan, p.xan, p.offsetX, ((model.height / 2) | 0) + sin + p.offsetY, cos + p.offsetY);
  return Uint32Array.from(pixels, (v) => v >>> 0);
}

/** Model.method2774: rotate (z, x-axis by `pitch`, y), offset, rotate by xan2d, project, paint. */
function project(
  cache: BakeCache,
  model: Model,
  pitch: number,
  yan: number,
  zan: number,
  xan: number,
  offX: number,
  offY: number,
  offZ: number,
) {
  const cx = Rasterizer3D.centerX;
  const cy = Rasterizer3D.centerY;
  const s1 = SINE[pitch]!, c1 = COSINE[pitch]!;
  const sy = SINE[yan]!, cyw = COSINE[yan]!;
  const sz = SINE[zan]!, cz = COSINE[zan]!;
  const sx = SINE[xan]!, cxw = COSINE[xan]!;
  const centerDepth = (sx * offY + cxw * offZ) >> 16;
  const n = model.verticesCount;
  const vx = new Int32Array(n), vy = new Int32Array(n), vz = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let x = model.verticesX[i]!, y = model.verticesY[i]!, z = model.verticesZ[i]!;
    let t: number;
    if (zan !== 0) {
      t = (y * sz + x * cz) >> 16;
      y = (y * cz - x * sz) >> 16;
      x = t;
    }
    if (pitch !== 0) {
      t = (y * c1 - z * s1) >> 16;
      z = (y * s1 + z * c1) >> 16;
      y = t;
    }
    if (yan !== 0) {
      t = (z * sy + x * cyw) >> 16;
      z = (z * cyw - x * sy) >> 16;
      x = t;
    }
    x += offX;
    y += offY;
    z += offZ;
    t = (y * cxw - z * sx) >> 16;
    z = (y * sx + z * cxw) >> 16;
    vz[i] = z - centerDepth;
    vx[i] = cx + Math.trunc((x * FOCAL) / z);
    vy[i] = cy + Math.trunc((t * FOCAL) / z);
  }
  paint(cache, model, vx, vy, vz);
}

/** Model.draw0: back-face cull, bucket by depth, order by render priority, rasterise. */
function paint(cache: BakeCache, model: Model, vx: Int32Array, vy: Int32Array, vz: Int32Array) {
  const diameter = model.diameter;
  const radius = model.radius;
  const buckets: number[][] = Array.from({ length: Math.max(diameter, 1) }, () => []);
  const clipped = new Uint8Array(model.faceCount);
  const maxX = Rasterizer3D.endX;
  for (let f = 0; f < model.faceCount; f++) {
    if (model.faceColors3[f] === -2) continue;
    const a = model.indices1[f]!, b = model.indices2[f]!, c = model.indices3[f]!;
    const xa = vx[a]!, xb = vx[b]!, xc = vx[c]!;
    const ya = vy[a]!, yb = vy[b]!, yc = vy[c]!;
    if ((ya - yb) * (xc - xb) - (xa - xb) * (yc - yb) >= 0) continue;
    clipped[f] = xa < 0 || xb < 0 || xc < 0 || xa > maxX || xb > maxX || xc > maxX ? 1 : 0;
    const depth = Math.trunc((vz[a]! + vz[b]! + vz[c]!) / 3) + radius;
    buckets[Math.min(Math.max(depth, 0), buckets.length - 1)]!.push(f);
  }

  const drawFace = (f: number) => {
    const a = model.indices1[f]!, b = model.indices2[f]!, c = model.indices3[f]!;
    Rasterizer3D.rasterClipEnable = clipped[f] === 1;
    Rasterizer3D.rasterAlpha = model.faceAlphas ? model.faceAlphas[f]! & 0xff : 0;
    // Lit colours carry the raw light intensity above bit 16; the HSL is the low 16 bits.
    let c1 = model.faceColors1[f]! & 0xffff;
    let c2 = model.faceColors2[f]! & 0xffff;
    let c3 = model.faceColors3[f] === -1 ? -1 : model.faceColors3[f]! & 0xffff;
    const tex = model.faceTextures ? model.faceTextures[f]! : -1;
    if (tex !== -1) {
      // Textured face: the client's low-detail path paints the texture's average colour, shaded.
      const avg = cache.factory.getTextureLoader().getAverageHsl(tex);
      const tint = (hsl: number) => (avg & ~0x7f) | Math.min(127, Math.max(0, ((avg & 0x7f) * (hsl & 0x7f)) >> 7));
      if (c3 === -1) c1 = c2 = c3 = tint(c1);
      else { c1 = tint(c1); c2 = tint(c2); c3 = tint(c3); }
    } else if (c3 === -1) {
      c2 = c3 = c1;
    }
    Rasterizer3D.rasterGouraud(vy[a]!, vy[b]!, vy[c]!, vx[a]!, vx[b]!, vx[c]!, c1, c2, c3);
  };

  const prios = model.faceRenderPriorities;
  if (!prios) {
    for (let d = buckets.length - 1; d >= 0; d--) for (const f of buckets[d]!) drawFace(f);
  } else {
    const faces: number[][] = Array.from({ length: 12 }, () => []);
    const depthSum: number[] = Array.from({ length: 12 }, () => 0);
    const depth10: number[] = [];
    const depth11: number[] = [];
    for (let d = buckets.length - 1; d >= 0; d--) {
      for (const f of buckets[d]!) {
        const p = prios[f]!;
        faces[p]!.push(f);
        if (p < 10) depthSum[p]! += d;
        else if (p === 10) depth10.push(d);
        else depth11.push(d);
      }
    }
    const avg = (p: number, q: number) => {
      const n = faces[p]!.length + faces[q]!.length;
      return n > 0 ? Math.trunc((depthSum[p]! + depthSum[q]!) / n) : 0;
    };
    const d12 = avg(1, 2);
    const d34 = avg(3, 4);
    const d68 = avg(6, 8);
    let list = faces[10]!;
    let depths = depth10;
    let i = 0;
    if (list.length === 0) {
      list = faces[11]!;
      depths = depth11;
    }
    let cur = i < list.length ? depths[i]! : -1000;
    const next = () => {
      drawFace(list[i++]!);
      if (i === list.length && list !== faces[11]) {
        i = 0;
        list = faces[11]!;
        depths = depth11;
      }
      cur = i < list.length ? depths[i]! : -1000;
    };
    for (let p = 0; p < 10; p++) {
      while (p === 0 && cur > d12) next();
      while (p === 3 && cur > d34) next();
      while (p === 5 && cur > d68) next();
      for (const f of faces[p]!) drawFace(f);
    }
    while (cur !== -1000) next();
  }
}

/** SpritePixels.outline: transparent pixels touching an opaque one take `color`. */
function outline(px: Uint32Array, color: number, w = ICON_WIDTH, h = ICON_HEIGHT): Uint32Array {
  const out = new Uint32Array(px.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let p = px[i]!;
      if (p === 0) {
        if (x > 0 && px[i - 1] !== 0) p = color;
        else if (y > 0 && px[i - w] !== 0) p = color;
        else if (x < w - 1 && px[i + 1] !== 0) p = color;
        else if (y < h - 1 && px[i + w] !== 0) p = color;
      }
      out[i] = p;
    }
  }
  return out;
}

/** SpritePixels.shadow: a one-pixel drop shadow down and to the right. */
function dropShadow(px: Uint32Array, color: number) {
  const w = ICON_WIDTH;
  for (let y = ICON_HEIGHT - 1; y > 0; y--) {
    const row = y * w;
    for (let x = w - 1; x > 0; x--) {
      if (px[x + row] === 0 && px[x + row - 1 - w] !== 0) px[x + row] = color;
    }
  }
}

/** Client RGB pixels (0 = transparent) to opaque ARGB. */
export function iconToArgb(px: Uint32Array): Uint32Array {
  return Uint32Array.from(px, (p) => (p === 0 ? 0 : (0xff000000 | p) >>> 0));
}
