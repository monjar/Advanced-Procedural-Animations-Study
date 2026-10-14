import { describe, expect, it } from 'vitest';
import { mirror, RUN, samplePose, WALK, type Pose } from '../../demos/07-biped/poses';

describe('key-pose sampling', () => {
  it('hits the keys exactly and mirrors them half a stride later', () => {
    for (const keys of [WALK, RUN]) {
      for (const [p, pose] of keys) {
        expect(samplePose(keys, p)).toEqual(pose);
        const m = samplePose(keys, p + 0.5);
        const expected = mirror(pose);
        for (const k of Object.keys(expected) as (keyof Pose)[]) expect(m[k]).toBeCloseTo(expected[k], 12);
      }
    }
  });

  it('is continuous across the whole cycle including the wrap', () => {
    for (const keys of [WALK, RUN]) {
      let prev = samplePose(keys, 0);
      for (let x = 0.001; x <= 1.0001; x += 0.001) {
        const p = samplePose(keys, x);
        for (const k of Object.keys(p) as (keyof Pose)[]) expect(Math.abs(p[k] - prev[k])).toBeLessThan(0.02);
        prev = p;
      }
    }
  });

  it('swings the arms opposite to each other', () => {
    for (let x = 0; x < 1; x += 0.05) {
      const p = samplePose(WALK, x);
      expect(Math.sign(p.armL) * Math.sign(p.armR)).toBeLessThanOrEqual(0);
    }
  });
});
