import * as THREE from 'three';

export interface TwoBoneOptions {
  /**
   * Soft IK: distance before full extension over which the effector starts lagging behind the
   * target, removing the visible "snap" as the limb locks straight. 0 disables.
   */
  softness?: number;
  /** 0..1 blend toward stretching the bones so the effector still reaches the target. */
  stretch?: number;
}

export interface TwoBoneResult {
  /** Middle joint (elbow / knee). */
  mid: THREE.Vector3;
  /** Effector (wrist / ankle). */
  end: THREE.Vector3;
  /** Unit normal of the bend plane, pointing from the root-target line toward the pole side. */
  bendDir: THREE.Vector3;
  /** Bone lengths actually used (differ from the inputs only when stretching). */
  lengthA: number;
  lengthB: number;
  /** Effector-to-target distance after the solve. */
  error: number;
}

const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();

export function createTwoBoneResult(): TwoBoneResult {
  return {
    mid: new THREE.Vector3(),
    end: new THREE.Vector3(),
    bendDir: new THREE.Vector3(),
    lengthA: 0,
    lengthB: 0,
    error: 0,
  };
}

/** Soft-IK remapping of the root→target distance (A. Nicholas, "Soft IK", 2009). */
export function softDistance(distance: number, chain: number, softness: number): number {
  if (softness <= 0) return distance;
  const start = chain - softness;
  if (distance <= start) return distance;
  return start + softness * (1 - Math.exp(-(distance - start) / softness));
}

/**
 * Analytic two-bone IK. Positions only: the middle joint is placed with the law of cosines in the
 * plane spanned by the root→target line and the pole vector.
 */
export function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  lengthA: number,
  lengthB: number,
  options: TwoBoneOptions = {},
  out: TwoBoneResult = createTwoBoneResult(),
): TwoBoneResult {
  const softness = Math.min(options.softness ?? 0, (lengthA + lengthB) * 0.5);
  const stretch = THREE.MathUtils.clamp(options.stretch ?? 0, 0, 1);

  _dir.subVectors(target, root);
  const distance = _dir.length();
  if (distance > 1e-9) _dir.divideScalar(distance);
  else _dir.subVectors(pole, root).normalize();
  if (_dir.lengthSq() < 0.5) _dir.set(0, -1, 0);

  // Bend plane normal: pole direction with the component along the root→target line removed.
  _pole.subVectors(pole, root);
  _pole.addScaledVector(_dir, -_pole.dot(_dir));
  if (_pole.lengthSq() < 1e-12) anyPerpendicular(_dir, _pole);
  out.bendDir.copy(_pole.normalize());

  let a = lengthA;
  let b = lengthB;
  let d = softDistance(distance, a + b, softness);
  if (stretch > 0 && distance > d) {
    const s = 1 + (distance / d - 1) * stretch;
    a *= s;
    b *= s;
    d *= s;
  }
  d = THREE.MathUtils.clamp(d, Math.abs(a - b), a + b);

  const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * Math.max(d, 1e-12)), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);

  out.mid.copy(root).addScaledVector(_dir, a * cosA).addScaledVector(out.bendDir, a * sinA);
  out.end.copy(root).addScaledVector(_dir, d);
  out.lengthA = a;
  out.lengthB = b;
  out.error = out.end.distanceTo(target);
  return out;
}

/** Unit vector perpendicular to unit vector `v`. */
export function anyPerpendicular(v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (Math.abs(v.y) < 0.9) out.set(0, 1, 0);
  else out.set(1, 0, 0);
  return out.addScaledVector(v, -out.dot(v)).normalize();
}

const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Orientation for a bone mesh whose local +Y runs along the bone and local +Z faces `hint`
 * (projected perpendicular to the bone). Gives a stable twist for rendering.
 */
export function boneRotation(
  from: THREE.Vector3,
  to: THREE.Vector3,
  hint: THREE.Vector3,
  out = new THREE.Quaternion(),
): THREE.Quaternion {
  const y = _dir.subVectors(to, from).normalize();
  _z.copy(hint).addScaledVector(y, -hint.dot(y));
  if (_z.lengthSq() < 1e-12) anyPerpendicular(y, _z);
  _z.normalize();
  _x.crossVectors(y, _z);
  _m.makeBasis(_x, y, _z);
  return out.setFromRotationMatrix(_m);
}
