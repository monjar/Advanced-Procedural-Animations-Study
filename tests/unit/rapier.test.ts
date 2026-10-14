import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { asSpherical, driveSpherical, FixedStepper, initRapier, RAPIER } from '../../src/physics/rapier';

beforeAll(async () => {
  await initRapier();
});

describe('Rapier helpers', () => {
  it('spherical joint motors reach random target rotations (no gravity)', () => {
    let seed = 5;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 2;
    for (let trial = 0; trial < 6; trial++) {
      const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
      world.timestep = 1 / 240;
      const parent = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 2, 0));
      const child = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1.6, 0));
      world.createCollider(RAPIER.ColliderDesc.capsule(0.15, 0.05).setMass(3), child);
      const j = asSpherical(world.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: -0.2, z: 0 }, { x: 0, y: 0.2, z: 0 }), parent, child, true));
      expect(j.configureMotorPosition).toBeTypeOf('function');
      j.setContactsEnabled(false);
      const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 1.2, rnd() * 1.2, rnd() * 1.2));
      for (const ax of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) j.configureMotorModel(ax, RAPIER.MotorModel.ForceBased);
      driveSpherical(j, target.toArray(), 300, 20);
      for (let i = 0; i < 240; i++) world.step();
      const r = child.rotation();
      expect(new THREE.Quaternion(r.x, r.y, r.z, r.w).angleTo(target)).toBeLessThan(THREE.MathUtils.degToRad(1));
      world.free();
    }
  });

  it('fixed stepper takes constant steps and reports the remainder', () => {
    const steps: number[] = [];
    const s = new FixedStepper(1 / 240, (dt) => steps.push(dt));
    let alpha = 0;
    for (let i = 0; i < 144; i++) alpha = s.advance(1 / 144);
    expect(steps.every((d) => d === 1 / 240)).toBe(true);
    expect(Math.abs(steps.length - 240)).toBeLessThanOrEqual(1);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(1);
  });
});
