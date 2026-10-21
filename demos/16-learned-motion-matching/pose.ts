import type { MotionFeatures } from '../../src/anim/mmfeatures';

/**
 * The pose vector Y the decompressor produces, one per frame — everything study 09's runtime reads from the
 * database to play a frame:
 *
 *   hip position relative to the simulation bone        3
 *   joint rotations in 6-D form (two matrix columns)    6 · joints (joint 0: hips relative to the bone)
 *   root motion: velocity x, z in the bone frame; yaw rate   3
 *   foot contacts (left, right)                         2
 *
 * Rotations use the 6-D representation (Zhou et al. 2019), continuous unlike quaternions or Euler angles,
 * so a network can regress it; decoding orthonormalises it back to a rotation.
 */

export const JOINTS = 25;
export const Y_HIP = 0;
export const Y_ROT = 3;
export const Y_ROOT = Y_ROT + 6 * JOINTS;
export const Y_CONTACT = Y_ROOT + 3;
export const Y_DIMS = Y_CONTACT + 2;

/** Write quaternion (x, y, z, w) at q[qi] as the first two columns of its rotation matrix. */
export function quatTo6d(q: ArrayLike<number>, qi: number, out: Float32Array | Float64Array, oi: number): void {
  const x = q[qi];
  const y = q[qi + 1];
  const z = q[qi + 2];
  const w = q[qi + 3];
  out[oi] = 1 - 2 * (y * y + z * z);
  out[oi + 1] = 2 * (x * y + w * z);
  out[oi + 2] = 2 * (x * z - w * y);
  out[oi + 3] = 2 * (x * y - w * z);
  out[oi + 4] = 1 - 2 * (x * x + z * z);
  out[oi + 5] = 2 * (y * z + w * x);
}

/** Orthonormalise two (noisy) matrix columns and write the rotation as a quaternion (x, y, z, w). */
export function sixdToQuat(v: ArrayLike<number>, vi: number, out: Float32Array | Float64Array, oi: number): void {
  let ax = v[vi];
  let ay = v[vi + 1];
  let az = v[vi + 2];
  let l = Math.hypot(ax, ay, az) || 1;
  ax /= l;
  ay /= l;
  az /= l;
  const d = ax * v[vi + 3] + ay * v[vi + 4] + az * v[vi + 5];
  let bx = v[vi + 3] - d * ax;
  let by = v[vi + 4] - d * ay;
  let bz = v[vi + 5] - d * az;
  l = Math.hypot(bx, by, bz) || 1;
  bx /= l;
  by /= l;
  bz /= l;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  // Matrix columns a, b, c → quaternion (Shepperd's method, branching on the largest diagonal term).
  const m00 = ax;
  const m11 = by;
  const m22 = cz;
  const tr = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (bz - cy) / s;
    y = (cx - az) / s;
    z = (ay - bx) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (bz - cy) / s;
    x = 0.25 * s;
    y = (bx + ay) / s;
    z = (cx + az) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (cx - az) / s;
    x = (bx + ay) / s;
    y = 0.25 * s;
    z = (cy + bz) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (ay - bx) / s;
    x = (cx + az) / s;
    y = (cy + bz) / s;
    z = 0.25 * s;
  }
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  out[oi] = x;
  out[oi + 1] = y;
  out[oi + 2] = z;
  out[oi + 3] = w;
}

/** Y for database frame `f`. */
export function encodePose(mf: MotionFeatures, f: number, out: Float32Array, o: number): void {
  const J = mf.db.joints.length;
  out[o + Y_HIP] = mf.hipPos[f * 3];
  out[o + Y_HIP + 1] = mf.hipPos[f * 3 + 1];
  out[o + Y_HIP + 2] = mf.hipPos[f * 3 + 2];
  quatTo6d(mf.hipRot, f * 4, out, o + Y_ROT);
  for (let j = 1; j < J; j++) quatTo6d(mf.db.rot, (f * J + j) * 4, out, o + Y_ROT + 6 * j);
  out[o + Y_ROOT] = mf.rootVel[f * 2];
  out[o + Y_ROOT + 1] = mf.rootVel[f * 2 + 1];
  out[o + Y_ROOT + 2] = mf.rootYawRate[f];
  out[o + Y_CONTACT] = mf.db.contacts[f * 2];
  out[o + Y_CONTACT + 1] = mf.db.contacts[f * 2 + 1];
}
