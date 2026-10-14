import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { velocitySpring, criticalSpringAngle } from '../../src/math/spring';
import { createPose, Inertializer, quatToRotVec, rotVecToQuat } from '../../src/anim/inertialize';

function randomQuat(rng: () => number): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler((rng() - 0.5) * 3, (rng() - 0.5) * 3, (rng() - 0.5) * 3));
}
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('trajectory springs', () => {
  it('closed-form prediction at +10/+20/+30 frames matches 1 kHz integration within 1 mm', () => {
    for (const [v0, a0, goal] of [[0, 0, 1.5], [3.5, 0, 0], [1, -2, 4], [-1, 3, 1]]) {
      const halflife = 0.25;
      for (const frames of [10, 20, 30]) {
        const T = frames / 60;
        const exact = velocitySpring({ x: 0, v: v0, a: a0 }, goal, halflife, T, { x: 0, v: 0, a: 0 });
        // Reference: x' = v, v' = a, a' = −y²(v − goal) − 2y a.
        const y = (4 * Math.LN2) / (halflife + 1e-5) / 2;
        let x = 0, v = v0, a = a0;
        const steps = Math.round(T * 1000);
        const h = T / steps;
        for (let i = 0; i < steps; i++) {
          const da = -y * y * (v - goal) - 2 * y * a;
          x += v * h;
          v += a * h;
          a += da * h;
        }
        expect(Math.abs(exact.x - x)).toBeLessThan(1e-3);
        expect(Math.abs(exact.v - v)).toBeLessThan(5e-3);
      }
    }
  });

  it('a long step equals many short ones (frame-rate independent)', () => {
    const one = velocitySpring({ x: 0, v: 0, a: 0 }, 2, 0.3, 0.5, { x: 0, v: 0, a: 0 });
    const many = { x: 0, v: 0, a: 0 };
    for (let i = 0; i < 50; i++) velocitySpring(many, 2, 0.3, 0.01);
    expect(many.x).toBeCloseTo(one.x, 9);
    expect(many.v).toBeCloseTo(one.v, 9);
  });

  it('angle spring turns the short way across ±π', () => {
    const s = { x: 3.0, v: 0 };
    criticalSpringAngle(s, -3.0, 0.2, 1);
    expect(s.x).toBeGreaterThan(3.0); // went up through π, not down through 0
    expect(Math.abs(s.x - (2 * Math.PI - 3.0))).toBeLessThan(0.01);
  });
});

describe('inertialization', () => {
  it('rotation vectors round-trip', () => {
    const rng = seeded(3);
    const r = new Float64Array(3);
    const q = new Float64Array(4);
    for (let i = 0; i < 100; i++) {
      const src = randomQuat(rng);
      quatToRotVec(src.toArray(), 0, r, 0);
      rotVecToQuat(r, 0, q, 0);
      expect(Math.abs(Math.abs(new THREE.Quaternion().fromArray(Array.from(q)).dot(src)) - 1)).toBeLessThan(1e-9);
    }
  });

  it('keeps the output continuous at a transition and decays the offset below 1% in 5 half-lives', () => {
    const J = 5;
    const rng = seeded(11);
    const src = createPose(J);
    const dst = createPose(J);
    for (let j = 0; j < J; j++) {
      src.rot.set(randomQuat(rng).toArray(), j * 4);
      dst.rot.set(randomQuat(rng).toArray(), j * 4);
    }
    src.hipPos.set([0.1, 1, 0]);
    dst.hipPos.set([-0.2, 0.9, 0.05]);
    const inert = new Inertializer(J, 0.1);
    const before = createPose(J);
    inert.update(src, 0, before);
    inert.transition(src, dst);
    const after = createPose(J);
    inert.update(dst, 0, after);
    for (let j = 0; j < J; j++) {
      const a = new THREE.Quaternion().fromArray(Array.from(before.rot.subarray(j * 4, j * 4 + 4)));
      const b = new THREE.Quaternion().fromArray(Array.from(after.rot.subarray(j * 4, j * 4 + 4)));
      expect(a.angleTo(b)).toBeLessThan(1e-3);
    }
    for (let k = 0; k < 3; k++) expect(after.hipPos[k]).toBeCloseTo(before.hipPos[k], 6);
    const initial = inert.maxRotationOffset();
    expect(initial).toBeGreaterThan(0.5);
    for (let t = 0; t < 0.5; t += 1 / 60) inert.update(dst, 1 / 60, after);
    expect(inert.maxRotationOffset() / initial).toBeLessThan(0.01);
  });
});
