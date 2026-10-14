import * as THREE from 'three';
import { signedAngleAbout, type Chain, type SolveOptions, type SolveResult } from './chain';

const _p: THREE.Vector3[] = [];
const _dir = new THREE.Vector3();
const _cur = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _delta = new THREE.Quaternion();
const _toE = new THREE.Vector3();
const _toT = new THREE.Vector3();

/**
 * FABRIK (Aristidou & Lasenby 2011) on a rotational chain.
 *
 * Backward pass: unconstrained positions from the target to the root.
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
      _p[i].copy(_p[i + 1]).addScaledVector(_dir.normalize(), chain.joints[i].length);
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
