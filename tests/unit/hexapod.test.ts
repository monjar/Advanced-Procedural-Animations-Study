import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { World } from '../../demos/05-hexapod/world';
import { Spider, DEFAULT_SETTINGS, FOOT_RADIUS } from '../../demos/05-hexapod/spider';
import { auditFootholds, auditHexapod } from '../support/hexapodAudit';

const DT = 1 / 60;

describe('Spider on flat ground', () => {
  it('walks forward upright at its body height with feet on the ground', () => {
    const world = new World('flat');
    const spider = new Spider(world.rays, new THREE.Vector3(0, 0, -6));
    let maxTilt = 0;
    for (let i = 0; i < 60 * 6; i++) {
      spider.update(DT, 1, 0);
      maxTilt = Math.max(maxTilt, 1 - spider.up.y);
    }
    expect(spider.position.z).toBeGreaterThan(-6 + DEFAULT_SETTINGS.speed * 4);
    expect(maxTilt).toBeLessThan(0.02);
    expect(Math.abs(spider.position.y - DEFAULT_SETTINGS.bodyHeight)).toBeLessThan(0.06);
    for (const leg of spider.legs) if (!leg.stepping) expect(Math.abs(leg.planted.y - FOOT_RADIUS)).toBeLessThan(1e-6);
  });

  it('steps with feet that stay within leg reach', () => {
    const world = new World('flat');
    const spider = new Spider(world.rays, new THREE.Vector3(0, 0, 0));
    let worst = 0;
    for (let i = 0; i < 60 * 5; i++) {
      spider.update(DT, 1, i < 150 ? 0.6 : -0.6);
      for (const leg of spider.legs) worst = Math.max(worst, leg.ik.error);
    }
    expect(worst).toBeLessThan(0.15);
  });

  it('settles all feet when it stops', () => {
    const world = new World('flat');
    const spider = new Spider(world.rays, new THREE.Vector3(0, 0, 0));
    for (let i = 0; i < 120; i++) spider.update(DT, 1, 0.3);
    for (let i = 0; i < 120; i++) spider.update(DT, 0, 0);
    expect(spider.legs.every((l) => !l.stepping)).toBe(true);
    for (const leg of spider.legs) expect(leg.planted.distanceTo(leg.target)).toBeLessThan(0.06);
  });
});

describe('Spider climbing', () => {
  it('transitions from the floor onto a wall it walks into', () => {
    const world = new World('wall'); // wall face at z = -2.7, normal +z
    const spider = new Spider(world.rays, new THREE.Vector3(0, 0, 2));
    spider.forward.set(0, 0, -1);
    let reached = false;
    for (let i = 0; i < 60 * 8; i++) {
      spider.update(DT, 1, 0);
      if (spider.up.z > 0.85 && spider.position.y > 1.0) reached = true;
    }
    expect(reached).toBe(true);
  });

  it('climbs over the top edge and down the far side onto the floor', () => {
    const world = new World('wall'); // 3 m tall, 0.6 m thick, spanning z ∈ [-3.3, -2.7]
    const spider = new Spider(world.rays, new THREE.Vector3(0, 0, 2));
    spider.forward.set(0, 0, -1);
    let onTop = false;
    let onBackFace = false;
    for (let i = 0; i < 60 * 9; i++) {
      spider.update(DT, 1, 0);
      if (spider.up.y > 0.9 && spider.position.y > 3.0) onTop = true;
      if (onTop && spider.up.z < -0.9) onBackFace = true;
    }
    expect(onTop).toBe(true);
    expect(onBackFace).toBe(true);
    expect(spider.position.z).toBeLessThan(-4.5);
    expect(spider.up.y).toBeGreaterThan(0.95);
    expect(spider.position.y).toBeLessThan(0.6);
  });
});

describe('Spider ground contact on the playground (crates, wall, ramp, hills)', () => {
  // Measured with an exact inside/outside test of the level geometry, independent of the raycaster.
  // Before the fix: planted feet up to 37 cm deep, body up to 31 cm, >50 % of leg-frames >1 cm deep.
  it('keeps feet and body out of the geometry while wandering for a minute', () => {
    const a = auditHexapod(60);
    const legFrames = a.frames * 6;
    expect(a.footPlanted).toBeLessThan(0.04);
    expect(a.footFrames / legFrames).toBeLessThan(0.01);
    expect(a.body).toBeLessThan(0.06);
    expect(a.bodyFrames / a.frames).toBeLessThan(0.01);
  }, 30000);

  // Regression: an interaction between swing-foot clamping and the body plane once left legs without a
  // foothold for 2.5 s (feet 3 m behind) under jittery frame times. The plane now uses footholds only.
  it.each([1, 3])('never leaves a leg without a foothold for long under jittery frames (seed %s)', (seed) => {
    const r = auditFootholds(45, seed);
    expect(r.worstLost).toBeLessThan(1);
    expect(r.reached).toBeGreaterThanOrEqual(9);
  }, 60000);
});
