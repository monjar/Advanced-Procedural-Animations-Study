import * as THREE from 'three';
import { Biped, DIM } from '../07-biped/biped';
import { solveTwoBone, createTwoBoneResult } from '../../src/ik/twoBone';
import { clampToCone, lookRotation } from '../../src/math/quat';
import { SCENE, type Program, type Step, type Target } from './program';

/**
 * Runs a validated program on the study 07 biped. Locomotion stays the biped's (stride wheel, key poses,
 * springs); this layer only steers it and overlays the upper body: two-bone IK arms (study 02) for pointing,
 * reaching and waving, blended in and out over the biped's own arm swing, and a cone-limited, spring-smoothed
 * look-at with nods and head shakes on top.
 */

const UP = new THREE.Vector3(0, 1, 0);
/** walk_to stops this far from an object's footprint: close enough to reach it. */
const STOP_GAP = 0.32;
const flat = () => 0;

interface Running {
  step: Step;
  index: number;
  t: number;
  /** Arm used (point/reach/wave). */
  arm?: 0 | 1;
  done: boolean;
}

export interface StepResult {
  index: number;
  action: Step['action'];
  /** Seconds from the program start. */
  start: number;
  end: number;
  /** Did the step achieve its intent (arrived, faced, hand on target …)? */
  achieved: boolean;
  /** How close: metres for walk_to / reach_for, degrees for turn_to / point_at / look_at. */
  error: number;
}

export class Performer {
  readonly biped = new Biped(flat, new THREE.Vector3(0, 0, 0));
  /** Viewer position (for the "camera" target). */
  readonly camera = new THREE.Vector3(0, 1.6, 6);
  program: Program | null = null;
  time = 0;
  readonly results: StepResult[] = [];
  /** Indices of the steps currently running. */
  readonly active: number[] = [];

  private queue: Step[] = [];
  private next = 0;
  private running: Running[] = [];
  private lookTarget: Target | 'none' = 'none';
  private lookUntil = Infinity;
  private readonly lookDir = new THREE.Vector3(0, 0, 1);
  private readonly lookVel = new THREE.Vector3();
  private readonly armWeight = [0, 0];
  private readonly armGoal: (THREE.Vector3 | null)[] = [null, null];
  private readonly armTarget = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly ik = createTwoBoneResult();
  private headNod = 0;
  /** Crouch (m the upper body drops) and its spring state. */
  crouch = 0;
  private crouchVel = 0;
  private crouchGoal = 0;
  private headShake = 0;
  private speed = 0;
  private turn = 0;

  load(program: Program): void {
    this.program = program;
    this.queue = program.steps;
    this.next = 0;
    this.running = [];
    this.results.length = 0;
    this.time = 0;
  }

  get finished(): boolean {
    return !!this.program && this.next >= this.queue.length && this.running.length === 0;
  }

  /** World point of a target. */
  point(target: Target | 'none', out = new THREE.Vector3()): THREE.Vector3 {
    if (target === 'camera') return out.copy(this.camera);
    if (target === 'ahead' || target === 'none') return out.copy(this.biped.position).addScaledVector(this.biped.forward, 5).setY(1.5);
    const o = SCENE.find((s) => s.id === target)!;
    return out.set(o.x, o.y, o.z);
  }

  /** Where a hand touches an object: its top surface, on the side facing the character. */
  touchPoint(target: Target | 'none', out = new THREE.Vector3()): THREE.Vector3 {
    const o = SCENE.find((s) => s.id === target);
    if (!o) return this.point(target, out);
    const dx = this.biped.position.x - o.x;
    const dz = this.biped.position.z - o.z;
    const d = Math.hypot(dx, dz) || 1;
    return out.set(o.x + (dx / d) * o.radius * 0.6, o.touch, o.z + (dz / d) * o.radius * 0.6);
  }

  private headingError(target: Target | 'none'): number {
    const p = this.point(target);
    const d = new THREE.Vector3(p.x - this.biped.position.x, 0, p.z - this.biped.position.z);
    if (d.lengthSq() < 1e-6) return 0;
    return Math.atan2(d.x, d.z) - this.biped.yaw;
  }

  private startGroup(): void {
    if (this.next >= this.queue.length) return;
    const first = this.next;
    do {
      const step = this.queue[this.next];
      const r: Running = { step, index: this.next, t: 0, done: false };
      if (step.action === 'point_at' || step.action === 'reach_for' || step.action === 'wave') r.arm = this.chooseArm(step);
      if (step.action === 'look_at') {
        this.lookTarget = step.target ?? 'none';
        this.lookUntil = step.seconds ? this.time + step.seconds : Infinity;
      }
      this.running.push(r);
      this.next++;
    } while (this.next < this.queue.length && this.queue[this.next].with_previous && this.next > first);
  }

  /** 0 = right arm, 1 = left arm (the biped's order). */
  private chooseArm(step: Step): 0 | 1 {
    if (step.hand === 'right') return 0;
    if (step.hand === 'left') return 1;
    if (!step.target || step.target === 'none') return 0;
    // The hand on the target's side: positive heading error is to the character's left.
    let e = this.headingError(step.target);
    e = Math.atan2(Math.sin(e), Math.cos(e));
    return e > 0 ? 1 : 0;
  }

  private finish(r: Running, achieved: boolean, error: number): void {
    r.done = true;
    this.results.push({ index: r.index, action: r.step.action, start: this.time - r.t, end: this.time, achieved, error });
  }

  update(dt: number): void {
    this.time += dt;
    if (this.program && this.running.length === 0) this.startGroup();
    this.active.length = 0;
    for (const r of this.running) this.active.push(r.index);

    this.speed = 0;
    this.turn = 0;
    this.armGoal[0] = this.armGoal[1] = null;
    this.crouchGoal = 0;
    const b = this.biped;
    for (const r of this.running) {
      r.t += dt;
      const s = r.step;
      switch (s.action) {
        case 'walk_to': {
          const p = this.point(s.target!);
          const o = SCENE.find((x) => x.id === s.target)!;
          const dist = Math.hypot(p.x - b.position.x, p.z - b.position.z) - o.radius - STOP_GAP;
          let e = this.headingError(s.target!);
          e = Math.atan2(Math.sin(e), Math.cos(e));
          this.turn = THREE.MathUtils.clamp(e * 3, -2.5, 2.5);
          // Slow down to arrive, and to turn sharply; stop when there.
          const arrive = THREE.MathUtils.clamp(dist / (0.5 + s.speed! * 0.6), 0, 1);
          this.speed = s.speed! * arrive * THREE.MathUtils.clamp(1 - Math.abs(e) / 1.6, 0.15, 1);
          if (dist < 0.08 && b.speed < 0.15) this.finish(r, true, Math.max(0, dist));
          else if (r.t > 40) this.finish(r, false, dist);
          break;
        }
        case 'turn_to': {
          let e = this.headingError(s.target!);
          e = Math.atan2(Math.sin(e), Math.cos(e));
          this.turn = THREE.MathUtils.clamp(e * 3, -2, 2);
          if (Math.abs(e) < THREE.MathUtils.degToRad(5) && Math.abs(b.yawRate) < 0.2) this.finish(r, true, THREE.MathUtils.radToDeg(Math.abs(e)));
          else if (r.t > 8) this.finish(r, false, THREE.MathUtils.radToDeg(Math.abs(e)));
          break;
        }
        case 'wait':
          if (r.t >= (s.seconds ?? 1)) this.finish(r, true, 0);
          break;
        case 'look_at': {
          // Starts the attention change; the step itself ends once the head has turned (or after a second).
          const err = this.lookError();
          if (r.t > 0.25 && (err < 10 || r.t > 1.2)) this.finish(r, err < 25, err);
          break;
        }
        case 'point_at':
        case 'reach_for': {
          const arm = b.arms[r.arm!];
          const p = this.point(s.target!);
          const goal = this.armTarget[r.arm!];
          if (s.action === 'point_at') {
            // Straight arm along the line from the shoulder to the target.
            goal.subVectors(p, arm.shoulder).normalize().multiplyScalar((DIM.upperArm + DIM.forearm) * 0.98).add(arm.shoulder);
          } else {
            this.touchPoint(s.target!, goal);
            // Low things need the knees: drop the shoulders to within ~0.3 m above the touch point.
            this.crouchGoal = Math.max(this.crouchGoal, THREE.MathUtils.clamp(b.pelvis.y + this.crouch + DIM.spine - goal.y - 0.32, 0, 0.42));
          }
          this.armGoal[r.arm!] = goal;
          const hold = s.seconds ?? 2;
          if (r.t >= hold) {
            let err: number;
            if (s.action === 'point_at') {
              const a = new THREE.Vector3().subVectors(arm.hand, arm.shoulder).normalize();
              const t = new THREE.Vector3().subVectors(p, arm.shoulder).normalize();
              err = THREE.MathUtils.radToDeg(a.angleTo(t));
              this.finish(r, err < 10, err);
            } else {
              err = arm.hand.distanceTo(this.touchPoint(s.target!, new THREE.Vector3()));
              this.finish(r, err < 0.12, err);
            }
          }
          break;
        }
        case 'wave': {
          const arm = b.arms[r.arm!];
          const side = r.arm === 0 ? -1 : 1;
          const n = s.times ?? 3;
          const swing = Math.sin(r.t * Math.PI * 2 * 1.6) * 0.14;
          this.armTarget[r.arm!]
            .copy(arm.shoulder)
            .addScaledVector(UP, 0.42)
            .addScaledVector(b.left, side * (0.22 + swing))
            .addScaledVector(b.forward, 0.12);
          this.armGoal[r.arm!] = this.armTarget[r.arm!];
          if (r.t >= 0.35 + n / 1.6) this.finish(r, true, 0);
          break;
        }
        case 'nod':
        case 'shake_head': {
          const n = s.times ?? 2;
          const T = 0.45;
          const ph = Math.min(1, r.t / (n * T));
          const v = Math.sin((r.t / T) * Math.PI * 2) * Math.sin(Math.PI * ph) * (s.action === 'nod' ? 0.28 : 0.42);
          if (s.action === 'nod') this.headNod = v;
          else this.headShake = v;
          if (r.t >= n * T) {
            this.headNod = this.headShake = 0;
            this.finish(r, true, 0);
          }
          break;
        }
      }
    }
    this.running = this.running.filter((r) => !r.done);
    if (this.time > this.lookUntil) {
      this.lookTarget = 'none';
      this.lookUntil = Infinity;
    }

    b.update(dt, this.speed, this.turn);
    this.overlay(dt);
  }

  /** Angle (degrees) between where the head points and its look target. */
  lookError(): number {
    if (this.lookTarget === 'none') return 0;
    const head = this.biped.head;
    const t = this.point(this.lookTarget).sub(head).normalize();
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.biped.headQuat);
    return THREE.MathUtils.radToDeg(f.angleTo(t));
  }

  private overlay(dt: number): void {
    const b = this.biped;
    // --- Crouch: lower everything above the hips and bend the knees to keep the feet planted.
    {
      const y = (4 * Math.LN2) / 0.18 / 2;
      const j0 = this.crouch - this.crouchGoal;
      const j1 = this.crouchVel + j0 * y;
      const e = Math.exp(-y * dt);
      this.crouch = e * (j0 + j1 * dt) + this.crouchGoal;
      this.crouchVel = e * (this.crouchVel - j1 * y * dt);
    }
    if (this.crouch > 1e-4) {
      const c = this.crouch;
      for (const p of [b.pelvis, b.chest, b.neck, b.head, ...b.spine]) p.y -= c;
      for (const a of b.arms) {
        a.shoulder.y -= c;
        a.elbow.y -= c;
        a.hand.y -= c;
      }
      for (const f of b.feet) {
        f.hip.y -= c;
        const pole = new THREE.Vector3().copy(f.hip).addScaledVector(b.forward, 1).addScaledVector(b.left, f.side * 0.15);
        solveTwoBone(f.hip, f.ankle, pole, DIM.thigh, DIM.shin, { softness: 0.015 }, f.ik);
      }
    }
    // --- Arms: blend the IK target in over ~0.25 s and back out, so arms never pop.
    for (let i = 0; i < 2; i++) {
      const goal = this.armGoal[i];
      const k = 1 - Math.exp(-dt / 0.12);
      this.armWeight[i] += ((goal ? 1 : 0) - this.armWeight[i]) * k;
      const w = this.armWeight[i];
      if (w < 1e-3) continue;
      const arm = b.arms[i];
      const side = i === 0 ? -1 : 1;
      const target = new THREE.Vector3().lerpVectors(arm.hand, goal ?? this.armTarget[i], w);
      // Elbow down and out, a little back: the natural bend plane.
      const pole = new THREE.Vector3().copy(arm.shoulder).addScaledVector(UP, -0.6).addScaledVector(b.left, side * 0.5).addScaledVector(b.forward, -0.3);
      solveTwoBone(arm.shoulder, target, pole, DIM.upperArm, DIM.forearm, { softness: 0.01 }, this.ik);
      arm.elbow.copy(this.ik.mid);
      arm.hand.copy(this.ik.end);
    }
    // --- Head: spring the look direction toward the target, clamped to ±75° of the chest's facing.
    const desired = this.lookTarget === 'none' ? new THREE.Vector3(0, 0, 1).applyQuaternion(b.headQuat) : this.point(this.lookTarget).sub(b.head).normalize();
    const chestFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(b.chestQuat).setY(0).normalize();
    clampToCone(desired, chestFwd, THREE.MathUtils.degToRad(75), desired);
    const y = (4 * Math.LN2) / 0.12 / 2;
    const j0 = this.lookDir.clone().sub(desired);
    const j1 = this.lookVel.clone().addScaledVector(j0, y);
    const e = Math.exp(-y * dt);
    this.lookDir.copy(j0.clone().addScaledVector(j1, dt).multiplyScalar(e).add(desired)).normalize();
    this.lookVel.copy(this.lookVel.clone().addScaledVector(j1, -y * dt).multiplyScalar(e));
    lookRotation(this.lookDir, UP, b.headQuat);
    if (this.headNod || this.headShake) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.headNod, this.headShake, 0, 'YXZ'));
      b.headQuat.multiply(q);
    }
  }
}
