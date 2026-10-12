import { Group, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type Mesh, type Object3D } from "three";
import type { Appearance } from "@shared/protocol";

import { OsrsCharacterFactory } from "./factory";
import type { CharacterHandle } from "./types";

export interface CharacterPreview {
  /** Swap the shown appearance (kept in place, animation continues). */
  update(appearance: Appearance): void;
  dispose(): void;
}

export interface CharacterPreviewOptions {
  /** Reuse an existing factory (its materials are not disposed with the preview). */
  factory?: OsrsCharacterFactory;
  /**
   * Seconds per sway cycle (left, back through the front, right and back).
   * Default {@link DESIGNER_SWAY_SECONDS}, the 2007 designer's rate; 0 holds
   * the model facing the viewer. Ignored for the "head" framing.
   */
  swaySeconds?: number;
  /**
   * "body" (default): the design interface's whole-body view. "head": a
   * dialogue chathead, the head and shoulders facing front, held still.
   */
  framing?: "body" | "head";
  /** The canvas's accessible name (default "Character preview"). */
  label?: string;
  /** Called once if nothing can be drawn: WebGL is unavailable or the model failed to load. */
  onError?: (err: unknown) => void;
}

/** What a preview shows: a player look, or a cache NPC (e.g. 2897, a banker). */
export type CharacterPreviewSource = Appearance | { npcId: number };

function isNpcSource(source: CharacterPreviewSource): source is { npcId: number } {
  return typeof (source as { npcId?: unknown }).npcId === "number";
}

/** The client's cycle is 20 ms; the 2007 designer sets the model's yaw to sin(cycle / 40) * 256 of 2048. */
const CLIENT_CYCLE_SECONDS = 0.02;
const SWAY_CYCLES = 40;
/** One full sway of the 2007 design interface model: 2π × 40 cycles of 20 ms, about 5.03 s. */
export const DESIGNER_SWAY_SECONDS = 2 * Math.PI * SWAY_CYCLES * CLIENT_CYCLE_SECONDS;
/** ±256 of the client's 2048-unit circle: ±45 degrees either side of facing front. */
const SWAY_RADIANS = (256 / 2048) * Math.PI * 2;
/** The design interface's fixed model pitch, modelAngleX = 150 of 2048: about 26 degrees. */
const PITCH_RADIANS = (150 / 2048) * Math.PI * 2;
/**
 * Framed body height in tiles. Designer looks run 1.49 to 1.66 tiles (the
 * tallest hairstyles) and most are about 1.53; framing one fixed height keeps
 * the zoom steady while cycling kits, like the interface's fixed model zoom,
 * centres the usual look and leaves the tallest hair inside the margin.
 */
const FRAME_HEIGHT = 1.53;
/** Models up to this height fit the fixed framing; anything taller is framed on its own height. */
const FRAME_FITS = 1.68;
/**
 * Measured from the designer bodies in their idle pose, in tiles: the back
 * of the head sits this far behind the body's axis, the forward toes reach
 * this far in front of it, and the soles this far below the floor. From the
 * raised camera these are the points that reach furthest up and down.
 */
const FRAME_HEAD_BACK = 0.05;
const FRAME_TOE_REACH = 0.23;
const FRAME_SOLE = 0.07;
/** Half the widest designer look in tiles plus the swing of the arms while swaying. */
const FRAME_HALF_WIDTH = 0.42;
/** Space around the framed body, as a factor on the field of view. */
const FRAME_MARGIN = 1.18;
const FOV_DEGREES = 24;
/** The chathead frame: this much of the model below its highest point (head, neck and the top of the shoulders), in tiles. */
const HEAD_SPAN = 0.36;
/** Space around the framed head, as a factor on the field of view. */
const HEAD_MARGIN = 1.08;
/** The chathead camera looks down this little, so the face reads rather than the crown. */
const HEAD_PITCH_RADIANS = (40 / 2048) * Math.PI * 2;
/** Keep the shared context this long after the last preview closes, so a remount (StrictMode, screen flips) reuses it. */
const RELEASE_DELAY_MS = 2000;

/**
 * One preview: its own scene, camera and visible 2D canvas. Rendering goes
 * through a single WebGL context shared by every preview on the page (see
 * below), so opening and closing the design screen never adds GL contexts
 * that could push the browser to evict the game's.
 */
interface PreviewView {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly turntable: Group;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly started: number;
  readonly swaySeconds: number;
  character: CharacterHandle | null;
  /** Backing size in device pixels; 0 while the container is not laid out. */
  width: number;
  height: number;
}

// ------------------------------------------------------------ shared renderer

const views = new Set<PreviewView>();
let renderer: WebGLRenderer | null = null;
let rendererFailed = false;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let raf = 0;
let lastFrame = 0;

/** The page's one preview renderer, created on first use and recreated if the browser lost its context. */
function sharedRenderer(): WebGLRenderer | null {
  if (renderer?.getContext().isContextLost()) {
    renderer.dispose();
    renderer = null;
  }
  if (!renderer && !rendererFailed) {
    try {
      renderer = new WebGLRenderer({
        canvas: document.createElement("canvas"),
        alpha: true,
        antialias: false,
        powerPreference: "low-power",
      });
      // Views are sized in device pixels already.
      renderer.setPixelRatio(1);
      renderer.setClearColor(0x000000, 0);
    } catch (err: unknown) {
      rendererFailed = true;
      console.error("character preview: WebGL is unavailable", err);
    }
  }
  return renderer;
}

/** Frees the shared context outright: dispose() alone leaves it alive until garbage collection. */
function releaseRenderer(): void {
  releaseTimer = null;
  if (views.size > 0 || !renderer) return;
  const r = renderer;
  renderer = null;
  r.dispose();
  if (!r.getContext().isContextLost()) r.forceContextLoss();
}

function tick(now: number): void {
  raf = views.size > 0 ? requestAnimationFrame(tick) : 0;
  const dt = Math.min(0.1, Math.max(0, now - lastFrame) / 1000);
  lastFrame = now;
  let needW = 0;
  let needH = 0;
  for (const v of views) {
    if (!v.character) continue;
    v.character.update(dt);
    const sway = v.swaySeconds > 0 ? Math.sin(((now - v.started) / 1000 / v.swaySeconds) * Math.PI * 2) : 0;
    v.turntable.rotation.y = -sway * SWAY_RADIANS;
    needW = Math.max(needW, v.width);
    needH = Math.max(needH, v.height);
  }
  if (needW === 0 || needH === 0) return;
  const r = sharedRenderer();
  if (!r) return;
  const gl = r.domElement;
  // Grow-only, so several previews of different sizes never reallocate per frame.
  if (gl.width < needW || gl.height < needH) r.setSize(Math.max(gl.width, needW), Math.max(gl.height, needH), false);
  for (const v of views) {
    if (!v.character || v.width === 0 || v.height === 0) continue;
    r.setViewport(0, 0, v.width, v.height);
    r.render(v.scene, v.camera);
    // GL's viewport origin is bottom-left; the canvas image's is top-left.
    v.ctx.clearRect(0, 0, v.width, v.height);
    v.ctx.drawImage(gl, 0, gl.height - v.height, v.width, v.height, 0, 0, v.width, v.height);
  }
}

function addView(view: PreviewView): void {
  views.add(view);
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
  if (raf === 0) {
    lastFrame = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

function removeView(view: PreviewView): void {
  views.delete(view);
  if (views.size > 0) return;
  cancelAnimationFrame(raf);
  raf = 0;
  if (releaseTimer === null) releaseTimer = setTimeout(releaseRenderer, RELEASE_DELAY_MS);
}

/**
 * Camera for the design interface's view: pitched down about 26 degrees,
 * the whole body in frame with equal space above the back of the head and
 * below the toes (the two points that reach furthest on screen from above).
 */
function frameCamera(camera: PerspectiveCamera, modelHeight: number): void {
  const h = modelHeight > FRAME_FITS ? modelHeight : FRAME_HEIGHT;
  const back = FRAME_HEAD_BACK;
  const toe = FRAME_TOE_REACH;
  const sole = FRAME_SOLE;
  const s = Math.sin(PITCH_RADIANS);
  const c = Math.cos(PITCH_RADIANS);
  const k = Math.tan(((camera.fov / 2) * Math.PI) / 180) / FRAME_MARGIN;
  // The look-at height where the crown (h, behind) and the toes (-sole, in front) project equally
  // far from the centre at the same distance, then the distance that puts both at the margin.
  const target = (h - sole) / 2 + ((back - toe) * s) / (2 * c) + (k * ((h + sole) * s - (back + toe) * c)) / (2 * c);
  const below = target + sole;
  const fitV = (below * c + toe * s) / k - below * s + toe * c;
  const fitH = FRAME_HALF_WIDTH / (k * camera.aspect) + FRAME_HALF_WIDTH;
  const distance = Math.max(fitV, fitH);
  camera.position.set(0, target + s * distance, c * distance);
  camera.lookAt(0, target, 0);
}

/** Head and shoulders: the model's vertices within HEAD_SPAN of its highest point, as a box. */
interface HeadBox {
  top: number;
  bottom: number;
  centreX: number;
  centreZ: number;
  halfWidth: number;
  front: number;
}

function headBox(object: Object3D): HeadBox | null {
  object.updateMatrixWorld(true);
  const v = new Vector3();
  const points: number[] = [];
  let top = Number.NEGATIVE_INFINITY;
  object.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      points.push(v.x, v.y, v.z);
      if (v.y > top) top = v.y;
    }
  });
  if (!Number.isFinite(top)) return null;
  const bottom = top - HEAD_SPAN;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < points.length; i += 3) {
    if (points[i + 1]! < bottom) continue;
    const x = points[i]!;
    const z = points[i + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return null;
  return { top, bottom, centreX: (minX + maxX) / 2, centreZ: (minZ + maxZ) / 2, halfWidth: (maxX - minX) / 2, front: maxZ };
}

/** The head box of a freshly built model, or one under its height when its vertices can't be read. */
function measureHead(character: CharacterHandle): HeadBox {
  return (
    headBox(character.object) ?? {
      top: character.height,
      bottom: character.height - HEAD_SPAN,
      centreX: 0,
      centreZ: 0,
      halfWidth: 0.2,
      front: 0.15,
    }
  );
}

/** Camera for a chathead: in front of the face, pitched down slightly, with the head and shoulders filling the frame. */
function frameHead(camera: PerspectiveCamera, box: HeadBox): void {
  const k = Math.tan(((camera.fov / 2) * Math.PI) / 180) / HEAD_MARGIN;
  const midY = (box.top + box.bottom) / 2;
  const fitV = (box.top - box.bottom) / 2 / k;
  const fitH = box.halfWidth / (k * camera.aspect);
  // Measured from the front of the face, so a wide brim or beard never reaches the near plane.
  const distance = Math.max(fitV, fitH) + (box.front - box.centreZ);
  const s = Math.sin(HEAD_PITCH_RADIANS);
  const c = Math.cos(HEAD_PITCH_RADIANS);
  camera.position.set(box.centreX, midY + s * distance, box.centreZ + c * distance);
  camera.lookAt(box.centreX, midY, box.centreZ);
}

/**
 * The character-design model preview: a transparent canvas filling
 * `container` and showing the character idling while it sways ±45 degrees
 * either side of facing the viewer under a fixed 26 degree pitch, like the
 * 2007 design interface's model (it never turns its back). The container
 * supplies the interface background. Under prefers-reduced-motion the model
 * holds still facing front.
 *
 * With `framing: "head"` it is a dialogue chathead instead: the head and
 * shoulders of a player look or a cache NPC (`{ npcId }`), facing front and
 * still apart from its idle animation.
 *
 * Every preview on the page renders through one shared WebGL context, which
 * is released (not just disposed) shortly after the last preview closes.
 */
export function renderCharacterPreview(
  container: HTMLElement,
  source: CharacterPreviewSource,
  options: CharacterPreviewOptions = {},
): CharacterPreview {
  const ownFactory = !options.factory;
  const factory = options.factory ?? new OsrsCharacterFactory();
  const head = options.framing === "head";
  const reducedMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Measured once per model (its rest pose), so resizes don't re-read every vertex. */
  let headBoxOf: { character: CharacterHandle; box: HeadBox } | null = null;
  const frame = (camera: PerspectiveCamera, character: CharacterHandle) => {
    if (!head) {
      frameCamera(camera, character.height);
      return;
    }
    if (headBoxOf?.character !== character) headBoxOf = { character, box: measureHead(character) };
    frameHead(camera, headBoxOf.box);
  };

  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", options.label ?? "Character preview");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("character preview: no 2D canvas context");
  container.appendChild(canvas);

  const scene = new Scene();
  const turntable = new Group();
  scene.add(turntable);
  const view: PreviewView = {
    scene,
    camera: new PerspectiveCamera(FOV_DEGREES, 1, 0.1, 50),
    turntable,
    canvas,
    ctx,
    started: performance.now(),
    swaySeconds: head || reducedMotion ? 0 : Math.max(0, options.swaySeconds ?? DESIGNER_SWAY_SECONDS),
    character: null,
    width: 0,
    height: 0,
  };

  let current = isNpcSource(source) ? null : source;
  let disposed = false;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(container.clientWidth * dpr);
    const h = Math.round(container.clientHeight * dpr);
    if (w === view.width && h === view.height) return;
    view.width = w;
    view.height = h;
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    view.camera.aspect = w > 0 && h > 0 ? w / h : 1;
    view.camera.updateProjectionMatrix();
    if (view.character) frame(view.camera, view.character);
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  observer?.observe(container);
  resize();
  addView(view);

  factory
    .load()
    .then(() => {
      if (disposed) return;
      if (!sharedRenderer()) throw new Error("character preview: WebGL is unavailable");
      const character = current ? factory.createPlayer(current) : factory.createNpc((source as { npcId: number }).npcId);
      view.character = character;
      turntable.add(character.object);
      frame(view.camera, character);
    })
    .catch((err: unknown) => {
      console.error("character preview failed to load", err);
      if (!disposed) options.onError?.(err);
    });

  return {
    update(next: Appearance) {
      // An NPC's look is fixed by the cache.
      if (current === null) return;
      current = next;
      if (!view.character) return;
      view.character.setAppearance(next);
      headBoxOf = null;
      frame(view.camera, view.character);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeView(view);
      observer?.disconnect();
      view.character?.dispose();
      view.character = null;
      if (ownFactory) factory.dispose();
      canvas.remove();
    },
  };
}
