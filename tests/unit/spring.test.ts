import { describe, expect, it } from 'vitest';
import { criticalSpring } from '../../src/math/spring';

describe('criticalSpring', () => {
  it('converges without overshoot from rest', () => {
    const s = { x: 0, v: 0 };
    let max = 0;
    for (let i = 0; i < 600; i++) {
      criticalSpring(s, 1, 0.2, 1 / 120);
      max = Math.max(max, s.x);
    }
    expect(max).toBeLessThanOrEqual(1);
    expect(s.x).toBeCloseTo(1, 6);
  });

  it('is exact: two half steps equal one full step', () => {
    const a = { x: 0.3, v: -2 };
    const b = { x: 0.3, v: -2 };
    criticalSpring(a, 1, 0.15, 0.1);
    criticalSpring(b, 1, 0.15, 0.05);
    criticalSpring(b, 1, 0.15, 0.05);
    expect(a.x).toBeCloseTo(b.x, 10);
    expect(a.v).toBeCloseTo(b.v, 10);
  });
});
