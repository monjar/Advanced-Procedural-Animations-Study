/**
 * Allocation-free quaternion helpers and forward kinematics on typed arrays (xyzw quaternions), for
 * processing whole motion databases quickly.
 */

/** out = a ⊗ b (apply b, then a). `out` may alias either input. */
export function qmul(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, out: Float32Array | Float64Array | number[], oi: number): void {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  out[oi] = aw * bx + ax * bw + ay * bz - az * by;
  out[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** out = q · v (rotate a vector). `out` may alias `v`. */
export function qrot(q: ArrayLike<number>, qi: number, v: ArrayLike<number>, vi: number, out: Float32Array | Float64Array | number[], oi: number): void {
  const x = q[qi], y = q[qi + 1], z = q[qi + 2], w = q[qi + 3];
  const vx = v[vi], vy = v[vi + 1], vz = v[vi + 2];
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[oi] = vx + w * tx + (y * tz - z * ty);
  out[oi + 1] = vy + w * ty + (z * tx - x * tz);
  out[oi + 2] = vz + w * tz + (x * ty - y * tx);
}

export interface SkeletonDef {
  parents: Int32Array;
  /** Bone offsets from the parent joint, in the parent's frame [joints·3]. */
  offsets: Float32Array;
}

export function skeletonDef(joints: readonly { parent: number; offset: readonly number[] }[]): SkeletonDef {
  return {
    parents: Int32Array.from(joints, (j) => j.parent),
    offsets: Float32Array.from(joints.flatMap((j) => [...j.offset])),
  };
}

/**
 * World positions and rotations of every joint for one pose. Joints must be ordered parents-first.
 * `rot` holds local rotations at `rotIndex` (joint 0 = root world rotation); the root is at `root[rootIndex]`.
 */
export function forwardKinematics(
  skel: SkeletonDef,
  root: ArrayLike<number>,
  rootIndex: number,
  rot: ArrayLike<number>,
  rotIndex: number,
  outPos: Float32Array | Float64Array,
  outRot: Float32Array | Float64Array,
): void {
  const J = skel.parents.length;
  outPos[0] = root[rootIndex];
  outPos[1] = root[rootIndex + 1];
  outPos[2] = root[rootIndex + 2];
  for (let k = 0; k < 4; k++) outRot[k] = rot[rotIndex + k];
  for (let j = 1; j < J; j++) {
    const p = skel.parents[j];
    qmul(outRot, p * 4, rot, rotIndex + j * 4, outRot, j * 4);
    qrot(outRot, p * 4, skel.offsets, j * 3, outPos, j * 3);
    outPos[j * 3] += outPos[p * 3];
    outPos[j * 3 + 1] += outPos[p * 3 + 1];
    outPos[j * 3 + 2] += outPos[p * 3 + 2];
  }
}
