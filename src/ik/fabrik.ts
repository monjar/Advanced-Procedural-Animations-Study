import * as THREE from 'three';
import { clampToCone } from '../math/quat';
import { signedAngleAbout, type Chain, type SolveOptions, type SolveResult } from './chain';

const _p: THREE.Vector3[] = [];
const _dir = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _delta = new THREE.Quaternion();
const _toE = new THREE.Vector3();
const _toT = new THREE.Vector3();
const _next = new THREE.Vector3();
const _bone = new THREE.Vector3();

/**
 * FABRIK (Aristidou & Lasenby 2011) on a rotational chain.
 *
 * Backward pass: positions from the target to the root. Where a ball joint sits between two collinear
 * rest bones, its cone limit is enforced here too, relative to the child bone (Aristidou's
 * "reorientation" step) — without it the backward pass keeps proposing shapes the forward pass cannot
 * realise and tightly limited chains stall far from the target.
 * Forward pass: re-solve each joint *as a rotation* that aims its bone at the backward-pass position,
 * then apply the joint limits, so FABRIK respects the same hinge/cone/twist constraints as CCD and
 * the Jacobian solver. Hinges whose bone is parallel to their axis (yaw/roll joints) cannot be aimed by
 * bone direction; they are solved CCD-style against the target instead.
 */
export function solveFABRIK(chain: Chain, target: THREE.Vector3, o: SolveOptions): SolveResult {
  const n = chain.size;
  while (_p.length < n + 1) _p.push(new THREE.Vector3());
  chain.forward();
  let error = chain.error(target);
  let it = 0;
  for (; it < o.iterations && error > o.tolerance; it++) {
    // Backward: tip to root.
    _p[n].copy(target);
    for (let i = n - 1; i >= 0; i--) {
      _dir.subVectors(chain.positions[i], _p[i + 1]);
      if (_dir.lengthSq() < 1e-14) _dir.subVectors(chain.positions[i], chain.positions[i + 1]);
      _dir.normalize();
      const child = chain.joints[i + 1];
      if (child && child.type === 'ball' && child.cone < Math.PI && child.boneDir.dot(chain.joints[i].boneDir) > 0.999) {
        // Bone i must lie within joint i+1's cone around bone i+1.
        _next.subVectors(_p[i + 2], _p[i + 1]).normalize();
        clampToCone(_bone.copy(_dir).negate(), _next, child.cone, _bone);
        _dir.copy(_bone).negate();
      }
      _p[i].copy(_p[i + 1]).addScaledVector(_dir, chain.joints[i].length);
    }

    // Forward: root to tip, as constrained rotations.
    for (let i = 0; i < n; i++) {
      const j = chain.joints[i];
      const parent = chain.parentRotation(i);
      chain.world[i].multiplyQuaternions(parent, chain.rotations[i]);
      _cur.copy(j.boneDir).applyQuaternion(chain.world[i]);
      _dir.subVectors(_p[i + 1], chain.positions[i]);

      if (j.type === 'hinge') {
        _axis.copy(j.axis).applyQuaternion(parent);
        let angle = signedAngleAbout(_cur, _dir, _axis);
        if (!Number.isFinite(angle)) {
          // Bone parallel to the hinge axis: align the effector with the target around the axis.
          chain.forward(i);
          _toE.subVectors(chain.effector, chain.positions[i]);
          _toT.subVectors(target, chain.positions[i]);
          angle = signedAngleAbout(_toE, _toT, _axis);
        }
        if (Number.isFinite(angle)) {
          _delta.setFromAxisAngle(_axis, angle);
          chain.rotateWorld(i, _delta);
        }
      } else if (_dir.lengthSq() > 1e-14) {
        _delta.setFromUnitVectors(_cur, _dir.normalize());
        chain.rotateWorld(i, _delta);
      }
      chain.world[i].multiplyQuaternions(parent, chain.rotations[i]);
      chain.positions[i + 1].copy(j.bone).applyQuaternion(chain.world[i]).add(chain.positions[i]);
    }
    error = chain.error(target);
    o.errors?.push(error);
  }
  return { iterations: it, error };
}
