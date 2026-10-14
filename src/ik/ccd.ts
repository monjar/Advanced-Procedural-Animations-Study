import * as THREE from 'three';
import { signedAngleAbout, type Chain, type SolveOptions, type SolveResult } from './chain';

const _toE = new THREE.Vector3();
const _toT = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _delta = new THREE.Quaternion();

export interface CCDOptions extends SolveOptions {
  /** Max rotation per joint per visit (radians); damps the "curl at the tip" artefact. */
  maxAngle?: number;
}

/**
 * Cyclic Coordinate Descent: walk from the tip to the root, rotating each joint so the
 * joint→effector vector points at the target. Hinges rotate only about their axis.
 */
export function solveCCD(chain: Chain, target: THREE.Vector3, o: CCDOptions): SolveResult {
  const maxAngle = o.maxAngle ?? Math.PI;
  chain.forward();
  let error = chain.error(target);
  let it = 0;
  for (; it < o.iterations && error > o.tolerance; it++) {
    for (let i = chain.size - 1; i >= 0; i--) {
      const j = chain.joints[i];
      const p = chain.positions[i];
      _toE.subVectors(chain.effector, p);
      _toT.subVectors(target, p);
      if (j.type === 'hinge') {
        _axis.copy(j.axis).applyQuaternion(chain.parentRotation(i));
        const angle = signedAngleAbout(_toE, _toT, _axis);
        if (!Number.isFinite(angle)) continue;
        _delta.setFromAxisAngle(_axis, THREE.MathUtils.clamp(angle, -maxAngle, maxAngle));
      } else {
        if (_toE.lengthSq() < 1e-14 || _toT.lengthSq() < 1e-14) continue;
        _delta.setFromUnitVectors(_toE.normalize(), _toT.normalize());
        limitAngle(_delta, maxAngle);
      }
      chain.rotateWorld(i, _delta);
      chain.forward(i);
    }
    error = chain.error(target);
    o.errors?.push(error);
  }
  return { iterations: it, error };
}

const _v = new THREE.Vector3();
function limitAngle(q: THREE.Quaternion, max: number): void {
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const angle = 2 * Math.acos(Math.min(1, q.w));
  if (angle <= max) return;
  _v.set(q.x, q.y, q.z).normalize();
  q.setFromAxisAngle(_v, max);
}
