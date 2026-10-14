import { halflifeToDamping } from '../math/spring';
import { qmul } from './fk';

/**
 * Inertialization (Bollo, GDC 2018; in the offset form of Holden, "Dead Blending" / Motion Matching code).
 * On a transition the difference between what is on screen and the new source is stored as an offset per
 * joint — a rotation and an angular velocity — and that offset decays to zero with a critically damped
 * spring while the new source plays. There is no cross-fade: only one source is ever evaluated, and the
 * output is continuous in position and velocity at the switch.
 */

const _q = new Float64Array(4);
const _r = new Float64Array(4);

/** Rotation vector (axis · angle) of a unit quaternion, shortest way. */
export function quatToRotVec(q: ArrayLike<number>, qi: number, out: Float32Array | Float64Array, oi: number): void {
  let x = q[qi], y = q[qi + 1], z = q[qi + 2], w = q[qi + 3];
  if (w < 0) (x = -x), (y = -y), (z = -z), (w = -w);
  const s = Math.hypot(x, y, z);
  const k = s < 1e-9 ? 2 : (2 * Math.atan2(s, w)) / s;
  out[oi] = x * k;
  out[oi + 1] = y * k;
  out[oi + 2] = z * k;
}

/** Unit quaternion from a rotation vector. */
export function rotVecToQuat(r: ArrayLike<number>, ri: number, out: Float32Array | Float64Array, oi: number): void {
  const x = r[ri], y = r[ri + 1], z = r[ri + 2];
  const angle = Math.hypot(x, y, z);
  const s = angle < 1e-9 ? 0.5 : Math.sin(angle / 2) / angle;
  out[oi] = x * s;
  out[oi + 1] = y * s;
  out[oi + 2] = z * s;
  out[oi + 3] = Math.cos(angle / 2);
}

/** A pose as inertialization sees it: hips position (relative to the character root) + joint rotations. */
export interface PoseBuffers {
  hipPos: Float32Array; // 3
  hipVel: Float32Array; // 3
  rot: Float32Array; // joints·4 (joint 0: hips relative to the root)
  angVel: Float32Array; // joints·3 (rad/s, in the parent frame)
}

export function createPose(joints: number): PoseBuffers {
  return { hipPos: new Float32Array(3), hipVel: new Float32Array(3), rot: new Float32Array(joints * 4), angVel: new Float32Array(joints * 3) };
}

export class Inertializer {
  halflife: number;
  readonly joints: number;
  /** Offsets: rotation vectors and angular velocities per joint, hips position and velocity. */
  readonly rotOff: Float32Array;
  readonly angOff: Float32Array;
  readonly posOff = new Float32Array(3);
  readonly velOff = new Float32Array(3);

  constructor(joints: number, halflife = 0.1) {
    this.joints = joints;
    this.halflife = halflife;
    this.rotOff = new Float32Array(joints * 3);
    this.angOff = new Float32Array(joints * 3);
  }

  reset(): void {
    this.rotOff.fill(0);
    this.angOff.fill(0);
    this.posOff.fill(0);
    this.velOff.fill(0);
  }

  /**
   * Switch source. `src` is the pose currently being played (before offsets), `dst` the new one; afterwards
   * offset ⊗ dst equals the old offset ⊗ src, so the output does not jump.
   */
  transition(src: PoseBuffers, dst: PoseBuffers): void {
    for (let j = 0; j < this.joints; j++) {
      // off = exp(off) ⊗ src ⊗ dst⁻¹
      rotVecToQuat(this.rotOff, j * 3, _q, 0);
      qmul(_q, 0, src.rot, j * 4, _q, 0);
      _r[0] = -dst.rot[j * 4];
      _r[1] = -dst.rot[j * 4 + 1];
      _r[2] = -dst.rot[j * 4 + 2];
      _r[3] = dst.rot[j * 4 + 3];
      qmul(_q, 0, _r, 0, _q, 0);
      quatToRotVec(_q, 0, this.rotOff, j * 3);
      for (let k = 0; k < 3; k++) this.angOff[j * 3 + k] += src.angVel[j * 3 + k] - dst.angVel[j * 3 + k];
    }
    for (let k = 0; k < 3; k++) {
      this.posOff[k] += src.hipPos[k] - dst.hipPos[k];
      this.velOff[k] += src.hipVel[k] - dst.hipVel[k];
    }
  }

  /** Decay the offsets by `dt` and write offset ⊗ `src` into `out` (rotations and hips position). */
  update(src: PoseBuffers, dt: number, out: PoseBuffers): void {
    const y = halflifeToDamping(this.halflife) / 2;
    const eydt = Math.exp(-y * dt);
    const decay = (x: Float32Array, v: Float32Array, i: number) => {
      const j1 = v[i] + x[i] * y;
      x[i] = eydt * (x[i] + j1 * dt);
      v[i] = eydt * (v[i] - j1 * y * dt);
    };
    for (let i = 0; i < this.joints * 3; i++) decay(this.rotOff, this.angOff, i);
    for (let i = 0; i < 3; i++) decay(this.posOff, this.velOff, i);
    for (let j = 0; j < this.joints; j++) {
      rotVecToQuat(this.rotOff, j * 3, _q, 0);
      qmul(_q, 0, src.rot, j * 4, out.rot, j * 4);
      for (let k = 0; k < 3; k++) out.angVel[j * 3 + k] = src.angVel[j * 3 + k] + this.angOff[j * 3 + k];
    }
    for (let k = 0; k < 3; k++) {
      out.hipPos[k] = src.hipPos[k] + this.posOff[k];
      out.hipVel[k] = src.hipVel[k] + this.velOff[k];
    }
  }

  /** Largest remaining rotation offset (rad). */
  maxRotationOffset(): number {
    let m = 0;
    for (let j = 0; j < this.joints; j++) m = Math.max(m, Math.hypot(this.rotOff[j * 3], this.rotOff[j * 3 + 1], this.rotOff[j * 3 + 2]));
    return m;
  }
}
