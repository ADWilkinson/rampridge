// Scratch exporter: NPC or identity-kit player -> GLB with client-lit (Gouraud) vertex colours
// and one morph target per animation frame (exactly how the OSRS client animates: colours fixed, vertices move).
// Usage:
//   npx tsx scripts/cache/export-actor-gltf.ts npc <npcId> <seqId,seqId,...> <out.glb>
//   npx tsx scripts/cache/export-actor-gltf.ts models <modelId,modelId,...> <seqId,...> <out.glb>
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";
import fs from "fs";

import { getModelFaces } from "../../src/mapviewer/webgl/buffer/SceneBuffer";
import { CacheSystem } from "../../src/rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../../src/rs/cache/loader/CacheLoaderFactory";
import { NpcModelLoader } from "../../src/rs/config/npctype/NpcModelLoader";
import { NpcType } from "../../src/rs/config/npctype/NpcType";
import { VarManager } from "../../src/rs/config/vartype/VarManager";
import { Model } from "../../src/rs/model/Model";
import { HSL_RGB_MAP } from "../../src/rs/util/ColorUtil";
import { loadCache, loadCacheInfos, loadCacheList } from "./load-util";

const [mode, idArg, seqArg, outPath] = process.argv.slice(2);
const seqIds = seqArg.split(",").filter(Boolean).map(Number);

const cacheInfo = loadCacheList(loadCacheInfos()).latest;
const loadedCache = loadCache(cacheInfo);
const f = getCacheLoaderFactory(cacheInfo, CacheSystem.fromFiles(loadedCache.type, loadedCache.files));
const npcTypeLoader = f.getNpcTypeLoader();
const seqTypeLoader = f.getSeqTypeLoader();
const textureLoader = f.getTextureLoader();
const npcModelLoader = new NpcModelLoader(
    npcTypeLoader,
    f.getModelLoader(),
    textureLoader,
    seqTypeLoader,
    f.getSeqFrameLoader(),
    f.getSkeletalSeqLoader(),
    new VarManager(f.getVarBitTypeLoader()),
);

let npcType: NpcType;
if (mode === "npc") {
    npcType = npcTypeLoader.load(Number(idArg));
} else {
    // synthetic NpcType: player body = merged identity-kit models, lit like the client's player (64, 850, -30,-50,-30)
    npcType = new NpcType(-1, cacheInfo);
    npcType.modelIds = idArg.split(",").map(Number);
    npcType.name = "player";
}

const base = npcModelLoader.getModel(npcType, -1, -1)!;
const faces = getModelFaces(base);

// dedupe (vertex, colour, alpha) like a client vertex buffer would
const key2idx = new Map<string, number>();
const srcVertex: number[] = [];
const col: number[] = [];
const indices: number[] = [];
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
for (const face of faces) {
    const i = face.index;
    let a = base.faceColors1[i], b = base.faceColors2[i], c = base.faceColors3[i];
    if (c === -1) c = b = a;
    const vs = [base.indices1[i], base.indices2[i], base.indices3[i]];
    const cs = [a, b, c];
    for (let k = 0; k < 3; k++) {
        const key = `${vs[k]}:${cs[k]}:${face.alpha}`;
        let idx = key2idx.get(key);
        if (idx === undefined) {
            idx = srcVertex.length;
            key2idx.set(key, idx);
            srcVertex.push(vs[k]);
            const rgb = HSL_RGB_MAP[cs[k] & 0xffff];
            col.push(srgbToLinear(((rgb >> 16) & 0xff) / 255), srgbToLinear(((rgb >> 8) & 0xff) / 255), srgbToLinear((rgb & 0xff) / 255), face.alpha / 255);
        }
        indices.push(idx);
    }
}
const positionsOf = (m: Model) => {
    const out = new Float32Array(srcVertex.length * 3);
    srcVertex.forEach((v, j) => {
        out[j * 3] = m.verticesX[v] / 128;
        out[j * 3 + 1] = -m.verticesY[v] / 128;
        out[j * 3 + 2] = -m.verticesZ[v] / 128;
    });
    return out;
};
const basePos = positionsOf(base);

const doc = new Document();
const unlit = doc.createExtension(KHRMaterialsUnlit);
const buf = doc.createBuffer();
const hasAlpha = faces.some((fc) => fc.alpha < 0xff);
const mat = doc.createMaterial("osrs_vertex_lit").setExtension("KHR_materials_unlit", unlit.createUnlit()).setAlphaMode(hasAlpha ? "BLEND" : "OPAQUE");
const prim = doc.createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(basePos).setBuffer(buf))
    .setAttribute("COLOR_0", doc.createAccessor().setType("VEC4").setArray(new Float32Array(col)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buf))
    .setMaterial(mat);
const mesh = doc.createMesh(npcType.name).addPrimitive(prim);
const node = doc.createNode(npcType.name).setMesh(mesh);
doc.createScene().addChild(node);

const clips: { seqId: number; frames: number[]; times: number[] }[] = [];
let targetCount = 0;
for (const seqId of seqIds) {
    const seq = seqTypeLoader.load(seqId);
    const frames: number[] = [];
    const times: number[] = [];
    let t = 0;
    for (let fi = 0; fi < seq.frameIds.length; fi++) {
        const m = npcModelLoader.getModel(npcType, seqId, fi)!;
        const p = positionsOf(m);
        for (let j = 0; j < p.length; j++) p[j] -= basePos[j];
        prim.addTarget(doc.createPrimitiveTarget().setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(p).setBuffer(buf)));
        frames.push(targetCount++);
        times.push(t);
        t += seq.frameLengths[fi] * 0.02; // client ticks are 20 ms
    }
    // close the loop: hold last frame until the clip end
    frames.push(frames[frames.length - 1]);
    times.push(t);
    clips.push({ seqId, frames, times });
}
mesh.setWeights(new Array(targetCount).fill(0));
for (const clip of clips) {
    const weights = new Float32Array(clip.times.length * targetCount);
    clip.frames.forEach((ti, k) => (weights[k * targetCount + ti] = 1));
    const sampler = doc.createAnimationSampler()
        .setInput(doc.createAccessor().setType("SCALAR").setArray(new Float32Array(clip.times)).setBuffer(buf))
        .setOutput(doc.createAccessor().setType("SCALAR").setArray(weights).setBuffer(buf))
        .setInterpolation("STEP");
    doc.createAnimation(`seq_${clip.seqId}`)
        .addSampler(sampler)
        .addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath("weights").setSampler(sampler));
}
new NodeIO().registerExtensions([KHRMaterialsUnlit]).write(outPath, doc).then(() =>
    console.log(JSON.stringify({ name: npcType.name, vertices: srcVertex.length, triangles: indices.length / 3, morphTargets: targetCount, clips: clips.map((c) => ({ seq: c.seqId, frames: c.frames.length - 1, seconds: +c.times[c.times.length - 1].toFixed(2) })), out: outPath, bytes: fs.statSync(outPath).size })),
);
