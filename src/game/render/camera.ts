import { MathUtils, PerspectiveCamera, Vector3 } from "three";

/**
 * The original client's camera: it orbits the local player, yaw is free,
 * pitch is clamped to 128..383 of 2048 units (22.5 to 67.3 degrees), and the
 * distance follows the 2007 formula `600 + pitch * 3` (client units, 128 per
 * tile), scaled by the scroll-wheel zoom. Arrow keys accelerate the yaw and
 * pitch like the client's key handler; drags and pinches set them directly.
 *
 * Yaw follows the client's camAngleY: the camera sits at
 * focus + (sin yaw, cos yaw) * distance, so yaw 0 is south of the player
 * looking north and positive yaw moves the camera east (looking west). Like
 * the client, Left lowers the yaw (the camera swings west round the player
 * and the compass needle turns anticlockwise) and Up raises the camera.
 */

const UNITS = 2048;
const TO_RAD = (Math.PI * 2) / UNITS;
export const PITCH_MIN = 128 * TO_RAD;
export const PITCH_MAX = 383 * TO_RAD;
const PITCH_DEFAULT = 256 * TO_RAD;
export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 1.7;
/** Default zoom: a little wider than the 2007 fixed viewport so the hall fits a browser window. */
const ZOOM_DEFAULT = 1.3;
/** Key rotation top speeds, from the client's 12 units per 20 ms yaw and 6 for pitch. */
const KEY_YAW_SPEED = 12 * 50 * TO_RAD;
const KEY_PITCH_SPEED = 6 * 50 * TO_RAD;
/** The client focuses 50 units above the tile; a little higher keeps the body centred. */
const FOCUS_HEIGHT = 0.5;
/** Vertical field of view of the 512x334 fixed viewport (focal length 512). */
const BASE_VFOV = 2 * Math.atan(167 / 512);
const BASE_HALF_HFOV = Math.atan(256 / 512);
const MAX_VFOV = MathUtils.degToRad(72);

/**
 * Portrait screens (phones held upright) see a narrow, tall slice of the
 * world: at the desktop framing the player is a small figure in the middle
 * with the road behind filling the lower half. Until the player picks their
 * own zoom or pitch, portrait starts closer and a little higher, and the
 * view is shifted so the player stands below the middle, leaving more of
 * the hall ahead in view.
 */
const PORTRAIT_ASPECT = 0.8;
/**
 * A short, wide view (a phone held sideways) sees little ground ahead at the
 * desktop pitch: it starts a little higher, with the player a little low.
 */
const SHORT_VIEW_PX = 500;

type Framing = "default" | "portrait" | "short";

const FRAMINGS: Record<Framing, { zoom: number; pitch: number; drop: number }> = {
  default: { zoom: ZOOM_DEFAULT, pitch: PITCH_DEFAULT, drop: 0 },
  // Share of the view's height the player stands below its middle (drop).
  portrait: { zoom: 0.95, pitch: 300 * TO_RAD, drop: 0.08 },
  short: { zoom: ZOOM_DEFAULT, pitch: 320 * TO_RAD, drop: 0.05 },
};

function framingFor(width: number, height: number): Framing {
  const aspect = width / Math.max(1, height);
  if (aspect < PORTRAIT_ASPECT) return "portrait";
  if (height < SHORT_VIEW_PX) return "short";
  return "default";
}
/**
 * Arrival framing. The server spawns players just inside the door, south-west
 * of the booths, and the default view (north-up, centred on the player)
 * spends much of a desktop window on the grass outside and leaves the
 * booths at or past a phone's right edge, under the minimap. Until the
 * player first walks, drags or rotates, the first view of the hall leans
 * towards the bankers: the focus moves `lead` tiles towards them (at most
 * `share` of the way) and, in portrait, the camera turns up to `turn`
 * radians towards them so the booth row stands clear of the minimap.
 */
const ARRIVAL: Record<Framing, { lead: number; share: number; turn: number }> = {
  default: { lead: 2.5, share: 0.5, turn: 0 },
  portrait: { lead: 1.5, share: 0.35, turn: MathUtils.degToRad(20) },
  short: { lead: 2.5, share: 0.5, turn: 0 },
};
/** How quickly the arrival lead eases out once the player takes over (per second). */
const LEAD_EASE = 2.5;

/** Title orbit pitch (radians): low and cinematic, higher in portrait where the sky would fill the top. */
const TITLE_PITCH = 0.52;
const TITLE_PITCH_PORTRAIT = 0.78;

function wrapAngle(a: number): number {
  return MathUtils.euclideanModulo(a + Math.PI, Math.PI * 2) - Math.PI;
}

export type CameraKey = "left" | "right" | "up" | "down";

export class OsrsCamera {
  readonly camera: PerspectiveCamera;
  /** Current values (eased). Yaw 0 looks north; positive yaw puts the camera east, looking west. */
  yaw = 0;
  pitch = PITCH_DEFAULT;
  zoom = ZOOM_DEFAULT;
  private targetYaw = 0;
  private targetPitch = PITCH_DEFAULT;
  private targetZoom = ZOOM_DEFAULT;
  private yawSpeed = 0;
  private pitchSpeed = 0;
  private readonly keys = { left: false, right: false, up: false, down: false };
  private readonly focus = new Vector3();
  private hasFocus = false;
  private titleAngle = 0;
  /** Default framing for the view's shape (see FRAMINGS). */
  framing: Framing = "default";
  /** The player has zoomed or tilted the camera; their choice outlives orientation changes. */
  private zoomChosen = false;
  private pitchChosen = false;
  private viewWidth = 1;
  private viewHeight = 1;
  /** Vertical view shift applied now, in CSS px (0 = centred). */
  private shift = 0;
  /** The player has turned the camera since arriving; arrival framing no longer sets the yaw. */
  private yawChosen = false;
  /** Scene direction (x, z) and distance from the player to what the arrival view leans towards; null once settled. */
  private arrival: { dx: number; dz: number; distance: number } | null = null;
  /** Focus offset (scene units) now and the one it eases towards. */
  readonly lead = new Vector3();
  private readonly leadTarget = new Vector3();

  constructor() {
    this.camera = new PerspectiveCamera(MathUtils.radToDeg(BASE_VFOV), 1, 0.1, 80);
  }

  setViewport(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    this.camera.aspect = aspect;
    // Keep at least the fixed viewport's horizontal view on narrow screens.
    // Portrait phones widen the vertical view, capped before perspective distortion sets in.
    const minVfov = 2 * Math.atan(Math.tan(BASE_HALF_HFOV) / aspect);
    this.camera.fov = MathUtils.radToDeg(Math.min(MAX_VFOV, Math.max(BASE_VFOV, minVfov)));
    this.viewWidth = Math.max(1, width);
    this.viewHeight = Math.max(1, height);
    const framing = framingFor(width, height);
    if (framing !== this.framing) {
      this.framing = framing;
      if (!this.zoomChosen) this.targetZoom = FRAMINGS[framing].zoom;
      if (!this.pitchChosen) this.targetPitch = FRAMINGS[framing].pitch;
      // A phone turned before the player moved: lean the new shape's way.
      if (this.arrival) this.applyArrival();
    }
    // Re-applies the shift for the new size (and updates the projection).
    this.applyShift(this.shift === 0 ? 0 : this.framingShift(), true);
  }

  /** The view shift for the current framing and size, in CSS px. */
  private framingShift(): number {
    return Math.round(this.viewHeight * FRAMINGS[this.framing].drop);
  }

  /** Shifts the projection so the focus is drawn `shift` px below the middle (picking and projection follow). */
  private applyShift(shift: number, force = false): void {
    if (shift === this.shift && !force) return;
    this.shift = shift;
    if (shift === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.viewWidth, this.viewHeight, 0, -shift, this.viewWidth, this.viewHeight);
    this.camera.updateProjectionMatrix();
  }

  setKey(key: CameraKey, down: boolean): void {
    this.keys[key] = down;
  }

  releaseKeys(): void {
    this.keys.left = this.keys.right = this.keys.up = this.keys.down = false;
  }

  /**
   * Frames the player's arrival: the view leans towards a point `dx`, `dz`
   * scene units from the player (the bankers) until `settle` is called or the
   * player turns the camera. Call `snap` afterwards to place it at once.
   */
  frameArrival(dx: number, dz: number): void {
    const distance = Math.hypot(dx, dz);
    this.yawChosen = false;
    if (distance < 1e-6) {
      this.arrival = null;
      this.leadTarget.set(0, 0, 0);
      return;
    }
    this.arrival = { dx: dx / distance, dz: dz / distance, distance };
    this.applyArrival();
  }

  /** True while the arrival framing is in effect (before the player first walks, drags or rotates). */
  get arriving(): boolean {
    return this.arrival !== null;
  }

  /** Ends the arrival framing: the lead eases back onto the player; the yaw stays where it is. */
  settle(): void {
    if (!this.arrival) return;
    this.arrival = null;
    this.leadTarget.set(0, 0, 0);
  }

  private applyArrival(): void {
    const a = this.arrival;
    if (!a) return;
    const { lead, share, turn } = ARRIVAL[this.framing];
    const reach = Math.min(lead, a.distance * share);
    this.leadTarget.set(a.dx * reach, 0, a.dz * reach);
    if (!this.yawChosen) {
      // Yaw that looks straight at the point (the camera sits opposite it), turned at most `turn`.
      const towards = Math.atan2(-a.dx, -a.dz);
      this.targetYaw = MathUtils.clamp(towards, -turn, turn);
    }
  }

  /** Drag rotation in radians (positive yaw moves the camera east round the focus, positive pitch raises it). */
  rotateBy(dYaw: number, dPitch: number): void {
    if (dYaw !== 0 || dPitch !== 0) this.takeOver();
    this.targetYaw += dYaw;
    if (dPitch !== 0) this.pitchChosen = true;
    this.targetPitch = MathUtils.clamp(this.targetPitch + dPitch, PITCH_MIN, PITCH_MAX);
  }

  /** Multiplies the distance (positive steps zoom out). */
  zoomBy(steps: number): void {
    if (steps !== 0) this.zoomChosen = true;
    this.targetZoom = MathUtils.clamp(this.targetZoom * Math.pow(1.12, steps), ZOOM_MIN, ZOOM_MAX);
  }

  zoomTo(factor: number): void {
    this.zoomChosen = true;
    this.targetZoom = MathUtils.clamp(factor, ZOOM_MIN, ZOOM_MAX);
  }

  resetNorth(): void {
    // Turn the short way round.
    this.targetYaw = this.yaw - wrapAngle(this.yaw);
  }

  /** The player turned the camera: their view from now on. */
  private takeOver(): void {
    this.yawChosen = true;
    this.settle();
  }

  /** Instantly places the camera (e.g. when the local player spawns). */
  snap(): void {
    this.yaw = this.targetYaw;
    this.pitch = this.targetPitch;
    this.zoom = this.targetZoom;
    this.lead.copy(this.leadTarget);
    this.hasFocus = false;
  }

  /** Follows `target` (feet position) with the player camera. */
  update(dt: number, target: Vector3): void {
    const { keys } = this;
    // Client: Left drives camAngleDY toward -24, Right toward +24.
    const yawDir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const pitchDir = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
    // The client halves the gap to the top speed every 20 ms.
    const ramp = 1 - Math.pow(0.5, dt / 0.02);
    this.yawSpeed += (yawDir * KEY_YAW_SPEED - this.yawSpeed) * ramp;
    this.pitchSpeed += (pitchDir * KEY_PITCH_SPEED - this.pitchSpeed) * ramp;
    if (yawDir !== 0 || pitchDir !== 0) this.takeOver();
    if (Math.abs(this.yawSpeed) > 1e-4) this.targetYaw += this.yawSpeed * dt;
    if (pitchDir !== 0) this.pitchChosen = true;
    if (Math.abs(this.pitchSpeed) > 1e-4) {
      this.targetPitch = MathUtils.clamp(this.targetPitch + this.pitchSpeed * dt, PITCH_MIN, PITCH_MAX);
    }

    const ease = 1 - Math.exp(-dt * 14);
    this.yaw += (this.targetYaw - this.yaw) * ease;
    this.pitch += (this.targetPitch - this.pitch) * ease;
    this.zoom += (this.targetZoom - this.zoom) * (1 - Math.exp(-dt * 10));
    this.lead.lerp(this.leadTarget, 1 - Math.exp(-dt * LEAD_EASE));
    // Keep the numbers small without a visible jump.
    if (Math.abs(this.yaw) > Math.PI * 4) {
      const wrapped = wrapAngle(this.yaw);
      this.targetYaw += wrapped - this.yaw;
      this.yaw = wrapped;
    }

    if (!this.hasFocus) {
      this.focus.copy(target);
      this.hasFocus = true;
    } else {
      this.focus.lerp(target, 1 - Math.exp(-dt * 30));
    }
    const pitchUnits = this.pitch / TO_RAD;
    const distance = ((600 + pitchUnits * 3) / 128) * this.zoom;
    this.applyShift(this.framingShift());
    const { lead } = this;
    this.place(this.focus.x + lead.x, this.focus.y + FOCUS_HEIGHT, this.focus.z + lead.z, this.yaw, this.pitch, distance);
  }

  /** Slow cinematic orbit used behind the title screen. */
  updateTitle(dt: number, centre: Vector3, radius: number): void {
    this.titleAngle += dt * 0.07;
    this.yaw = this.titleAngle;
    this.applyShift(0);
    const pitch = this.framing === "portrait" ? TITLE_PITCH_PORTRAIT : TITLE_PITCH;
    this.place(centre.x, centre.y + 0.6, centre.z, this.titleAngle, pitch + Math.sin(this.titleAngle * 0.7) * 0.05, radius);
    this.hasFocus = false;
  }

  private place(fx: number, fy: number, fz: number, yaw: number, pitch: number, distance: number): void {
    const horizontal = Math.cos(pitch) * distance;
    this.camera.position.set(fx + Math.sin(yaw) * horizontal, fy + Math.sin(pitch) * distance, fz + Math.cos(yaw) * horizontal);
    this.camera.lookAt(fx, fy, fz);
  }
}
