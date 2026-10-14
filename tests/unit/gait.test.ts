import { describe, expect, it } from 'vitest';
import { blendGait, GAITS, phaseDelta, stanceAt, TRANSITIONS } from '../../demos/06-quadruped/gait';

function minMaxStance(speed: number): [number, number] {
  const g = blendGait(speed);
  let min = 4;
  let max = 0;
  for (let k = 0; k < 1000; k++) {
    const n = stanceAt(g, k / 1000).filter(Boolean).length;
    min = Math.min(min, n);
    max = Math.max(max, n);
  }
  return [min, max];
}

describe('gait table', () => {
  it('uses pure gaits away from transitions', () => {
    expect(blendGait(0.6).weights.walk).toBe(1);
    expect(blendGait(2.5).weights.trot).toBe(1);
    expect(blendGait(4.5).weights.canter).toBe(1);
    expect(blendGait(7).weights.gallop).toBe(1);
    expect(blendGait(2.5).offsets).toEqual(GAITS.trot.offsets);
  });

  it('the walk keeps at least two feet down; the gallop has a suspension phase', () => {
    expect(minMaxStance(0.8)[0]).toBeGreaterThanOrEqual(2);
    expect(minMaxStance(7)[0]).toBe(0);
  });

  it('trot moves diagonal pairs together', () => {
    const g = blendGait(2.5);
    for (let k = 0; k < 100; k++) {
      const s = stanceAt(g, k / 100);
      expect(s[0]).toBe(s[3]); // LF with RH
      expect(s[1]).toBe(s[2]); // RF with LH
    }
  });

  it('blends continuously through every transition', () => {
    let prev = blendGait(0);
    for (let v = 0.01; v < 8; v += 0.01) {
      const g = blendGait(v);
      for (let i = 0; i < 4; i++) expect(Math.abs(phaseDelta(prev.offsets[i], g.offsets[i]))).toBeLessThan(0.05);
      expect(Math.abs(g.duty - prev.duty)).toBeLessThan(0.02);
      const total = Object.values(g.weights).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1, 9);
      prev = g;
    }
    expect(TRANSITIONS.length).toBe(4);
  });
});
