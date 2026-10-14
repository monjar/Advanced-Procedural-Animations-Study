import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Biped } from '../../demos/07-biped/biped';
import { hills } from '../../src/world/terrain';

const DT = 1 / 60;
const h = hills({ seed: 4, amplitude: 0.4, scale: 9 });

function run(speed: number, seconds: number, turn = 0.15, height = h) {
  const b = new Biped(height, new THREE.Vector3());
  const stats = { minStance: 2, maxStance: 0, maxDrop: 0, maxErr: 0 };
  for (let i = 0; i < seconds * 60; i++) {
    b.update(DT, speed, turn);
    if (i < 180) continue;
    const n = b.feet.filter((f) => !f.swinging).length;
    stats.minStance = Math.min(stats.minStance, n);
    stats.maxStance = Math.max(stats.maxStance, n);
    stats.maxDrop = Math.max(stats.maxDrop, b.reachDrop);
    for (const f of b.feet) stats.maxErr = Math.max(stats.maxErr, f.ik.error);
  }
  return { b, stats };
}

describe('Biped', () => {
  it('walks with a foot always on the ground and a double-support phase', () => {
    const { stats } = run(1.4, 8);
    expect(stats.minStance).toBe(1);
    expect(stats.maxStance).toBe(2);
  });

  it('runs with a flight phase', () => {
    const { stats } = run(3.8, 8);
    expect(stats.minStance).toBe(0);
    expect(stats.maxStance).toBe(1);
  });

  it.each([0.8, 1.4, 2.3, 3.8, 5])('keeps legs solvable without crouching at %s m/s', (speed) => {
    const { stats } = run(speed, 8);
    expect(stats.maxErr).toBeLessThan(0.005);
    expect(stats.maxDrop).toBeLessThan(0.1);
  });

  it('planted feet stay on the terrain and do not slide', () => {
    const b = new Biped(h, new THREE.Vector3());
    const last = b.feet.map((f) => f.planted.clone());
    for (let i = 0; i < 60 * 6; i++) {
      const stance = b.feet.map((f) => !f.swinging);
      b.update(DT, i < 200 ? 1.4 : 3.5, 0.3);
      b.feet.forEach((f, k) => {
        if (stance[k] && !f.swinging) {
          expect(f.planted.distanceTo(last[k])).toBeLessThan(1e-12);
          expect(Math.abs(f.planted.y - h(f.planted.x, f.planted.z))).toBeLessThan(1e-9);
        }
        last[k].copy(f.planted);
      });
    }
  });

  it('stops with both feet down near neutral', () => {
    const b = new Biped(() => 0, new THREE.Vector3());
    for (let i = 0; i < 180; i++) b.update(DT, 1.4, 0.2);
    for (let i = 0; i < 180; i++) b.update(DT, 0, 0);
    expect(b.feet.every((f) => !f.swinging)).toBe(true);
    const width = b.feet[0].planted.distanceTo(b.feet[1].planted);
    expect(width).toBeGreaterThan(0.12);
    expect(width).toBeLessThan(0.35);
  });
});
