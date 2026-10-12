/**
 * Dev-only backdrop for the UI gallery: renders the baked Varrock West Bank
 * (public/game/world/varrock-west-bank.glb) so the HUD and screens can be
 * judged over the real scene. The engine owns the production renderer.
 */
import { AmbientLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

export interface BackdropOptions {
  /** Slow orbit like the title screen. */
  orbit?: boolean;
}

export function mountBankBackdrop(container: HTMLElement, { orbit = false }: BackdropOptions = {}): () => void {
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 1);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";

  const scene = new Scene();
  scene.add(new AmbientLight(0xffffff, 1));
  const camera = new PerspectiveCamera(45, 1, 0.1, 400);
  const target = new Vector3(10.5, 2.4, -12);
  let disposed = false;
  let raf = 0;

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const place = (t: number) => {
    const angle = orbit ? t * 0.00005 : 0;
    const r = 15;
    camera.position.set(target.x + Math.sin(angle) * r, target.y + 12, target.z + Math.cos(angle) * r);
    camera.lookAt(target);
  };

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load("/game/world/varrock-west-bank.glb", (gltf) => {
    if (disposed) return;
    for (const name of ["plane1", "plane2", "plane3"]) {
      const node = gltf.scene.getObjectByName(name);
      if (node) node.visible = false;
    }
    scene.add(gltf.scene);
  });

  const frame = (t: number) => {
    if (disposed) return;
    place(t);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
