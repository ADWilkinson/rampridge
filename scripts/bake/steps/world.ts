/**
 * Varrock West Bank scene -> public/game/world/varrock-west-bank.glb.
 *
 * Geometry comes from rs-map-viewer's SceneBuilder (the client's floor
 * blending, loc placement, ground contouring and Gouraud lighting), so the
 * colours are the client's baked vertex colours and the GLB is meant to be
 * drawn unlit. Only map level 0 is exported, as node `plane0`: the 2007
 * client hid the levels above (upper floors, roofs) while the player stood
 * indoors, and RampRidge players never leave the hall and its street strip,
 * so the engine never shows them and shipping them only cost download size.
 *
 * Fidelity details handled here:
 * - Colours: palette at the client's default brightness (0.8); textured faces
 *   carry their lightness as a linear vertex colour that modulates the
 *   texture, like the client's textured rasteriser.
 * - Draw order: the client paints faces within a model by render priority
 *   and floor decorations over the floor. With a depth buffer, coplanar
 *   faces would z-fight, so higher-priority faces and floor decorations are
 *   nudged a fraction of a unit towards their front.
 * - Back faces are culled (single-sided materials), as in the client.
 */
import path from "node:path";

import { Document, NodeIO, type Primitive } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMaterialsUnlit, KHRMeshQuantization } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, quantize, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { PNG } from "pngjs";

import { getModelFaces } from "../vendor/rs-map-viewer/src/mapviewer/webgl/buffer/SceneBuffer";
import type { Model } from "../vendor/rs-map-viewer/src/rs/model/Model";
import { Model as ModelClass } from "../vendor/rs-map-viewer/src/rs/model/Model";
import type { SceneLoc } from "../vendor/rs-map-viewer/src/rs/scene/SceneLoc";
import { LocEntity } from "../vendor/rs-map-viewer/src/rs/scene/entity/LocEntity";
import { INVALID_HSL_COLOR, buildPalette } from "../vendor/rs-map-viewer/src/rs/util/ColorUtil";
import type { BakeCache } from "../lib/cache";
import { WORLD_DIR, rel, writeIfChanged } from "../lib/paths";
import { encodePng } from "../lib/png";
import { ORIGIN, SURROUNDINGS, TILE, buildAreaScene, inRect } from "../lib/region";

/** The client's default brightness setting. */
export const BRIGHTNESS = 0.8;
const PALETTE = buildPalette(BRIGHTNESS, 0, 512);
const TEXTURE_SIZE = 128;
/** RS units a face is pushed towards its front per render-priority step. */
const PRIORITY_NUDGE = 0.12;
/** RS units floor decorations (rugs, debris) are lifted off the floor. */
const FLOOR_DECORATION_LIFT = 0.75;
/** The only map level exported: the one the hall and street stand on, and the only one the engine shows. */
const LEVEL = 0;

type Bucket = {
  level: number;
  textureId: number;
  blend: boolean;
  pos: number[];
  col: number[];
  uv: number[];
};

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export interface WorldStats {
  file: string;
  bytes: number;
  rawBytes: number;
  triangles: number;
  levels: number[];
  textures: number[];
}

export async function bakeWorld(cache: BakeCache): Promise<WorldStats> {
  const area = SURROUNDINGS;
  const { scene, baseX, baseY } = buildAreaScene(cache, area, true);
  const textureLoader = cache.factory.getTextureLoader();
  const locTypes = cache.factory.getLocTypeLoader();

  const buckets = new Map<string, Bucket>();
  const bucket = (level: number, textureId: number, blend: boolean): Bucket => {
    const key = `${level}:${textureId}:${blend ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) {
      b = { level, textureId, blend, pos: [], col: [], uv: [] };
      buckets.set(key, b);
    }
    return b;
  };

  // scene units -> output frame
  const ox = (ORIGIN.x - baseX) * TILE;
  const oz = (ORIGIN.y - baseY) * TILE;
  const push = (b: Bucket, x: number, y: number, z: number, hsl: number, alpha: number, u: number, v: number) => {
    b.pos.push((x - ox) / TILE, -y / TILE, -(z - oz) / TILE);
    const a = alpha / 255;
    if (b.textureId !== -1) {
      const l = srgbToLinear((hsl & 0x7f) / 127);
      b.col.push(l, l, l, a);
    } else {
      const rgb = PALETTE[hsl & 0xffff]!;
      b.col.push(srgbToLinear(((rgb >> 16) & 0xff) / 255), srgbToLinear(((rgb >> 8) & 0xff) / 255), srgbToLinear((rgb & 0xff) / 255), a);
    }
    b.uv.push(u, v);
  };

  const tileInArea = (sceneUnitsX: number, sceneUnitsZ: number) =>
    inRect(area, baseX + (sceneUnitsX >> 7), baseY + (sceneUnitsZ >> 7));

  // ---- terrain -------------------------------------------------------------
  let triangles = 0;
  for (let sx = 0; sx < scene.sizeX; sx++) {
    for (let sy = 0; sy < scene.sizeY; sy++) {
      if (!inRect(area, baseX + sx, baseY + sy)) continue;
      const tm = scene.tiles[LEVEL]![sx]![sy]?.tileModel;
      if (!tm) continue;
      for (const face of tm.faces) {
        const v0 = face.vertices[0]!;
        if (v0.hsl === INVALID_HSL_COLOR) continue;
        const b = bucket(LEVEL, v0.textureId, false);
        for (const v of face.vertices) push(b, v.x, v.y, v.z, v.hsl, 0xff, v.u, v.v);
        triangles++;
      }
    }
  }

  // ---- locs ------------------------------------------------------------------
  const addModel = (model: Model, level: number, sceneX: number, height: number, sceneZ: number, lift: number) => {
    const vy = model.contourVerticesY ?? model.verticesY;
    const uvs = model.uvs;
    for (const face of getModelFaces(model)) {
      const i = face.index;
      const a = model.faceColors1[i]!;
      let b = model.faceColors2[i]!;
      let c = model.faceColors3[i]!;
      if (c === -1) c = b = a;
      const transparent = face.alpha < 0xff;
      const bk = bucket(level, face.textureId, transparent);
      const idx = [model.indices1[i]!, model.indices2[i]!, model.indices3[i]!];
      const xs = idx.map((k) => sceneX + model.verticesX[k]!);
      const ys = idx.map((k) => height + vy[k]! - lift);
      const zs = idx.map((k) => sceneZ + model.verticesZ[k]!);
      // Face normal in RS space (y down); nudge along it by priority so coplanar overlays win.
      if (face.priority > 0) {
        const ux = xs[1]! - xs[0]!, uy = ys[1]! - ys[0]!, uz = zs[1]! - zs[0]!;
        const wx = xs[2]! - xs[0]!, wy = ys[2]! - ys[0]!, wz = zs[2]! - zs[0]!;
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) {
          // The output frame is a proper rotation of RS space and its triangles are CCW from the
          // front, so this cross product already points out of the visible side.
          const s = (PRIORITY_NUDGE * face.priority) / len;
          nx *= s; ny *= s; nz *= s;
          for (let k = 0; k < 3; k++) { xs[k]! += nx; ys[k]! += ny; zs[k]! += nz; }
        }
      }
      const cols = [a, b, c];
      for (let k = 0; k < 3; k++) {
        const u = uvs ? uvs[i * 6 + k * 2]! : 0;
        const v = uvs ? uvs[i * 6 + k * 2 + 1]! : 0;
        push(bk, xs[k]!, ys[k]!, zs[k]!, cols[k]!, face.alpha, u, v);
      }
      triangles++;
    }
  };

  const resolveEntity = (entity: LocEntity): Model | undefined => {
    let locType = locTypes.load(entity.id);
    if (locType.transforms) {
      const t = locType.transform(cache.varManager, locTypes);
      if (!t) return undefined;
      locType = t;
    }
    return cache.locModelLoader.getModelAnimated(locType, entity.type, entity.rotation, entity.seqId, entity.seqId !== -1 ? 0 : -1);
  };

  const emit = (
    entity: unknown,
    sceneLoc: SceneLoc,
    level: number,
    offX: number,
    offY: number,
    lift: number,
  ) => {
    const sx = sceneLoc.x + offX;
    const sz = sceneLoc.y + offY;
    if (!tileInArea(sceneLoc.x, sceneLoc.y)) return;
    let model: Model | undefined;
    if (entity instanceof ModelClass) model = entity;
    else if (entity instanceof LocEntity) model = resolveEntity(entity);
    if (!model) return;
    // Multiloc entities were stored without contouring; their sceneLoc.height is the tile centre.
    addModel(model, level, sx, sceneLoc.height, sz, lift);
  };

  for (let tx = 0; tx < scene.sizeX; tx++) {
    for (let ty = 0; ty < scene.sizeY; ty++) {
      const tile = scene.tiles[LEVEL]![tx]![ty];
      if (!tile) continue;
      if (tile.floorDecoration) emit(tile.floorDecoration.entity, tile.floorDecoration, LEVEL, 0, 0, FLOOR_DECORATION_LIFT);
      if (tile.wall) {
        emit(tile.wall.entity0, tile.wall, LEVEL, 0, 0, 0);
        emit(tile.wall.entity1, tile.wall, LEVEL, 0, 0, 0);
      }
      if (tile.wallDecoration) {
        const d = tile.wallDecoration;
        emit(d.entity0, d, LEVEL, d.offsetX, d.offsetY, 0);
        emit(d.entity1, d, LEVEL, 0, 0, 0);
      }
      for (const loc of tile.locs) {
        if (loc.startX !== tx || loc.startY !== ty) continue;
        emit(loc.entity, loc, LEVEL, 0, 0, 0);
      }
    }
  }

  // ---- glTF ------------------------------------------------------------------
  const doc = new Document();
  doc.createBuffer();
  const unlit = doc.createExtension(KHRMaterialsUnlit);
  const root = doc.createNode("varrock_west_bank");
  doc.createScene("varrock_west_bank").addChild(root);
  const buf = doc.getRoot().listBuffers()[0]!;

  const textures = new Map<number, ReturnType<typeof doc.createTexture>>();
  const materials = new Map<string, ReturnType<typeof doc.createMaterial>>();
  const textureFor = (id: number) => {
    let tex = textures.get(id);
    if (tex) return tex;
    const px = textureLoader.getPixelsArgb(id, TEXTURE_SIZE, true, BRIGHTNESS);
    const transparent = textureLoader.isTransparent(id);
    const png = new PNG({ width: TEXTURE_SIZE, height: TEXTURE_SIZE });
    for (let i = 0; i < TEXTURE_SIZE * TEXTURE_SIZE; i++) {
      const p = px[i]!;
      png.data[i * 4] = (p >> 16) & 0xff;
      png.data[i * 4 + 1] = (p >> 8) & 0xff;
      png.data[i * 4 + 2] = p & 0xff;
      png.data[i * 4 + 3] = transparent ? (p >>> 24) & 0xff : 0xff;
    }
    tex = doc.createTexture(`texture_${id}`).setImage(encodePng(png)).setMimeType("image/png");
    textures.set(id, tex);
    return tex;
  };
  const materialFor = (textureId: number, blend: boolean) => {
    const key = `${textureId}:${blend}`;
    let m = materials.get(key);
    if (m) return m;
    m = doc
      .createMaterial(textureId === -1 ? (blend ? "vertex_colour_alpha" : "vertex_colour") : `texture_${textureId}${blend ? "_alpha" : ""}`)
      .setExtension("KHR_materials_unlit", unlit.createUnlit())
      .setDoubleSided(false)
      .setAlphaMode(blend ? "BLEND" : "OPAQUE");
    if (textureId !== -1) {
      const tex = textureFor(textureId);
      m.setBaseColorTexture(tex);
      m.getBaseColorTextureInfo()!.setWrapS(10497).setWrapT(10497).setMagFilter(9728).setMinFilter(9987);
      if (textureLoader.isTransparent(textureId) && !blend) m.setAlphaMode("MASK").setAlphaCutoff(0.5);
    }
    materials.set(key, m);
    return m;
  };

  const levels = [...new Set([...buckets.values()].map((b) => b.level))].sort();
  const mesh = doc.createMesh(`plane${LEVEL}`);
  const node = doc.createNode(`plane${LEVEL}`);
  root.addChild(node);
  const list = [...buckets.values()]
    .filter((b) => b.pos.length > 0)
    // opaque first, then masked, then blended, each by texture id: stable draw order
    .sort((a, b) => Number(a.blend) - Number(b.blend) || a.textureId - b.textureId);
  for (const b of list) {
    const prim: Primitive = doc
      .createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(b.pos)).setBuffer(buf))
      .setAttribute("COLOR_0", doc.createAccessor().setType("VEC4").setArray(new Float32Array(b.col)).setBuffer(buf))
      .setMaterial(materialFor(b.textureId, b.blend));
    if (b.textureId !== -1) {
      prim.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(b.uv)).setBuffer(buf));
    }
    mesh.addPrimitive(prim);
  }
  if (mesh.listPrimitives().length === 0) throw new Error("plane 0 exported no geometry");
  node.setMesh(mesh);

  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit, KHRMeshQuantization, EXTMeshoptCompression]).registerDependencies({
    "meshopt.encoder": MeshoptEncoder,
  });
  const rawBytes = (await io.writeBinary(doc)).byteLength;
  await MeshoptEncoder.ready;
  await doc.transform(
    dedup(),
    weld(),
    quantize({ quantizePosition: 14, quantizeColor: 8, quantizeTexcoord: 12 }),
    meshopt({ encoder: MeshoptEncoder, level: "high" }),
    prune({ keepLeaves: true, keepAttributes: true }),
  );
  const glb = await io.writeBinary(doc);
  const file = path.join(WORLD_DIR, "varrock-west-bank.glb");
  writeIfChanged(file, glb);
  console.log(
    `  world: ${triangles} triangles, levels ${levels.join(",")}, textures ${[...textures.keys()].join(",")}, ${(rawBytes / 1024).toFixed(0)} KB raw -> ${(glb.byteLength / 1024).toFixed(0)} KB -> ${rel(file)}`,
  );
  return { file, bytes: glb.byteLength, rawBytes, triangles, levels, textures: [...textures.keys()] };
}
