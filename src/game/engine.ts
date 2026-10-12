import {
  Box3,
  Color,
  Fog,
  Group,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { decodeEffects, parseEffects, type ChatEffects } from "@shared/chat";
import { decodePath, type Appearance, type EmoteId, type PlayerRecord, type StallSummary, type Tile } from "@shared/protocol";
import {
  defaultAssetBase,
  fetchJson,
  fetchJsonOptional,
  joinUrl,
  loadEngineFonts,
  loadImage,
  loadSprite,
  type SpriteFrame,
} from "./assets";
import { SoundBoard } from "./audio";
import { Actor } from "./entities/actor";
import { cheerLine } from "./entities/cheers";
import {
  createSchedule,
  lastShoutSlot,
  merchantPitches,
  segmentAt,
  segmentMotion,
  shoutCadence,
  takeShout,
  type MerchantSchedule,
  type ShoutCadence,
} from "./entities/merchantSchedule";
import { Fireworks } from "./fx/fireworks";
import { InputController } from "./input";
import { BANKER_EXAMINE, BOOTH_EXAMINE, buildMenu, merchantExamine, playerExamine, stallTag, type MenuHit } from "./menu";
import type { CharacterFactory } from "./osrs/types";
import { CHAT_LIFETIME_MS } from "./overlay/chatEffects";
import { HintMemory, hintBob, nearestBanker } from "./overlay/hintArrow";
import { CHAT_ASCENT, Overlay, TAG_ASCENT, TAG_LINE, createBubble, type ChatBubble } from "./overlay/overlay";
import {
  OverheadStack,
  ShoutPicker,
  fitOverhead,
  isNarrowView,
  type ExclusionRect,
  type OverheadFit,
  type OverheadView,
} from "./overlay/stacking";
import {
  DotBuffer,
  Minimap,
  SEED_MINIMAP_GEO,
  loadMinimapIcons,
  parseMinimapGeo,
  parseMinimapIcons,
  type MinimapSprites,
} from "./overlay/minimap";
import { OsrsCamera } from "./render/camera";
import { buildDebugGrid } from "./render/debugGrid";
import { PixelRatioGovernor, renderQuality } from "./render/quality";
import { loadWorld, type LoadedWorld } from "./render/worldScene";
import type {
  CelebrationKind,
  EngineApi,
  EngineEventName,
  EngineEvents,
  InteractVerb,
  LocalPlayerInit,
  MenuOption,
  MerchantSpec,
  RemotePlayerView,
  TargetRef,
} from "./types";
import { hashString, mix } from "./util/hash";
import { ReducedMotion } from "./util/reducedMotion";
import { Chase } from "./world/chase";
import { CollisionMap } from "./world/collision";
import { groundHeight, tileAtScene, type WorldFrame } from "./world/coords";
import { adjacentGoal, bankerGoal, bankerUseTile, boothGoal, yawTowards } from "./world/interaction";
import { motionEnd, nextStop, standingMotion, tileAt, type Motion } from "./world/motion";
import { findPath, tileGoal, type PathGoal } from "./world/pathfinding";
import { bundledCollision, bundledWorldMeta, parseWorldMeta, type WorldMeta } from "./world/worldMeta";

/**
 * The three.js world engine (no React). Owns the scene, the camera, input
 * and picking, the local player's routing, the replay of other players,
 * merchants and bankers, the 2D overhead overlay, the minimap and sounds.
 * The shell feeds it world state and reacts to its events.
 */

export interface EngineOptions {
  /** World metadata JSON (defaults to the bundled shared/world-meta.json). */
  worldMeta?: unknown;
  /** Collision grid JSON (defaults to the bundled shared/collision.json, from the same bake as the meta). */
  collision?: unknown;
  /** Draws the collision grid and tile coordinates (defaults to `?debug=1`). */
  debug?: boolean;
  /** Base URL of public/game (defaults to `${BASE_URL}game/`). */
  assetBase?: string;
}

/** EngineApi plus the extras the shell may use. */
export interface Engine extends EngineApi {
  /** Draws the rotating compass into `canvas`; pressing it faces north. */
  attachCompass(canvas: HTMLCanvasElement): void;
  /**
   * Current camera yaw in radians, the client's camAngleY: 0 looks north;
   * positive puts the camera east of the player looking west, so the minimap
   * and compass turn clockwise by this angle. The Left arrow lowers it.
   */
  getCameraYaw(): number;
  /** Viewport position (CSS px) of an entity or tile, or null when off screen. */
  projectTarget(target: TargetRef): { x: number; y: number } | null;
  /** Smoothed frame statistics: fps, CPU ms spent simulating and drawing, draw calls. */
  getStats(): EngineStats;
  /**
   * A HUD area drawn over the view (the minimap) that overhead text moves out
   * of rather than hiding under, in CSS px from the view's top-left; null for none.
   */
  setOverlayExclusion(rect: ExclusionRect | null): void;
  /** Releases every resource; the engine cannot be used afterwards. */
  destroy(): void;
}

export interface EngineStats {
  fps: number;
  tickMs: number;
  renderMs: number;
  drawCalls: number;
  triangles: number;
  actors: number;
}

type Listener<K extends EngineEventName> = (payload: EngineEvents[K]) => void;

interface RemoteState {
  actor: Actor;
  record: PlayerRecord;
  emoteKey: string;
}

interface MerchantState {
  spec: MerchantSpec;
  actor: Actor;
  schedule: MerchantSchedule;
  /** The pitch and shout cadence the schedule was built for (they follow the merchant's list index). */
  layoutKey: string;
  segment: number;
  shoutSlot: number;
  shout: { text: string; effects: ChatEffects };
  /** performance.now() until which the merchant stays with the local player. */
  engagedUntil: number;
  /** Resume the walk from where the merchant stands (after a trade). */
  resumeFrom: Tile | null;
}

interface BankerState {
  index: number;
  actor: Actor;
  restYaw: number;
  useTile: Tile | null;
  nextGlance: number;
  glanceUntil: number;
}

interface Pending {
  verb: InteractVerb;
  target: TargetRef;
  /** Routes sent towards the target (moving targets re-plan when their destination changes). */
  chase: Chase;
  arrived: boolean;
}

/** A merchant's local line ("gz!", "New stall!") after a verified world event, due at `at` (performance.now()). */
interface Cheer {
  merchantId: string;
  text: string;
  at: number;
}

const CROSS_MS = 400;
const HOVER_REPICK_MS = 100;
const ENGAGE_MS = 60_000;
const EMOTE_FRESH_MS = 8_000;
const MOTIONS = ["wave", "scroll"] as const;
const CANT_REACH = "I can't reach that!";
/** Overhead stacking group of merchant shouts. */
const MERCHANT_GROUP = 1;
/** Merchant shouts stacked in one column at most; older ones give way. */
const MERCHANT_STACK_MAX = 3;
/** In a narrow view (a phone, or any portrait screen) at most this many merchant shouts show at once. */
const NARROW_MERCHANT_SHOUTS = 2;
/** A second merchant joins in when within this many tiles of the trader. */
const CHEER_RADIUS = 6;
/** Delay before the first merchant speaks, and between the two, in ms. */
const CHEER_DELAY_MS = 450;
const CHEER_GAP_MS = 700;
/** The hint arrow's tip sits this far (scene units) above the banker's head. */
const HINT_ABOVE_HEAD = 0.25;
/** Banker or booth interactions that dismiss the hint arrow. */
const HINT_VERBS: ReadonlySet<InteractVerb> = new Set(["talk", "bank", "exchange", "collect"]);
/**
 * How far above the top edge (in normalised device units, 2 = the view's
 * height) an overhead anchor may be and still be drawn, clamped into view:
 * the actor's body is then still on screen.
 */
const OVERHEAD_ABOVE_TOP_NDC = 1.25;

function tileKey(t: Tile): string {
  return `${t.x},${t.y}`;
}

function appearanceKey(a: Appearance): string {
  return `${a.body}|${a.kits.join(",")}|${a.colors.join(",")}`;
}

function layoutKey(pitch: readonly Tile[], cadence: ShoutCadence): string {
  return `${pitch.map(tileKey).join(";")}|${cadence.phase}/${cadence.period}/${cadence.jitter}`;
}

export class GameEngine implements Engine {
  private readonly characters: CharacterFactory;
  private readonly options: EngineOptions;
  private readonly assetBase: string;
  private readonly listeners = new Map<EngineEventName, Set<Listener<EngineEventName>>>();
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private destroyed = false;

  // World
  private meta: WorldMeta | null = null;
  private map: CollisionMap | null = null;
  private frame: WorldFrame = { originX: 0, originY: 0, floorHeight: 0, heights: null };
  private world: LoadedWorld | null = null;
  private readonly scene = new Scene();
  private readonly actorGroup = new Group();
  private readonly cam = new OsrsCamera();
  private readonly fireworks: Fireworks;
  private readonly boothBoxes: Box3[] = [];
  private readonly titleCentre = new Vector3();
  private titleRadius = 12;
  private debugGrid: { group: Group; dispose(): void } | null = null;
  private readonly debug: boolean;

  // Mount
  private renderer: WebGLRenderer | null = null;
  private overlay: Overlay | null = null;
  private wrapper: HTMLDivElement | null = null;
  private input: InputController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private raf = 0;
  private lastTime = 0;
  private width = 1;
  private height = 1;

  // Actors
  private local: Actor | null = null;
  private localInit: LocalPlayerInit | null = null;
  private readonly remotes = new Map<string, RemoteState>();
  private readonly merchants = new Map<string, MerchantState>();
  private readonly bankers: BankerState[] = [];
  private actors: Actor[] = [];
  private stalls: Record<string, StallSummary | null> = {};
  private pendingPlayers: { players: RemotePlayerView[]; serverNow: number } | null = null;
  private pendingMerchants: MerchantSpec[] | null = null;
  private clock: () => number = () => Date.now() + this.clockOffset;
  private clockOffset = 0;
  private customClock = false;

  // Local player
  private running = false;
  private pending: Pending | null = null;
  private queued: Motion | null = null;
  private destination: Tile | null = null;
  private engagedMerchant: MerchantState | null = null;
  /** The next entry into the world frames the hall (OsrsCamera.frameArrival). */
  private arrivalPending = true;
  /** Banker hint arrow: dismissed for good after the first banker or booth interaction. */
  private readonly hint = new HintMemory();
  /** Index (meta.bankers) of the banker the hint arrow is over, or -1. */
  private hintBanker = -1;
  private cheers: Cheer[] = [];
  /** Overhead lines that go before merchant shouts on a narrow view (the cheers). */
  private readonly priorityLines = new WeakSet<ChatBubble>();

  // Input and view state
  private titleMode = false;
  private inputEnabled = true;
  private readonly pointer = { x: 0, y: 0, inside: false, moved: false, lastPick: 0 };
  private hoverKey = "";
  private lastMenuPoint = { x: 0, y: 0 };
  private cross: { x: number; y: number; red: boolean; startedAt: number } | null = null;
  private crossFrames: SpriteFrame[] = [];
  private minimap: Minimap | null = null;
  private minimapCanvas: HTMLCanvasElement | null = null;
  private compassCanvas: HTMLCanvasElement | null = null;
  private readonly dots = new DotBuffer();
  private readonly sound = new SoundBoard();
  private readonly motion = new ReducedMotion((reduced) => this.applyReducedMotion(reduced));

  /**
   * The view's edges hidden under a notch, status bar or rounded corners
   * (env(safe-area-inset-top/left/right)), in CSS px; the sides matter in landscape.
   */
  private safeTop = 0;
  private safeLeft = 0;
  private safeRight = 0;
  private exclusion: ExclusionRect | null = null;
  /** The view overhead text is fitted into (refreshed every frame from the fields above). */
  private readonly overheadView: OverheadView = { width: 1, height: 1, safeTop: 0, safeLeft: 0, safeRight: 0, hud: null };
  private readonly fitted: OverheadFit = { x: 0, y: 0, minTop: 0 };
  private safeProbe: HTMLDivElement | null = null;

  // Render quality
  private coarsePointer = false;
  private pixelRatio = 1;
  private governor: PixelRatioGovernor | null = null;

  // Scratch objects (no per-frame allocation)
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly hitPoint = new Vector3();
  private readonly projected = new Vector3();
  private readonly focus = new Vector3();
  private readonly overheads = new OverheadStack();
  /** Actor indices of merchants with something overhead, in placing order (reused each frame). */
  private readonly merchantOverheads: number[] = [];
  private readonly shoutPicker = new ShoutPicker();
  private readonly stats = { fps: 0, tickMs: 0, renderMs: 0, drawCalls: 0, triangles: 0 };

  constructor(characters: CharacterFactory, options: EngineOptions = {}) {
    this.characters = characters;
    this.options = options;
    this.assetBase = options.assetBase ?? defaultAssetBase();
    this.debug =
      options.debug ?? (typeof location !== "undefined" && new URLSearchParams(location.search).get("debug") === "1");
    this.scene.background = new Color(0x000000);
    this.scene.fog = new Fog(0x000000, 20, 38);
    this.scene.add(this.actorGroup);
    this.fireworks = new Fireworks(this.scene);
  }

  // ------------------------------------------------------------------ events

  on<K extends EngineEventName>(event: K, fn: (payload: EngineEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<EngineEventName>);
    return () => set.delete(fn as Listener<EngineEventName>);
  }

  private emit<K extends EngineEventName>(event: K, payload: EngineEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Snapshot: a listener may unsubscribe while the event is being delivered.
    for (const fn of Array.from(set)) {
      try {
        (fn as Listener<K>)(payload);
      } catch (err) {
        console.error(`[engine] ${event} listener failed`, err);
      }
    }
  }

  // ------------------------------------------------------------------ loading

  load(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
      this.loadPromise.catch(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    const parts = { world: 0, characters: 0, assets: 0 };
    const report = (label: string) => {
      const fraction = Math.min(0.99, parts.world * 0.5 + parts.characters * 0.35 + parts.assets * 0.15);
      this.emit("progress", { fraction, label });
    };
    report("Loading world data");

    const rawMeta = this.options.worldMeta ?? bundledWorldMeta();
    if (!rawMeta) throw new Error("World metadata is missing: run the asset bake to write shared/world-meta.json");
    const meta = parseWorldMeta(rawMeta);
    const rawCollision = this.options.collision ?? bundledCollision();
    if (!rawCollision) throw new Error("Collision grid is missing: run the asset bake to write shared/collision.json");
    const map = CollisionMap.from(rawCollision);
    map.setBounds(meta.bounds);
    this.meta = meta;
    this.map = map;
    this.frame = { originX: meta.origin.x, originY: meta.origin.y, floorHeight: meta.floorHeight, heights: meta.heights };

    const worldTask = loadWorld(joinUrl(this.assetBase, "world/varrock-west-bank.glb"), (p) => {
      parts.world = p;
      report("Loading Varrock West Bank");
    }).then((w) => {
      parts.world = 1;
      report("Loading Varrock West Bank");
      return w;
    });
    const characterTask = this.characters
      .load((p) => {
        parts.characters = p;
        report("Loading characters");
      })
      .then(() => {
        parts.characters = 1;
        report("Loading characters");
      });
    let assetsDone = 0;
    const assetStep = <T>(task: Promise<T>): Promise<T> =>
      task.then((v) => {
        assetsDone++;
        parts.assets = assetsDone / 4;
        report("Loading interfaces");
        return v;
      });
    const spritesBase = joinUrl(this.assetBase, "sprites/");
    const spriteTask = assetStep(
      fetchJson(joinUrl(spritesBase, "manifest.json")).then(async (manifest) => {
        const optional = (id: number) => loadSprite(spritesBase, manifest, id).catch(() => null);
        const [cross, compass, dots, marker] = await Promise.all([
          loadSprite(spritesBase, manifest, 299),
          optional(169),
          optional(300),
          optional(422),
        ]);
        const minimapSprites: MinimapSprites = {
          compass: compass?.[0] ?? null,
          npcDot: dots?.[1] ?? null,
          playerDot: dots?.[2] ?? null,
          marker: marker?.[0] ?? null,
        };
        return { cross, minimap: minimapSprites };
      }),
    );
    const minimapBase = joinUrl(this.assetBase, "world/");
    const minimapTask = assetStep(
      Promise.all([
        loadImage(joinUrl(minimapBase, "minimap.png")),
        fetchJsonOptional(joinUrl(minimapBase, "minimap.json")).then(
          async (json) => [json, await loadMinimapIcons(minimapBase, parseMinimapIcons(json))] as const,
        ),
      ]),
    );
    const fontTask = assetStep(loadEngineFonts(this.assetBase));
    const soundTask = assetStep(this.sound.load(this.assetBase));

    const [world, , sprites, [minimapImage, [minimapJson, minimapIcons]]] = await Promise.all([
      worldTask,
      characterTask,
      spriteTask,
      minimapTask,
      fontTask,
      soundTask,
    ]);
    if (this.destroyed) {
      world.dispose();
      return;
    }

    this.world = world;
    this.scene.add(world.root);
    this.crossFrames = sprites.cross;
    const geo = parseMinimapGeo(minimapJson, minimapImage.width, minimapImage.height) ?? SEED_MINIMAP_GEO;
    this.minimap = new Minimap(
      minimapImage,
      geo,
      sprites.minimap,
      (tile) => this.onMinimapWalk(tile),
      () => this.onCompassPress(),
      minimapIcons,
    );
    if (this.minimapCanvas) this.minimap.attach(this.minimapCanvas);
    if (this.compassCanvas) this.minimap.attachCompass(this.compassCanvas);

    this.buildStatic(meta, map);
    if (this.debug) {
      this.debugGrid = buildDebugGrid(map, this.frame);
      this.scene.add(this.debugGrid.group);
    }

    this.loaded = true;
    if (this.localInit) this.spawnLocal(this.localInit);
    if (this.pendingMerchants) this.setMerchants(this.pendingMerchants);
    if (this.pendingPlayers) this.syncPlayers(this.pendingPlayers.players, this.pendingPlayers.serverNow);
    this.pendingMerchants = null;
    this.pendingPlayers = null;
    this.emit("progress", { fraction: 1, label: "Ready" });
    this.emit("ready", undefined);
  }

  private buildStatic(meta: WorldMeta, map: CollisionMap): void {
    const f = this.frame;
    for (const booth of meta.booths) {
      const x = booth.tile.x - f.originX;
      const z = -(booth.tile.y - f.originY);
      // The counter is pickable; the banker shows through the window above it.
      this.boothBoxes.push(new Box3(new Vector3(x, f.floorHeight, z - 1), new Vector3(x + 1, f.floorHeight + 1.05, z)));
    }
    const now = this.clock();
    meta.bankers.forEach((b, index) => {
      const handle = this.characters.createNpc(b.npcId);
      const actor = new Actor("banker", String(index), "Banker", handle, b.tile, f);
      const useTile = bankerUseTile(map, b, meta.booths);
      const restYaw = b.faceYaw ?? (useTile ? yawTowards(b.tile, useTile) : null) ?? -Math.PI / 2;
      actor.restYaw = restYaw;
      actor.setYaw(restYaw);
      actor.snapTo(b.tile, f, now);
      this.actorGroup.add(actor.root);
      this.bankers.push({
        index,
        actor,
        restYaw,
        useTile,
        nextGlance: performance.now() + 4_000 + Math.random() * 12_000,
        glanceUntil: 0,
      });
    });

    // Title camera orbits the middle of the banking hall.
    const tiles = [...meta.booths.map((b) => b.tile), ...meta.merchantArea];
    if (tiles.length > 0) {
      let sx = 0;
      let sy = 0;
      for (const t of tiles) {
        sx += t.x;
        sy += t.y;
      }
      this.titleCentre.set(sx / tiles.length - f.originX + 0.5, f.floorHeight, -(sy / tiles.length - f.originY + 0.5));
    } else {
      const b = meta.bounds;
      this.titleCentre.set((b.minX + b.maxX) / 2 - f.originX + 0.5, f.floorHeight, -((b.minY + b.maxY) / 2 - f.originY + 0.5));
    }
    this.titleRadius = 12;
    this.rebuildActorList();
  }

  // ------------------------------------------------------------------ mounting

  mount(container: HTMLElement): void {
    if (this.destroyed) throw new Error("Engine has been destroyed");
    if (this.wrapper) this.unmount();
    const wrapper = document.createElement("div");
    Object.assign(wrapper.style, {
      position: "absolute",
      inset: "0",
      overflow: "hidden",
      touchAction: "none",
      userSelect: "none",
      webkitUserSelect: "none",
      background: "#000",
    } satisfies Partial<CSSStyleDeclaration>);
    wrapper.dataset.engine = "world";
    this.coarsePointer = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const quality = renderQuality(window.devicePixelRatio || 1, this.coarsePointer);
    this.governor = this.coarsePointer ? new PixelRatioGovernor() : null;
    this.pixelRatio = quality.pixelRatio;
    const renderer = new WebGLRenderer({ antialias: quality.antialias, powerPreference: quality.powerPreference });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setPixelRatio(this.pixelRatio);
    renderer.setClearColor(0x000000, 1);
    Object.assign(renderer.domElement.style, { position: "absolute", inset: "0", width: "100%", height: "100%", display: "block" });
    const overlay = new Overlay();
    overlay.reducedMotion = this.motion.reduced;
    wrapper.append(renderer.domElement, overlay.canvas);
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.appendChild(wrapper);
    this.wrapper = wrapper;
    this.renderer = renderer;
    this.overlay = overlay;

    this.input = new InputController(wrapper, {
      hover: (x, y) => {
        this.pointer.x = x;
        this.pointer.y = y;
        this.pointer.inside = true;
        this.pointer.moved = true;
      },
      leave: () => {
        this.pointer.inside = false;
        this.setHover(null, 0);
      },
      click: (x, y) => this.onClick(x, y),
      menu: (x, y) => this.onMenu(x, y),
      drag: (dx, dy) => {
        // Client mouse camera: camAngleDY = (clickX - mouseX) * 2, so dragging right turns like Left.
        if (!this.titleMode) this.cam.rotateBy(-dx * 0.006, dy * 0.005);
      },
      zoom: (steps) => {
        if (!this.titleMode) this.cam.zoomBy(steps);
      },
      key: (key, down) => {
        const used = down && !this.titleMode && this.inputEnabled;
        this.cam.setKey(key, used);
        return used;
      },
      gesture: () => this.sound.unlock(),
    });
    this.input.enabled = this.inputEnabled;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(wrapper);
    this.resize();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.start();
  }

  unmount(): void {
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.input?.dispose();
    this.input = null;
    this.cam.releaseKeys();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
    this.wrapper?.remove();
    this.wrapper = null;
    this.safeProbe = null;
    this.renderer = null;
    this.overlay = null;
    this.pointer.inside = false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.unmount();
    this.destroyed = true;
    this.motion.dispose();
    for (const actor of this.actors) actor.dispose();
    this.actors = [];
    this.local = null;
    this.remotes.clear();
    this.merchants.clear();
    this.bankers.length = 0;
    this.fireworks.dispose();
    this.world?.dispose();
    this.world = null;
    this.debugGrid?.dispose();
    this.debugGrid = null;
    this.minimap?.detach();
    this.minimap?.detachCompass();
    this.sound.dispose();
    this.listeners.clear();
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) this.stop();
    else if (this.renderer) this.start();
  };

  private applyReducedMotion(reduced: boolean): void {
    if (this.overlay) this.overlay.reducedMotion = reduced;
    if (reduced) this.fireworks.stopAll();
  }

  private start(): void {
    if (this.raf || !this.renderer) return;
    if (typeof document !== "undefined" && document.hidden) return;
    this.lastTime = performance.now();
    this.governor?.reset();
    this.raf = requestAnimationFrame(this.loop);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private resize(): void {
    if (!this.wrapper || !this.renderer || !this.overlay) return;
    const w = Math.max(1, this.wrapper.clientWidth);
    const h = Math.max(1, this.wrapper.clientHeight);
    this.width = w;
    this.height = h;
    // The device ratio can change (another monitor, browser zoom); the governor only ever lowers it.
    const ratio = Math.min(renderQuality(window.devicePixelRatio || 1, this.coarsePointer, w * h).pixelRatio, this.governor?.cap ?? Infinity);
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.cam.setViewport(w, h);
    this.overlay.resize(w, h, ratio);
    this.readSafeArea();
  }

  /**
   * Reads the top, left and right safe-area insets from a hidden probe in the
   * wrapper (all 0 without a notch). Called on every resize, which includes
   * rotating the phone, when the notch moves from the top to a side.
   */
  private readSafeArea(): void {
    const wrapper = this.wrapper;
    if (!wrapper) return;
    if (!this.safeProbe) {
      const probe = document.createElement("div");
      probe.setAttribute("aria-hidden", "true");
      Object.assign(probe.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "0",
        height: "0",
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingLeft: "env(safe-area-inset-left, 0px)",
        paddingRight: "env(safe-area-inset-right, 0px)",
        visibility: "hidden",
        pointerEvents: "none",
      } satisfies Partial<CSSStyleDeclaration>);
      wrapper.appendChild(probe);
      this.safeProbe = probe;
    }
    const style = getComputedStyle(this.safeProbe);
    this.safeTop = parseFloat(style.paddingTop) || 0;
    this.safeLeft = parseFloat(style.paddingLeft) || 0;
    this.safeRight = parseFloat(style.paddingRight) || 0;
  }

  private readonly loop = (time: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, Math.max(0, (time - this.lastTime) / 1000));
    this.lastTime = time;
    const t0 = performance.now();
    this.tick(dt, time);
    const t1 = performance.now();
    this.draw(time);
    const t2 = performance.now();
    const k = 0.05;
    const st = this.stats;
    if (dt > 0) st.fps += (1 / dt - st.fps) * k;
    st.tickMs += (t1 - t0 - st.tickMs) * k;
    st.renderMs += (t2 - t1 - st.renderMs) * k;
    if (this.renderer) {
      st.drawCalls = this.renderer.info.render.calls;
      st.triangles = this.renderer.info.render.triangles;
    }
    // Phones draw fewer pixels while frames stay slow.
    if (this.loaded && this.governor && dt > 0 && this.governor.frame(dt * 1000, this.pixelRatio)) this.resize();
  };

  getStats(): EngineStats {
    return { ...this.stats, actors: this.actors.length };
  }

  setOverlayExclusion(rect: ExclusionRect | null): void {
    this.exclusion = rect && rect.right > rect.left && rect.bottom > rect.top ? { ...rect } : null;
  }

  projectTarget(target: TargetRef): { x: number; y: number } | null {
    let x: number;
    let y: number;
    let z: number;
    const f = this.frame;
    if (target.kind === "tile" || target.kind === "booth") {
      const tile = target.kind === "tile" ? target.tile : this.meta?.booths[target.boothIndex]?.tile;
      if (!tile) return null;
      x = tile.x - f.originX + 0.5;
      z = -(tile.y - f.originY + 0.5);
      y = groundHeight(f, tile.x, tile.y) + (target.kind === "booth" ? 0.8 : 0);
    } else {
      const actor =
        target.kind === "banker"
          ? this.bankers[target.npcIndex]?.actor
          : target.kind === "merchant"
            ? this.merchants.get(target.merchantId)?.actor
            : this.actorForPid(target.pid);
      if (!actor) return null;
      x = actor.position.x;
      y = actor.position.y + actor.height * 0.6;
      z = actor.position.z;
    }
    const p = this.projected.set(x, y, z).project(this.cam.camera);
    if (p.z > 1 || p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1) return null;
    return { x: (p.x + 1) * (this.width / 2), y: (1 - p.y) * (this.height / 2) };
  }

  // ------------------------------------------------------------------ public state

  setTitleMode(enabled: boolean): void {
    this.titleMode = enabled;
    if (this.local) this.local.root.visible = !enabled;
    if (enabled) {
      this.cam.releaseKeys();
      this.setHover(null, 0);
      this.arrivalPending = true;
    } else {
      if (this.arrivalPending && this.local) this.frameArrival();
      this.cam.snap();
    }
  }

  /**
   * Points the first view of the world at the bankers (the camera leans
   * towards the middle of the serving booths until the player first walks,
   * drags or rotates). Rejoins after a lost connection keep the player's view.
   */
  private frameArrival(): void {
    const local = this.local;
    const meta = this.meta;
    if (!local || !meta) return;
    this.arrivalPending = false;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const b of meta.bankers) {
      if (!b.serves) continue;
      sx += b.tile.x;
      sy += b.tile.y;
      n++;
    }
    if (n === 0) return;
    const here = local.currentTile();
    // Scene frame: east is +x, north is -z.
    this.cam.frameArrival(sx / n - here.x, -(sy / n - here.y));
  }

  setLocalPlayer(init: LocalPlayerInit): void {
    this.localInit = init;
    if (this.loaded) this.spawnLocal(init);
  }

  private spawnLocal(init: LocalPlayerInit): void {
    const map = this.map!;
    if (this.local) {
      this.removeActor(this.local);
      this.local = null;
    }
    const remote = this.remotes.get(init.pid);
    if (remote) {
      this.removeActor(remote.actor);
      this.remotes.delete(init.pid);
    }
    const spawn = this.meta!.spawn[0] ?? { x: this.meta!.bounds.minX, y: this.meta!.bounds.minY };
    const tile = map.isWalkable(init.tile.x, init.tile.y) ? init.tile : (map.nearestWalkable(init.tile) ?? spawn);
    const actor = new Actor("local", init.pid, init.name, this.createPlayerHandle(init.appearance, init.pid), tile, this.frame);
    actor.setYaw(0);
    actor.root.visible = !this.titleMode;
    this.local = actor;
    this.actorGroup.add(actor.root);
    this.pending = null;
    this.queued = null;
    this.destination = null;
    this.applyStall(actor, init.pid, null);
    this.rebuildActorList();
    this.hintBanker = -1;
    if (this.arrivalPending && !this.titleMode) this.frameArrival();
    this.cam.snap();
  }

  setLocalAppearance(appearance: Appearance): void {
    if (this.localInit) this.localInit = { ...this.localInit, appearance };
    if (this.local && this.characters.isValidAppearance(appearance)) this.local.handle.setAppearance(appearance);
  }

  setClock(serverNow: () => number): void {
    this.clock = serverNow;
    this.customClock = true;
  }

  syncPlayers(players: RemotePlayerView[], serverNow: number): void {
    if (!this.customClock && Number.isFinite(serverNow)) this.clockOffset = serverNow - Date.now();
    if (!this.loaded) {
      this.pendingPlayers = { players, serverNow };
      return;
    }
    const now = this.clock();
    const localPid = this.local?.id ?? this.localInit?.pid ?? null;
    const seen = new Set<string>();
    let changed = false;
    for (const { pid, record } of players) {
      if (pid === localPid) continue;
      seen.add(pid);
      const state = this.remotes.get(pid);
      if (!state) {
        this.addRemote(pid, record, now);
        changed = true;
        continue;
      }
      const prev = state.record;
      state.record = record;
      state.actor.name = record.n;
      if (prev.p !== record.p || prev.t !== record.t || prev.r !== record.r) {
        state.actor.setMotion(this.recordMotion(record), this.frame, now);
      }
      if (appearanceKey(prev.a) !== appearanceKey(record.a) && this.characters.isValidAppearance(record.a)) {
        state.actor.handle.setAppearance(record.a);
      }
      this.applyRecordEmote(state, now);
      this.applyStall(state.actor, pid, record.s ?? null);
    }
    for (const [pid, state] of this.remotes) {
      if (seen.has(pid)) continue;
      this.fireworks.stop(state.actor.position);
      this.removeActor(state.actor);
      this.remotes.delete(pid);
      changed = true;
      if (this.pending?.target.kind === "player" && this.pending.target.pid === pid) this.pending = null;
    }
    if (changed) this.rebuildActorList();
  }

  private addRemote(pid: string, record: PlayerRecord, now: number): void {
    const handle = this.createPlayerHandle(record.a, pid);
    const motion = this.recordMotion(record);
    const first = motion.path[0] ?? this.meta!.spawn[0] ?? { x: this.frame.originX, y: this.frame.originY };
    const actor = new Actor("player", pid, record.n, handle, first, this.frame);
    actor.setMotion(motion, this.frame, now, false);
    actor.place(this.frame, now);
    const s = actor.sample;
    if (s.moving) actor.setYaw(Math.atan2(s.dirX, -s.dirY));
    else {
      const path = motion.path;
      const a = path[path.length - 2];
      const b = path[path.length - 1];
      actor.setYaw(a && b ? Math.atan2(b.x - a.x, -(b.y - a.y)) : 0);
    }
    this.actorGroup.add(actor.root);
    const state: RemoteState = { actor, record, emoteKey: "" };
    this.remotes.set(pid, state);
    this.applyRecordEmote(state, now);
    this.applyStall(actor, pid, record.s ?? null);
  }

  private recordMotion(record: PlayerRecord): Motion {
    const path = decodePath(record.p);
    if (path.length === 0) {
      const spawn = this.meta!.spawn[0] ?? { x: this.frame.originX, y: this.frame.originY };
      return standingMotion(spawn, record.t);
    }
    return { path, startedAt: record.t, run: record.r };
  }

  private applyRecordEmote(state: RemoteState, now: number): void {
    const { e, et } = state.record;
    if (!e || !et) return;
    const key = `${e}|${et}`;
    if (key === state.emoteKey) return;
    state.emoteKey = key;
    if (now - et < EMOTE_FRESH_MS) state.actor.handle.playEmote(e);
  }

  private createPlayerHandle(appearance: Appearance, seed: string) {
    const valid = this.characters.isValidAppearance(appearance) ? appearance : this.characters.randomAppearance(seed);
    return this.characters.createPlayer(valid);
  }

  setStalls(stalls: Record<string, StallSummary | null>): void {
    this.stalls = { ...stalls };
    for (const [pid, state] of this.remotes) this.applyStall(state.actor, pid, state.record.s ?? null);
    if (this.local) this.applyStall(this.local, this.local.id, null);
  }

  private applyStall(actor: Actor, pid: string, recordStall: StallSummary | null): void {
    const stall = pid in this.stalls ? (this.stalls[pid] ?? null) : recordStall;
    if (stall === actor.stall || (stall && actor.stall && stall.depositId === actor.stall.depositId && stall.available === actor.stall.available)) {
      actor.stall = stall;
      return;
    }
    actor.stall = stall;
    actor.stallTag = stall ? stallTag(stall) : null;
    actor.stallTagWidth = actor.stallTag && this.overlay ? this.overlay.measureTag(actor.stallTag) : -1;
  }

  setMerchants(merchants: MerchantSpec[]): void {
    if (!this.loaded) {
      this.pendingMerchants = merchants;
      return;
    }
    // Merchant i of n takes pitch i of the merchant area and turn i of the
    // shouts, so every client with the same list places them alike.
    const pitches = merchantPitches(this.merchantArea(), merchants.length, this.map!);
    const now = this.clock();
    const ids = new Set(merchants.map((m) => m.id));
    let changed = false;
    for (const [id, state] of this.merchants) {
      if (ids.has(id)) continue;
      this.removeActor(state.actor);
      this.merchants.delete(id);
      if (this.engagedMerchant === state) this.engagedMerchant = null;
      if (this.pending?.target.kind === "merchant" && this.pending.target.merchantId === id) this.pending = null;
      changed = true;
    }
    merchants.forEach((spec, index) => {
      const seed = spec.seed || spec.id;
      const pitch = pitches[index]!;
      const cadence = shoutCadence(index, merchants.length);
      const key = layoutKey(pitch, cadence);
      const shout = this.merchantShout(spec);
      const existing = this.merchants.get(spec.id);
      if (existing) {
        existing.spec = spec;
        existing.shout = shout;
        existing.actor.name = spec.name;
        if (existing.layoutKey !== key) {
          // The list changed around it: walk over to the new pitch and take the new turn.
          existing.schedule = createSchedule(seed, pitch, cadence);
          existing.layoutKey = key;
          existing.segment = segmentAt(existing.schedule, now);
          existing.shoutSlot = lastShoutSlot(existing.schedule, now);
          existing.resumeFrom = existing.actor.currentTile();
        }
        return;
      }
      const schedule = createSchedule(seed, pitch, cadence);
      const segment = segmentAt(schedule, now);
      const motion = segmentMotion(this.map!, schedule, segment);
      const start = motion.path[0]!;
      const handle = this.characters.createPlayer(this.characters.randomAppearance(seed));
      const actor = new Actor("merchant", spec.id, spec.name, handle, start, this.frame);
      actor.setMotion(motion, this.frame, now, false);
      actor.setYaw((mix(schedule.seed, 9) % 8) * (Math.PI / 4));
      this.actorGroup.add(actor.root);
      this.merchants.set(spec.id, {
        spec,
        actor,
        schedule,
        layoutKey: key,
        segment,
        shout,
        // A shout still to come in this slot will play; one already past waits for the next.
        shoutSlot: lastShoutSlot(schedule, now),
        engagedUntil: 0,
        resumeFrom: null,
      });
      changed = true;
    });
    if (changed) this.rebuildActorList();
  }

  private merchantShout(spec: MerchantSpec): { text: string; effects: ChatEffects } {
    const { effects, text } = parseEffects(spec.shout);
    if (!effects.motion && effects.color === "yellow" && spec.shout === text) {
      // Plain shouts get the traders' classic wave or scroll.
      return { text, effects: { color: "yellow", motion: MOTIONS[hashString(spec.seed || spec.id) % 2]! } };
    }
    return { text, effects };
  }

  private merchantArea(): Tile[] {
    const map = this.map!;
    const meta = this.meta!;
    const area = meta.merchantArea.filter((t) => map.isWalkable(t.x, t.y));
    if (area.length > 0) return area;
    const spawn = meta.spawn.filter((t) => map.isWalkable(t.x, t.y));
    if (spawn.length > 0) return spawn;
    const centre = map.nearestWalkable({
      x: Math.round((meta.bounds.minX + meta.bounds.maxX) / 2),
      y: Math.round((meta.bounds.minY + meta.bounds.maxY) / 2),
    }, 16);
    return centre ? [centre] : [];
  }

  showChat(actor: { pid: string } | { merchantId: string }, text: string, fx?: string | null): void {
    const target = "pid" in actor ? this.actorForPid(actor.pid) : this.merchants.get(actor.merchantId)?.actor;
    if (!target) return;
    target.chat = createBubble(text, decodeEffects(fx), performance.now());
  }

  playEmote(pid: string, emote: EmoteId): void {
    this.actorForPid(pid)?.handle.playEmote(emote);
  }

  celebrate(pid: string, kind: CelebrationKind = "trade"): void {
    const actor = this.actorForPid(pid);
    if (!actor) return;
    if (!this.motion.reduced) {
      this.fireworks.play(actor.position);
      this.sound.play("levelup", 0.6);
      this.cheer(actor, pid, kind);
    }
    this.sound.play("coins");
  }

  /**
   * The merchants nearest a verified world event speak up: the nearest one,
   * and a second within CHEER_RADIUS tiles, a moment apart. Local only
   * (nothing is sent); the line fits the event (cheerLine) and is chosen
   * from the merchant's seed and the player, so it varies between merchants.
   */
  private cheer(actor: Actor, pid: string, kind: CelebrationKind): void {
    let first: MerchantState | null = null;
    let second: MerchantState | null = null;
    let d1 = Infinity;
    let d2 = Infinity;
    for (const state of this.merchants.values()) {
      if (!state.actor.root.visible) continue;
      const d = Math.hypot(state.actor.tileX - actor.tileX, state.actor.tileY - actor.tileY);
      if (d < d1) {
        second = first;
        d2 = d1;
        first = state;
        d1 = d;
      } else if (d < d2) {
        second = state;
        d2 = d;
      }
    }
    const now = performance.now();
    const picks = second && d2 <= CHEER_RADIUS ? [first!, second] : first ? [first] : [];
    picks.forEach((state, k) => {
      const line = cheerLine(kind, state.spec.seed || state.spec.id, pid);
      this.cheers.push({ merchantId: state.spec.id, text: line, at: now + CHEER_DELAY_MS + k * CHEER_GAP_MS });
    });
  }

  private updateCheers(perfNow: number): void {
    if (this.cheers.length === 0) return;
    const due = this.cheers.filter((c) => c.at <= perfNow);
    if (due.length === 0) return;
    this.cheers = this.cheers.filter((c) => c.at > perfNow);
    for (const c of due) {
      const state = this.merchants.get(c.merchantId);
      if (!state) continue;
      const bubble = createBubble(c.text, { color: "yellow", motion: null }, perfNow);
      this.priorityLines.add(bubble);
      state.actor.chat = bubble;
    }
  }

  private actorForPid(pid: string): Actor | undefined {
    if (this.local && this.local.id === pid) return this.local;
    return this.remotes.get(pid)?.actor;
  }

  setRunning(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    // Like toggling run mid-walk in the original: the rest of the route changes speed.
    const local = this.local;
    if (!local || !this.map) return;
    const now = this.clock();
    const motion = this.queued ?? local.motion;
    if (motionEnd(motion) <= now) return;
    const end = motion.path[motion.path.length - 1];
    if (end) this.planPath(tileGoal(end));
  }

  walkTo(tile: Tile): void {
    if (!this.local || !this.map || this.titleMode) return;
    this.cancelPending();
    this.planPath(tileGoal(this.clampTile(tile)));
  }

  choose(option: MenuOption): void {
    this.perform(option, this.lastMenuPoint.x, this.lastMenuPoint.y);
  }

  attachMinimap(canvas: HTMLCanvasElement): void {
    this.minimapCanvas = canvas;
    this.minimap?.attach(canvas);
  }

  attachCompass(canvas: HTMLCanvasElement): void {
    this.compassCanvas = canvas;
    this.minimap?.attachCompass(canvas);
  }

  getCameraYaw(): number {
    return this.cam.yaw;
  }

  resetCameraNorth(): void {
    this.cam.resetNorth();
  }

  setSoundEnabled(enabled: boolean): void {
    this.sound.setEnabled(enabled);
  }

  setReducedMotion(enabled: boolean): void {
    this.motion.setSetting(enabled);
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (this.input) this.input.enabled = enabled;
    if (!enabled) {
      this.cam.releaseKeys();
      this.setHover(null, 0);
    }
  }

  // ------------------------------------------------------------------ input

  private canAct(): boolean {
    return this.loaded && !this.titleMode && this.inputEnabled && !!this.local;
  }

  /** A minimap click walks like a world click: it closes interfaces and obeys setInputEnabled. */
  private onMinimapWalk(tile: Tile): void {
    this.sound.unlock();
    if (!this.canAct()) return;
    this.emit("worldClick", undefined);
    this.walkTo(tile);
  }

  private onCompassPress(): void {
    this.sound.unlock();
    if (!this.loaded || this.titleMode || !this.inputEnabled) return;
    this.cam.resetNorth();
  }

  private onClick(x: number, y: number): void {
    if (!this.loaded || this.titleMode || !this.inputEnabled) return;
    this.emit("worldClick", undefined);
    if (!this.canAct()) return;
    const options = this.menuAt(x, y);
    this.lastMenuPoint.x = x;
    this.lastMenuPoint.y = y;
    const first = options[0];
    if (first) this.perform(first, x, y);
  }

  private onMenu(x: number, y: number): void {
    if (!this.loaded || this.titleMode || !this.inputEnabled) return;
    this.emit("worldClick", undefined);
    if (!this.canAct()) return;
    const options = this.menuAt(x, y);
    this.lastMenuPoint.x = x;
    this.lastMenuPoint.y = y;
    this.emit("menu", { x, y, options });
  }

  private perform(option: MenuOption, x: number, y: number): void {
    if (!this.canAct()) return;
    switch (option.interact) {
      case "examine":
        this.emit("examine", { text: this.examineText(option.target) });
        return;
      case "walk":
        if (option.target.kind !== "tile") return;
        this.cross = { x, y, red: false, startedAt: performance.now() };
        this.walkTo(option.target.tile);
        return;
      default:
        this.cross = { x, y, red: true, startedAt: performance.now() };
        this.startInteraction(option.interact, option.target);
    }
  }

  private examineText(target: TargetRef): string {
    switch (target.kind) {
      case "banker":
        return BANKER_EXAMINE;
      case "booth":
        return BOOTH_EXAMINE;
      case "merchant": {
        const m = this.merchants.get(target.merchantId);
        return m ? merchantExamine(m.spec.name, m.spec.platform, m.spec.currency) : "";
      }
      case "player": {
        const actor = this.actorForPid(target.pid);
        return actor ? playerExamine(actor.name, actor.stall) : "";
      }
      case "tile":
        return "";
    }
  }

  /** Picks entities and the floor under a viewport point and builds the menu. */
  private menuAt(x: number, y: number): MenuOption[] {
    const camera = this.cam.camera;
    this.ndc.set((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, camera);
    const ray = this.raycaster.ray;
    const hits: { d: number; hit: MenuHit }[] = [];
    for (const actor of this.actors) {
      if (actor.kind === "local" || !actor.root.visible) continue;
      if (!ray.intersectBox(actor.box, this.hitPoint)) continue;
      const d = this.hitPoint.distanceToSquared(ray.origin);
      if (actor.kind === "banker") {
        const npcIndex = Number(actor.id);
        const serves = this.meta?.bankers[npcIndex]?.serves ?? true;
        hits.push({ d, hit: { kind: "banker", npcIndex, name: actor.name, serves } });
      }
      else if (actor.kind === "merchant") {
        hits.push({ d, hit: { kind: "merchant", merchantId: actor.id, name: actor.name, sharesTile: this.playerOnTileOf(actor) } });
      }
      else hits.push({ d, hit: { kind: "player", pid: actor.id, name: actor.name, stall: actor.stall } });
    }
    this.boothBoxes.forEach((box, boothIndex) => {
      if (!ray.intersectBox(box, this.hitPoint)) return;
      hits.push({ d: this.hitPoint.distanceToSquared(ray.origin), hit: { kind: "booth", boothIndex } });
    });
    hits.sort((a, b) => a.d - b.d);

    let floor: Tile | null = null;
    if (Math.abs(ray.direction.y) > 1e-6) {
      // Intersect the floor plane, then refine against the ground height there
      // (the street outside is lower than the bank floor).
      let height = this.frame.floorHeight;
      for (let pass = 0; pass < 3; pass++) {
        const t = (height - ray.origin.y) / ray.direction.y;
        if (t <= 0) break;
        const px = ray.origin.x + ray.direction.x * t;
        const pz = ray.origin.z + ray.direction.z * t;
        floor = tileAtScene(this.frame, px, pz);
        const next = groundHeight(this.frame, px + this.frame.originX - 0.5, -pz + this.frame.originY - 0.5);
        if (Math.abs(next - height) < 0.01) break;
        height = next;
      }
      if (floor) floor = this.clampTile(floor);
    }
    return buildMenu(
      hits.map((h) => h.hit),
      floor,
    );
  }

  /** True when another player stands on the tile `actor` is on (or crossing). */
  private playerOnTileOf(actor: Actor): boolean {
    const x = Math.round(actor.tileX);
    const y = Math.round(actor.tileY);
    for (const state of this.remotes.values()) {
      const other = state.actor;
      if (other.root.visible && Math.round(other.tileX) === x && Math.round(other.tileY) === y) return true;
    }
    return false;
  }

  private clampTile(tile: Tile): Tile {
    const b = this.meta?.bounds;
    if (!b) return tile;
    return { x: Math.min(b.maxX, Math.max(b.minX, tile.x)), y: Math.min(b.maxY, Math.max(b.minY, tile.y)) };
  }

  private setHover(first: MenuOption | null, more: number): void {
    const key = first ? `${first.verb}|${first.targetName}|${first.kind}|${first.suffix ?? ""}|${more}` : "";
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.emit("hover", first ? { first, more } : null);
  }

  private updateHover(time: number): void {
    if (!this.pointer.inside || !this.canAct()) return;
    if (!this.pointer.moved && time - this.pointer.lastPick < HOVER_REPICK_MS) return;
    this.pointer.moved = false;
    this.pointer.lastPick = time;
    const options = this.menuAt(this.pointer.x, this.pointer.y);
    const first = options[0] ?? null;
    this.setHover(first, Math.max(0, options.length - 1));
  }

  // ------------------------------------------------------------------ local routing

  /**
   * Routes the local player towards `goal` from the tile it is standing on or
   * stepping onto, emits the move, and returns the path (null if it cannot move).
   */
  private planPath(goal: PathGoal): Tile[] | null {
    const local = this.local;
    const map = this.map;
    if (!local || !map) return null;
    const now = this.clock();
    const stop = nextStop(local.motion, now);
    const path = findPath(map, stop.tile, goal);
    this.releaseMerchant();
    local.faceTile = null;
    if (!path) {
      this.destination = null;
      return null;
    }
    const standing = stop.at <= now && motionEnd(local.motion) <= now;
    if (path.length === 1 && standing) {
      this.queued = null;
      this.destination = null;
      return path;
    }
    const motion: Motion = { path, startedAt: stop.at, run: this.running };
    if (stop.at > now) this.queued = motion;
    else {
      this.queued = null;
      local.setMotion(motion, this.frame, now, false);
    }
    this.destination = path.length > 1 ? path[path.length - 1]! : null;
    // The first step ends the arrival framing.
    this.cam.settle();
    this.emit("move", { path: path.map((t) => ({ x: t.x, y: t.y })), run: this.running });
    return path;
  }

  private cancelPending(): void {
    this.pending = null;
    if (this.local) this.local.faceTile = null;
  }

  private startInteraction(verb: InteractVerb, target: TargetRef): void {
    if (target.kind === "tile") {
      this.walkTo(target.tile);
      return;
    }
    this.pending = { verb, target, chase: new Chase(), arrived: false };
    this.updatePending(performance.now());
  }

  /**
   * The target's tile and the goal to interact with it; for someone walking,
   * where their route ends (`destination`) and the goal next to that, which
   * is what a chaser routes to; and whether it moves at all.
   */
  private resolveTarget(
    target: TargetRef,
  ): { tile: Tile; goal: PathGoal; destination: Tile; destinationGoal: PathGoal; moving: boolean } | null {
    const map = this.map!;
    const meta = this.meta!;
    const still = (tile: Tile, goal: PathGoal) => ({ tile, goal, destination: tile, destinationGoal: goal, moving: false });
    const walker = (actor: Actor) => {
      const tile = tileAt(actor.motion, this.clock());
      const goal = adjacentGoal(map, tile);
      const end = actor.motion.path[actor.motion.path.length - 1];
      const destination = end && (end.x !== tile.x || end.y !== tile.y) ? { x: end.x, y: end.y } : tile;
      const destinationGoal = destination === tile ? goal : adjacentGoal(map, destination);
      return { tile, goal, destination, destinationGoal, moving: true };
    };
    switch (target.kind) {
      case "booth": {
        const booth = meta.booths[target.boothIndex];
        return booth ? still(booth.tile, boothGoal(booth)) : null;
      }
      case "banker": {
        const banker = meta.bankers[target.npcIndex];
        if (!banker) return null;
        const goal = bankerGoal(map, banker, meta.booths);
        return goal ? still(banker.tile, goal) : null;
      }
      case "merchant": {
        const actor = this.merchants.get(target.merchantId)?.actor;
        return actor ? walker(actor) : null;
      }
      case "player": {
        const actor = this.remotes.get(target.pid)?.actor;
        return actor ? walker(actor) : null;
      }
      case "tile":
        return null;
    }
  }

  private updatePending(perfNow: number): void {
    const pending = this.pending;
    const local = this.local;
    if (!pending || !local) return;
    const resolved = this.resolveTarget(pending.target);
    if (!resolved) {
      this.pending = null;
      return;
    }
    const now = this.clock();
    const walking = this.queued !== null || motionEnd(local.motion) > now;
    const here = tileAt(local.motion, now);

    // Standing next to it: interact (following carries on after).
    const reached = !walking && resolved.goal.reached(here.x, here.y);
    if (reached) {
      local.faceTile = resolved.tile;
      if (!pending.arrived) {
        pending.arrived = true;
        this.onArrived(pending, resolved.tile);
        if (pending.verb !== "follow") {
          this.pending = null;
          return;
        }
      }
    }

    // Route to where the target's own route ends (see Chase).
    const route = this.queued ?? local.motion;
    const routeEnd = route.path[route.path.length - 1] ?? here;
    if (pending.chase.shouldPlan(perfNow, resolved.destination, resolved.destinationGoal, routeEnd)) {
      if (walking || !resolved.destinationGoal.reached(here.x, here.y)) {
        const path = this.planPath(resolved.destinationGoal);
        if (!path) {
          if (!pending.arrived) {
            this.emit("examine", { text: CANT_REACH });
            this.pending = null;
          }
          return;
        }
        if (path.length > 1) return;
      }
    }
    if (walking || reached) return;

    // Stopped at the end of the route without reaching it: static targets give up.
    if (!resolved.moving && perfNow - pending.chase.plannedAt > 50) {
      this.emit("examine", { text: CANT_REACH });
      this.pending = null;
    }
  }

  private onArrived(pending: Pending, targetTile: Tile): void {
    const target = pending.target;
    if (target.kind === "merchant") {
      const state = this.merchants.get(target.merchantId);
      if (state) {
        state.engagedUntil = performance.now() + ENGAGE_MS;
        this.engagedMerchant = state;
        const now = this.clock();
        state.actor.setMotion(standingMotion(state.actor.currentTile(), now), this.frame, now);
        state.actor.faceTile = this.local!.currentTile();
      }
    } else if (target.kind === "banker") {
      const banker = this.bankers[target.npcIndex];
      if (banker) {
        banker.actor.faceTile = this.local!.currentTile();
        banker.glanceUntil = performance.now() + 6_000;
      }
    }
    this.local!.faceTile = targetTile;
    if ((target.kind === "banker" || target.kind === "booth") && HINT_VERBS.has(pending.verb)) {
      this.hint.dismiss();
      this.hintBanker = -1;
    }
    this.sound.play("click");
    this.emit("interact", { verb: pending.verb, target });
  }

  private releaseMerchant(): void {
    const state = this.engagedMerchant;
    if (!state) return;
    this.engagedMerchant = null;
    state.engagedUntil = 0;
    state.resumeFrom = state.actor.currentTile();
    state.actor.faceTile = null;
  }

  // ------------------------------------------------------------------ simulation

  private tick(dt: number, time: number): void {
    if (!this.loaded) return;
    const now = this.clock();
    const local = this.local;

    if (local && this.queued && now >= this.queued.startedAt) {
      local.setMotion(this.queued, this.frame, now, false);
      this.queued = null;
    }
    if (local && this.destination && motionEnd(local.motion) <= now && !this.queued) this.destination = null;
    this.updatePending(time);
    this.updateMerchants(now, time);
    this.updateCheers(time);
    this.updateBankers(time);
    this.updateHint();

    for (const actor of this.actors) actor.update(this.frame, now, dt);
    this.fireworks.update(dt);

    if (this.titleMode || !local) {
      // The title orbit holds still under reduced motion.
      this.cam.updateTitle(this.motion.reduced ? 0 : dt, this.titleCentre, this.titleRadius);
    } else {
      this.cam.update(dt, local.position);
    }
    this.updateHover(time);
  }

  private updateMerchants(now: number, perfNow: number): void {
    const map = this.map!;
    for (const state of this.merchants.values()) {
      const { actor, schedule } = state;
      if (state.engagedUntil > perfNow && this.local) {
        actor.faceTile = this.local.currentTile();
      } else {
        if (state === this.engagedMerchant) this.releaseMerchant();
        const k = segmentAt(schedule, now);
        if (k !== state.segment || state.resumeFrom) {
          let motion: Motion;
          if (state.resumeFrom) {
            // Catch up with the shared schedule from wherever the trade left the merchant.
            const resumed = segmentMotion(map, schedule, k, state.resumeFrom);
            motion = { ...resumed, startedAt: Math.max(now, resumed.startedAt) };
            state.resumeFrom = null;
          } else {
            motion = segmentMotion(map, schedule, k);
          }
          state.segment = k;
          actor.setMotion(motion, this.frame, now);
        }
      }
      // Dated from its slot time, so a slow frame's shout still ends on schedule. One missed while the loop was
      // paused (a hidden tab, a phone switching apps) is skipped, so a resumed hall doesn't shout all at once.
      const late = takeShout(schedule, state, now);
      if (late >= 0) actor.chat = createBubble(state.shout.text, state.shout.effects, perfNow - late);
    }
  }

  private updateBankers(perfNow: number): void {
    for (const banker of this.bankers) {
      const { actor } = banker;
      if (perfNow >= banker.glanceUntil && (actor.faceTile || actor.restYaw !== banker.restYaw)) {
        actor.faceTile = null;
        actor.restYaw = banker.restYaw;
      }
      if (perfNow < banker.nextGlance) continue;
      banker.nextGlance = perfNow + 8_000 + Math.random() * 14_000;
      // Glance at someone at the counter, or look along the hall for a moment.
      const visitor = this.nearestVisitor(banker);
      if (visitor) {
        actor.faceTile = visitor;
        banker.glanceUntil = perfNow + 2_500 + Math.random() * 2_000;
      } else {
        actor.restYaw = banker.restYaw + (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 4);
        banker.glanceUntil = perfNow + 1_800 + Math.random() * 1_500;
      }
    }
  }

  /** Moves the hint arrow to the serving banker nearest the local player (until dismissed). */
  private updateHint(): void {
    const local = this.local;
    const meta = this.meta;
    if (this.hint.dismissed || !local || !meta || this.titleMode) {
      this.hintBanker = -1;
      return;
    }
    this.hintBanker = nearestBanker(meta.bankers, { x: local.tileX, y: local.tileY }, this.hintBanker);
  }

  private nearestVisitor(banker: BankerState): Tile | null {
    const bt = banker.actor.currentTile();
    let best: Tile | null = null;
    let bestD = 5 * 5 + 1;
    for (const actor of this.actors) {
      if (actor.kind === "banker" || !actor.root.visible) continue;
      const dx = actor.tileX - bt.x;
      const dy = actor.tileY - bt.y;
      if (dx >= 0) continue; // only people on the customer side of the counter
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = actor.currentTile();
      }
    }
    return best;
  }

  private rebuildActorList(): void {
    const list: Actor[] = [];
    if (this.local) list.push(this.local);
    for (const s of this.remotes.values()) list.push(s.actor);
    for (const s of this.merchants.values()) list.push(s.actor);
    for (const s of this.bankers) list.push(s.actor);
    this.actors = list;
  }

  private removeActor(actor: Actor): void {
    this.actorGroup.remove(actor.root);
    actor.dispose();
    this.actors = this.actors.filter((a) => a !== actor);
  }

  // ------------------------------------------------------------------ drawing

  private draw(time: number): void {
    const renderer = this.renderer;
    const overlay = this.overlay;
    if (!renderer || !overlay) return;
    renderer.render(this.scene, this.cam.camera);
    overlay.clear();
    if (!this.loaded) return;

    // Overhead text belongs to the game view, not the title screen behind the logo.
    if (!this.titleMode) {
      this.drawHint(time);
      this.drawOverheads(time);
    }

    const cross = this.cross;
    if (cross) {
      const elapsed = time - cross.startedAt;
      const frame = this.crossFrames[Math.min(3, Math.floor((elapsed / CROSS_MS) * 4)) + (cross.red ? 4 : 0)];
      if (elapsed >= CROSS_MS) this.cross = null;
      else if (frame) overlay.drawSprite(frame, cross.x, cross.y);
    }

    if (this.debug) {
      this.drawDebugLabels();
      const st = this.stats;
      overlay.drawLabel(
        `${st.fps.toFixed(0)} fps  tick ${st.tickMs.toFixed(2)} ms  draw ${st.renderMs.toFixed(2)} ms  ${st.drawCalls} calls  ${this.actors.length} actors`,
        this.width / 2,
        16,
        "#00ff00",
      );
    }
    this.drawMinimap();
  }

  /** The bobbing hint arrow over the banker new players should talk to (under any overhead text). */
  private drawHint(time: number): void {
    const banker = this.bankers[this.hintBanker]?.actor;
    if (!banker || !banker.root.visible) return;
    const p = this.projected.set(banker.position.x, banker.position.y + banker.height + HINT_ABOVE_HEAD, banker.position.z).project(this.cam.camera);
    if (p.z > 1 || p.z < -1 || p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1) return;
    const x = (p.x + 1) * (this.width / 2);
    const y = (1 - p.y) * (this.height / 2);
    this.overlay!.drawHintArrow(x, y - hintBob(time, this.motion.reduced));
  }

  /**
   * Overhead text: each actor's block (stall tag with its chat above) is
   * stacked upwards clear of the ones placed before it, like the client.
   * Players go first (the local player's text never moves), then merchant
   * shouts. On a wide view the newest shouts go first, so when a column
   * already holds MERCHANT_STACK_MAX shouts the oldest give way. A narrow
   * view (a phone, or portrait) shows at most NARROW_MERCHANT_SHOUTS: those
   * already showing keep their place until they end, and free places go to
   * the shouts nearest the middle of the view (ShoutPicker).
   */
  private drawOverheads(time: number): void {
    const overlay = this.overlay!;
    const actors = this.actors;
    const stack = this.overheads;
    const merchants = this.merchantOverheads;
    const view = this.overheadView;
    view.width = this.width;
    view.height = this.height;
    view.safeTop = this.safeTop;
    view.safeLeft = this.safeLeft;
    view.safeRight = this.safeRight;
    view.hud = this.exclusion;
    stack.ensure(actors.length);
    stack.reset();
    merchants.length = 0;
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i]!;
      if (actor.chat && time - actor.chat.startedAt >= CHAT_LIFETIME_MS) actor.chat = null;
      if (!actor.root.visible || (!actor.chat && !actor.stallTag)) continue;
      if (actor.kind === "merchant") merchants.push(i);
      else this.placeOverhead(actor, i, 0, Infinity);
    }
    if (isNarrowView(this.width, this.height)) {
      const picker = this.shoutPicker;
      const cx = this.width / 2;
      const cy = this.height / 2;
      for (const i of merchants) {
        const actor = actors[i]!;
        const p = this.projected.set(actor.position.x, actor.position.y + actor.height, actor.position.z).project(this.cam.camera);
        const dx = (p.x + 1) * cx - cx;
        const dy = (1 - p.y) * cy - cy;
        const key = actor.chat ?? actor;
        picker.score(i, key, dx, dy, actor.chat !== null && this.priorityLines.has(actor.chat));
      }
      merchants.sort(picker.compare);
      picker.begin();
      let shown = 0;
      for (let k = 0; k < merchants.length && shown < NARROW_MERCHANT_SHOUTS; k++) {
        const i = merchants[k]!;
        const actor = actors[i]!;
        if (!this.placeOverhead(actor, i, MERCHANT_GROUP, MERCHANT_STACK_MAX)) continue;
        picker.mark(actor.chat ?? actor);
        shown++;
      }
      picker.end();
    } else {
      this.shoutPicker.clear();
      merchants.sort(this.newestShoutFirst);
      for (const i of merchants) this.placeOverhead(actors[i]!, i, MERCHANT_GROUP, MERCHANT_STACK_MAX);
    }

    for (let k = 0; k < stack.count; k++) {
      const actor = actors[stack.index[k]!]!;
      const sx = stack.x[k]!;
      let sy = stack.y[k]!;
      if (actor.stallTag) {
        overlay.drawTag(actor.stallTag, actor.stallTagWidth, sx, sy);
        sy -= TAG_LINE;
      }
      // Moving text keeps its amplitude clear above and below.
      if (actor.chat && !overlay.drawChat(actor.chat, sx, sy - overlay.chatRise(actor.chat), time)) actor.chat = null;
    }
  }

  private readonly newestShoutFirst = (a: number, b: number): number =>
    (this.actors[b]!.chat?.startedAt ?? 0) - (this.actors[a]!.chat?.startedAt ?? 0);

  /** Places one actor's overhead block on the stack, inside the viewport; false when it is off screen or dropped. */
  private placeOverhead(actor: Actor, index: number, group: number, maxBelow: number): boolean {
    const overlay = this.overlay!;
    const p = this.projected.set(actor.position.x, actor.position.y + actor.height + 0.12, actor.position.z).project(this.cam.camera);
    // Below the bottom (the whole body is) or well above the top: nothing to label. The sides are fitOverhead's.
    if (p.z > 1 || p.z < -1 || p.y < -1 || p.y > OVERHEAD_ABOVE_TOP_NDC) return false;
    let width = 0;
    let height = 0;
    if (actor.stallTag) {
      if (actor.stallTagWidth < 0) actor.stallTagWidth = overlay.measureTag(actor.stallTag);
      width = actor.stallTagWidth;
      height = TAG_ASCENT;
    }
    if (actor.chat) {
      width = Math.max(width, overlay.chatBlockWidth(actor.chat));
      height = (actor.stallTag ? TAG_LINE : 0) + CHAT_ASCENT + 2 * overlay.chatRise(actor.chat);
    }
    const halfWidth = width / 2;
    // Centred over the head, kept inside the view (clear of a notch and the rounded corners) and out from
    // under the minimap; a shout that stacking would push back under it gives way.
    const fit = this.fitted;
    if (!fitOverhead((p.x + 1) * (this.width / 2), (1 - p.y) * (this.height / 2), halfWidth, height, this.overheadView, fit)) return false;
    return !Number.isNaN(this.overheads.place(index, fit.x, fit.y, halfWidth, height, group, maxBelow, fit.minTop));
  }

  private drawDebugLabels(): void {
    const overlay = this.overlay!;
    const camera = this.cam.camera;
    const centre = this.local?.currentTile();
    if (!centre) return;
    const f = this.frame;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const tx = centre.x + dx;
        const ty = centre.y + dy;
        const p = this.projected.set(tx - f.originX + 0.5, f.floorHeight, -(ty - f.originY + 0.5)).project(camera);
        if (p.z > 1) continue;
        overlay.drawLabel(`${tx},${ty}`, (p.x + 1) * (this.width / 2), (1 - p.y) * (this.height / 2) + 4, dx === 0 && dy === 0 ? "#ffff00" : "#ffffff");
      }
    }
  }

  private drawMinimap(): void {
    const minimap = this.minimap;
    if (!minimap) return;
    const dots = this.dots;
    dots.reset();
    for (const actor of this.actors) {
      if (actor.kind === "local" || !actor.root.visible) continue;
      dots.push(actor.tileX, actor.tileY, actor.kind !== "player");
    }
    const local = this.local;
    if (local && !this.titleMode) {
      minimap.draw(local.tileX, local.tileY, this.cam.yaw, dots, this.destination);
    } else {
      const f = this.frame;
      this.focus.copy(this.titleCentre);
      minimap.draw(this.focus.x + f.originX - 0.5, -this.focus.z + f.originY - 0.5, this.cam.yaw, dots, null);
    }
  }
}
