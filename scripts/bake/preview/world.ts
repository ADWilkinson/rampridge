/**
 * Bake preview: renders the baked GLB the way the engine will (unlit vertex
 * colours, single-sided; the GLB holds map level 0 only) with an optional
 * collision overlay drawn from collision.json + world-meta.json.
 *
 * Query: view=interior|booths|doorway|exterior|street|rug|top|north,
 * overlay=0|1, fov=deg.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

interface Grid {
  originX: number;
  originY: number;
  width: number;
  height: number;
  flags: number[];
}
interface TileXY {
  x: number;
  y: number;
}
interface Meta {
  origin: TileXY;
  floorHeight: number;
  heightMap: { originX: number; originY: number; width: number; height: number; values: number[] };
  spawn: TileXY[];
  bankers: { tile: TileXY }[];
  booths: { tile: TileXY; useTile: TileXY }[];
  merchantArea: TileXY[];
  doors: { tiles: TileXY[]; outside: TileXY[]; open: boolean }[];
}

/** Camera presets: look-at tile, yaw (deg, 0 = camera south of target looking north), pitch (deg), distance (tiles). */
const VIEWS: Record<string, { at: [number, number]; yaw: number; pitch: number; dist: number }> = {
  interior: { at: [3184, 3440], yaw: 210, pitch: 42, dist: 17 },
  booths: { at: [3185.5, 3440], yaw: 255, pitch: 30, dist: 8 },
  doorway: { at: [3182.5, 3436], yaw: 0, pitch: 24, dist: 9 },
  street: { at: [3183, 3433], yaw: 180, pitch: 22, dist: 10 },
  exterior: { at: [3185, 3438], yaw: 20, pitch: 38, dist: 34 },
  north: { at: [3183, 3446], yaw: 180, pitch: 30, dist: 10 },
  rug: { at: [3182.5, 3439], yaw: 300, pitch: 55, dist: 7 },
  top: { at: [3185, 3440.5], yaw: 0, pitch: 90, dist: 30 },
};

export async function runWorld(hud: (s: string) => void): Promise<void> {
  const q = new URLSearchParams(location.search);
  const viewName = q.get("view") ?? "interior";
  const view = VIEWS[viewName] ?? VIEWS.interior!;
  const overlay = q.get("overlay") === "1";

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const [grid, meta, gltf] = await Promise.all([
    fetch("/game/world/collision.json").then((r) => r.json() as Promise<Grid>),
    fetch("/shared/world-meta.json").then((r) => r.json() as Promise<Meta>),
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/game/world/varrock-west-bank.glb"),
  ]);
  scene.add(gltf.scene);
  let tris = 0;
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const g = (o as THREE.Mesh).geometry;
      tris += (g.index ? g.index.count : g.attributes.position!.count) / 3;
    }
  });

  const tileToScene = (x: number, y: number) => new THREE.Vector3(x - meta.origin.x + 0.5, 0, -(y - meta.origin.y + 0.5));
  const heightAt = (wx: number, wy: number) => {
    // wx, wy: continuous world tile coords (corner grid)
    const hm = meta.heightMap;
    const fx = Math.min(Math.max(wx - hm.originX, 0), hm.width - 1.001);
    const fy = Math.min(Math.max(wy - hm.originY, 0), hm.height - 1.001);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const h = (x: number, y: number) => hm.values[y * hm.width + x]!;
    return (h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx) * (1 - ty) + (h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx) * ty;
  };

  if (overlay) scene.add(buildOverlay(grid, meta, tileToScene, heightAt));

  const fov = Number(q.get("fov") ?? 36);
  const aspect = innerWidth / innerHeight;
  const target = tileToScene(view.at[0] - 0.5, view.at[1] - 0.5);
  target.y = heightAt(view.at[0], view.at[1]);
  let camera: THREE.Camera;
  if (viewName === "top") {
    const half = 13.5;
    const ortho = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, 200);
    ortho.position.set(target.x, 60, target.z);
    ortho.up.set(0, 0, -1);
    ortho.lookAt(target);
    camera = ortho;
  } else {
    const persp = new THREE.PerspectiveCamera(fov, aspect, 0.05, 200);
    const yaw = (view.yaw * Math.PI) / 180;
    const pitch = (view.pitch * Math.PI) / 180;
    persp.position.set(
      target.x - Math.sin(yaw) * Math.cos(pitch) * view.dist,
      target.y + Math.sin(pitch) * view.dist,
      target.z + Math.cos(yaw) * Math.cos(pitch) * view.dist,
    );
    persp.lookAt(target);
    camera = persp;
  }
  renderer.render(scene, camera);
  hud(`view=${viewName} overlay=${overlay ? 1 : 0} triangles=${tris}`);
}

function buildOverlay(
  grid: Grid,
  meta: Meta,
  tileToScene: (x: number, y: number) => THREE.Vector3,
  heightAt: (x: number, y: number) => number,
): THREE.Group {
  const group = new THREE.Group();
  const quad = (x: number, y: number, color: number, opacity: number, inset = 0.04, lift = 0.03) => {
    const c = tileToScene(x, y);
    const geo = new THREE.PlaneGeometry(1 - inset * 2, 1 - inset * 2);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
    m.position.set(c.x, heightAt(x + 0.5, y + 0.5) + lift, c.z);
    m.renderOrder = 10;
    group.add(m);
  };
  const edge = (x0: number, y0: number, x1: number, y1: number, color: number) => {
    // world corner coordinates
    const a = new THREE.Vector3(x0 - meta.origin.x, heightAt(x0, y0) + 0.06, -(y0 - meta.origin.y));
    const b = new THREE.Vector3(x1 - meta.origin.x, heightAt(x1, y1) + 0.06, -(y1 - meta.origin.y));
    const len = a.distanceTo(b);
    const geo = new THREE.BoxGeometry(len, 0.08, 0.1);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    m.renderOrder = 11;
    group.add(m);
  };
  for (let ly = 0; ly < grid.height; ly++) {
    for (let lx = 0; lx < grid.width; lx++) {
      const f = grid.flags[ly * grid.width + lx]!;
      const x = grid.originX + lx;
      const y = grid.originY + ly;
      if (f & (0x100 | 0x40000 | 0x200000)) quad(x, y, 0xff2020, 0.45);
      else if (f & 0x100000) quad(x, y, 0x2040ff, 0.22);
      else quad(x, y, 0x20ff40, 0.12, 0.1);
      if (f & 0x2) edge(x, y + 1, x + 1, y + 1, 0xff3030);
      if (f & 0x8) edge(x + 1, y, x + 1, y + 1, 0xff3030);
      if (f & 0x20) edge(x, y, x + 1, y, 0xff3030);
      if (f & 0x80) edge(x, y, x, y + 1, 0xff3030);
      if (f & 0x1) edge(x, y + 1, x + 0.5, y + 0.5, 0xffa030);
      if (f & 0x4) edge(x + 1, y + 1, x + 0.5, y + 0.5, 0xffa030);
      if (f & 0x10) edge(x + 1, y, x + 0.5, y + 0.5, 0xffa030);
      if (f & 0x40) edge(x, y, x + 0.5, y + 0.5, 0xffa030);
    }
  }
  for (const t of meta.merchantArea) quad(t.x, t.y, 0xff40ff, 0.5, 0.3, 0.05);
  for (const t of meta.spawn) quad(t.x, t.y, 0xffffff, 0.7, 0.3, 0.05);
  for (const b of meta.booths) {
    quad(b.tile.x, b.tile.y, 0x20ffff, 0.8, 0.25, 0.06);
    quad(b.useTile.x, b.useTile.y, 0x20ff20, 0.8, 0.3, 0.06);
  }
  for (const b of meta.bankers) quad(b.tile.x, b.tile.y, 0xffff20, 0.9, 0.3, 0.06);
  for (const d of meta.doors) for (const t of d.tiles) quad(t.x, t.y, d.open ? 0xff9020 : 0x804010, 0.8, 0.35, 0.07);
  return group;
}
