/**
 * Frame animation: the client's Model.transform (origin, translate, rotate,
 * scale over labelled vertex groups) ported from rs-map-viewer and the
 * client, extended with frame tweening.
 *
 * Every frame is expanded to a dense pose over its frame base (one x/y/z per
 * transform group plus a presence flag), so two frames, or two sequences on
 * the same base, can be interpolated parameter by parameter: offsets and
 * scales lerp, rotations take the short way round. Applying a pose walks the
 * groups in base order exactly like the client: an origin group (present or
 * not) sets the pivot used by the following translate/rotate/scale groups,
 * measured lazily just before the first of them, which is where the
 * client's frame decoder inserts its implicit zero-offset origin transforms.
 *
 * Portions Copyright (c) 2022-2023, dennisdev (https://github.com/dennisdev/rs-map-viewer)
 * BSD 2-Clause License; see ./NOTICE.
 */
import type { FrameBase, FrameSource } from "./format";

export const TRANSFORM_ORIGIN = 0;
export const TRANSFORM_TRANSLATE = 1;
export const TRANSFORM_ROTATE = 2;
export const TRANSFORM_SCALE = 3;

/** One client cycle, the unit of SeqType frame lengths. */
export const CLIENT_CYCLE_MS = 20;

const ANGLE_TO_RADIANS = (Math.PI * 2) / 256;

/** Dense, interpolable transform parameters for one frame base. */
export interface Pose {
  /** Index of the frame base in the actor data. */
  base: number;
  present: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
}

export function createPose(base: number, groupCount: number): Pose {
  return {
    base,
    present: new Uint8Array(groupCount),
    x: new Float32Array(groupCount),
    y: new Float32Array(groupCount),
    z: new Float32Array(groupCount),
  };
}

function neutral(type: number): number {
  return type === TRANSFORM_SCALE ? 128 : 0;
}

/** Expands a sparse cache frame into a dense pose. */
export function densify(frame: FrameSource, base: FrameBase): Pose {
  const pose = createPose(frame.base, base.types.length);
  for (let g = 0; g < base.types.length; g++) {
    const n = neutral(base.types[g]!);
    pose.x[g] = n;
    pose.y[g] = n;
    pose.z[g] = n;
  }
  for (let i = 0; i < frame.groups.length; i++) {
    const g = frame.groups[i]!;
    pose.present[g] = 1;
    pose.x[g] = frame.x[i]!;
    pose.y[g] = frame.y[i]!;
    pose.z[g] = frame.z[i]!;
  }
  return pose;
}

export function copyPose(out: Pose, src: Pose): void {
  out.base = src.base;
  out.present.set(src.present);
  out.x.set(src.x);
  out.y.set(src.y);
  out.z.set(src.z);
}

/** Shortest signed difference between two rotation values (256 per turn). */
function angleDelta(from: number, to: number): number {
  const a = ((from % 256) + 256) % 256;
  const b = ((to % 256) + 256) % 256;
  let d = b - a;
  if (d > 128) d -= 256;
  else if (d < -128) d += 256;
  return d;
}

/**
 * out = a + (b - a) * t, per group. Poses on different bases cannot be
 * mixed; the nearer one is copied instead.
 */
export function mixPose(out: Pose, a: Pose, b: Pose, t: number, types: Uint8Array): void {
  if (a.base !== b.base) {
    copyPose(out, t < 0.5 ? a : b);
    return;
  }
  out.base = a.base;
  const n = types.length;
  for (let g = 0; g < n; g++) {
    const pa = a.present[g]!;
    const pb = b.present[g]!;
    out.present[g] = pa | pb;
    if (!(pa | pb)) continue;
    const type = types[g]!;
    const ax = a.x[g]!;
    const ay = a.y[g]!;
    const az = a.z[g]!;
    if (type === TRANSFORM_ROTATE) {
      out.x[g] = ax + angleDelta(ax, b.x[g]!) * t;
      out.y[g] = ay + angleDelta(ay, b.y[g]!) * t;
      out.z[g] = az + angleDelta(az, b.z[g]!) * t;
    } else {
      out.x[g] = ax + (b.x[g]! - ax) * t;
      out.y[g] = ay + (b.y[g]! - ay) * t;
      out.z[g] = az + (b.z[g]! - az) * t;
    }
  }
}

/**
 * Applies `pose` to vertex positions in place (model units, y down). `px`,
 * `py`, `pz` must already hold the bind pose.
 */
export function applyPose(
  pose: Pose,
  base: FrameBase,
  vertexLabels: readonly Int32Array[],
  px: Float32Array,
  py: Float32Array,
  pz: Float32Array,
  exact = false,
): void {
  if (exact) {
    applyPoseFixed(pose, base, vertexLabels, px, py, pz);
    return;
  }
  const types = base.types;
  const labelCount = vertexLabels.length;
  let originX = 0;
  let originY = 0;
  let originZ = 0;
  let pendingOrigin = -1;

  for (let g = 0; g < types.length; g++) {
    const type = types[g]!;
    if (type === TRANSFORM_ORIGIN) {
      pendingOrigin = g;
      continue;
    }
    if (!pose.present[g]) continue;
    if (type !== TRANSFORM_TRANSLATE && type !== TRANSFORM_ROTATE && type !== TRANSFORM_SCALE) continue;

    if (pendingOrigin >= 0) {
      // Pivot = centroid of the origin group's vertices plus its offset.
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let count = 0;
      for (const label of base.labels[pendingOrigin]!) {
        if (label >= labelCount) continue;
        const verts = vertexLabels[label]!;
        for (let i = 0; i < verts.length; i++) {
          const v = verts[i]!;
          sx += px[v]!;
          sy += py[v]!;
          sz += pz[v]!;
          count++;
        }
      }
      const ox = pose.present[pendingOrigin] ? pose.x[pendingOrigin]! : 0;
      const oy = pose.present[pendingOrigin] ? pose.y[pendingOrigin]! : 0;
      const oz = pose.present[pendingOrigin] ? pose.z[pendingOrigin]! : 0;
      if (count > 0) {
        originX = ox + sx / count;
        originY = oy + sy / count;
        originZ = oz + sz / count;
      } else {
        originX = ox;
        originY = oy;
        originZ = oz;
      }
      pendingOrigin = -1;
    }

    const tx = pose.x[g]!;
    const ty = pose.y[g]!;
    const tz = pose.z[g]!;
    const labels = base.labels[g]!;

    if (type === TRANSFORM_TRANSLATE) {
      if (tx === 0 && ty === 0 && tz === 0) continue;
      for (const label of labels) {
        if (label >= labelCount) continue;
        const verts = vertexLabels[label]!;
        for (let i = 0; i < verts.length; i++) {
          const v = verts[i]!;
          px[v]! += tx;
          py[v]! += ty;
          pz[v]! += tz;
        }
      }
    } else if (type === TRANSFORM_ROTATE) {
      const roll = tz * ANGLE_TO_RADIANS;
      const pitch = tx * ANGLE_TO_RADIANS;
      const yaw = ty * ANGLE_TO_RADIANS;
      if (roll === 0 && pitch === 0 && yaw === 0) continue;
      const sinR = Math.sin(roll);
      const cosR = Math.cos(roll);
      const sinP = Math.sin(pitch);
      const cosP = Math.cos(pitch);
      const sinY = Math.sin(yaw);
      const cosY = Math.cos(yaw);
      for (const label of labels) {
        if (label >= labelCount) continue;
        const verts = vertexLabels[label]!;
        for (let i = 0; i < verts.length; i++) {
          const v = verts[i]!;
          let x = px[v]! - originX;
          let y = py[v]! - originY;
          let z = pz[v]! - originZ;
          if (roll !== 0) {
            const t = sinR * y + cosR * x;
            y = cosR * y - sinR * x;
            x = t;
          }
          if (pitch !== 0) {
            const t = cosP * y - sinP * z;
            z = sinP * y + cosP * z;
            y = t;
          }
          if (yaw !== 0) {
            const t = sinY * z + cosY * x;
            z = cosY * z - sinY * x;
            x = t;
          }
          px[v] = x + originX;
          py[v] = y + originY;
          pz[v] = z + originZ;
        }
      }
    } else {
      if (tx === 128 && ty === 128 && tz === 128) continue;
      const kx = tx / 128;
      const ky = ty / 128;
      const kz = tz / 128;
      for (const label of labels) {
        if (label >= labelCount) continue;
        const verts = vertexLabels[label]!;
        for (let i = 0; i < verts.length; i++) {
          const v = verts[i]!;
          px[v] = (px[v]! - originX) * kx + originX;
          py[v] = (py[v]! - originY) * ky + originY;
          pz[v] = (pz[v]! - originZ) * kz + originZ;
        }
      }
    }
  }
}

/** Client sine/cosine tables: 2048 steps, 16.16 fixed point. */
const SINE = new Int32Array(2048);
const COSINE = new Int32Array(2048);
for (let i = 0; i < 2048; i++) {
  SINE[i] = (65536 * Math.sin((i * Math.PI * 2) / 2048)) | 0;
  COSINE[i] = (65536 * Math.cos((i * Math.PI * 2) / 2048)) | 0;
}

/**
 * Bit-exact client arithmetic (Model.transform): integer centroids, 16.16
 * rotation tables with arithmetic shifts, truncating scale. Only meaningful
 * for untweened poses, whose parameters are integers.
 */
function applyPoseFixed(
  pose: Pose,
  base: FrameBase,
  vertexLabels: readonly Int32Array[],
  px: Float32Array,
  py: Float32Array,
  pz: Float32Array,
): void {
  const types = base.types;
  const labelCount = vertexLabels.length;
  let originX = 0;
  let originY = 0;
  let originZ = 0;
  let pendingOrigin = -1;
  for (let g = 0; g < types.length; g++) {
    const type = types[g]!;
    if (type === TRANSFORM_ORIGIN) {
      pendingOrigin = g;
      continue;
    }
    if (!pose.present[g]) continue;
    if (type !== TRANSFORM_TRANSLATE && type !== TRANSFORM_ROTATE && type !== TRANSFORM_SCALE) continue;
    if (pendingOrigin >= 0) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let count = 0;
      for (const label of base.labels[pendingOrigin]!) {
        if (label >= labelCount) continue;
        for (const v of vertexLabels[label]!) {
          sx += px[v]!;
          sy += py[v]!;
          sz += pz[v]!;
          count++;
        }
      }
      const present = pose.present[pendingOrigin] === 1;
      const ox = present ? pose.x[pendingOrigin]! : 0;
      const oy = present ? pose.y[pendingOrigin]! : 0;
      const oz = present ? pose.z[pendingOrigin]! : 0;
      originX = count > 0 ? ox + ((sx / count) | 0) : ox;
      originY = count > 0 ? oy + ((sy / count) | 0) : oy;
      originZ = count > 0 ? oz + ((sz / count) | 0) : oz;
      pendingOrigin = -1;
    }
    const tx = pose.x[g]! | 0;
    const ty = pose.y[g]! | 0;
    const tz = pose.z[g]! | 0;
    for (const label of base.labels[g]!) {
      if (label >= labelCount) continue;
      for (const v of vertexLabels[label]!) {
        if (type === TRANSFORM_TRANSLATE) {
          px[v]! += tx;
          py[v]! += ty;
          pz[v]! += tz;
          continue;
        }
        let x = px[v]! - originX;
        let y = py[v]! - originY;
        let z = pz[v]! - originZ;
        if (type === TRANSFORM_ROTATE) {
          const pitch = (tx & 255) * 8;
          const yaw = (ty & 255) * 8;
          const roll = (tz & 255) * 8;
          if (roll !== 0) {
            const t = (SINE[roll]! * y + COSINE[roll]! * x) >> 16;
            y = (COSINE[roll]! * y - SINE[roll]! * x) >> 16;
            x = t;
          }
          if (pitch !== 0) {
            const t = (COSINE[pitch]! * y - SINE[pitch]! * z) >> 16;
            z = (SINE[pitch]! * y + COSINE[pitch]! * z) >> 16;
            y = t;
          }
          if (yaw !== 0) {
            const t = (SINE[yaw]! * z + COSINE[yaw]! * x) >> 16;
            z = (COSINE[yaw]! * z - SINE[yaw]! * x) >> 16;
            x = t;
          }
        } else {
          x = ((tx * x) / 128) | 0;
          y = ((ty * y) / 128) | 0;
          z = ((tz * z) / 128) | 0;
        }
        px[v] = x + originX;
        py[v] = y + originY;
        pz[v] = z + originZ;
      }
    }
  }
}
