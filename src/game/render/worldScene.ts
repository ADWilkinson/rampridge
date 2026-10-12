import {
  type BufferGeometry,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  type Object3D,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/**
 * The baked Varrock West Bank region. Lighting is baked into vertex colours
 * by the client's own lighting model, so every surface is unlit. The upper
 * planes (roofs and the first floor) are hidden, like the client hides
 * roofs while the player is indoors.
 */

const HIDDEN_PLANES = /^plane[123]$/;

export interface LoadedWorld {
  root: Object3D;
  dispose(): void;
}

function isMesh(object: Object3D): object is Mesh {
  return (object as Mesh).isMesh === true;
}

function unlit(source: Material): MeshBasicMaterial {
  if (source instanceof MeshBasicMaterial) {
    source.vertexColors = true;
    source.fog = true;
    return source;
  }
  const s = source as Material & { map?: Texture | null; alphaTest?: number };
  const out = new MeshBasicMaterial({
    vertexColors: true,
    map: s.map ?? null,
    transparent: source.transparent,
    opacity: source.opacity,
    alphaTest: s.alphaTest ?? 0,
    side: source.side,
    depthWrite: source.depthWrite,
  });
  out.name = source.name;
  source.dispose();
  return out;
}

export async function loadWorld(url: string, onProgress?: (fraction: number) => void): Promise<LoadedWorld> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, (event) => {
    if (onProgress && event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
  });
  const root = gltf.scene;
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();

  root.traverse((object) => {
    if (HIDDEN_PLANES.test(object.name)) object.visible = false;
    if (!isMesh(object)) return;
    object.matrixAutoUpdate = false;
    object.updateMatrix();
    geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    const converted = list.map((m) => {
      const basic = unlit(m);
      if (basic.map) textures.add(basic.map);
      materials.add(basic);
      return basic;
    });
    object.material = Array.isArray(object.material) ? converted : converted[0]!;
  });
  root.updateMatrixWorld(true);

  return {
    root,
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}
