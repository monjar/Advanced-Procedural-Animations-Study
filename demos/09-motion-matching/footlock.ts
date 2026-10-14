import * as THREE from 'three';
import { createTwoBoneResult, solveTwoBone } from '../../src/ik/twoBone';
import { criticalSpring } from '../../src/math/spring';
import { DIMS } from '../../src/anim/mmfeatures';
import type { MotionMatcher } from './matcher';

/** Ankle speed (m/s) below which a contact frame counts as foot-flat. */
const FLAT_SPEED = 0.25;
const _planted = [false, false];

/**
 * Which feet are planted in the playing frame: labelled in contact *and* the ankle nearly still. A contact
 * also covers heel strike and toe-off, when the ankle rolls 15–20 cm — pinning those stretches the leg.
 */
export function plantedFeet(m: MotionMatcher): boolean[] {
  const f = m.frame;
  for (let side = 0; side < 2; side++) {
    const o = f * DIMS + 18 + side * 3;
    _planted[side] = m.mf.db.contacts[f * 2 + side] === 1 && Math.hypot(m.mf.raw[o], m.mf.raw[o + 2]) < FLAT_SPEED;
  }
  return _planted;
}

interface FootState {
  hip: number;
  knee: number;
  ankle: number;
  toe: number;
  locked: boolean;
  lock: THREE.Vector3;
  /** Offset from the animated ankle, decaying after the lock releases. */
  off: { x: { x: number; v: number }; y: { x: number; v: number }; z: { x: number; v: number } };
  /** Horizontal ankle travel while in contact this frame (m), for measurement. */
  skate: number;
  last: THREE.Vector3;
  hasLast: boolean;
}

const _hip = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _ankle = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _mid = new THREE.Vector3();
const ik = createTwoBoneResult();

/**
 * Foot locking on world joint positions: while the playing frame says a foot is planted, its ankle
 * is pinned where it touched down and the leg is re-solved with two-bone IK (pole from the animated knee);
 * when the contact ends the pin releases through a decaying offset instead of snapping.
 */
export class FootLocker {
  enabled = true;
  /** Release half-life (s). */
  halflife = 0.08;
  /** Unlock if the animation moves this far from the pin (m) — the pin would stretch the leg. */
  maxDrift = 0.25;
  readonly feet: FootState[];

  constructor(joints: readonly { name: string }[]) {
    const idx = (n: string) => joints.findIndex((j) => j.name === n);
    this.feet = (['Left', 'Right'] as const).map((s) => ({
      hip: idx(`${s}UpLeg`),
      knee: idx(`${s}Leg`),
      ankle: idx(`${s}Foot`),
      toe: idx(`${s}ToeBase`),
      locked: false,
      lock: new THREE.Vector3(),
      off: { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, z: { x: 0, v: 0 } },
      skate: 0,
      last: new THREE.Vector3(),
      hasLast: false,
    }));
  }

  reset(): void {
    for (const f of this.feet) {
      f.locked = false;
      f.hasLast = false;
      for (const c of [f.off.x, f.off.y, f.off.z]) c.x = c.v = 0;
    }
  }

  /** Modify `world` [joints·3] in place. `contacts` = [left, right] planted in the playing frame. */
  apply(world: Float32Array, contacts: readonly boolean[], dt: number): void {
    this.feet.forEach((f, i) => {
      const read = (j: number, v: THREE.Vector3) => v.set(world[j * 3], world[j * 3 + 1], world[j * 3 + 2]);
      read(f.hip, _hip);
      read(f.knee, _knee);
      read(f.ankle, _ankle);
      const contact = this.enabled && contacts[i];
      if (contact && !f.locked) {
        f.locked = true;
        f.lock.set(_ankle.x + f.off.x.x, _ankle.y + f.off.y.x, _ankle.z + f.off.z.x);
      }
      if (f.locked && (!contact || f.lock.distanceTo(_ankle) > this.maxDrift)) {
        f.locked = false;
        f.off.x.x = f.lock.x - _ankle.x;
        f.off.y.x = f.lock.y - _ankle.y;
        f.off.z.x = f.lock.z - _ankle.z;
        f.off.x.v = f.off.y.v = f.off.z.v = 0;
      }
      if (f.locked) _target.copy(f.lock);
      else {
        for (const c of [f.off.x, f.off.y, f.off.z]) criticalSpring(c, 0, this.halflife, dt);
        _target.set(_ankle.x + f.off.x.x, _ankle.y + f.off.y.x, _ankle.z + f.off.z.x);
      }
      if (_target.distanceToSquared(_ankle) > 1e-12) {
        const lenA = _hip.distanceTo(_knee);
        const lenB = _knee.distanceTo(_ankle);
        _mid.addVectors(_hip, _ankle).multiplyScalar(0.5);
        _pole.subVectors(_knee, _mid).normalize().multiplyScalar(0.5).add(_knee);
        solveTwoBone(_hip, _target, _pole, lenA, lenB, { softness: 0.01 }, ik);
        const dx = ik.end.x - _ankle.x;
        const dy = ik.end.y - _ankle.y;
        const dz = ik.end.z - _ankle.z;
        world.set([ik.mid.x, ik.mid.y, ik.mid.z], f.knee * 3);
        world.set([ik.end.x, ik.end.y, ik.end.z], f.ankle * 3);
        world[f.toe * 3] += dx;
        world[f.toe * 3 + 1] += dy;
        world[f.toe * 3 + 2] += dz;
      }
      // Measurement: horizontal travel of the rendered ankle while the data says the foot is planted.
      read(f.ankle, _ankle);
      f.skate = contacts[i] && f.hasLast ? Math.hypot(_ankle.x - f.last.x, _ankle.z - f.last.z) : 0;
      f.last.copy(_ankle);
      f.hasLast = true;
    });
  }
}
