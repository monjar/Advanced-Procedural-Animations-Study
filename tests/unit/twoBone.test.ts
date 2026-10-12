import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { boneRotation, softDistance, solveTwoBone } from '../../src/ik/twoBone';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const root = v(0, 1.5, 0);
const pole = v(0, 1.0, -1);
const A = 0.32;
const B = 0.3;

describe('solveTwoBone', () => {
  it('hits reachable targets exactly and preserves bone lengths', () => {
    for (const target of [v(0.3, 1.2, 0.2), v(-0.1, 1.6, 0.4), v(0.05, 1.5, 0.1), v(0.3, 1.1, 0.2)]) {
      const r = solveTwoBone(root, target, pole, A, B);
      expect(r.error).toBeLessThan(1e-4);
      expect(r.mid.distanceTo(root)).toBeCloseTo(A, 9);
      expect(r.end.distanceTo(r.mid)).toBeCloseTo(B, 9);
    }
  });

  it('fully extends toward unreachable targets', () => {
    const target = v(2, 1.5, 0);
    const r = solveTwoBone(root, target, pole, A, B);
    const expected = root.clone().add(v(1, 0, 0).multiplyScalar(A + B));
    expect(r.end.distanceTo(expected)).toBeLessThan(1e-9);
    expect(r.mid.distanceTo(root.clone().add(v(A, 0, 0)))).toBeLessThan(1e-6);
  });

  it('bends in the pole plane, toward the pole', () => {
    const target = v(0.3, 1.1, 0.25);
    const r = solveTwoBone(root, target, pole, A, B);
    const toTarget = target.clone().sub(root);
    const toPole = pole.clone().sub(root);
    const planeNormal = toTarget.clone().cross(toPole).normalize();
    expect(Math.abs(r.mid.clone().sub(root).dot(planeNormal))).toBeLessThan(1e-9);
    const perpPole = toPole.clone().addScaledVector(toTarget.clone().normalize(), -toPole.dot(toTarget.clone().normalize()));
    expect(r.mid.clone().sub(root).dot(perpPole)).toBeGreaterThan(0);
  });

  it('does not produce NaN when the pole is collinear with the target', () => {
    const target = v(0, 1.0, 0);
    const r = solveTwoBone(root, target, v(0, 0, 0), A, B);
    expect(Number.isFinite(r.mid.x + r.mid.y + r.mid.z)).toBe(true);
    expect(r.error).toBeLessThan(1e-4);
  });

  it('soft IK leaves near targets untouched and eases toward full extension', () => {
    const softness = 0.05;
    const chain = A + B;
    expect(softDistance(chain - 0.1, chain, softness)).toBeCloseTo(chain - 0.1, 12);
    const atChain = softDistance(chain, chain, softness);
    expect(atChain).toBeLessThan(chain);
    expect(softDistance(10, chain, softness)).toBeLessThanOrEqual(chain);
    // Monotonic.
    let prev = 0;
    for (let d = 0.3; d < 1.2; d += 0.01) {
      const s = softDistance(d, chain, softness);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('full stretch reaches targets beyond the chain length', () => {
    const target = v(0.9, 1.5, 0);
    const r = solveTwoBone(root, target, pole, A, B, { softness: 0.05, stretch: 1 });
    expect(r.error).toBeLessThan(1e-6);
    expect(r.lengthA / A).toBeCloseTo(r.lengthB / B, 9);
    expect(r.lengthA).toBeGreaterThan(A);
  });
});

describe('boneRotation', () => {
  it('maps local +Y onto the bone and +Z toward the hint', () => {
    const from = v(0, 0, 0);
    const to = v(1, 1, 0);
    const q = boneRotation(from, to, v(0, 0, 1));
    const y = v(0, 1, 0).applyQuaternion(q);
    const z = v(0, 0, 1).applyQuaternion(q);
    expect(y.distanceTo(to.clone().normalize())).toBeLessThan(1e-9);
    expect(z.distanceTo(v(0, 0, 1))).toBeLessThan(1e-9);
  });
});
