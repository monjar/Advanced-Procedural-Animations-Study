import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Dog } from '../../demos/06-quadruped/dog';
import { hills } from '../../src/world/terrain';

const DT = 1 / 60;
const h = hills({ seed: 2, amplitude: 0.35, scale: 10 });

describe('Dog', () => {
  it.each([0.9, 2.5, 4.5, 7])('keeps legs within reach and feet on the terrain at %s m/s', (speed) => {
    const dog = new Dog(h, new THREE.Vector3());
    let maxErr = 0;
    for (let i = 0; i < 60 * 6; i++) {
      dog.update(DT, speed, 0.25);
      if (i < 120) continue;
      for (const l of dog.legs) {
        maxErr = Math.max(maxErr, l.ik.error);
        if (!l.swinging) expect(Math.abs(l.planted.y - h(l.planted.x, l.planted.z))).toBeLessThan(1e-9);
      }
    }
    expect(dog.speed).toBeCloseTo(speed, 6);
    expect(maxErr).toBeLessThan(0.015);
  });

  it('planted feet do not slide', () => {
    const dog = new Dog(h, new THREE.Vector3());
    const last = dog.legs.map((l) => l.planted.clone());
    for (let i = 0; i < 60 * 5; i++) {
      const wasStance = dog.legs.map((l) => !l.swinging);
      dog.update(DT, 2.5, 0.3);
      dog.legs.forEach((l, k) => {
        if (wasStance[k] && !l.swinging) expect(l.planted.distanceTo(last[k])).toBeLessThan(1e-12);
        last[k].copy(l.planted);
      });
    }
  });

  it('trots on diagonal pairs', () => {
    const dog = new Dog(() => 0, new THREE.Vector3());
    let same = 0;
    let total = 0;
    for (let i = 0; i < 60 * 6; i++) {
      dog.update(DT, 2.5, 0);
      if (i < 120) continue;
      const [lf, rf, lh, rh] = dog.legs.map((l) => l.swinging);
      total += 2;
      if (lf === rh) same++;
      if (rf === lh) same++;
    }
    expect(same / total).toBeGreaterThan(0.9);
  });

  it('comes to rest with all four feet down', () => {
    const dog = new Dog(() => 0, new THREE.Vector3());
    for (let i = 0; i < 120; i++) dog.update(DT, 2, 0.4);
    for (let i = 0; i < 180; i++) dog.update(DT, 0, 0);
    expect(dog.legs.every((l) => !l.swinging)).toBe(true);
  });
});
