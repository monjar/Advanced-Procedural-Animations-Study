import * as THREE from 'three';
import type { ClipData } from '../../src/anim/clip';
import { ClipPlayer } from '../../src/anim/clip';
import { asSpherical, driveSpherical, RAPIER } from '../../src/physics/rapier';

/**
 * A pinned active ragdoll (the PuppetMaster model): every body is a rigid capsule following one bone of a
 * kinematic target pose. Two things pull it there —
 *  - **muscles**: implicit joint motors on each joint driving the parent→child relative rotation to the
 *    target's (strength ∝ the gravity torque the joint has to hold);
 *  - **pins**: a velocity blend of each body towards the target body's position and orientation, i.e. the
 *    "hand of god" that keeps an animated ragdoll upright.
 * Hits knock muscle and pin strength out of the bodies around the impact, which then regain it; a fall drops
 * the pins, the body goes limp, and recovery fades the pins back in at the target moved to where it lies.
 */

export interface BodyDef {
  name: string;
  /** Bone whose world transform the body follows (the body's frame is that bone's frame). */
  bone: string;
  parent?: string;
  /** Capsule end points, as joint names (or a joint name + an offset in the bone frame). */
  a: string;
  b: string;
  extend?: number;
  radius: number;
  /** Fraction of body mass (de Leva 1996). */
  mass: number;
}

export const BODY_DEFS: BodyDef[] = [
  { name: 'pelvis', bone: 'Hips', a: 'LeftUpLeg', b: 'RightUpLeg', radius: 0.09, mass: 0.1117 },
  { name: 'abdomen', bone: 'Spine', parent: 'pelvis', a: 'Spine', b: 'Spine1', radius: 0.1, mass: 0.1633 },
  { name: 'chest', bone: 'Spine1', parent: 'abdomen', a: 'LeftArm', b: 'RightArm', radius: 0.1, mass: 0.1596 },
  { name: 'head', bone: 'Neck1', parent: 'chest', a: 'Neck1', b: 'Head', extend: 0.06, radius: 0.1, mass: 0.0694 },
  { name: 'upperArmL', bone: 'LeftArm', parent: 'chest', a: 'LeftArm', b: 'LeftForeArm', radius: 0.045, mass: 0.0271 },
  { name: 'forearmL', bone: 'LeftForeArm', parent: 'upperArmL', a: 'LeftForeArm', b: 'LeftHand', extend: 0.08, radius: 0.04, mass: 0.0223 },
  { name: 'upperArmR', bone: 'RightArm', parent: 'chest', a: 'RightArm', b: 'RightForeArm', radius: 0.045, mass: 0.0271 },
  { name: 'forearmR', bone: 'RightForeArm', parent: 'upperArmR', a: 'RightForeArm', b: 'RightHand', extend: 0.08, radius: 0.04, mass: 0.0223 },
  { name: 'thighL', bone: 'LeftUpLeg', parent: 'pelvis', a: 'LeftUpLeg', b: 'LeftLeg', radius: 0.065, mass: 0.1416 },
  { name: 'shinL', bone: 'LeftLeg', parent: 'thighL', a: 'LeftLeg', b: 'LeftFoot', radius: 0.05, mass: 0.0433 },
  { name: 'footL', bone: 'LeftFoot', parent: 'shinL', a: 'LeftFoot', b: 'LeftToeBase', radius: 0.04, mass: 0.0137 },
  { name: 'thighR', bone: 'RightUpLeg', parent: 'pelvis', a: 'RightUpLeg', b: 'RightLeg', radius: 0.065, mass: 0.1416 },
  { name: 'shinR', bone: 'RightLeg', parent: 'thighR', a: 'RightLeg', b: 'RightFoot', radius: 0.05, mass: 0.0433 },
  { name: 'footR', bone: 'RightFoot', parent: 'shinR', a: 'RightFoot', b: 'RightToeBase', radius: 0.04, mass: 0.0137 },
];

export const TOTAL_MASS = 70;
/**
 * Hit response: an impulse of `local` N·s takes all pin strength from the body hit (falling off by `falloff`
 * per joint away), and `global` N·s would take it from the whole body.
 */
export const HIT = { local: 40, global: 220, falloff: 0.6 };
const GROUND = 0x0002;
const RAGDOLL = 0x0001;
/**
 * Pin: gap-closing time and blend time constant (s) at full weight, and the exponent applied to the weight
 * (PuppetMaster's "pin power": a half-lost pin is much weaker than half as strong, so hits read).
 */
export const PIN = { close: 0.08, tau: 0.015, power: 3 };
/** Muscle stiffness such that full strength sags this much (rad) under the subtree's own weight. */
const MUSCLE_SAG = 0.04;
/** Muscle and pin strength kept while limp. */
const LIMP_MUSCLE = 0.12;

export type RagdollState = 'active' | 'fallen' | 'recovering';
export type TargetMode = 'walk' | 'stand';

export interface Body {
  def: BodyDef;
  index: number;
  rb: RAPIER.RigidBody;
  /** Capsule end points in the body frame. */
  a: THREE.Vector3;
  b: THREE.Vector3;
  parent: number;
  /** Local hit damage: 1 = full strength. */
  muscle: number;
  pin: number;
  /** Previous / current pose (for render interpolation). */
  prevPos: THREE.Vector3;
  prevRot: THREE.Quaternion;
}

export interface Joint {
  child: number;
  parent: number;
  joint: RAPIER.SphericalImpulseJoint;
  stiffness: number;
  damping: number;
  /** Anchors in the parent and child body frames. */
  anchor1: THREE.Vector3;
  anchor2: THREE.Vector3;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _qt = new THREE.Quaternion();

export interface RagdollSettings {
  /** Global muscle strength (0..1.5). */
  muscle: number;
  /** Global pin weight (0..1): balance assist. */
  pin: number;
  /** Seconds a body takes to regain lost strength after a hit. */
  regain: number;
  /** Fall detection on/off (off: hits never drop the pins entirely). */
  autoFall: boolean;
  /** Seconds lying limp before recovery starts. */
  limpTime: number;
  /** Seconds the pins take to fade back in. */
  recoverTime: number;
}

export class Ragdoll {
  readonly world: RAPIER.World;
  readonly bodies: Body[] = [];
  readonly joints: Joint[] = [];
  readonly target: ClipPlayer;
  readonly settings: RagdollSettings = { muscle: 1, pin: 1, regain: 1.5, autoFall: true, limpTime: 2, recoverTime: 1.5 };
  mode: TargetMode = 'walk';
  state: RagdollState = 'active';
  stateTime = 0;
  /** Recovery ramp 0..1 (pins and muscles fade back in). */
  private recovery = 1;
  time = 0;
  /** Target body poses (current substep) and their previous values for velocities. */
  private readonly tPos: THREE.Vector3[] = [];
  private readonly tRot: THREE.Quaternion[] = [];
  private readonly tPrevPos: THREE.Vector3[] = [];
  private readonly tPrevRot: THREE.Quaternion[] = [];
  /** Height added to the target so the capsule feet stand on the floor. */
  readonly lift: number;
  private readonly restWorld: Map<string, THREE.Vector3>;
  private readonly standRot: Map<string, THREE.Quaternion>;
  /** Target root offset (moved under the body when recovering). */
  readonly targetOffset = new THREE.Vector3();

  constructor(
    readonly clip: ClipData,
    readonly dt = 1 / 240,
  ) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = dt;
    this.target = new ClipPlayer(clip);

    // Rest pose: every BVH bone has identity orientation, so joint positions are summed offsets.
    this.restWorld = new Map();
    clip.joints.forEach((j) => {
      const p = new THREE.Vector3().fromArray(j.offset);
      if (j.parent >= 0) p.add(this.restWorld.get(clip.joints[j.parent].name)!);
      this.restWorld.set(j.name, p);
    });
    // Standing pose: rest legs and spine, arms lowered from the T-pose.
    this.standRot = new Map([
      ['LeftArm', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -1.25)],
      ['RightArm', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.25)],
      ['LeftForeArm', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.25)],
      ['RightForeArm', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.25)],
    ]);
    // Lift so the toe capsule clears the floor in the clip's lowest frame.
    let minToe = Infinity;
    for (let f = 0; f < clip.frames; f++) {
      this.target.time = f / clip.fps;
      this.target.apply();
      for (const n of ['LeftToeBase', 'RightToeBase', 'LeftFoot', 'RightFoot']) minToe = Math.min(minToe, this.target.bone(n).getWorldPosition(_v).y);
    }
    this.lift = Math.max(0, 0.04 - minToe) + 0.005;

    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(200, 0.5, 200)
        .setTranslation(0, -0.5, 0)
        .setFriction(1)
        .setCollisionGroups((GROUND << 16) | RAGDOLL),
    );
    this.buildBodies();
    this.reset();
  }

  private buildBodies(): void {
    const rest = this.restWorld;
    for (const def of BODY_DEFS) {
      const origin = rest.get(def.bone)!;
      const a = rest.get(def.a)!.clone().sub(origin);
      const b = rest.get(def.b)!.clone().sub(origin);
      if (def.extend) b.add(_v.subVectors(b, a).normalize().multiplyScalar(def.extend));
      const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(origin.x, origin.y, origin.z).setCanSleep(false));
      const mid = _v.addVectors(a, b).multiplyScalar(0.5);
      const half = a.distanceTo(b) / 2;
      _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _w.subVectors(b, a).normalize());
      this.world.createCollider(
        RAPIER.ColliderDesc.capsule(half, def.radius)
          .setTranslation(mid.x, mid.y, mid.z)
          .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
          .setMass(def.mass * TOTAL_MASS)
          .setFriction(0.9)
          .setCollisionGroups((RAGDOLL << 16) | GROUND),
        rb,
      );
      this.bodies.push({
        def,
        index: this.bodies.length,
        rb,
        a,
        b,
        parent: def.parent ? BODY_DEFS.findIndex((d) => d.name === def.parent) : -1,
        muscle: 1,
        pin: 1,
        prevPos: new THREE.Vector3(),
        prevRot: new THREE.Quaternion(),
      });
      this.tPos.push(new THREE.Vector3());
      this.tRot.push(new THREE.Quaternion());
      this.tPrevPos.push(new THREE.Vector3());
      this.tPrevRot.push(new THREE.Quaternion());
    }
    // Joints at each child's bone origin; muscle gains from the weight each joint carries.
    for (const body of this.bodies) {
      if (body.parent < 0) continue;
      const parent = this.bodies[body.parent];
      const anchor1 = rest.get(body.def.bone)!.clone().sub(rest.get(parent.def.bone)!);
      const anchor2 = new THREE.Vector3();
      const joint = asSpherical(
        this.world.createImpulseJoint(RAPIER.JointData.spherical(anchor1, anchor2), parent.rb, body.rb, true),
      );
      joint.setContactsEnabled(false);
      for (const ax of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) joint.configureMotorModel(ax, RAPIER.MotorModel.ForceBased);
      // Subtree below this joint: mass, and moment arm/inertia about the joint (rest pose).
      const sub = this.subtree(body.index);
      let m = 0;
      const com = new THREE.Vector3();
      let inertia = 0;
      const pivot = rest.get(body.def.bone)!;
      for (const i of sub) {
        const bi = this.bodies[i];
        const mi = bi.def.mass * TOTAL_MASS;
        const c = _v.addVectors(bi.a, bi.b).multiplyScalar(0.5).add(rest.get(bi.def.bone)!);
        m += mi;
        com.addScaledVector(c, mi);
        inertia += mi * c.distanceToSquared(pivot) + (mi * bi.a.distanceToSquared(bi.b)) / 12;
      }
      com.divideScalar(m);
      const arm = Math.max(0.05, com.distanceTo(pivot));
      const stiffness = (m * 9.81 * arm) / MUSCLE_SAG;
      const damping = 2 * Math.sqrt(stiffness * inertia);
      this.joints.push({ child: body.index, parent: parent.index, joint, stiffness, damping, anchor1, anchor2 });
    }
  }

  /** Body indices in the subtree rooted at `i` (inclusive). */
  subtree(i: number): number[] {
    const out = [i];
    for (const b of this.bodies) if (b.parent >= 0 && out.includes(b.parent) && !out.includes(b.index)) out.push(b.index);
    return out;
  }

  /** Put the target at its current time and copy the body target transforms (bone world transforms). */
  private evaluateTarget(): void {
    const p = this.target;
    p.rootOffset.set(this.targetOffset.x, this.lift, this.targetOffset.z);
    if (this.mode === 'walk') p.apply();
    else {
      p.apply();
      // Standing: rest rotations below the hips, arms lowered; keep the clip's hip position and facing.
      for (const bone of p.bones) {
        if (bone === p.bones[0]) continue;
        bone.quaternion.copy(this.standRot.get(bone.name) ?? _qi.identity());
      }
      const hips = p.bones[0];
      hips.quaternion.identity();
      hips.position.set(this.targetOffset.x, -this.restMinY() + this.lift, this.targetOffset.z);
      p.root.updateMatrixWorld(true);
    }
    for (const body of this.bodies) {
      const bone = p.bone(body.def.bone);
      bone.getWorldPosition(this.tPos[body.index]);
      bone.getWorldQuaternion(this.tRot[body.index]);
    }
  }

  private restMinY(): number {
    let m = Infinity;
    for (const n of ['LeftToeBase', 'RightToeBase', 'LeftFoot', 'RightFoot']) m = Math.min(m, this.restWorld.get(n)!.y);
    return m;
  }

  /** Teleport every body onto the target pose, at rest. */
  reset(): void {
    this.state = 'active';
    this.recovery = 1;
    this.stateTime = 0;
    this.evaluateTarget();
    for (const body of this.bodies) {
      const p = this.tPos[body.index];
      const q = this.tRot[body.index];
      body.rb.setTranslation(p, true);
      body.rb.setRotation(q, true);
      body.rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.muscle = body.pin = 1;
      body.prevPos.copy(p);
      body.prevRot.copy(q);
      this.tPrevPos[body.index].copy(p);
      this.tPrevRot[body.index].copy(q);
    }
  }

  setMode(mode: TargetMode): void {
    this.mode = mode;
  }

  /** One physics step. */
  step(): void {
    const dt = this.dt;
    this.time += dt;
    if (this.mode === 'walk') this.target.time += dt;
    for (let i = 0; i < this.bodies.length; i++) {
      this.tPrevPos[i].copy(this.tPos[i]);
      this.tPrevRot[i].copy(this.tRot[i]);
    }
    this.evaluateTarget();
    this.updateState(dt);
    const s = this.settings;
    const ramp = this.state === 'fallen' ? 0 : this.recovery;
    const regain = 1 - Math.exp(-dt / Math.max(0.05, s.regain / 3));

    // Muscles.
    for (const j of this.joints) {
      const child = this.bodies[j.child];
      child.muscle += (1 - child.muscle) * regain;
      const w = Math.max(LIMP_MUSCLE, s.muscle * child.muscle * (this.state === 'fallen' ? LIMP_MUSCLE : Math.max(LIMP_MUSCLE, ramp)));
      _q.copy(this.tRot[j.parent]).invert().multiply(this.tRot[j.child]);
      driveSpherical(j.joint, [_q.x, _q.y, _q.z, _q.w], j.stiffness * w, j.damping * Math.sqrt(w));
    }

    // Pins: blend each body's velocity towards closing the gap to its target.
    const beta = 1 - Math.exp(-dt / PIN.tau);
    for (const body of this.bodies) {
      body.pin += (1 - body.pin) * regain;
      const w = (s.pin * body.pin * ramp) ** PIN.power;
      body.prevPos.copy(body.rb.translation() as THREE.Vector3Like);
      body.prevRot.copy(body.rb.rotation() as THREE.QuaternionLike);
      if (w <= 0) continue;
      const i = body.index;
      const p = body.rb.translation();
      const v = body.rb.linvel();
      // Target velocity + gap / closing time.
      _v.subVectors(this.tPos[i], this.tPrevPos[i]).divideScalar(dt);
      _v.x += (this.tPos[i].x - p.x) / PIN.close;
      _v.y += (this.tPos[i].y - p.y) / PIN.close;
      _v.z += (this.tPos[i].z - p.z) / PIN.close;
      const k = beta * Math.min(1, w);
      body.rb.setLinvel({ x: v.x + (_v.x - v.x) * k, y: v.y + (_v.y - v.y) * k, z: v.z + (_v.z - v.z) * k }, true);
      const r = body.rb.rotation();
      const om = body.rb.angvel();
      angularVelocity(this.tPrevRot[i], this.tRot[i], dt, _w);
      _qt.set(r.x, r.y, r.z, r.w).invert().premultiply(this.tRot[i]);
      rotationVector(_qt, _v);
      _w.addScaledVector(_v, 1 / PIN.close);
      body.rb.setAngvel({ x: om.x + (_w.x - om.x) * k, y: om.y + (_w.y - om.y) * k, z: om.z + (_w.z - om.z) * k }, true);
    }
    this.world.step();
  }

  private updateState(dt: number): void {
    this.stateTime += dt;
    const s = this.settings;
    if (this.state === 'active') {
      this.recovery = Math.min(1, this.recovery + dt / s.recoverTime);
      if (s.autoFall && this.isDown()) this.setState('fallen');
    } else if (this.state === 'fallen') {
      if (this.stateTime > s.limpTime) {
        // Recover where the body lies: move the target root under the pelvis, then fade the pins back in.
        const pelvis = this.bodies[0].rb.translation();
        this.evaluateTarget();
        this.targetOffset.x += pelvis.x - this.tPos[0].x;
        this.targetOffset.z += pelvis.z - this.tPos[0].z;
        this.evaluateTarget();
        for (let i = 0; i < this.bodies.length; i++) {
          this.tPrevPos[i].copy(this.tPos[i]);
          this.tPrevRot[i].copy(this.tRot[i]);
        }
        this.recovery = 0;
        this.setState('recovering');
      }
    } else {
      this.recovery = Math.min(1, this.recovery + dt / s.recoverTime);
      if (this.recovery >= 1) this.setState('active');
    }
  }

  private setState(state: RagdollState): void {
    this.state = state;
    this.stateTime = 0;
  }

  /** Down: pelvis low, head low, torso tipped past 55°, or the pelvis knocked 0.6 m off its target. */
  isDown(): boolean {
    const pelvis = this.bodies[0].rb.translation();
    const head = this.bodies[3].rb.translation();
    const r = this.bodies[2].rb.rotation();
    const up = _v.set(0, 1, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
    const off = Math.hypot(pelvis.x - this.tPos[0].x, pelvis.z - this.tPos[0].z);
    return pelvis.y < 0.5 || head.y < 0.85 || up.y < Math.cos(THREE.MathUtils.degToRad(55)) || off > 0.6;
  }

  /**
   * Hit a body: an impulse at a world point, and strength knocked out of the bodies around it (halving per
   * joint away from the impact) — the PuppetMaster "unpin" that lets a hit read as a hit.
   */
  hit(bodyIndex: number, point: THREE.Vector3, impulse: THREE.Vector3): void {
    this.bodies[bodyIndex].rb.applyImpulseAtPoint(impulse, point, true);
    const J = impulse.length();
    const local = Math.min(1, J / HIT.local);
    const knock = Math.min(0.95, J / HIT.global);
    const dist = this.chainDistances(bodyIndex);
    for (const b of this.bodies) {
      const k = Math.max(local * HIT.falloff ** dist[b.index], knock);
      b.pin = Math.min(b.pin, 1 - k);
      b.muscle = Math.min(b.muscle, 1 - 0.6 * k);
    }
  }

  private chainDistances(from: number): number[] {
    const d = this.bodies.map(() => Infinity);
    d[from] = 0;
    for (let pass = 0; pass < this.bodies.length; pass++) {
      for (const b of this.bodies) {
        if (b.parent < 0) continue;
        d[b.index] = Math.min(d[b.index], d[b.parent] + 1);
        d[b.parent] = Math.min(d[b.parent], d[b.index] + 1);
      }
    }
    return d;
  }

  /** World position of a body's target (bone) — for audits and the ghost. */
  targetPosition(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.tPos[i]);
  }

  targetRotation(i: number, out: THREE.Quaternion): THREE.Quaternion {
    return out.copy(this.tRot[i]);
  }

  /** Largest separation between the two anchors of any joint (m) — a joint-drift measure. */
  jointDrift(): number {
    let worst = 0;
    for (const j of this.joints) {
      const p = this.bodies[j.parent].rb;
      const c = this.bodies[j.child].rb;
      const a = _v.copy(j.anchor1).applyQuaternion(_q.copy(p.rotation() as THREE.QuaternionLike)).add(p.translation() as THREE.Vector3Like);
      const b = _w.copy(j.anchor2).applyQuaternion(_q.copy(c.rotation() as THREE.QuaternionLike)).add(c.translation() as THREE.Vector3Like);
      worst = Math.max(worst, a.distanceTo(b));
    }
    return worst;
  }

  dispose(): void {
    this.world.free();
  }
}

/** Rotation vector (axis·angle) of a quaternion, shortest way. */
function rotationVector(q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  let { x, y, z, w } = q;
  if (w < 0) (x = -x), (y = -y), (z = -z), (w = -w);
  const s = Math.hypot(x, y, z);
  const k = s < 1e-9 ? 2 : (2 * Math.atan2(s, w)) / s;
  return out.set(x * k, y * k, z * k);
}

/** World angular velocity taking `a` to `b` in `dt`. */
function angularVelocity(a: THREE.Quaternion, b: THREE.Quaternion, dt: number, out: THREE.Vector3): THREE.Vector3 {
  _qt.copy(a).invert().premultiply(b);
  return rotationVector(_qt, out).divideScalar(dt);
}
