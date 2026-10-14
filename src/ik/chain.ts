import * as THREE from 'three';
import { clampRotationAngle, clampTwist, swingTwist } from '../math/quat';

export interface JointSpec {
  /** Bone from this joint to the next, in this joint's local frame (rest pose). */
  bone: THREE.Vector3;
  type?: 'ball' | 'hinge';
  /** Hinge axis in the joint's local frame. */
  axis?: THREE.Vector3;
  /** Ball: maximum swing of the bone away from its rest direction (radians). */
  cone?: number;
  /** Ball: maximum twist about the bone axis (radians). */
  twist?: number;
  /** Hinge: angle range (radians). */
  min?: number;
  max?: number;
}

export interface Joint {
  bone: THREE.Vector3;
  /** Unit bone direction in the local frame. */
  boneDir: THREE.Vector3;
  length: number;
  type: 'ball' | 'hinge';
  axis: THREE.Vector3;
  cone: number;
  twist: number;
  min: number;
  max: number;
}

export interface SolveOptions {
  iterations: number;
  tolerance: number;
  /** If provided, the effector error after every iteration is appended. */
  errors?: number[];
}

export interface SolveResult {
  iterations: number;
  error: number;
}

const _swing = new THREE.Quaternion();
const _twist = new THREE.Quaternion();

/**
 * Serial kinematic chain stored as local joint rotations (rest pose = identity).
 *
 *   R_i = R_{i-1} · q_i            (R_{-1} = base rotation)
 *   P_{i+1} = P_i + R_i · bone_i    (P_0 = base position)
 *
 * `positions` has N+1 entries; the last is the end effector.
 */
export class Chain {
  readonly joints: Joint[];
  readonly rotations: THREE.Quaternion[];
  readonly world: THREE.Quaternion[];
  readonly positions: THREE.Vector3[];
  readonly basePosition = new THREE.Vector3();
  readonly baseRotation = new THREE.Quaternion();
  readonly totalLength: number;

  constructor(specs: JointSpec[]) {
    this.joints = specs.map((s) => ({
      bone: s.bone.clone(),
      boneDir: s.bone.clone().normalize(),
      length: s.bone.length(),
      type: s.type ?? 'ball',
      axis: (s.axis ?? new THREE.Vector3(1, 0, 0)).clone().normalize(),
      cone: s.cone ?? Math.PI,
      twist: s.twist ?? Math.PI,
      min: s.min ?? -Math.PI,
      max: s.max ?? Math.PI,
    }));
    this.rotations = specs.map(() => new THREE.Quaternion());
    this.world = specs.map(() => new THREE.Quaternion());
    this.positions = Array.from({ length: specs.length + 1 }, () => new THREE.Vector3());
    this.totalLength = this.joints.reduce((s, j) => s + j.length, 0);
    this.forward();
  }

  get size(): number {
    return this.joints.length;
  }

  get effector(): THREE.Vector3 {
    return this.positions[this.joints.length];
  }

  /** World rotation of joint i's parent frame. */
  parentRotation(i: number): THREE.Quaternion {
    return i === 0 ? this.baseRotation : this.world[i - 1];
  }

  /** Forward kinematics from joint `from` (joints before it must be up to date). */
  forward(from = 0): void {
    if (from === 0) this.positions[0].copy(this.basePosition);
    for (let i = from; i < this.joints.length; i++) {
      this.world[i].multiplyQuaternions(this.parentRotation(i), this.rotations[i]);
      this.positions[i + 1].copy(this.joints[i].bone).applyQuaternion(this.world[i]).add(this.positions[i]);
    }
  }

  /** Project joint i's local rotation onto its limits. */
  constrain(i: number): void {
    const j = this.joints[i];
    const q = this.rotations[i];
    if (j.type === 'hinge') {
      swingTwist(q, j.axis, _swing, _twist);
      q.copy(clampTwistRange(_twist, j.axis, j.min, j.max));
    } else {
      swingTwist(q, j.boneDir, _swing, _twist);
      clampRotationAngle(_swing, j.cone);
      clampTwist(_twist, j.boneDir, j.twist);
      q.multiplyQuaternions(_swing, _twist);
    }
  }

  /**
   * Apply a world-space rotation `delta` to joint i (rotating its whole subtree), then constrain.
   * Uses the joint's current world rotation; call `forward(i)` afterwards.
   */
  rotateWorld(i: number, delta: THREE.Quaternion): void {
    const parentInv = _inv.copy(this.parentRotation(i)).invert();
    this.rotations[i].copy(parentInv).multiply(delta).multiply(this.world[i]);
    this.rotations[i].normalize();
    this.constrain(i);
  }

  copyPose(other: Chain): void {
    this.basePosition.copy(other.basePosition);
    this.baseRotation.copy(other.baseRotation);
    for (let i = 0; i < this.rotations.length; i++) this.rotations[i].copy(other.rotations[i]);
    this.forward();
  }

  resetPose(): void {
    for (const q of this.rotations) q.identity();
    this.forward();
  }

  error(target: THREE.Vector3): number {
    return this.effector.distanceTo(target);
  }
}

const _inv = new THREE.Quaternion();

function clampTwistRange(twist: THREE.Quaternion, axis: THREE.Vector3, min: number, max: number): THREE.Quaternion {
  const s = twist.x * axis.x + twist.y * axis.y + twist.z * axis.z;
  let angle = 2 * Math.atan2(s, twist.w);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle < -Math.PI) angle += 2 * Math.PI;
  return twist.setFromAxisAngle(axis, THREE.MathUtils.clamp(angle, min, max));
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Signed angle from `from` to `to` about unit `axis`, after projecting both onto the plane ⟂ axis. NaN if degenerate. */
export function signedAngleAbout(from: THREE.Vector3, to: THREE.Vector3, axis: THREE.Vector3): number {
  _a.copy(from).addScaledVector(axis, -from.dot(axis));
  _b.copy(to).addScaledVector(axis, -to.dot(axis));
  if (_a.lengthSq() < 1e-14 || _b.lengthSq() < 1e-14) return NaN;
  _c.crossVectors(_a, _b);
  return Math.atan2(_c.dot(axis), _a.dot(_b));
}
