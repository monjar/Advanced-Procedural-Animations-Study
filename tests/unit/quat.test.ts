import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clampRotationAngle, clampToCone, clampTwist, lookRotation, swingTwist, twistAngle } from '../../src/math/quat';

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

function randomQuat(seed: number): THREE.Quaternion {
  const e = new THREE.Euler(Math.sin(seed) * 3, Math.cos(seed * 1.7) * 3, Math.sin(seed * 2.3) * 3);
  return new THREE.Quaternion().setFromEuler(e);
}

describe('swingTwist', () => {
  it('recomposes to the input with a pure twist and a perpendicular swing', () => {
    for (let i = 0; i < 50; i++) {
      const q = randomQuat(i + 0.5);
      const { swing, twist } = swingTwist(q, Y);
      const recomposed = swing.clone().multiply(twist);
      expect(Math.abs(recomposed.dot(q))).toBeCloseTo(1, 9);
      // twist axis ∥ Y, swing axis ⟂ Y
      expect(Math.abs(twist.x) + Math.abs(twist.z)).toBeLessThan(1e-9);
      expect(Math.abs(swing.y)).toBeLessThan(1e-9);
    }
  });

  it('measures and clamps twist angles', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(Y, 2.0);
    expect(twistAngle(q, Y)).toBeCloseTo(2.0, 9);
    clampTwist(q, Y, 0.5);
    expect(twistAngle(q, Y)).toBeCloseTo(0.5, 9);
    const neg = new THREE.Quaternion().setFromAxisAngle(Y, -1.2);
    expect(twistAngle(clampTwist(neg, Y, 0.5), Y)).toBeCloseTo(-0.5, 9);
  });

  it('clamps rotation angle keeping the axis', () => {
    const axis = new THREE.Vector3(1, 0, 1).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(axis, 2.5);
    clampRotationAngle(q, 1);
    const expected = new THREE.Quaternion().setFromAxisAngle(axis, 1);
    expect(Math.abs(q.dot(expected))).toBeCloseTo(1, 9);
  });
});

describe('clampToCone', () => {
  it('leaves inside directions unchanged and projects outside ones onto the rim', () => {
    const inside = new THREE.Vector3(0.1, 0, 1).normalize();
    expect(clampToCone(inside, Z, 0.5).distanceTo(inside)).toBeLessThan(1e-12);
    for (const d of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, -1).normalize(), new THREE.Vector3(0, 0, -1)]) {
      const c = clampToCone(d, Z, 0.6);
      expect(c.length()).toBeCloseTo(1, 9);
      expect(Math.acos(c.dot(Z))).toBeCloseTo(0.6, 9);
    }
  });
});

describe('lookRotation', () => {
  it('points +Z along forward without roll', () => {
    const fwd = new THREE.Vector3(1, 0.5, 0.3).normalize();
    const q = lookRotation(fwd, Y);
    expect(Z.clone().applyQuaternion(q).distanceTo(fwd)).toBeLessThan(1e-9);
    expect(Math.abs(new THREE.Vector3(1, 0, 0).applyQuaternion(q).y)).toBeLessThan(1e-9);
  });
});
