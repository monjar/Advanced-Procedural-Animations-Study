import * as THREE from 'three';

const _v = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Swing-twist decomposition: q = swing * twist, where `twist` rotates about `axis` (unit) and
 * `swing` rotates about an axis perpendicular to it.
 */
export function swingTwist(
  q: THREE.Quaternion,
  axis: THREE.Vector3,
  swing = new THREE.Quaternion(),
  twist = new THREE.Quaternion(),
): { swing: THREE.Quaternion; twist: THREE.Quaternion } {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  twist.set(axis.x * d, axis.y * d, axis.z * d, q.w);
  const len = twist.length();
  if (len < 1e-9) {
    // 180° swing: twist is undefined, choose identity.
    twist.identity();
  } else {
    twist.x /= len;
    twist.y /= len;
    twist.z /= len;
    twist.w /= len;
  }
  swing.copy(q).multiply(_conj.copy(twist).invert());
  return { swing, twist };
}
const _conj = new THREE.Quaternion();

/** Signed rotation angle of a pure twist quaternion about `axis`, in (-π, π]. */
export function twistAngle(twist: THREE.Quaternion, axis: THREE.Vector3): number {
  const s = twist.x * axis.x + twist.y * axis.y + twist.z * axis.z;
  let angle = 2 * Math.atan2(s, twist.w);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle <= -Math.PI) angle += 2 * Math.PI;
  return angle;
}

/** Rotation angle of `q` in [0, π]. */
export function rotationAngle(q: THREE.Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

/** Limit the rotation angle of `q` to `maxAngle`, keeping its axis. Mutates and returns `q`. */
export function clampRotationAngle(q: THREE.Quaternion, maxAngle: number): THREE.Quaternion {
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const angle = rotationAngle(q);
  if (angle <= maxAngle) return q;
  _v.set(q.x, q.y, q.z).normalize();
  return q.setFromAxisAngle(_v, maxAngle);
}

/** Clamp a pure twist about `axis` to [-limit, limit]. Mutates and returns `twist`. */
export function clampTwist(twist: THREE.Quaternion, axis: THREE.Vector3, limit: number): THREE.Quaternion {
  const angle = THREE.MathUtils.clamp(twistAngle(twist, axis), -limit, limit);
  return twist.setFromAxisAngle(axis, angle);
}

/**
 * Restrict unit direction `dir` to the cone of half-angle `maxAngle` around unit `axis`.
 * Directions outside are rotated onto the cone surface toward `dir`.
 */
export function clampToCone(
  dir: THREE.Vector3,
  axis: THREE.Vector3,
  maxAngle: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const cos = THREE.MathUtils.clamp(dir.dot(axis), -1, 1);
  if (Math.acos(cos) <= maxAngle) return out.copy(dir);
  _v.copy(dir).addScaledVector(axis, -cos);
  if (_v.lengthSq() < 1e-12) {
    // Exactly opposite: any side is as good as another.
    _v.set(axis.y, -axis.x, 0);
    if (_v.lengthSq() < 1e-12) _v.set(0, axis.z, -axis.y);
  }
  _v.normalize();
  return out.copy(axis).multiplyScalar(Math.cos(maxAngle)).addScaledVector(_v, Math.sin(maxAngle));
}

/** Rotation whose local +Z points along `forward` and whose local +Y is as close to `up` as possible (no roll). */
export function lookRotation(
  forward: THREE.Vector3,
  up: THREE.Vector3,
  out = new THREE.Quaternion(),
): THREE.Quaternion {
  const z = _v.copy(forward).normalize();
  _x.crossVectors(up, z);
  if (_x.lengthSq() < 1e-12) _x.set(1, 0, 0).addScaledVector(z, -z.x);
  _x.normalize();
  _y.crossVectors(z, _x);
  _m.makeBasis(_x, _y, z);
  return out.setFromRotationMatrix(_m);
}
