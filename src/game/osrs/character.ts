import { Group, Mesh, type Material } from "three";
import type { Appearance, EmoteId } from "@shared/protocol";

import { applyPose, copyPose, createPose, mixPose, type Pose } from "./animation";
import type { FrameBase } from "./format";
import { ModelGeometry, MODEL_UNITS_PER_TILE } from "./mesh";
import type { LitModel } from "./model";
import { EMOTE_SEQUENCES } from "./sequences";
import { Track, type SequenceClip } from "./track";
import type { CharacterHandle, Locomotion } from "./types";

/** Locomotion sequence ids; -1 falls back as the client does. */
export interface MovementSet {
  idle: number;
  walk: number;
  walkBack: number;
  walkLeft: number;
  walkRight: number;
  turn: number;
  run: number;
}

export interface CharacterOptions {
  lit: LitModel;
  scale: { x: number; y: number; z: number };
  movement: MovementSet;
  clips: ReadonlyMap<number, SequenceClip>;
  bases: readonly FrameBase[];
  materials: [Material, Material];
  /** Rebuilds the lit model for a new appearance; absent for NPCs. */
  relight?: (appearance: Appearance) => LitModel;
  /** Tween between frames and blend sequence changes (modern client smoothing). */
  smoothing: boolean;
  /** Cross-fade when the playing sequence changes, in ms (smoothing only). */
  blendMs: number;
}

/** Heading offset thresholds in client angle units (2048 per turn). */
const FORWARD_LIMIT = 256;
const SIDE_LIMIT = 768;

export class OsrsCharacter implements CharacterHandle {
  readonly object = new Group();
  height: number;

  private readonly mesh: Mesh;
  private geometry: ModelGeometry;
  private lit: LitModel;
  private bindX: Float32Array;
  private bindY: Float32Array;
  private bindZ: Float32Array;
  private workX: Float32Array;
  private workY: Float32Array;
  private workZ: Float32Array;

  private locomotion: Locomotion = "idle";
  /** Movement direction relative to facing, client units (positive = to the actor's right). */
  private headingUnits = 0;
  private movementTrack: Track | null = null;
  private actionTrack: Track | null = null;
  /** The track currently shown (action or movement), and its last written frame when unsmoothed. */
  private shownTrack: Track | null = null;
  private shownFrame = -1;
  private readonly pose: Pose;
  private readonly target: Pose;
  private readonly blendFrom: Pose;
  private blendElapsed = Number.POSITIVE_INFINITY;
  private dirty = true;
  private disposed = false;

  constructor(private readonly opts: CharacterOptions) {
    this.lit = opts.lit;
    this.geometry = new ModelGeometry(opts.lit, opts.scale.x, opts.scale.y, opts.scale.z);
    this.mesh = new Mesh(this.geometry.geometry, opts.materials);
    this.mesh.name = "osrs-actor";
    this.object.add(this.mesh);
    this.height = this.computeHeight();
    [this.bindX, this.bindY, this.bindZ] = bind(opts.lit);
    [this.workX, this.workY, this.workZ] = bind(opts.lit);
    const groups = opts.bases[0]?.types.length ?? 0;
    this.pose = createPose(0, groups);
    this.target = createPose(0, groups);
    this.blendFrom = createPose(0, groups);
    this.selectMovement();
    this.update(0);
  }

  setLocomotion(mode: Locomotion): void {
    if (mode === this.locomotion) return;
    this.locomotion = mode;
    // Player.method2139: a new step cancels a sequence whose priority is 1 (every emote).
    if (this.isMoving() && this.actionTrack?.clip.priority === 1) this.actionTrack = null;
    this.selectMovement();
  }

  /**
   * Signed angle (radians, three.js rotation.y sense) from the facing
   * direction to the movement direction. Selects walk back/left/right like
   * the client when an actor moves while facing elsewhere.
   */
  setHeadingOffset(radians: number): void {
    let units = Math.round((-radians * 2048) / (Math.PI * 2)) & 2047;
    if (units > 1024) units -= 2048;
    if (units === this.headingUnits) return;
    this.headingUnits = units;
    this.selectMovement();
  }

  playEmote(emote: EmoteId): void {
    this.playSequence(EMOTE_SEQUENCES[emote]);
  }

  playSequence(seqId: number): void {
    const clip = this.opts.clips.get(seqId);
    if (!clip) return;
    // While moving, a priority-1 sequence is held and then cancelled by the next step: it never shows.
    if (this.isMoving() && clip.priority === 1) return;
    this.actionTrack = new Track(clip, false);
    this.dirty = true;
  }

  update(dt: number): void {
    if (this.disposed) return;
    const ms = Math.max(0, dt * 1000);
    this.movementTrack?.advance(ms);
    // precedenceAnimating 1: while moving the sequence is held (sequenceDelay) and movement shows.
    const held = this.actionTrack !== null && this.isMoving() && this.actionTrack.clip.precedenceAnimating === 1;
    if (this.actionTrack && !held) {
      this.actionTrack.advance(ms);
      if (this.actionTrack.finished) this.actionTrack = null;
    }
    const track = (held ? null : this.actionTrack) ?? this.movementTrack;
    if (!track) return;
    const base = this.opts.bases[0];
    if (!base) return;

    if (track !== this.shownTrack) {
      if (this.opts.smoothing && this.opts.blendMs > 0 && this.shownTrack) {
        copyPose(this.blendFrom, this.pose);
        this.blendElapsed = 0;
      }
      this.shownTrack = track;
      this.dirty = true;
    } else {
      this.blendElapsed += ms;
    }

    if (!this.opts.smoothing) {
      if (!this.dirty && track.frame === this.shownFrame) return;
      this.shownFrame = track.frame;
    }
    track.sample(this.target, this.opts.smoothing, base.types);
    if (this.blendElapsed < this.opts.blendMs) {
      const t = this.blendElapsed / this.opts.blendMs;
      mixPose(this.pose, this.blendFrom, this.target, t * t * (3 - 2 * t), base.types);
    } else {
      copyPose(this.pose, this.target);
    }

    this.workX.set(this.bindX);
    this.workY.set(this.bindY);
    this.workZ.set(this.bindZ);
    applyPose(
      this.pose,
      this.opts.bases[this.pose.base] ?? base,
      this.lit.vertexLabels,
      this.workX,
      this.workY,
      this.workZ,
      !this.opts.smoothing,
    );
    this.geometry.write(this.workX, this.workY, this.workZ);
    this.dirty = false;
  }

  setAppearance(appearance: Appearance): void {
    if (!this.opts.relight || this.disposed) return;
    const lit = this.opts.relight(appearance);
    const old = this.geometry;
    this.lit = lit;
    this.geometry = new ModelGeometry(lit, this.opts.scale.x, this.opts.scale.y, this.opts.scale.z);
    this.mesh.geometry = this.geometry.geometry;
    old.dispose();
    [this.bindX, this.bindY, this.bindZ] = bind(lit);
    [this.workX, this.workY, this.workZ] = bind(lit);
    this.height = this.computeHeight();
    this.dirty = true;
    this.update(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.geometry.dispose();
  }

  private isMoving(): boolean {
    return this.locomotion === "walk" || this.locomotion === "run";
  }

  private computeHeight(): number {
    return (this.lit.height / MODEL_UNITS_PER_TILE) * this.opts.scale.y;
  }

  private selectMovement(): void {
    const m = this.opts.movement;
    let seq = m.idle;
    if (this.locomotion === "turn") {
      seq = m.turn >= 0 ? m.turn : m.idle;
    } else if (this.locomotion === "walk" || this.locomotion === "run") {
      const u = this.headingUnits;
      let walk = m.walkBack;
      if (u >= -FORWARD_LIMIT && u <= FORWARD_LIMIT) walk = m.walk;
      else if (u >= FORWARD_LIMIT && u < SIDE_LIMIT) walk = m.walkRight;
      else if (u >= -SIDE_LIMIT && u <= -FORWARD_LIMIT) walk = m.walkLeft;
      if (walk < 0) walk = m.walk;
      seq = walk;
      if (this.locomotion === "run" && walk === m.walk && m.run >= 0) seq = m.run;
    }
    if (seq < 0) seq = m.idle;
    if (this.movementTrack?.clip.id === seq) return;
    const clip = this.opts.clips.get(seq) ?? this.opts.clips.get(m.idle);
    this.movementTrack = clip ? new Track(clip, true) : null;
    this.dirty = true;
  }
}

function bind(lit: LitModel): [Float32Array, Float32Array, Float32Array] {
  return [Float32Array.from(lit.x), Float32Array.from(lit.y), Float32Array.from(lit.z)];
}
