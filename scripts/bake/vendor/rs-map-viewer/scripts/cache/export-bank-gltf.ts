// Scratch exporter: builds a client-accurate scene for one OSRS map square with
// rs-map-viewer's SceneBuilder and writes it as GLB (unlit, baked vertex colours).
// Usage: npx tsx scripts/cache/export-bank-gltf.ts <mapX> <mapY> <minTileX> <minTileY> <maxTileX> <maxTileY> <out.glb>
import { Document, NodeIO, Primitive } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";
import fs from "fs";
import { PNG } from "pngjs";

import { ContourGroundType, getModelFaces } from "../../src/mapviewer/webgl/buffer/SceneBuffer";
import { getSceneLocs } from "../../src/mapviewer/webgl/loc/SceneLocs";
import { CacheSystem } from "../../src/rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../../src/rs/cache/loader/CacheLoaderFactory";
import { LocModelLoader } from "../../src/rs/config/loctype/LocModelLoader";
import { VarManager } from "../../src/rs/config/vartype/VarManager";
import { Model } from "../../src/rs/model/Model";
import { Scene } from "../../src/rs/scene/Scene";
import { LocLoadType, SceneBuilder } from "../../src/rs/scene/SceneBuilder";
import { HSL_RGB_MAP, INVALID_HSL_COLOR } from "../../src/rs/util/ColorUtil";
import { loadCache, loadCacheInfos, loadCacheList } from "./load-util";

const [mapX, mapY, minX, minY, maxX, maxY] = process.argv.slice(2, 8).map(Number);
const outPath = process.argv[8];

const cacheInfo = loadCacheList(loadCacheInfos()).latest;
const loadedCache = loadCache(cacheInfo);
const cacheSystem = CacheSystem.fromFiles(loadedCache.type, loadedCache.files);
const f = getCacheLoaderFactory(cacheInfo, cacheSystem);
const textureLoader = f.getTextureLoader();
const locTypeLoader = f.getLocTypeLoader();
const varManager = new VarManager(f.getVarBitTypeLoader());
const locModelLoader = new LocModelLoader(
    locTypeLoader,
    f.getModelLoader(),
    textureLoader,
    f.getSeqTypeLoader(),
    f.getSeqFrameLoader(),
    f.getSkeletalSeqLoader(),
);
const sceneBuilder = new SceneBuilder(
    cacheInfo,
    f.getMapFileLoader(),
    f.getUnderlayTypeLoader(),
    f.getOverlayTypeLoader(),
    locTypeLoader,
    locModelLoader,
    loadedCache.xteas,
);

const borderSize = 6;
const baseX = mapX * 64 - borderSize;
const baseY = mapY * 64 - borderSize;
const scene = sceneBuilder.buildScene(baseX, baseY, 64 + borderSize * 2, 64 + borderSize * 2, false);

// world tile range filter, in scene-local units (0 = SW corner of map square)
const lx0 = minX - mapX * 64, ly0 = minY - mapY * 64, lx1 = maxX - mapX * 64, ly1 = maxY - mapY * 64;
const inRange = (sceneX: number, sceneZ: number) => {
    const tx = sceneX >> 7, ty = sceneZ >> 7;
    return tx >= lx0 && tx <= lx1 && ty >= ly0 && ty <= ly1;
};

type Bucket = { pos: number[]; col: number[]; uv: number[]; textureId: number; alpha: boolean; level: number };
const buckets = new Map<string, Bucket>();
let curLevel = 0;
const bucket = (textureId: number, alpha: boolean) => {
    const key = `${curLevel}:${textureId}:${alpha}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { pos: [], col: [], uv: [], textureId, alpha, level: curLevel }));
    return b;
};
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
// RS units: 128 per tile, y down. Output: 1 unit per tile, y up, north = -z, origin = SW corner of range.
const ox = lx0 * 128, oz = ly0 * 128;
function pushVertex(b: Bucket, x: number, y: number, z: number, hsl: number, alpha: number, u: number, v: number) {
    b.pos.push((x - ox) / 128, -y / 128, -(z - oz) / 128);
    if (b.textureId !== -1) {
        const l = (hsl & 0x7f) / 127;
        b.col.push(l, l, l, alpha / 255);
    } else {
        const rgb = HSL_RGB_MAP[hsl & 0xffff];
        b.col.push(
            srgbToLinear(((rgb >> 16) & 0xff) / 255),
            srgbToLinear(((rgb >> 8) & 0xff) / 255),
            srgbToLinear((rgb & 0xff) / 255),
            alpha / 255,
        );
    }
    b.uv.push(u, v);
}

// terrain
let terrainFaces = 0;
for (let level = 0; level < scene.levels; level++) {
    for (let x = 0; x < scene.sizeX; x++) {
        for (let y = 0; y < scene.sizeY; y++) {
            const tile = scene.tiles[level][x][y];
            const tm = tile?.tileModel;
            if (!tm) continue;
            curLevel = level;
            const sx = (x - borderSize) * 128, sz = (y - borderSize) * 128;
            if (!inRange(sx, sz)) continue;
            for (const face of tm.faces) {
                const v0 = face.vertices[0];
                if (v0.hsl === INVALID_HSL_COLOR) continue;
                const b = bucket(v0.textureId, false);
                for (const v of face.vertices) {
                    pushVertex(b, v.x - borderSize * 128, v.y, v.z - borderSize * 128, v.hsl, 0xff, v.u, v.v);
                }
                terrainFaces++;
            }
        }
    }
}

function addModel(model: Model, sceneX: number, sceneHeight: number, sceneZ: number, contour: boolean) {
    const vy = contour && model.contourVerticesY ? model.contourVerticesY : model.verticesY;
    const uvs = model.uvs;
    let n = 0;
    for (const face of getModelFaces(model)) {
        const i = face.index;
        let a = model.faceColors1[i], bb = model.faceColors2[i], c = model.faceColors3[i];
        if (c === -1) c = bb = a;
        const transparent = face.alpha < 0xff || (face.textureId !== -1 && textureLoader.isTransparent(face.textureId));
        const b = bucket(face.textureId, transparent);
        const idx = [model.indices1[i], model.indices2[i], model.indices3[i]];
        const cols = [a, bb, c];
        for (let k = 0; k < 3; k++) {
            const vi = idx[k];
            const u = uvs ? uvs[i * 6 + k * 2] : 0;
            const v = uvs ? uvs[i * 6 + k * 2 + 1] : 0;
            pushVertex(b, sceneX + model.verticesX[vi], sceneHeight + vy[vi], sceneZ + model.verticesZ[vi], cols[k], face.alpha, u, v);
        }
        n++;
    }
    return n;
}

const sceneLocs = getSceneLocs(locTypeLoader, scene, borderSize, 3);
let locModels = 0, locFaces = 0, entityModels = 0;
for (const sm of sceneLocs.locs) {
    if (!inRange(sm.sceneX, sm.sceneZ)) continue;
    curLevel = sm.level;
    locFaces += addModel(sm.model, sm.sceneX, sm.sceneHeight, sm.sceneZ, sm.contourGround === ContourGroundType.VERTEX);
    locModels++;
}
// animated / multiloc (varbit) entities: resolve with default varps, frame 0
for (const le of sceneLocs.locEntities) {
    if (!inRange(le.sceneX, le.sceneZ)) continue;
    curLevel = le.level;
    let locType = locTypeLoader.load(le.entity.id);
    if (locType.transforms) locType = locType.transform(varManager, locTypeLoader)!;
    if (!locType) continue;
    const model = locModelLoader.getModelAnimated(locType, le.entity.type, le.entity.rotation, le.entity.seqId, le.entity.seqId !== -1 ? 0 : -1);
    if (!model) continue;
    locFaces += addModel(model, le.sceneX, le.sceneLoc.height, le.sceneZ, false);
    entityModels++;
}

// write GLB
const doc = new Document();
const unlit = doc.createExtension(KHRMaterialsUnlit);
const buf = doc.createBuffer();
const root = doc.createNode("varrock_west_bank");
doc.createScene("scene").addChild(root);
const meshes = new Map<number, ReturnType<typeof doc.createMesh>>();
const textures = new Map<number, ReturnType<typeof doc.createTexture>>();
for (const b of buckets.values()) {
    let mesh = meshes.get(b.level);
    if (!mesh) {
        mesh = doc.createMesh(`plane${b.level}`);
        meshes.set(b.level, mesh);
        root.addChild(doc.createNode(`plane${b.level}`).setMesh(mesh));
    }
    if (b.pos.length === 0) continue;
    const mat = doc.createMaterial(`tex${b.textureId}${b.alpha ? "_alpha" : ""}`)
        .setExtension("KHR_materials_unlit", unlit.createUnlit())
        .setAlphaMode(b.alpha ? "BLEND" : "OPAQUE")
        .setDoubleSided(false);
    const prim: Primitive = doc.createPrimitive()
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(b.pos)).setBuffer(buf))
        .setAttribute("COLOR_0", doc.createAccessor().setType("VEC4").setArray(new Float32Array(b.col)).setBuffer(buf))
        .setMaterial(mat);
    if (b.textureId !== -1) {
        prim.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(b.uv)).setBuffer(buf));
        const size = 128;
        const px = textureLoader.getPixelsArgb(b.textureId, size, true, 1.0);
        const png = new PNG({ width: size, height: size });
        for (let i = 0; i < size * size; i++) {
            const p = px[i];
            png.data[i * 4] = (p >> 16) & 0xff;
            png.data[i * 4 + 1] = (p >> 8) & 0xff;
            png.data[i * 4 + 2] = p & 0xff;
            png.data[i * 4 + 3] = textureLoader.isTransparent(b.textureId) ? (p >>> 24) & 0xff : 0xff;
        }
        let tex = textures.get(b.textureId);
        if (!tex) {
            tex = doc.createTexture(`texture_${b.textureId}`).setImage(PNG.sync.write(png)).setMimeType("image/png");
            textures.set(b.textureId, tex);
        }
        mat.setBaseColorTexture(tex);
        if (textureLoader.isTransparent(b.textureId)) mat.setAlphaMode("MASK");
    }
    mesh.addPrimitive(prim);
}
new NodeIO().registerExtensions([KHRMaterialsUnlit]).write(outPath, doc).then(() =>
    console.log(JSON.stringify({ terrainFaces, locModels, entityModels, locFaces, buckets: [...buckets.keys()], out: outPath, bytes: fs.statSync(outPath).size })),
);
