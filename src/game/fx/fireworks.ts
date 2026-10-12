import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  PointsMaterial,
  type Object3D,
  type Vector3,
} from "three";

/**
 * Level-up style fireworks: three rockets climb from around the player and
 * burst into coloured sparks that fall and fade, about three seconds in all.
 * Each show uses fixed typed arrays; nothing allocates while it plays.
 */

const ROCKETS = 3;
const SPARKS = 44;
const PER_ROCKET = SPARKS + 1;
const COUNT = ROCKETS * PER_ROCKET;
const RISE_S = 0.55;
const SPARK_LIFE_S = 1.6;
const GRAVITY = -2.2;
export const FIREWORK_DURATION_S = 0.5 * (ROCKETS - 1) + RISE_S + SPARK_LIFE_S;

/** The level-up firework palette: gold, red, green, cyan, violet. */
const WHITE: readonly [number, number, number] = [1, 1, 0.85];
const PALETTE: readonly [number, number, number][] = [
  [1, 0.85, 0.2],
  [1, 0.25, 0.15],
  [0.3, 1, 0.3],
  [0.3, 0.9, 1],
  [0.85, 0.4, 1],
];

class Show {
  readonly points: Points;
  private readonly geometry: BufferGeometry;
  private readonly positions = new Float32Array(COUNT * 3);
  private readonly colours = new Float32Array(COUNT * 3);
  private readonly base = new Float32Array(COUNT * 3);
  private readonly origin = new Float32Array(ROCKETS * 3);
  private readonly velocity = new Float32Array(COUNT * 3);
  private readonly launch = new Float32Array(ROCKETS);
  private elapsed = 0;
  anchor: Vector3 | null = null;
  active = false;

  constructor(material: PointsMaterial) {
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new BufferAttribute(this.colours, 3));
    this.points = new Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  start(anchor: Vector3, random: () => number): void {
    this.anchor = anchor;
    this.elapsed = 0;
    this.active = true;
    this.points.visible = true;
    for (let r = 0; r < ROCKETS; r++) {
      this.launch[r] = r * 0.5;
      const angle = random() * Math.PI * 2;
      const radius = 0.35 + random() * 0.35;
      this.origin[r * 3] = Math.cos(angle) * radius;
      this.origin[r * 3 + 1] = 1.5 + random() * 0.9;
      this.origin[r * 3 + 2] = Math.sin(angle) * radius;
      const colour = PALETTE[Math.floor(random() * PALETTE.length)]!;
      const second = PALETTE[Math.floor(random() * PALETTE.length)]!;
      for (let i = 0; i < PER_ROCKET; i++) {
        const p = r * PER_ROCKET + i;
        // The rocket head burns white-hot; sparks mix two palette colours.
        const c = i === 0 ? WHITE : (i & 1) === 0 ? colour : second;
        this.base[p * 3] = c[0];
        this.base[p * 3 + 1] = c[1];
        this.base[p * 3 + 2] = c[2];
        if (i === 0) continue;
        // Even spread over a sphere.
        const z = random() * 2 - 1;
        const a = random() * Math.PI * 2;
        const ring = Math.sqrt(1 - z * z);
        const speed = 1.3 + random() * 0.7;
        this.velocity[p * 3] = Math.cos(a) * ring * speed;
        this.velocity[p * 3 + 1] = z * speed + 0.4;
        this.velocity[p * 3 + 2] = Math.sin(a) * ring * speed;
      }
    }
  }

  /** Advances the show; returns false when it has finished. */
  update(dt: number): boolean {
    if (!this.active || !this.anchor) return false;
    this.elapsed += dt;
    const { anchor, positions, colours } = this;
    for (let r = 0; r < ROCKETS; r++) {
      const t = this.elapsed - this.launch[r]!;
      const ox = this.origin[r * 3]!;
      const oy = this.origin[r * 3 + 1]!;
      const oz = this.origin[r * 3 + 2]!;
      for (let i = 0; i < PER_ROCKET; i++) {
        const p = r * PER_ROCKET + i;
        let x = 0;
        let y = -1000;
        let z = 0;
        let fade = 0;
        if (t >= 0 && t < RISE_S && i === 0) {
          const k = t / RISE_S;
          x = ox * k;
          y = oy * (1 - (1 - k) * (1 - k));
          z = oz * k;
          fade = 1;
        } else if (t >= RISE_S && i > 0) {
          const s = t - RISE_S;
          if (s < SPARK_LIFE_S) {
            x = ox + this.velocity[p * 3]! * s;
            y = oy + this.velocity[p * 3 + 1]! * s + 0.5 * GRAVITY * s * s;
            z = oz + this.velocity[p * 3 + 2]! * s;
            const life = s / SPARK_LIFE_S;
            // Sparks twinkle as they fade, like the original's flickering pixels.
            fade = (1 - life) * (((p + Math.floor(s * 20)) & 3) === 0 ? 0.45 : 1);
          }
        }
        positions[p * 3] = anchor.x + x;
        positions[p * 3 + 1] = anchor.y + y;
        positions[p * 3 + 2] = anchor.z + z;
        colours[p * 3] = this.base[p * 3]! * fade;
        colours[p * 3 + 1] = this.base[p * 3 + 1]! * fade;
        colours[p * 3 + 2] = this.base[p * 3 + 2]! * fade;
      }
    }
    (this.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("color") as BufferAttribute).needsUpdate = true;
    if (this.elapsed >= FIREWORK_DURATION_S) {
      this.active = false;
      this.points.visible = false;
      this.anchor = null;
      return false;
    }
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

export class Fireworks {
  private readonly material = new PointsMaterial({
    size: 0.2,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  private readonly shows: Show[] = [];

  constructor(private readonly parent: Object3D) {}

  /** Starts a show that follows `anchor` (an actor's live position). */
  play(anchor: Vector3, random: () => number = Math.random): void {
    let show = this.shows.find((s) => !s.active);
    if (!show) {
      if (this.shows.length >= 8) return;
      show = new Show(this.material);
      this.shows.push(show);
      this.parent.add(show.points);
    }
    show.start(anchor, random);
  }

  /** Stops shows attached to `anchor` (the actor left). */
  stop(anchor: Vector3): void {
    for (const show of this.shows) {
      if (show.anchor === anchor) {
        show.active = false;
        show.points.visible = false;
        show.anchor = null;
      }
    }
  }

  /** Stops every show (reduced motion was turned on). */
  stopAll(): void {
    for (const show of this.shows) {
      show.active = false;
      show.points.visible = false;
      show.anchor = null;
    }
  }

  update(dt: number): void {
    for (const show of this.shows) if (show.active) show.update(dt);
  }

  dispose(): void {
    for (const show of this.shows) {
      this.parent.remove(show.points);
      show.dispose();
    }
    this.shows.length = 0;
    this.material.dispose();
  }
}
