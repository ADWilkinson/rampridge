/**
 * Visual harness for the OSRS character runtime (dev/actors.html).
 *
 * Views (?view=):
 *   all      12 random looks idling, walk/run/turn, every emote, the bankers
 *   idle     12 random looks idling
 *   emotes   locomotion and every emote, replayed in a loop
 *   bankers  the three bank NPCs, close up
 *   perf     40 animated characters; logs frame and update times
 *   preview  the character-design preview widget in design-screen sized boxes:
 *            male and female defaults plus two random looks (?sway=0 holds front,
 *            &tall=1 the tallest hairstyles, &set=jaw body B's jaw options)
 *   kits     every designer kit for one slot (?body=0|1&slot=0..6) plus the colour swatches
 *   bank     bankers and a few players in the baked bank room (world GLB), to
 *            compare with the research render and the original game
 *   sheet    contact sheet: each sequence sampled at 8 points across its
 *            duration (?set=loco|emotes1|emotes2), for checking every frame
 * Options: ?t=<seconds> freezes the clock at that time (deterministic stills),
 * ?smooth=0 plays frames unsmoothed like the 2007 client, ?seed=<s> reseeds,
 * ?churn=<n> (animated views) mounts n previews one after another over the
 * running scene, each disposed after 150 ms (&churnGap=<ms> waits between
 * them), and reports the GL contexts previews created and released and
 * whether the main context was lost in document.body.dataset.churn.
 */
import {
  Color,
  GridHelper,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Camera,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { EMOTES, type Appearance, type EmoteId } from "@shared/protocol";

import {
  BANKER_NPC_IDS,
  EMOTE_SEQUENCES,
  PLAYER_ANIMS,
  createCharacterFactory,
  loadActors,
  renderCharacterPreview,
  type CharacterHandle,
  type Locomotion,
} from "../index";

interface Actor {
  handle: CharacterHandle;
  label: string;
  emote?: EmoteId;
  /** Seconds until the emote replays. */
  replayIn?: number;
  sub?: HTMLDivElement;
}

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "all";
const frozenAt = params.has("t") ? Number(params.get("t")) : null;
const smoothing = params.get("smooth") !== "0";
const seed = params.get("seed") ?? "rampridge";

const stage = document.getElementById("stage")!;
const labels = document.getElementById("labels")!;
const hud = document.getElementById("hud")!;

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);
const scene = new Scene();
scene.background = new Color(0x1b1712);
const perspective = new PerspectiveCamera(32, 1, 0.1, 200);
let camera: Camera = perspective;

const factory = createCharacterFactory({ smoothing, sequenceBlendMs: view === "sheet" ? 0 : 120 });
const actors: Actor[] = [];

function resize(): void {
  renderer.setSize(innerWidth, innerHeight);
  perspective.aspect = innerWidth / innerHeight;
  perspective.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

function place(handle: CharacterHandle, x: number, z: number, label: string, extra: Partial<Actor> = {}): Actor {
  handle.object.position.set(x, 0, z);
  scene.add(handle.object);
  const el = document.createElement("div");
  el.className = "label";
  el.textContent = label;
  labels.appendChild(el);
  const actor: Actor = { handle, label, sub: el, ...extra };
  actors.push(actor);
  return actor;
}

function lookFrom(x: number, y: number, z: number, at: Vector3): void {
  perspective.position.set(x, y, z);
  perspective.lookAt(at);
}

const ROW_HEIGHT = 2.3;

/** Bank-room coordinates: x = X - 3176 + 0.5, z = -(Y - 3428 + 0.5), floor y = 312/128. */
const BANK_ORIGIN = { x: 3176, y: 3428 };
const BANK_FLOOR = 312 / 128;
function bankTile(x: number, y: number): [number, number] {
  return [x - BANK_ORIGIN.x + 0.5, -(y - BANK_ORIGIN.y + 0.5)];
}

async function buildBank(): Promise<void> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync("/game/world/varrock-west-bank.glb");
  for (const name of ["plane1", "plane2", "plane3"]) {
    const node = gltf.scene.getObjectByName(name);
    if (node) node.visible = false;
  }
  scene.add(gltf.scene);
  const bankers: [number, number, number][] = [
    [2898, 3187, 3438],
    [2897, 3187, 3440],
    [2898, 3187, 3442],
    [2897, 3187, 3444],
    [8666, 3187, 3446],
  ];
  for (const [id, x, y] of bankers) {
    const [px, pz] = bankTile(x, y);
    const h = place(factory.createNpc(id), px, pz, "");
    h.handle.object.position.y = BANK_FLOOR;
    h.handle.object.rotation.y = -Math.PI / 2; // face west, over the booth
  }
  const looks = randomLooks(4);
  const visitors: [number, number, number, EmoteId | null][] = [
    [3185, 3440, Math.PI / 2, null],
    [3185, 3442, Math.PI / 2, "wave"],
    [3183, 3437, 0.4, null],
    [3182, 3441, -0.9, "dance"],
  ];
  visitors.forEach(([x, y, rot, emote], i) => {
    const [px, pz] = bankTile(x, y);
    const h = place(factory.createPlayer(looks[i]!), px, pz, "", emote ? { emote, replayIn: 0 } : {});
    h.handle.object.position.y = BANK_FLOOR;
    h.handle.object.rotation.y = rot;
  });
  const [cx, cz] = bankTile(3186, 3440);
  lookFrom(cx + 5.2, BANK_FLOOR + 5.4, cz + 6.5, new Vector3(cx, BANK_FLOOR + 0.6, cz - 0.6));
}

const SLOT_NAMES = ["hair", "jaw", "torso", "arms", "hands", "legs", "feet"];

/** Every kit the designer offers for one slot, on an otherwise default body, plus colour swatch rows. */
function buildKits(body: 0 | 1, slot: number): void {
  const catalog = factory.designer();
  const options = catalog.kits[body][slot]!;
  const perRow = 12;
  const rows = Math.ceil(options.length / perRow);
  options.forEach((opt, i) => {
    const kits: Appearance["kits"] = [0, 0, 0, 0, 0, 0, 0];
    kits[slot] = opt.index;
    // Brown hair and a light shirt make hair and beard recolours easy to judge.
    const h = factory.createPlayer({ body, kits, colors: [7, 9, 2, 0, 1] });
    h.object.rotation.y = slot === 0 || slot === 1 ? -0.5 : 0;
    place(h, (i % perRow) * 1.1, 0, String(opt.index));
    h.object.position.y = -Math.floor(i / perRow) * ROW_HEIGHT;
  });
  const width = (perRow - 1) * 1.1;
  const height = (rows - 1) * ROW_HEIGHT;
  const aspect = innerWidth / innerHeight;
  const halfH = Math.max(height / 2 + 1.6, (width / 2 + 1) / aspect);
  const ortho = new OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, 0.1, 100);
  const cy = -height / 2 + 0.2;
  ortho.position.set(width / 2, cy + 2, 20);
  ortho.lookAt(width / 2, cy, 0);
  camera = ortho;
  const swatches = document.createElement("div");
  swatches.style.cssText = "position:fixed;left:8px;bottom:8px;display:grid;gap:3px";
  catalog.colors.forEach((channel, c) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:2px;align-items:center";
    row.innerHTML = `<span style="width:44px">${["hair", "torso", "legs", "feet", "skin"][c]}</span>`;
    for (const o of channel) {
      const sw = document.createElement("span");
      sw.title = String(o.index);
      sw.style.cssText = `width:18px;height:14px;background:${o.swatch};border:1px solid #000;font-size:9px;color:#fff`;
      sw.textContent = String(o.index);
      row.appendChild(sw);
    }
    swatches.appendChild(row);
  });
  document.body.appendChild(swatches);
  hud.textContent = `kits body=${body} slot=${SLOT_NAMES[slot]} options=${options.length}`;
}

/** Rows of sequences, 8 evenly spaced samples each, all static. */
async function buildSheet(set: string): Promise<void> {
  const { clips } = await loadActors();
  const rows: { label: string; seq: number; mode?: Locomotion; heading?: number }[] =
    set === "loco"
      ? [
          { label: "idle 808", seq: PLAYER_ANIMS.idle },
          { label: "walk 819", seq: PLAYER_ANIMS.walk, mode: "walk" },
          { label: "run 824", seq: PLAYER_ANIMS.run, mode: "run" },
          { label: "back 820", seq: PLAYER_ANIMS.walkBack, mode: "walk", heading: Math.PI },
          { label: "left 821", seq: PLAYER_ANIMS.walkLeft, mode: "walk", heading: Math.PI / 2 },
          { label: "right 822", seq: PLAYER_ANIMS.walkRight, mode: "walk", heading: -Math.PI / 2 },
          { label: "turn 823", seq: PLAYER_ANIMS.turn, mode: "turn" },
        ]
      : EMOTES.slice(set === "emotes2" ? 7 : 0, set === "emotes2" ? 14 : 7).map((e) => ({
          label: `${e} ${EMOTE_SEQUENCES[e]}`,
          seq: EMOTE_SEQUENCES[e],
        }));
  // Short hair, shirt and trousers so head, arm and leg motion all read.
  const look: Appearance = { body: 0, kits: [1, 0, 0, 0, 0, 0, 0], colors: [0, 8, 6, 0, 0] };
  const cols = 8;
  rows.forEach((row, r) => {
    const clip = clips.get(row.seq)!;
    let total = 0;
    for (const d of clip.durations) total += d;
    for (let c = 0; c < cols; c++) {
      const h = factory.createPlayer(look);
      // Seen from the front-left quarter so arm and leg swings read in both axes.
      h.object.rotation.y = -0.6;
      if (row.mode) {
        h.setLocomotion(row.mode);
        if (row.heading !== undefined) h.setHeadingOffset?.(row.heading);
      } else {
        h.playSequence(row.seq);
      }
      const t = ((total / cols) * c) / 1000;
      for (let k = 0; k < t; k += 0.02) h.update(Math.min(0.02, t - k));
      place(h, c * 1.25, 0, c === 0 ? row.label : `${t.toFixed(2)}s`);
      // Stack rows vertically and view them head-on with an orthographic camera.
      h.object.position.y = -r * ROW_HEIGHT;
    }
  });
  const width = (cols - 1) * 1.25;
  const height = (rows.length - 1) * ROW_HEIGHT;
  const aspect = innerWidth / innerHeight;
  const halfH = Math.max(height / 2 + 1.3, (width / 2 + 1) / aspect);
  const ortho = new OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, 0.1, 100);
  const cy = -height / 2 + 0.75;
  ortho.position.set(width / 2, cy + 3, 20);
  ortho.lookAt(width / 2, cy, 0);
  camera = ortho;
}

/** Design-screen sized preview boxes (150 x 196, as .rs-design__preview) on the interface stone. */
function buildPreviews(): void {
  const catalog = factory.designer();
  const defaults = catalog.defaults ?? { 0: [0, 0, 0, 0, 0, 0, 0], 1: [0, 0, 0, 0, 0, 0, 0] };
  const looks: [string, Appearance][] = [
    ["Male default", { body: 0, kits: [...defaults[0]] as Appearance["kits"], colors: [0, 0, 0, 0, 0] }],
    ["Female default", { body: 1, kits: [...defaults[1]] as Appearance["kits"], colors: [0, 0, 0, 0, 0] }],
    ...randomLooks(2).map((a, i): [string, Appearance] => [`Random ${i + 1}`, a]),
  ];
  if (params.get("set") === "jaw") {
    // Body B's jaw contract: -1 (bad data) renders the default, option 0 the clean chin 296, option 1 the goatee 292.
    const f = (jaw: number): Appearance => ({ body: 1, kits: [0, jaw, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] });
    looks.splice(0, looks.length, ["F jaw -1", f(-1)], ["F jaw 0 (296)", f(0)], ["F jaw 1 (292)", f(1)], ["M default", looks[0]![1]]);
  }
  if (params.has("tall")) {
    // The tallest hairstyle per body (male 29, female 31), to check the fixed framing never clips.
    looks.splice(2, 2, ["Tallest male", { body: 0, kits: [29, 0, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] }], [
      "Tallest female",
      { body: 1, kits: [31, 0, 0, 0, 0, 0, 0], colors: [0, 0, 0, 0, 0] },
    ]);
  }
  const sway = params.get("sway");
  const row = document.createElement("div");
  row.style.cssText = "position:fixed;left:24px;top:40px;display:flex;gap:16px;padding:12px;background:#3e3529;border:2px solid #5a4d3c";
  for (const [label, look] of looks) {
    const cell = document.createElement("div");
    cell.style.cssText = "display:grid;gap:4px;justify-items:center;color:#ff981f";
    const box = document.createElement("div");
    box.style.cssText = "width:150px;height:196px;background:rgba(0,0,0,0.3);border:1px solid #000;box-shadow:inset 0 0 0 1px #5d5547";
    cell.append(box, label);
    row.appendChild(cell);
    renderCharacterPreview(box, look, { factory, ...(sway !== null ? { swaySeconds: Number(sway) } : {}) });
  }
  document.body.appendChild(row);
  hud.textContent = `preview sway=${sway ?? "designer"}`;
  document.body.dataset.ready = "1";
}

/** Mounts and disposes `count` previews 150 ms apart over the running scene; reports GL context use. */
async function runChurn(count: number): Promise<void> {
  const main = renderer.getContext();
  let mainLost = 0;
  renderer.domElement.addEventListener("webglcontextlost", () => mainLost++);
  let contexts = 0;
  let released = 0;
  const seen = new WeakSet<HTMLCanvasElement>();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
    if ((type === "webgl" || type === "webgl2") && !seen.has(this)) {
      seen.add(this);
      contexts++;
      this.addEventListener("webglcontextlost", () => released++);
    }
    return (getContext as (...a: unknown[]) => unknown).call(this, type, ...rest);
  } as typeof getContext;
  const gap = Number(params.get("churnGap") ?? 0);
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;right:24px;top:24px;width:150px;height:196px;background:rgba(0,0,0,0.3)";
  document.body.appendChild(box);
  const look = factory.randomAppearance(`${seed}-churn`);
  for (let i = 0; i < count; i++) {
    const p = renderCharacterPreview(box, look, { factory });
    await new Promise((r) => setTimeout(r, 150));
    p.dispose();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  }
  HTMLCanvasElement.prototype.getContext = getContext;
  // Past the shared preview context's release delay.
  await new Promise((r) => setTimeout(r, 2500));
  const report = {
    previews: count,
    gapMs: gap,
    previewContextsCreated: contexts,
    previewContextsReleased: released,
    mainContextLostEvents: mainLost,
    mainContextLost: main.isContextLost(),
  };
  document.body.dataset.churn = JSON.stringify(report);
  hud.textContent += `\nchurn ${JSON.stringify(report)}`;
  box.remove();
}

function addGrid(size: number): void {
  const grid = new GridHelper(size, size, 0x4a3f30, 0x2e271e);
  grid.position.set(0, 0.001, 0);
  scene.add(grid);
}

function randomLooks(count: number): Appearance[] {
  return Array.from({ length: count }, (_, i) => factory.randomAppearance(`${seed}-${i}`));
}

function buildIdle(z: number, spacing = 1.8): void {
  randomLooks(12).forEach((a, i) => {
    const col = i % 6;
    const row = Math.floor(i / 6);
    const h = place(factory.createPlayer(a), (col - 2.5) * spacing, z + row * 2.4, `${a.body ? "F" : "M"} ${a.kits.join(".")}`);
    h.handle.update(i * 0.37);
  });
}

function buildEmotes(z: number): void {
  const looks = randomLooks(20);
  const locomotion: Locomotion[] = ["walk", "run", "turn"];
  const all: { label: string; setup: (h: CharacterHandle) => Partial<Actor> }[] = [
    ...locomotion.map((mode) => ({
      label: mode,
      setup: (h: CharacterHandle) => {
        h.setLocomotion(mode);
        return {};
      },
    })),
    { label: "walk-left", setup: (h) => (h.setLocomotion("walk"), h.setHeadingOffset?.(Math.PI / 2), {}) },
    ...EMOTES.map((emote) => ({
      label: emote,
      setup: (h: CharacterHandle) => {
        h.playEmote(emote);
        return { emote, replayIn: 0 };
      },
    })),
  ];
  const perRow = 9;
  all.forEach((entry, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const handle = factory.createPlayer(looks[i % looks.length]!);
    const extra = entry.setup(handle);
    place(handle, (col - (perRow - 1) / 2) * 1.5, z + row * 2.6, entry.label, extra);
  });
}

function buildBankers(z: number, spacing: number): void {
  BANKER_NPC_IDS.forEach((id, i) => {
    place(factory.createNpc(id), (i - 1) * spacing, z, `${factory.npcName(id) ?? "npc"} ${id}`);
  });
}

function buildPerf(): void {
  const looks = randomLooks(40);
  looks.forEach((a, i) => {
    const handle = factory.createPlayer(a);
    const col = i % 8;
    const row = Math.floor(i / 8);
    const kind = i % 4;
    const extra: Partial<Actor> = {};
    if (kind === 1) handle.setLocomotion("walk");
    else if (kind === 2) handle.setLocomotion("run");
    else if (kind === 3) {
      const emote = EMOTES[i % EMOTES.length]!;
      handle.playEmote(emote);
      extra.emote = emote;
      extra.replayIn = 0;
    }
    place(handle, (col - 3.5) * 1.6, (row - 2) * 2.2, "", extra);
  });
}

const perf = { frames: 0, frameMs: 0, updateMs: 0, maxFrameMs: 0, maxUpdateMs: 0, start: 0 };

function step(dt: number): void {
  for (const a of actors) {
    if (a.emote && a.replayIn !== undefined) {
      a.replayIn -= dt;
      if (a.replayIn <= 0) {
        a.handle.playEmote(a.emote);
        a.replayIn = 4.5;
      }
    }
    a.handle.update(dt);
  }
}

const tmp = new Vector3();
function updateLabels(): void {
  for (const a of actors) {
    if (!a.sub) continue;
    tmp.copy(a.handle.object.position);
    tmp.y -= 0.15;
    tmp.project(camera);
    a.sub.style.left = `${((tmp.x + 1) / 2) * innerWidth}px`;
    a.sub.style.top = `${((1 - tmp.y) / 2) * innerHeight}px`;
  }
}

async function main(): Promise<void> {
  hud.textContent = "Loading actors...";
  const t0 = performance.now();
  await factory.load((f) => (hud.textContent = `Loading actors... ${Math.round(f * 100)}%`));
  const loadMs = performance.now() - t0;

  switch (view) {
    case "idle":
      addGrid(14);
      buildIdle(-1.2, 1.9);
      lookFrom(0, 4.2, 9.5, new Vector3(0, 0.6, 0.2));
      break;
    case "emotes":
      addGrid(16);
      buildEmotes(-1.3);
      lookFrom(0, 3.8, 9.8, new Vector3(0, 0.6, 0.4));
      break;
    case "bankers":
      addGrid(6);
      buildBankers(0, 1);
      lookFrom(1.6, 2.4, 3.6, new Vector3(0, 0.75, 0));
      break;
    case "perf":
      addGrid(18);
      buildPerf();
      lookFrom(0, 9, 13, new Vector3(0, 0, 0));
      break;
    case "kits": {
      const body = params.get("body") === "1" ? 1 : 0;
      const slot = Math.min(6, Math.max(0, Number(params.get("slot") ?? 0)));
      buildKits(body, slot);
      renderer.render(scene, camera);
      updateLabels();
      document.body.dataset.ready = "1";
      return;
    }
    case "bank":
      await buildBank();
      break;
    case "sheet":
      await buildSheet(params.get("set") ?? "emotes1");
      renderer.render(scene, camera);
      updateLabels();
      hud.textContent = `sheet ${params.get("set") ?? "emotes1"} smooth=${smoothing}`;
      document.body.dataset.ready = "1";
      return;
    case "preview":
      buildPreviews();
      return;
    default:
      addGrid(22);
      buildIdle(-6.5);
      buildEmotes(-0.6);
      buildBankers(6.4, 1.6);
      lookFrom(0, 11, 17, new Vector3(0, 0, 1));
  }

  const triangles = actors.reduce((sum, a) => {
    let n = 0;
    a.handle.object.traverse((o) => {
      const g = (o as { geometry?: { index: { count: number } | null } }).geometry;
      if (g?.index) n += g.index.count / 3;
    });
    return sum + n;
  }, 0);

  if (frozenAt !== null) {
    // Deterministic still: simulate to t at the client's 20 ms cycle, render once.
    const cycle = 0.02;
    for (let t = 0; t < frozenAt; t += cycle) step(Math.min(cycle, frozenAt - t));
    renderer.render(scene, camera);
    updateLabels();
    hud.textContent = `view=${view} t=${frozenAt}s smooth=${smoothing} actors=${actors.length} tris=${triangles} load=${loadMs.toFixed(0)}ms`;
    document.body.dataset.ready = "1";
    return;
  }

  let last = performance.now();
  perf.start = last;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    const frameMs = now - last;
    last = now;
    const u0 = performance.now();
    step(dt);
    const updateMs = performance.now() - u0;
    renderer.render(scene, camera);
    updateLabels();
    if (now - perf.start > 1000) {
      // Skip the first second (shader compile, JIT warm-up).
      perf.frames++;
      perf.frameMs += frameMs;
      perf.updateMs += updateMs;
      perf.maxFrameMs = Math.max(perf.maxFrameMs, frameMs);
      perf.maxUpdateMs = Math.max(perf.maxUpdateMs, updateMs);
    }
    if (perf.frames > 0 && perf.frames % 60 === 0) {
      const report = {
        view,
        actors: actors.length,
        triangles,
        frames: perf.frames,
        avgFrameMs: +(perf.frameMs / perf.frames).toFixed(2),
        fps: +((1000 * perf.frames) / perf.frameMs).toFixed(1),
        avgUpdateMs: +(perf.updateMs / perf.frames).toFixed(3),
        maxUpdateMs: +perf.maxUpdateMs.toFixed(3),
        maxFrameMs: +perf.maxFrameMs.toFixed(2),
        loadMs: +loadMs.toFixed(0),
      };
      hud.textContent = JSON.stringify(report, null, 1);
      document.body.dataset.perf = JSON.stringify(report);
      if (perf.frames % 300 === 0) console.log("[actors perf]", JSON.stringify(report));
    }
  };
  requestAnimationFrame(loop);
  hud.textContent = `view=${view} smooth=${smoothing} actors=${actors.length} tris=${triangles} load=${loadMs.toFixed(0)}ms`;
  const churn = Number(params.get("churn") ?? 0);
  if (churn > 0) await runChurn(churn);
  document.body.dataset.ready = "1";
}

main().catch((err: unknown) => {
  hud.textContent = `Failed: ${String(err)}`;
  console.error(err);
});
