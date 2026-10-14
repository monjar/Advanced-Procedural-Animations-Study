import { describe, expect, it } from 'vitest';
import { auditCourse, clip as data } from '../support/footikAudit';

describe('CMU clip asset', () => {
  it('is a single loop with unit quaternions and both feet stepping', () => {
    expect(data.frames).toBeGreaterThan(40);
    expect(data.rotations.length).toBe(data.frames * data.joints.length * 4);
    for (let i = 0; i < data.rotations.length; i += 4) {
      const [x, y, z, w] = data.rotations.slice(i, i + 4);
      expect(Math.abs(Math.hypot(x, y, z, w) - 1)).toBeLessThan(1e-3);
    }
    for (const side of ['left', 'right'] as const) {
      const stance = data.contacts[side].reduce((a, b) => a + b, 0) / data.frames;
      expect(stance).toBeGreaterThan(0.45);
      expect(stance).toBeLessThan(0.75);
    }
    expect(data.cycle[2]).toBeGreaterThan(1);
  });
});

describe('Foot IK over mocap on the obstacle course', () => {
  // Penetration is measured exactly against the rendered course mesh, independent of the layer's own query.
  it('without IK the clip sinks over a metre into the stairs', () => {
    const raw = auditCourse({ enabled: false });
    expect(raw.stance).toBeGreaterThan(1);
    expect(raw.deepFrames / raw.frames).toBeGreaterThan(0.5);
  });

  for (const fps of [25, 60, 144]) {
    it(`with IK at ${fps} fps the rendered feet and shins stay out of the course`, () => {
      const a = auditCourse({}, fps);
      expect(a.stance).toBeLessThan(0.005);
      expect(a.swing).toBeLessThan(0.005);
      expect(a.shin).toBeLessThan(0.005);
      expect(a.deepFrames).toBe(0);
      // The plan, not the last-resort guard, does the work.
      expect(a.guard).toBeLessThan(0.01);
    });
  }

  it('planted feet stand on the course rather than hovering, and stay pinned', () => {
    const a = auditCourse();
    expect(a.flatFrames).toBeGreaterThan(800);
    expect(a.floatFrames / a.flatFrames).toBeLessThan(0.03);
    expect(a.slip).toBeLessThan(0.025);
  });

  it('planned heights are smooth; reacting frame by frame is not', () => {
    const planned = auditCourse();
    const reactive = auditCourse({ swing: false });
    expect(planned.accel).toBeLessThan(100);
    expect(reactive.accel).toBeGreaterThan(300);
  });
});
