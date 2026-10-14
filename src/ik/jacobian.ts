import * as THREE from 'three';
import type { Chain, SolveOptions, SolveResult } from './chain';

export type JacobianMethod = 'transpose' | 'pinv' | 'dls';

export interface JacobianOptions extends SolveOptions {
  method: JacobianMethod;
  /** Damping λ for damped least squares. */
  lambda?: number;
  /** Max rotation per joint per iteration (radians). */
  maxStep?: number;
  /** Clamp the per-iteration error vector to this length (fraction of chain length). */
  maxErrorStep?: number;
}

const WORLD_AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

interface Column {
  joint: number;
  axis: THREE.Vector3;
  col: THREE.Vector3;
}

const _cols: Column[] = [];
const _e = new THREE.Vector3();
const _r = new THREE.Vector3();
const _y = new THREE.Vector3();
const _v = new THREE.Vector3();
const _A = new THREE.Matrix3();
const _rot: THREE.Vector3[] = [];
const _old: THREE.Quaternion[] = [];
const _parentOld: THREE.Quaternion[] = [];
const _delta = new THREE.Quaternion();

/**
 * Jacobian IK for a single positional end effector (S. Buss, 2004).
 *
 * Each ball joint contributes three columns (world x/y/z axes), each hinge one column (its axis):
 *   J_k = a_k × (effector − P_joint)
 *
 *   transpose: Δθ = α·Jᵀe            with α = (e·JJᵀe)/|JJᵀe|²
 *   pinv:      Δθ = Jᵀ(JJᵀ)⁻¹e
 *   dls:       Δθ = Jᵀ(JJᵀ + λ²I)⁻¹e
 *
 * With one 3D effector JJᵀ is 3×3, so the pseudo-inverse costs one 3×3 inversion regardless of DOF count.
 */
export function solveJacobian(chain: Chain, target: THREE.Vector3, o: JacobianOptions): SolveResult {
  const n = chain.size;
  const lambda = o.lambda ?? 0.1;
  const maxStep = o.maxStep ?? 0.3;
  const maxErr = (o.maxErrorStep ?? 0.1) * chain.totalLength;
  while (_rot.length < n) {
    _rot.push(new THREE.Vector3());
    _old.push(new THREE.Quaternion());
    _parentOld.push(new THREE.Quaternion());
  }

  chain.forward();
  let error = chain.error(target);
  let it = 0;
  for (; it < o.iterations && error > o.tolerance; it++) {
    _e.subVectors(target, chain.effector);
    if (_e.length() > maxErr) _e.setLength(maxErr);

    // Build columns.
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = chain.joints[i];
      _r.subVectors(chain.effector, chain.positions[i]);
      const axes = j.type === 'hinge' ? [_v.copy(j.axis).applyQuaternion(chain.parentRotation(i))] : WORLD_AXES;
      for (const a of axes) {
        const c = (_cols[m] ??= { joint: 0, axis: new THREE.Vector3(), col: new THREE.Vector3() });
        c.joint = i;
        c.axis.copy(a);
        c.col.crossVectors(a, _r);
        m++;
      }
    }

    // A = J Jᵀ (3×3, symmetric).
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
    for (let k = 0; k < m; k++) {
      const c = _cols[k].col;
      a00 += c.x * c.x; a01 += c.x * c.y; a02 += c.x * c.z;
      a11 += c.y * c.y; a12 += c.y * c.z; a22 += c.z * c.z;
    }

    let alpha = 1;
    if (o.method === 'transpose') {
      // y = e; step size from Buss' optimal α.
      _y.copy(_e);
      _v.set(a00 * _e.x + a01 * _e.y + a02 * _e.z, a01 * _e.x + a11 * _e.y + a12 * _e.z, a02 * _e.x + a12 * _e.y + a22 * _e.z);
      const vv = _v.lengthSq();
      alpha = vv > 1e-14 ? _e.dot(_v) / vv : 0;
    } else {
      const d = o.method === 'dls' ? lambda * lambda : 1e-9;
      _A.set(a00 + d, a01, a02, a01, a11 + d, a12, a02, a12, a22 + d);
      if (Math.abs(_A.determinant()) < 1e-18) break;
      _y.copy(_e).applyMatrix3(_A.invert());
    }

    // Δθ_k = α · J_kᵀ y, accumulated into a world rotation vector per joint.
    for (let i = 0; i < n; i++) _rot[i].set(0, 0, 0);
    for (let k = 0; k < m; k++) {
      const c = _cols[k];
      _rot[c.joint].addScaledVector(c.axis, alpha * c.col.dot(_y));
    }

    // Apply all joint updates against the configuration the Jacobian was built from.
    for (let i = 0; i < n; i++) {
      _old[i].copy(chain.world[i]);
      _parentOld[i].copy(chain.parentRotation(i));
    }
    for (let i = 0; i < n; i++) {
      const angle = _rot[i].length();
      if (angle < 1e-12) continue;
      _delta.setFromAxisAngle(_rot[i].divideScalar(angle), Math.min(angle, maxStep));
      // q_i ← P_oldᵀ · Δ · R_old
      chain.rotations[i].copy(_parentOld[i]).invert().multiply(_delta).multiply(_old[i]).normalize();
      chain.constrain(i);
    }
    chain.forward();
    error = chain.error(target);
    o.errors?.push(error);
  }
  return { iterations: it, error };
}
