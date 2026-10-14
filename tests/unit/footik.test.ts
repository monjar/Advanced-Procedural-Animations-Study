import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ClipPlayer, type ClipData } from '../../src/anim/clip';
import { FootIK } from '../../demos/08-foot-ik/footik';
import { courseHeight, courseNormal, COURSE_LENGTH } from '../../demos/08-foot-ik/course';

const data = JSON.parse(readFileSync('public/assets/mocap/cmu-02_01-walk.json', 'utf8')) as ClipData;

function walkCourse(enabled: boolean) {
  const player = new ClipPlayer(data);
  const ik = new FootIK(player, courseHeight, courseNormal, { enabled, pelvis: true, lock: true, align: true, swing: true });
  const stats = { maxError: 0, maxReach: 0, maxSlip: 0, maxRawError: 0, flatFrames: 0 };
  for (let i = 0; i < 60 * 30; i++) {
    player.time += 1 / 60;
    ik.update(1 / 60);
    if (player.bones[0].position.z > COURSE_LENGTH) break;
    for (const f of ik.feet) {
      stats.maxReach = Math.max(stats.maxReach, enabled ? f.ik.error : 0);
      if (!f.flat) continue;
      stats.flatFrames++;
      stats.maxError = Math.max(stats.maxError, f.ikError);
      stats.maxRawError = Math.max(stats.maxRawError, f.rawError);
      stats.maxSlip = Math.max(stats.maxSlip, f.lastSlip.ik);
    }
  }
  return stats;
}

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
  it('without IK the clip penetrates or floats by over a metre on stairs', () => {
    const s = walkCourse(false);
    expect(s.maxError).toBeGreaterThan(1);
  });

  it('with IK, flat feet stay within 2 cm of the supporting surface, reachable and pinned', () => {
    const s = walkCourse(true);
    expect(s.flatFrames).toBeGreaterThan(500);
    expect(s.maxError).toBeLessThan(0.02);
    expect(s.maxReach).toBeLessThan(1e-3);
    expect(s.maxSlip).toBeLessThan(0.02);
    expect(s.maxRawError).toBeGreaterThan(1);
  });
});
