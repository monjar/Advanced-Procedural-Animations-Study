import * as THREE from 'three';
import { createTwoBoneResult, solveTwoBone, type TwoBoneResult } from '../../src/ik/twoBone';
import { SecondOrderDynamics } from '../../src/math/secondOrder';
import { lookRotation } from '../../src/math/quat';
import { SpringChain } from '../../src/rig/springChain';
import type { HeightFn } from '../../src/world/terrain';
import { blendGait, frac, LEG_NAMES, type BlendedGait } from './gait';

const UP = new THREE.Vector3(0, 1, 0);

export interface QLeg {
  name: (typeof LEG_NAMES)[number];
  front: boolean;
  side: number;
  /** Shoulder / hip socket in the body frame. */
  rootLocal: THREE.Vector3;
  root: THREE.Vector3;
  planted: THREE.Vector3;
  foot: THREE.Vector3;
  /** Carpus (front) or hock (hind). */
  ankle: THREE.Vector3;
  swinging: boolean;
  s: number;
  duration: number;
  /** Swing start/end relative to the body, in the yaw-only frame (x left, z forward). */
  fromRel: THREE.Vector3;
  toRel: THREE.Vector3;
  prevPhase: number;
  /** Set when the foot lifted early (over-extended); the next scheduled liftoff is skipped. */
  skipLift: boolean;
  ik: TwoBoneResult;
  upper: number;
  lower: number;
  meta: number;
}

export interface DogState {
  speed: number;
  yawRate: number;
  gait: BlendedGait;
  phase: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _e = new THREE.Euler();
const _axis = new THREE.Vector3();

export class Dog {
  readonly position = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  yawRate = 0;
  phase = 0;
  gait: BlendedGait = blendGait(0);
  readonly quaternion = new THREE.Quaternion();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly legs: QLeg[];
  readonly spine: THREE.Vector3[] = Array.from({ length: 6 }, () => new THREE.Vector3());
  readonly neck: THREE.Vector3[] = Array.from({ length: 4 }, () => new THREE.Vector3());
  readonly head = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  readonly tail: SpringChain;
  readonly shoulder = new THREE.Vector3();
  readonly hip = new THREE.Vector3();
  standHeight = 0.44;
  /** Filters only the head's height: horizontal tracking must not lag at speed. */
  private readonly headHeight: SecondOrderDynamics;
  private readonly headLook = new THREE.Vector3(0, 0, 1);
  private idle = 0;
  private flexNow = 0;

  constructor(private readonly height: HeightFn, start: THREE.Vector3) {
    const mk = (name: QLeg['name']): QLeg => {
      const front = name[1] === 'F';
      const side = name[0] === 'L' ? 1 : -1;
      return {
        name,
        front,
        side,
        rootLocal: new THREE.Vector3(side * 0.1, front ? -0.02 : 0, front ? 0.34 : -0.34),
        root: new THREE.Vector3(),
        planted: new THREE.Vector3(),
        foot: new THREE.Vector3(),
        ankle: new THREE.Vector3(),
        swinging: false,
        s: 0,
        duration: 0.2,
        fromRel: new THREE.Vector3(),
        toRel: new THREE.Vector3(),
        prevPhase: 0,
        skipLift: false,
        ik: createTwoBoneResult(),
        upper: front ? 0.23 : 0.25,
        lower: front ? 0.25 : 0.27,
        meta: front ? 0.07 : 0.15,
      };
    };
    this.legs = LEG_NAMES.map(mk);
    this.position.copy(start);
    this.pose(0);
    for (const leg of this.legs) {
      this.neutral(leg, leg.planted);
      leg.foot.copy(leg.planted);
    }
    this.headHeight = new SecondOrderDynamics({ f: 2.2, zeta: 0.85, r: 0 }, [this.headTarget(_v).y]);
    this.head.position.copy(_v);
    const tailDirs = Array.from({ length: 7 }, (_, i) => new THREE.Vector3(0, 0.55 - i * 0.16, -1).normalize());
    this.tail = new SpringChain(tailDirs, 0.07, this.tailAnchor(_w), this.quaternion, { f: 2.2, zeta: 0.3, r: 0 });
    this.updateRig(0);
  }

  /** Foot position directly under a leg's root (with a small fore-aft offset), on the terrain. */
  private neutral(leg: QLeg, out: THREE.Vector3, ahead = 0): THREE.Vector3 {
    out.copy(leg.rootLocal).setY(0).applyAxisAngle(UP, this.yaw).add(this.position);
    out.addScaledVector(this.forward, ahead + (leg.front ? 0.03 : -0.02));
    out.y = this.height(out.x, out.z);
    return out;
  }

  /** Root frame: yaw, terrain pitch, gait pitch, lean into turns. */
  private pose(_dt: number): void {
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const fx = this.position.x;
    const fz = this.position.z;
    const hFront = this.height(fx + this.forward.x * 0.34, fz + this.forward.z * 0.34);
    const hBack = this.height(fx - this.forward.x * 0.34, fz - this.forward.z * 0.34);
    const g = this.gait;
    const amp = Math.min(1, this.speed / 0.6);
    const bob = g.bob * amp * Math.cos(2 * Math.PI * this.phase * g.bobsPerStride);
    const pitchTerrain = -Math.atan2(hFront - hBack, 0.68);
    const pitchGait = g.pitch * amp * Math.sin(2 * Math.PI * this.phase);
    const roll = THREE.MathUtils.clamp(-this.yawRate * this.speed * 0.04, -0.25, 0.25);
    this.position.y = (hFront + hBack) / 2 + this.standHeight + bob - 0.04 * g.flex * amp;
    _e.set(pitchTerrain + pitchGait, this.yaw, roll, 'YXZ');
    this.quaternion.setFromEuler(_e);
    this.flexNow = g.flex * amp * Math.sin(2 * Math.PI * (this.phase + 0.25));
  }

  private headTarget(out: THREE.Vector3): THREE.Vector3 {
    // Head target ignores gait bob and pitch: forward of the shoulders at a terrain-relative height.
    out.copy(this.position).addScaledVector(this.forward, 0.58);
    out.y = this.height(out.x, out.z) + this.standHeight + 0.3;
    return out;
  }

  private tailAnchor(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0.06, -0.42).applyQuaternion(this.quaternion).add(this.position);
  }

  update(dt: number, targetSpeed: number, turn: number): void {
    // Speed and heading.
    const accel = targetSpeed > this.speed ? 4 : 6;
    this.speed += THREE.MathUtils.clamp(targetSpeed - this.speed, -accel * dt, accel * dt);
    this.yawRate += (turn - this.yawRate) * (1 - Math.exp(-dt * 5));
    this.yaw += this.yawRate * dt;
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.position.addScaledVector(this.forward, this.speed * dt);

    // Gait phase.
    this.gait = blendGait(this.speed);
    const g = this.gait;
    const rate = Math.min(1, this.speed / 0.3);
    this.phase += g.frequency * rate * dt;
    this.pose(dt);

    const stanceTime = g.duty / g.frequency;
    const swingTime = Math.min(0.45, (1 - g.duty) / g.frequency);
    const moving = this.speed > 0.05;
    this.idle = moving ? 0 : this.idle + dt;

    for (let i = 0; i < 4; i++) {
      const leg = this.legs[i];
      const p = frac(this.phase - g.offsets[i]);
      const crossed = moving && leg.prevPhase < g.duty && p >= g.duty && p - leg.prevPhase < 0.5;
      leg.prevPhase = p;
      if (crossed) {
        if (leg.skipLift) leg.skipLift = false;
        else if (!leg.swinging) this.lift(leg, swingTime, stanceTime);
      } else if (moving && !leg.swinging && p < g.duty && p > g.duty * 0.5) {
        // Late stance with the leg already straight: lift now rather than let the foot slide.
        const reach = leg.root.distanceTo(leg.ankle) / (leg.upper + leg.lower);
        if (reach > 0.99) {
          this.lift(leg, swingTime + (g.duty - p) / g.frequency, stanceTime);
          leg.skipLift = true;
        }
      }
    }
    // Standing still: tidy up one foot at a time.
    if (this.idle > 0.4 && !this.legs.some((l) => l.swinging)) {
      let worst: QLeg | null = null;
      let worstD = 0.06;
      for (const leg of this.legs) {
        const d = leg.planted.distanceTo(this.neutral(leg, _v));
        if (d > worstD) {
          worstD = d;
          worst = leg;
        }
      }
      if (worst) this.lift(worst, 0.28, 0);
    }

    for (const leg of this.legs) {
      if (!leg.swinging) {
        leg.foot.copy(leg.planted);
        continue;
      }
      // Interpolate relative to the moving body (yaw frame): a world-space ease would make the foot
      // overshoot the body at speed, because the body itself moves linearly.
      leg.s = Math.min(1, leg.s + dt / leg.duration);
      const e = leg.s * leg.s * (3 - 2 * leg.s);
      this.fromLocal(_v.lerpVectors(leg.fromRel, leg.toRel, e), leg.foot);
      const ground = this.height(leg.foot.x, leg.foot.z);
      const arc = (0.05 + 0.09 * Math.min(1, this.speed / 6)) * (leg.front ? 1 : 0.85);
      leg.foot.y = ground + Math.sin(Math.PI * leg.s) * arc;
      if (leg.s >= 1) {
        leg.swinging = false;
        leg.foot.y = ground;
        leg.planted.copy(leg.foot);
      }
    }
    this.updateRig(dt);
  }

  private lift(leg: QLeg, swingTime: number, stanceTime: number): void {
    leg.swinging = true;
    leg.s = 0;
    leg.duration = Math.max(0.08, swingTime);
    this.toLocal(leg.planted, leg.fromRel);
    // Land half a stance of travel ahead of the neutral point, so the root passes over the foot at
    // mid-stance.
    leg.toRel.set(leg.rootLocal.x, 0, leg.rootLocal.z + (leg.front ? 0.03 : -0.02) + this.speed * stanceTime * 0.5);
  }

  /** World point → yaw-frame offset from the body origin (x left, z forward), ignoring height. */
  private toLocal(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.set(p.x - this.position.x, 0, p.z - this.position.z);
    return out.applyAxisAngle(UP, -this.yaw);
  }

  /** Inverse of `toLocal` (height left at 0). */
  private fromLocal(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.copy(local).setY(0).applyAxisAngle(UP, this.yaw);
    out.x += this.position.x;
    out.z += this.position.z;
    return out;
  }

  private updateRig(dt: number): void {
    const q = this.quaternion;
    const right = _axis.set(1, 0, 0).applyQuaternion(q);
    // Spine from hips to shoulders, bent sideways by the turn and arched/extended by the gallop flex.
    this.hip.set(0, 0, -0.34 + 0.05 * this.flexNow).applyQuaternion(q).add(this.position);
    this.shoulder.set(0, 0.02, 0.34 - 0.05 * this.flexNow).applyQuaternion(q).add(this.position);
    const lateral = THREE.MathUtils.clamp(this.yawRate * 0.05, -0.12, 0.12);
    const ctrl = _w.set(lateral, 0.04 + 0.06 * this.flexNow, 0).applyQuaternion(q).add(this.position);
    for (let i = 0; i < this.spine.length; i++) {
      const t = i / (this.spine.length - 1);
      const a = (1 - t) * (1 - t);
      const b = 2 * (1 - t) * t;
      const c = t * t;
      this.spine[i].set(0, 0, 0).addScaledVector(this.hip, a).addScaledVector(ctrl, b).addScaledVector(this.shoulder, c);
    }

    // Legs: ankle from the foot, then two-bone IK root → ankle.
    for (const leg of this.legs) {
      const base = leg.front ? this.shoulder : this.hip;
      leg.root.copy(right).multiplyScalar(leg.side * Math.abs(leg.rootLocal.x)).add(base);
      leg.root.addScaledVector(UP, leg.rootLocal.y);
      const fold = leg.swinging ? Math.sin(Math.PI * leg.s) : 0;
      // Metapodial direction from foot up to ankle (rotation about the body's right axis; + leans
      // the ankle forward). Hind: hock sits behind the paw and folds further back in swing.
      // Front: carpus slightly behind the paw in stance; the paw flips back (carpus ahead) in swing.
      const tilt = leg.front ? -0.1 + 1.0 * fold : -(0.4 + 0.45 * fold);
      _v.copy(UP).applyAxisAngle(right, tilt);
      leg.ankle.copy(leg.foot).addScaledVector(_v, leg.meta);
      const pole = _w.copy(leg.root).addScaledVector(this.forward, leg.front ? -0.6 : 0.6).addScaledVector(UP, -0.25);
      solveTwoBone(leg.root, leg.ankle, pole, leg.upper, leg.lower, { softness: 0.02 }, leg.ik);
    }

    // Neck and stabilised head.
    const neckBase = _v.set(0, 0.1, 0.4).applyQuaternion(q).add(this.position);
    const head = this.head.position.copy(this.headTarget(_w));
    if (dt > 0) head.y = this.headHeight.update(dt, [head.y])[0];
    else head.y = this.headHeight.y[0];
    const maxReach = 0.34;
    if (head.distanceTo(neckBase) > maxReach) head.sub(neckBase).setLength(maxReach).add(neckBase);
    const mid = _w.copy(neckBase).lerp(head, 0.5).addScaledVector(UP, 0.05);
    for (let i = 0; i < this.neck.length; i++) {
      const t = i / (this.neck.length - 1);
      this.neck[i]
        .set(0, 0, 0)
        .addScaledVector(neckBase, (1 - t) * (1 - t))
        .addScaledVector(mid, 2 * (1 - t) * t)
        .addScaledVector(head, t * t);
    }
    // Look along the travel direction, turned slightly into the turn.
    _w.copy(this.forward).applyAxisAngle(UP, THREE.MathUtils.clamp(this.yawRate * 0.25, -0.5, 0.5));
    this.headLook.lerp(_w, dt > 0 ? 1 - Math.exp(-dt * 6) : 1).normalize();
    lookRotation(_w.copy(this.headLook).addScaledVector(UP, -0.15), UP, this.head.quaternion);

    if (dt > 0) this.tail.update(dt, this.tailAnchor(_w), q, 0.02);
  }
}
