import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ParticleSystem } from '../../src/physics/xpbd';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A mass hanging from a fixed anchor on one distance constraint. Returns the settled stretch. */
function hangingStretch(opts: { compliance: number; substeps: number; iterations?: number; mode?: 'xpbd' | 'pbd'; k?: number }) {
  const ps = new ParticleSystem(2);
  ps.groundY = null;
  ps.damping = 5;
  ps.substeps = opts.substeps;
  ps.iterations = opts.iterations ?? 1;
  ps.mode = opts.mode ?? 'xpbd';
  ps.pbdStiffness = opts.k ?? 1;
  const a = ps.addParticle(v(0, 2, 0), Infinity);
  const b = ps.addParticle(v(0, 1, 0), 2); // 2 kg
  ps.addDistance(a, b, opts.compliance, 1);
  for (let i = 0; i < 600; i++) ps.step(1 / 60);
  return ps.distance(a, b) - 1;
}

describe('ParticleSystem (XPBD)', () => {
  it('settles at the physical stretch m·g·α, independent of substeps', () => {
    const alpha = 0.01; // m/N
    const expected = 2 * 9.81 * alpha;
    for (const substeps of [5, 20, 40]) {
      const s = hangingStretch({ compliance: alpha, substeps });
      expect(Math.abs(s - expected) / expected, `substeps ${substeps}`).toBeLessThan(0.02);
    }
  });

  it('XPBD stretch is independent of the iteration count, PBD stretch is not', () => {
    const x1 = hangingStretch({ compliance: 0.01, substeps: 1, iterations: 1 });
    const x10 = hangingStretch({ compliance: 0.01, substeps: 1, iterations: 10 });
    expect(Math.abs(x1 - x10) / x10).toBeLessThan(0.05);

    const p1 = hangingStretch({ compliance: 0, substeps: 1, iterations: 1, mode: 'pbd', k: 0.05 });
    const p10 = hangingStretch({ compliance: 0, substeps: 1, iterations: 10, mode: 'pbd', k: 0.05 });
    expect(p1 / p10).toBeGreaterThan(3);
  });

  it('keeps an inextensible rope near its rest length', () => {
    const ps = new ParticleSystem(21);
    ps.groundY = null;
    ps.substeps = 20;
    let prev = ps.addParticle(v(0, 2, 0), Infinity);
    for (let i = 1; i <= 20; i++) {
      const p = ps.addParticle(v(i * 0.05, 2, 0), 0.05);
      ps.addDistance(prev, p, 0);
      prev = p;
    }
    for (let i = 0; i < 300; i++) ps.step(1 / 60);
    for (let k = 0; k < ps.nConstraints; k++) {
      const [a, b] = ps.constraintEnds(k);
      expect(Math.abs(ps.distance(a, b) - 0.05) / 0.05).toBeLessThan(0.01);
    }
  });

  it('moves pinned particles only to their pin target', () => {
    const ps = new ParticleSystem(2);
    const a = ps.addParticle(v(0, 1, 0), 1);
    const b = ps.addParticle(v(0, 0.5, 0), 1);
    ps.addDistance(a, b, 0);
    ps.pin(a, v(0.3, 1.2, 0));
    for (let i = 0; i < 10; i++) ps.step(1 / 60);
    expect(ps.get(a).distanceTo(v(0.3, 1.2, 0))).toBeLessThan(1e-12);
    ps.unpin(a);
    expect(ps.isPinned(a)).toBe(false);
  });

  it('does not let particles fall through the ground or into colliders', () => {
    const ps = new ParticleSystem(2);
    ps.radius = 0.02;
    const a = ps.addParticle(v(0, 1, 0), 1);
    const b = ps.addParticle(v(2, 3, 0), 1);
    ps.spheres.push({ centre: v(2, 1, 0), radius: 0.5 });
    for (let i = 0; i < 240; i++) ps.step(1 / 60);
    expect(ps.get(a).y).toBeGreaterThanOrEqual(0.02 - 1e-9);
    expect(ps.get(b).distanceTo(v(2, 1, 0))).toBeGreaterThanOrEqual(0.52 - 1e-6);
  });

  it('does not gain energy as an undamped pendulum', () => {
    const ps = new ParticleSystem(2);
    ps.groundY = null;
    ps.damping = 0;
    ps.substeps = 20;
    const a = ps.addParticle(v(0, 2, 0), Infinity);
    const b = ps.addParticle(v(1, 2, 0), 1);
    ps.addDistance(a, b, 0);
    let maxY = -Infinity;
    for (let i = 0; i < 600; i++) {
      ps.step(1 / 60);
      if (i > 30) maxY = Math.max(maxY, ps.get(b).y);
    }
    expect(maxY).toBeLessThanOrEqual(2 + 1e-3);
  });
});
