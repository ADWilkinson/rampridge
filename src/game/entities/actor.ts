import { Box3, Group, Vector3 } from "three";
import type { StallSummary, Tile } from "@shared/protocol";
import type { CharacterHandle, Locomotion } from "../osrs/types";
import type { ChatBubble } from "../overlay/overlay";
import { createSample, sampleMotion, standingMotion, type Motion, type MotionSample } from "../world/motion";
import { groundHeight, type WorldFrame } from "../world/coords";

/**
 * One character in the world: its model, deterministic motion, facing and
 * overhead state. Positions come from `sampleMotion` on the server clock;
 * facing turns at the client's rate (32 of 2048 units per 20 ms cycle), and
 * the gap between facing and movement selects walk-back/left/right.
 */

export type ActorKind = "local" | "player" | "merchant" | "banker";

const TURN_SPEED = ((32 / 2048) * Math.PI * 2) / 0.02;
const PICK_RADIUS = 0.32;
/** Small corrections (a re-sent path) blend instead of popping; bigger ones snap. */
const BLEND_MAX_TILES = 2.5;
const BLEND_RATE = 12;

function wrap(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

export class Actor {
  readonly kind: ActorKind;
  readonly id: string;
  name: string;
  readonly root = new Group();
  handle: CharacterHandle;
  motion: Motion;
  readonly sample: MotionSample = createSample();
  /** Live scene position of the feet (also the anchor for effects). */
  readonly position = new Vector3();
  /** Fractional world tile coordinates. */
  tileX = 0;
  tileY = 0;
  yaw = 0;
  targetYaw = 0;
  /** When standing, face this tile (an interaction target), if set. */
  faceTile: Tile | null = null;
  /** Default facing when idle with nothing to face (bankers). */
  restYaw: number | null = null;
  chat: ChatBubble | null = null;
  stall: StallSummary | null = null;
  stallTag: string | null = null;
  stallTagWidth = 0;
  readonly box = new Box3();
  private locomotion: Locomotion | null = null;
  private readonly blend = new Vector3();

  constructor(kind: ActorKind, id: string, name: string, handle: CharacterHandle, tile: Tile, frame: WorldFrame) {
    this.kind = kind;
    this.id = id;
    this.name = name;
    this.handle = handle;
    this.motion = standingMotion(tile);
    this.root.add(handle.object);
    this.root.name = `${kind}:${id}`;
    this.place(frame, 0);
  }

  get height(): number {
    return this.handle.height;
  }

  /** Replaces the motion; small jumps are blended away. */
  setMotion(motion: Motion, frame: WorldFrame, now: number, blend = true): void {
    const prevX = this.position.x;
    const prevZ = this.position.z;
    this.motion = motion;
    sampleMotion(motion, now, this.sample);
    const nx = this.sample.x - frame.originX + 0.5;
    const nz = -(this.sample.y - frame.originY + 0.5);
    const dx = prevX - nx;
    const dz = prevZ - nz;
    if (blend && dx * dx + dz * dz <= BLEND_MAX_TILES * BLEND_MAX_TILES) {
      this.blend.set(dx, 0, dz);
    } else {
      this.blend.set(0, 0, 0);
    }
  }

  /** Teleports to a tile, standing. */
  snapTo(tile: Tile, frame: WorldFrame, now: number): void {
    this.motion = standingMotion(tile, now);
    this.blend.set(0, 0, 0);
    this.place(frame, now);
  }

  /** Samples the motion and moves the model. */
  place(frame: WorldFrame, now: number): void {
    const s = sampleMotion(this.motion, now, this.sample);
    this.tileX = s.x;
    this.tileY = s.y;
    this.position.set(
      s.x - frame.originX + 0.5 + this.blend.x,
      groundHeight(frame, s.x, s.y),
      -(s.y - frame.originY + 0.5) + this.blend.z,
    );
    this.root.position.copy(this.position);
  }

  update(frame: WorldFrame, now: number, dt: number): void {
    this.place(frame, now);
    if (this.blend.x !== 0 || this.blend.z !== 0) {
      const k = Math.exp(-dt * BLEND_RATE);
      this.blend.x *= k;
      this.blend.z *= k;
      if (Math.abs(this.blend.x) < 1e-3 && Math.abs(this.blend.z) < 1e-3) this.blend.set(0, 0, 0);
    }

    const s = this.sample;
    if (s.moving) {
      this.targetYaw = Math.atan2(s.dirX, -s.dirY);
    } else if (this.faceTile) {
      const dx = this.faceTile.x - s.x;
      const dy = this.faceTile.y - s.y;
      if (dx !== 0 || dy !== 0) this.targetYaw = Math.atan2(dx, -dy);
    } else if (this.restYaw !== null) {
      this.targetYaw = this.restYaw;
    }
    const diff = wrap(this.targetYaw - this.yaw);
    const maxTurn = TURN_SPEED * dt;
    const turning = Math.abs(diff) > 1e-3;
    this.yaw = turning ? wrap(this.yaw + Math.max(-maxTurn, Math.min(maxTurn, diff))) : this.targetYaw;
    this.root.rotation.y = this.yaw;
    // While the facing catches up with the movement direction the runtime
    // plays walk-back or a sidestep, as the client does (it skips unchanged values).
    this.handle.setHeadingOffset?.(s.moving ? wrap(this.targetYaw - this.yaw) : 0);

    const mode: Locomotion = s.moving ? (this.motion.run ? "run" : "walk") : turning && Math.abs(diff) > 0.2 ? "turn" : "idle";
    if (mode !== this.locomotion) {
      this.locomotion = mode;
      this.handle.setLocomotion(mode);
    }
    this.handle.update(dt);

    const h = this.handle.height;
    this.box.min.set(this.position.x - PICK_RADIUS, this.position.y, this.position.z - PICK_RADIUS);
    this.box.max.set(this.position.x + PICK_RADIUS, this.position.y + h, this.position.z + PICK_RADIUS);
  }

  /** Faces a yaw immediately (spawning). */
  setYaw(yaw: number): void {
    this.yaw = this.targetYaw = yaw;
    this.root.rotation.y = yaw;
  }

  /** Swaps the model (appearance rebuilt by a new handle). */
  replaceHandle(handle: CharacterHandle): void {
    this.root.remove(this.handle.object);
    this.handle.dispose();
    this.handle = handle;
    this.root.add(handle.object);
    this.locomotion = null;
  }

  /** The tile currently occupied (last reached). */
  currentTile(): Tile {
    const p = this.motion.path[this.sample.index] ?? this.motion.path[0];
    return p ? { x: p.x, y: p.y } : { x: Math.round(this.tileX), y: Math.round(this.tileY) };
  }

  dispose(): void {
    this.root.remove(this.handle.object);
    this.handle.dispose();
  }
}
