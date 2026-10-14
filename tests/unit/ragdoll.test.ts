import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { initRapier } from '../../src/physics/rapier';
import { Ragdoll } from '../../demos/10-active-ragdoll/ragdoll';
import { measure, walkClip } from '../support/ragdollAudit';

beforeAll(async () => {
  await initRapier();
});

const deg = THREE.MathUtils.degToRad;

function shove(impulse: number) {
  const r = new Ragdoll(walkClip);
  r.setMode('stand');
  r.reset();
  measure(r, 1);
  const chest = r.bodies[2].rb.translation();
  r.hit(2, new THREE.Vector3(chest.x, chest.y, chest.z), new THREE.Vector3(impulse, 0, 0));
  const t = new THREE.Vector3();
  const res = { peak: 0, back: Infinity, fell: Infinity, active: Infinity, pelvisAfter: Infinity };
  for (let i = 0; i < 240 * 8; i++) {
    r.step();
    const time = (i + 1) / 240;
    const c = r.bodies[2].rb.translation();
    const d = r.targetPosition(2, t).distanceTo(c as THREE.Vector3Like);
    res.peak = Math.max(res.peak, d);
    if (r.state === 'fallen' && res.fell === Infinity) res.fell = time;
    if (res.fell === Infinity && i > 24 && d < 0.03 && res.back === Infinity) res.back = time;
    if (res.fell < Infinity && r.state === 'active' && res.active === Infinity) res.active = time;
    if (res.active < Infinity && time > res.active + 1 && res.pelvisAfter === Infinity) {
      res.pelvisAfter = r.targetPosition(0, t).distanceTo(r.bodies[0].rb.translation() as THREE.Vector3Like);
    }
  }
  r.dispose();
  return res;
}

describe('pinned active ragdoll (Rapier, 240 Hz)', () => {
  it('is assembled with coincident joint anchors', () => {
    const r = new Ragdoll(walkClip);
    r.setMode('stand');
    r.reset();
    expect(r.bodies).toHaveLength(14);
    expect(r.joints).toHaveLength(13);
    expect(r.jointDrift()).toBeLessThan(1e-5);
    const mass = r.bodies.reduce((s, b) => s + b.rb.mass(), 0);
    expect(mass).toBeCloseTo(70, 1);
    r.dispose();
  });

  it('stands still on its target: stable, out of the floor, within 3° and 3 cm', () => {
    const r = new Ragdoll(walkClip);
    r.setMode('stand');
    r.reset();
    const m = measure(r, 20, 1);
    expect(m.nan).toBe(false);
    expect(m.maxSpeed).toBeLessThan(1);
    expect(m.maxDrift).toBeLessThan(0.005);
    expect(m.maxPenetration).toBeLessThan(0.01);
    expect(m.meanAngle).toBeLessThan(deg(3));
    expect(m.pelvisPos).toBeLessThan(0.03);
    expect(r.state).toBe('active');
    r.dispose();
  }, 20000);

  it('walks the CMU clip: stable, within 8° and 4 cm on average', () => {
    const r = new Ragdoll(walkClip);
    r.setMode('walk');
    r.reset();
    const m = measure(r, 20, 1);
    expect(m.nan).toBe(false);
    expect(m.maxSpeed).toBeLessThan(10);
    expect(m.maxDrift).toBeLessThan(0.005);
    expect(m.maxPenetration).toBeLessThan(0.01);
    expect(m.meanAngle).toBeLessThan(deg(8));
    expect(m.meanPos).toBeLessThan(0.04);
    expect(m.pelvisPos).toBeLessThan(0.04);
    expect(r.state).toBe('active');
    r.dispose();
  }, 20000);

  it('cannot stand on muscles alone (pins off): falls within 3 s', () => {
    const r = new Ragdoll(walkClip);
    r.setMode('stand');
    r.reset();
    r.settings.pin = 0;
    let fell = Infinity;
    for (let i = 0; i < 240 * 4 && fell === Infinity; i++) {
      r.step();
      if (r.isDown()) fell = i / 240;
    }
    expect(fell).toBeLessThan(3);
    r.dispose();
  });

  it('a 120 N·s shove staggers the chest ≥ 15 cm and it recovers within a second without falling', () => {
    const s = shove(120);
    expect(s.peak).toBeGreaterThan(0.15);
    expect(s.fell).toBe(Infinity);
    expect(s.back).toBeLessThan(1);
  });

  it('a 250 N·s hit knocks it down; it gets back up and onto its target', () => {
    const s = shove(250);
    expect(s.fell).toBeLessThan(0.5);
    expect(s.active).toBeLessThan(s.fell + 2 + 1.5 + 1);
    expect(s.pelvisAfter).toBeLessThan(0.05);
  });

  it('a finer step keeps joints tighter (implicit motors are stable at 60 Hz too)', () => {
    const drift = (hz: number) => {
      const r = new Ragdoll(walkClip, 1 / hz);
      r.setMode('walk');
      r.reset();
      const m = measure(r, 5, 1);
      r.dispose();
      return m;
    };
    const coarse = drift(60);
    const fine = drift(240);
    expect(coarse.nan).toBe(false);
    expect(fine.maxDrift).toBeLessThan(coarse.maxDrift);
  }, 20000);
});
