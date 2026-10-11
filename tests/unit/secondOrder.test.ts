import { describe, expect, it } from 'vitest';
import { SecondOrderDynamics, stepResponse } from '../../src/math/secondOrder';

const last = (a: Float64Array) => a[a.length - 1];

describe('SecondOrderDynamics', () => {
  it.each([0.3, 1, 2])('converges to a unit step (zeta=%s)', (zeta) => {
    const y = stepResponse({ f: 2, zeta, r: 0 }, 1 / 60, 6);
    expect(Math.abs(last(y) - 1)).toBeLessThan(1e-3);
  });

  it('critically damped with r=0 does not overshoot', () => {
    const y = stepResponse({ f: 1.5, zeta: 1, r: 0 }, 1 / 120, 5);
    expect(Math.max(...y)).toBeLessThanOrEqual(1 + 1e-6);
  });

  it('negative r anticipates (moves away from the target first)', () => {
    const y = stepResponse({ f: 2, zeta: 0.5, r: -2 }, 1 / 60, 1);
    expect(Math.min(...y)).toBeLessThan(-0.01);
  });

  it('naive Euler diverges for a fast system at 30 Hz', () => {
    const y = stepResponse({ f: 10, zeta: 0.5, r: 0 }, 1 / 30, 3, 'euler');
    const v = last(y);
    expect(!Number.isFinite(v) || Math.abs(v) > 1e3).toBe(true);
  });

  it.each(['clamped', 'pole-matching'] as const)('%s stays stable for a fast system at 30 Hz', (integrator) => {
    const y = stepResponse({ f: 10, zeta: 0.5, r: 0 }, 1 / 30, 3, integrator);
    expect(y.every((v) => Math.abs(v) < 2)).toBe(true);
    expect(Math.abs(last(y) - 1)).toBeLessThan(1e-3);
  });

  it('is approximately frame-rate independent', () => {
    const p = { f: 1.5, zeta: 0.7, r: 1 };
    const a = stepResponse(p, 1 / 60, 0.5);
    const b = stepResponse(p, 1 / 240, 0.5);
    expect(Math.abs(last(a) - last(b))).toBeLessThan(0.03);
  });

  it('tracks each dimension independently', () => {
    const sys = new SecondOrderDynamics({ f: 3, zeta: 1, r: 0 }, [0, 5, -2]);
    for (let i = 0; i < 600; i++) sys.update(1 / 120, [1, 5, 4]);
    expect(sys.y[0]).toBeCloseTo(1, 4);
    expect(sys.y[1]).toBeCloseTo(5, 6);
    expect(sys.y[2]).toBeCloseTo(4, 4);
  });
});
