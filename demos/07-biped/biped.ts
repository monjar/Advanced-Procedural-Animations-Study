import * as THREE from 'three';
import { createTwoBoneResult, solveTwoBone, type TwoBoneResult } from '../../src/ik/twoBone';
import { SecondOrderDynamics, SecondOrderVec3 } from '../../src/math/secondOrder';
import { lookRotation } from '../../src/math/quat';
import type { HeightFn } from '../../src/world/terrain';
import { lerpPose, NEUTRAL, RUN, samplePose, WALK, type Pose } from './poses';

export const DIM = {
  hipWidth: 0.1,
  thigh: 0.44,
  shin: 0.44,
  ankleHeight: 0.08,
  toe: 0.15,
  heel: 0.05,
  pelvisHeight: 0.9,
  spine: 0.34,
  shoulderWidth: 0.19,
  upperArm: 0.28,
  forearm: 0.26,
};

const UP = new THREE.Vector3(0, 1, 0);

export interface Foot {
  /** +1 left, −1 right. */
  side: number;
  /** Phase offset: right foot contacts at 0, left at 0.5. */
  offset: number;
  /** Ground point under the ankle while planted (world). */
  planted: THREE.Vector3;
  /** Current ground point under the ankle (world; includes swing arc). */
  ground: THREE.Vector3;
  ankle: THREE.Vector3;
  toe: THREE.Vector3;
  heel: THREE.Vector3;
  /** Foot pitch (rad, + toe up). */
  pitch: number;
  swinging: boolean;
  s: number;
  duration: number;
  fromRel: THREE.Vector3;
  toRel: THREE.Vector3;
  prevPhase: number;
  skipLift: boolean;
  hip: THREE.Vector3;
  ik: TwoBoneResult;
}

export interface Arm {
  shoulder: THREE.Vector3;
  elbow: THREE.Vector3;
  hand: THREE.Vector3;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _a = new THREE.Vector3();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function frac(x: number): number {
  return x - Math.floor(x);
}

/**
 * Biped driven by a stride wheel (phase advances with distance travelled, not time), key poses for the
 * upper body, planted feet + two-bone IK for the legs, and springs for weight.
 */
export class Biped {
  readonly position = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  yawRate = 0;
  phase = 0;
  /** Gait blend weights. */
  wRun = 0;
  wIdle = 1;
  duty = 0.62;
  strideLength = 1;
  readonly pose: Pose = { ...NEUTRAL };
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly left = new THREE.Vector3(1, 0, 0);
  readonly pelvis = new THREE.Vector3();
  readonly pelvisQuat = new THREE.Quaternion();
  readonly chest = new THREE.Vector3();
  readonly chestQuat = new THREE.Quaternion();
  readonly spine: THREE.Vector3[] = Array.from({ length: 4 }, () => new THREE.Vector3());
  readonly neck = new THREE.Vector3();
  readonly head = new THREE.Vector3();
  readonly headQuat = new THREE.Quaternion();
  readonly feet: Foot[];
  readonly arms: Arm[];
  /** Pelvis drop applied to keep both legs within reach (diagnostics). */
  reachDrop = 0;

  private readonly pelvisSpring: SecondOrderDynamics;
  private readonly chestUp: SecondOrderVec3;
  private readonly headHeight: SecondOrderDynamics;
  private readonly accel: SecondOrderDynamics;
  private prevSpeed = 0;
  private idle = 0;
  private time = 0;
  private readonly walkPose: Pose = { ...NEUTRAL };
  private readonly runPose: Pose = { ...NEUTRAL };

  constructor(
    private readonly height: HeightFn,
    start: THREE.Vector3,
  ) {
    this.position.set(start.x, height(start.x, start.z), start.z);
    const mk = (side: number, offset: number): Foot => ({
      side,
      offset,
      planted: new THREE.Vector3(),
      ground: new THREE.Vector3(),
      ankle: new THREE.Vector3(),
      toe: new THREE.Vector3(),
      heel: new THREE.Vector3(),
      pitch: 0,
      swinging: false,
      s: 0,
      duration: 0.3,
      fromRel: new THREE.Vector3(),
      toRel: new THREE.Vector3(),
      prevPhase: 0,
      skipLift: false,
      hip: new THREE.Vector3(),
      ik: createTwoBoneResult(),
    });
    this.feet = [mk(-1, 0), mk(1, 0.5)];
    for (const f of this.feet) {
      this.fromLocal(_v.set(f.side * DIM.hipWidth, 0, 0), f.planted);
      f.ground.copy(f.planted);
    }
    this.arms = [0, 1].map(() => ({ shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), hand: new THREE.Vector3() }));
    this.pelvisSpring = new SecondOrderDynamics({ f: 3.2, zeta: 0.55, r: 0 }, [this.position.y + DIM.pelvisHeight]);
    this.chestUp = new SecondOrderVec3({ f: 2.6, zeta: 0.55, r: 0 }, UP);
    this.headHeight = new SecondOrderDynamics({ f: 2.5, zeta: 0.9, r: 0 }, [this.position.y + DIM.pelvisHeight + 0.6]);
    this.accel = new SecondOrderDynamics({ f: 1.5, zeta: 1, r: 0 }, [0]);
    this.solve(0);
  }

  /** Yaw-frame offset (x left, z forward) → world, height set to the terrain. */
  fromLocal(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.copy(local).setY(0).applyAxisAngle(UP, this.yaw);
    out.x += this.position.x;
    out.z += this.position.z;
    out.y = this.height(out.x, out.z);
    return out;
  }

  private toLocal(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(p.x - this.position.x, 0, p.z - this.position.z).applyAxisAngle(UP, -this.yaw);
  }

  update(dt: number, targetSpeed: number, turn: number): void {
    this.time += dt;
    const accel = targetSpeed > this.speed ? 2.5 : 4;
    this.speed += THREE.MathUtils.clamp(targetSpeed - this.speed, -accel * dt, accel * dt);
    this.yawRate += (turn - this.yawRate) * (1 - Math.exp(-dt * 6));
    this.yaw += this.yawRate * dt;
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.left.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.position.addScaledVector(this.forward, this.speed * dt);
    this.position.y = this.height(this.position.x, this.position.z);
    this.accel.update(dt, [(this.speed - this.prevSpeed) / dt]);
    this.prevSpeed = this.speed;

    // Gait blend and the stride wheel: phase advances with distance, so strides never skate.
    const v = this.speed;
    this.wRun = smoothstep(1.9, 2.7, v);
    this.wIdle = 1 - smoothstep(0.05, 0.5, v);
    this.strideLength = THREE.MathUtils.lerp(0.75 + 0.42 * v, 1.1 + 0.45 * v, this.wRun);
    // Duty factor falls with speed (contact time shortens faster than the stride grows).
    this.duty = THREE.MathUtils.lerp(0.62, THREE.MathUtils.lerp(0.36, 0.27, smoothstep(3, 6, v)), this.wRun);
    this.phase += (v / this.strideLength) * dt;

    samplePose(WALK, this.phase, this.walkPose);
    samplePose(RUN, this.phase, this.runPose);
    lerpPose(this.walkPose, this.runPose, this.wRun, this.pose);
    lerpPose(this.pose, NEUTRAL, this.wIdle, this.pose);

    this.stepFeet(dt);
    this.solve(dt);
  }

  private stepFeet(dt: number): void {
    const v = this.speed;
    const moving = v > 0.05;
    this.idle = moving ? 0 : this.idle + dt;
    const stanceTime = moving ? (this.duty * this.strideLength) / v : 0;
    const swingTime = moving ? Math.min(0.6, ((1 - this.duty) * this.strideLength) / v) : 0.35;

    for (const f of this.feet) {
      const p = frac(this.phase - f.offset);
      const crossed = moving && f.prevPhase < this.duty && p >= this.duty && p - f.prevPhase < 0.5;
      f.prevPhase = p;
      if (crossed) {
        if (f.skipLift) f.skipLift = false;
        else if (!f.swinging) this.lift(f, swingTime, stanceTime);
      }
    }
    // Standing or turning on the spot: step the foot furthest from its neutral spot.
    if (this.idle > 0.3 && !this.feet.some((f) => f.swinging)) {
      let worst: Foot | null = null;
      let worstD = 0.07;
      for (const f of this.feet) {
        const d = f.planted.distanceTo(this.fromLocal(_v.set(f.side * DIM.hipWidth, 0, 0), _w));
        if (d > worstD) {
          worstD = d;
          worst = f;
        }
      }
      if (worst) this.lift(worst, 0.32, 0);
    }

    const arc = THREE.MathUtils.lerp(0.09, 0.2, this.wRun);
    for (const f of this.feet) {
      const p = frac(this.phase - f.offset);
      if (!f.swinging) {
        f.ground.copy(f.planted);
        // Heel-off over the last part of stance (pivot on the toe).
        const u = moving ? p / this.duty : 0;
        f.pitch = -smoothstep(0.55, 1, u) * THREE.MathUtils.lerp(0.35, 0.6, this.wRun);
        continue;
      }
      f.s = Math.min(1, f.s + dt / f.duration);
      const e = f.s * f.s * (3 - 2 * f.s);
      this.fromLocal(_v.lerpVectors(f.fromRel, f.toRel, e), f.ground);
      f.ground.y += Math.sin(Math.PI * f.s) * arc * (moving ? 1 : 0.5);
      // Toe down after push-off → toe up just before heel strike.
      f.pitch = THREE.MathUtils.lerp(-THREE.MathUtils.lerp(0.35, 0.6, this.wRun), 0.25, smoothstep(0, 0.9, f.s));
      if (!moving) f.pitch *= 0.3;
      if (f.s >= 1) {
        f.swinging = false;
        f.ground.y = this.height(f.ground.x, f.ground.z);
        f.planted.copy(f.ground);
        f.pitch = 0;
      }
    }
  }

  private lift(f: Foot, swingTime: number, stanceTime: number): void {
    f.swinging = true;
    f.s = 0;
    f.duration = Math.max(0.12, swingTime);
    this.toLocal(f.planted, f.fromRel);
    f.toRel.set(f.side * DIM.hipWidth, 0, this.speed * stanceTime * 0.5);
  }

  /** Foot points from the ground point and pitch: pivot on the toe in stance, on the ankle in swing. */
  private footPoints(f: Foot): void {
    const fw = this.forward;
    const lat = this.left;
    f.ankle.copy(f.ground).addScaledVector(UP, DIM.ankleHeight);
    f.toe.copy(f.ground).addScaledVector(fw, DIM.toe);
    f.heel.copy(f.ground).addScaledVector(fw, -DIM.heel);
    if (f.pitch === 0) return;
    // + pitch = toe up = rotation about the left axis by −pitch.
    _q.setFromAxisAngle(lat, -f.pitch);
    const pivot = f.swinging ? f.ankle.clone() : f.toe.clone();
    for (const p of [f.ankle, f.toe, f.heel]) p.sub(pivot).applyQuaternion(_q).add(pivot);
  }

  private solve(dt: number): void {
    const pose = this.pose;
    for (const f of this.feet) this.footPoints(f);

    // Pelvis height: above the feet's ground, minus the pose drop, sprung for weight.
    // (planted points, so the swing arc does not lift the pelvis; capped near the lower foot on slopes)
    const groundY = (this.feet[0].planted.y + this.feet[1].planted.y) / 2;
    const minGround = Math.min(this.feet[0].planted.y, this.feet[1].planted.y);
    const base = Math.min(groundY, minGround + 0.15);
    const breathe = this.wIdle * 0.006 * Math.sin(this.time * 1.6);
    const targetY = base + DIM.pelvisHeight - pose.drop + breathe;
    let pelvisY = dt > 0 ? this.pelvisSpring.update(dt, [targetY])[0] : targetY;

    // Lateral sway and orientation.
    this.pelvis.copy(this.position).addScaledVector(this.left, pose.sway);
    const tilt = 0.04 + pose.lean * 0.25;
    _e.set(tilt, this.yaw + pose.yaw, pose.roll, 'YXZ');
    this.pelvisQuat.setFromEuler(_e);

    // Hard constraint: lower the pelvis until both ankles are within reach.
    const reach = (DIM.thigh + DIM.shin) * 0.985;
    this.reachDrop = 0;
    for (let iter = 0; iter < 2; iter++) {
      this.pelvis.y = pelvisY;
      let drop = 0;
      for (const f of this.feet) {
        this.hipOf(f, f.hip);
        const dx = f.hip.x - f.ankle.x;
        const dz = f.hip.z - f.ankle.z;
        const horiz2 = dx * dx + dz * dz;
        if (horiz2 >= reach * reach) continue;
        const maxY = f.ankle.y + Math.sqrt(reach * reach - horiz2);
        drop = Math.max(drop, f.hip.y - maxY);
      }
      if (drop <= 1e-6) break;
      pelvisY -= drop;
      this.reachDrop += drop;
      if (dt > 0) this.pelvisSpring.setOutput([Math.min(this.pelvisSpring.y[0], pelvisY)]);
    }
    this.pelvis.y = pelvisY;

    // Legs: two-bone IK, knee toward the walking direction.
    for (const f of this.feet) {
      this.hipOf(f, f.hip);
      const pole = _w.copy(f.hip).addScaledVector(this.forward, 1).addScaledVector(this.left, f.side * 0.15);
      solveTwoBone(f.hip, f.ankle, pole, DIM.thigh, DIM.shin, { softness: 0.015 }, f.ik);
    }

    // Chest: counter-rotation, lean (pose + acceleration), sprung so it lags and overshoots.
    const accLean = THREE.MathUtils.clamp(this.accel.y[0] * 0.035, -0.25, 0.3);
    _e.set(pose.lean + accLean, this.yaw + pose.yaw + pose.twist, -pose.roll * 0.6, 'YXZ');
    this.chestQuat.setFromEuler(_e);
    const upTarget = _v.copy(UP).applyQuaternion(this.chestQuat);
    const up = dt > 0 ? this.chestUp.update(dt, upTarget) : upTarget;
    _q.setFromUnitVectors(upTarget, _a.copy(up).normalize());
    this.chestQuat.premultiply(_q);
    this.chest.copy(UP).applyQuaternion(this.chestQuat).multiplyScalar(DIM.spine).add(this.pelvis);
    const pelvisUp = _w.copy(UP).applyQuaternion(this.pelvisQuat);
    const mid = _a.copy(this.pelvis).addScaledVector(pelvisUp, DIM.spine * 0.5);
    for (let i = 0; i < this.spine.length; i++) {
      const t = i / (this.spine.length - 1);
      this.spine[i]
        .set(0, 0, 0)
        .addScaledVector(this.pelvis, (1 - t) * (1 - t))
        .addScaledVector(mid, 2 * (1 - t) * t)
        .addScaledVector(this.chest, t * t);
    }

    // Arms: forward kinematics from the key pose, in the chest frame.
    const chestLeft = _w.set(1, 0, 0).applyQuaternion(this.chestQuat);
    const chestUpV = _v.set(0, 1, 0).applyQuaternion(this.chestQuat);
    this.arms.forEach((arm, i) => {
      const side = i === 0 ? -1 : 1;
      const pitch = side < 0 ? pose.armR : pose.armL;
      const elbow = side < 0 ? pose.elbowR : pose.elbowL;
      arm.shoulder.copy(this.chest).addScaledVector(chestLeft, side * DIM.shoulderWidth).addScaledVector(chestUpV, -0.03);
      const down = _a.copy(chestUpV).negate().applyAxisAngle(chestLeft, -pitch);
      down.addScaledVector(chestLeft, side * 0.12).normalize();
      arm.elbow.copy(arm.shoulder).addScaledVector(down, DIM.upperArm);
      down.applyAxisAngle(chestLeft, -elbow);
      arm.hand.copy(arm.elbow).addScaledVector(down, DIM.forearm);
    });

    // Head: stays level and steady; height filtered against bob.
    this.neck.copy(this.chest).addScaledVector(chestUpV, 0.08);
    this.head.copy(this.neck).addScaledVector(UP, 0.17).addScaledVector(this.forward, 0.02);
    if (dt > 0) this.head.y = this.headHeight.update(dt, [this.head.y])[0];
    const look = _a.copy(this.forward).applyAxisAngle(UP, THREE.MathUtils.clamp(this.yawRate * 0.3, -0.6, 0.6));
    lookRotation(look.addScaledVector(UP, -0.05), UP, this.headQuat);
  }

  private hipOf(f: Foot, out: THREE.Vector3): THREE.Vector3 {
    return out.set(f.side * DIM.hipWidth, 0, 0).applyQuaternion(this.pelvisQuat).add(this.pelvis);
  }
}
