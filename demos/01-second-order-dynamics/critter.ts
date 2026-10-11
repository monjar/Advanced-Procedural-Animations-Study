import * as THREE from 'three';
import { SecondOrderVec3, type Integrator, type SecondOrderParams } from '../../src/math/secondOrder';

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

/**
 * A chain whose every joint chases its rest position (expressed in the body frame) through
 * its own second-order system, then is projected back to a fixed segment length.
 * Because each joint chases the *lagged* joint before it, motion whips down the chain.
 */
class Chain {
  readonly points: THREE.Vector3[] = [];
  private readonly joints: SecondOrderVec3[] = [];
  private readonly segments: THREE.Mesh[] = [];
  private readonly tip: THREE.Mesh;
  private readonly desired = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(
    scene: THREE.Object3D,
    private readonly restDirs: THREE.Vector3[],
    private readonly length: number,
    radius: [number, number],
    material: THREE.Material,
    tipRadius: number,
    anchor: THREE.Vector3,
    bodyQuat: THREE.Quaternion,
    params: SecondOrderParams,
  ) {
    const n = restDirs.length;
    this.points.push(anchor.clone());
    for (let i = 0; i < n; i++) {
      const p = this.points[i].clone().addScaledVector(restDirs[i].clone().applyQuaternion(bodyQuat), length);
      this.points.push(p);
      this.joints.push(new SecondOrderVec3(params, p));
      const r0 = THREE.MathUtils.lerp(radius[0], radius[1], i / n);
      const r1 = THREE.MathUtils.lerp(radius[0], radius[1], (i + 1) / n);
      const geo = new THREE.CylinderGeometry(r1, r0, 1, 8, 1);
      const seg = new THREE.Mesh(geo, material);
      seg.castShadow = true;
      this.segments.push(seg);
      scene.add(seg);
    }
    this.tip = new THREE.Mesh(new THREE.SphereGeometry(tipRadius, 16, 12), material);
    this.tip.castShadow = true;
    this.tip.visible = tipRadius > 0;
    scene.add(this.tip);
  }

  setParams(p: SecondOrderParams, integrator: Integrator): void {
    for (const j of this.joints) {
      j.core.setParams(p);
      j.core.integrator = integrator;
    }
  }

  update(dt: number, anchor: THREE.Vector3, bodyQuat: THREE.Quaternion): void {
    this.points[0].copy(anchor);
    for (let i = 0; i < this.joints.length; i++) {
      const parent = this.points[i];
      this.desired.copy(this.restDirs[i]).applyQuaternion(bodyQuat).multiplyScalar(this.length).add(parent);
      const y = this.joints[i].update(dt, this.desired);
      this.dir.subVectors(y, parent);
      const len = this.dir.length();
      if (!Number.isFinite(len) || len < 1e-6) this.dir.subVectors(this.desired, parent).normalize();
      else this.dir.divideScalar(len);
      this.points[i + 1].copy(parent).addScaledVector(this.dir, this.length);
      this.joints[i].setOutput(this.points[i + 1]);
    }
  }

  sync(): void {
    const d = new THREE.Vector3();
    for (let i = 0; i < this.segments.length; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];
      const seg = this.segments[i];
      d.subVectors(b, a);
      seg.position.copy(a).addScaledVector(d, 0.5);
      seg.scale.set(1, d.length(), 1);
      seg.quaternion.setFromUnitVectors(UP, d.normalize());
    }
    this.tip.position.copy(this.points[this.points.length - 1]);
  }
}

export interface CritterSettings {
  body: SecondOrderParams;
  antenna: SecondOrderParams;
  tail: SecondOrderParams;
  lean: number;
  hop: number;
}

/** A small hopping creature whose body, facing, lean, antennae and tail are all driven by second-order systems. */
export class Critter {
  readonly group = new THREE.Group();
  private readonly body: SecondOrderVec3;
  private readonly facing: SecondOrderVec3;
  private readonly accel: SecondOrderVec3;
  private readonly chains: { chain: Chain; anchor: THREE.Vector3; kind: 'antenna' | 'tail' }[] = [];
  private readonly prevVel = new THREE.Vector3();
  private readonly rawAccel = new THREE.Vector3();
  private readonly lastFacing = new THREE.Vector3(1, 0, 0);
  private readonly yaw = new THREE.Quaternion();
  private readonly lean = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private phase = 0;
  private readonly baseHeight = 0.45;

  constructor(
    scene: THREE.Object3D,
    start: THREE.Vector3,
    private settings: CritterSettings,
  ) {
    const skin = new THREE.MeshStandardMaterial({ color: 0xff8a3d, roughness: 0.55 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1f, roughness: 0.3 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 });
    const feeler = new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.6 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.45, 8, 16), skin);
    torso.rotation.x = Math.PI / 2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 24, 16), skin);
    head.position.set(0, 0.2, 0.42);
    this.group.add(torso, head);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), white);
      eye.position.set(side * 0.1, 0.3, 0.6);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 8), dark);
      pupil.position.set(side * 0.1, 0.31, 0.668);
      this.group.add(eye, pupil);
    }
    this.group.traverse((o) => (o.castShadow = true));
    scene.add(this.group);

    this.group.position.set(start.x, this.baseHeight, start.z);
    this.body = new SecondOrderVec3(settings.body, start);
    this.facing = new SecondOrderVec3({ f: 1.2, zeta: 1, r: 0 }, this.lastFacing);
    this.accel = new SecondOrderVec3({ f: 2.5, zeta: 1, r: 0 }, new THREE.Vector3());
    this.orient();
    this.group.updateMatrixWorld();

    const antennaDirs = (side: number) =>
      Array.from({ length: 6 }, (_, i) => {
        const t = i / 5;
        return new THREE.Vector3(side * (0.15 + 0.35 * t), 1 - 0.55 * t, 0.15 + 0.9 * t).normalize();
      });
    const tailDirs = Array.from({ length: 8 }, (_, i) => {
      const t = i / 7;
      return new THREE.Vector3(0, 0.55 - 1.0 * t, -1).normalize();
    });

    const q = this.group.quaternion;
    for (const side of [-1, 1]) {
      const anchor = new THREE.Vector3(side * 0.09, 0.42, 0.46);
      const world = this.group.localToWorld(anchor.clone());
      const chain = new Chain(scene, antennaDirs(side), 0.09, [0.018, 0.01], feeler, 0.04, world, q, settings.antenna);
      this.chains.push({ chain, anchor, kind: 'antenna' });
    }
    {
      const anchor = new THREE.Vector3(0, 0.05, -0.5);
      const world = this.group.localToWorld(anchor.clone());
      const chain = new Chain(scene, tailDirs, 0.1, [0.09, 0.02], skin, 0.0, world, q, settings.tail);
      this.chains.push({ chain, anchor, kind: 'tail' });
    }
  }

  configure(settings: CritterSettings, integrator: Integrator): void {
    this.settings = settings;
    this.body.core.setParams(settings.body);
    this.body.core.integrator = integrator;
    for (const { chain, kind } of this.chains) {
      chain.setParams(kind === 'tail' ? settings.tail : settings.antenna, integrator);
    }
  }

  update(dt: number, target: THREE.Vector3): void {
    const pos = this.body.update(dt, target);
    if (!Number.isFinite(pos.x) || pos.distanceTo(target) > 50) this.body.reset(target);
    const vel = this.body.velocity;

    this.rawAccel.subVectors(vel, this.prevVel).divideScalar(dt);
    this.prevVel.copy(vel);
    if (!Number.isFinite(this.rawAccel.x)) this.rawAccel.set(0, 0, 0);
    const accel = this.accel.update(dt, this.rawAccel);

    const speed = Math.hypot(vel.x, vel.z);
    if (speed > 0.15) this.tmp.set(vel.x, 0, vel.z).divideScalar(speed);
    else this.tmp.copy(this.lastFacing);
    const f = this.facing.update(dt, this.tmp);
    if (f.lengthSq() > 1e-4) this.lastFacing.set(f.x, 0, f.z).normalize();

    this.phase += speed * dt * 2.2;
    const hop = Math.abs(Math.sin(this.phase * Math.PI)) * this.settings.hop * Math.min(1, speed / 1.5);

    this.group.position.set(this.body.value.x, this.baseHeight + hop, this.body.value.z);
    this.orient(accel);
    this.group.updateMatrixWorld();

    for (const { chain, anchor } of this.chains) {
      chain.update(dt, this.group.localToWorld(this.tmp.copy(anchor)), this.group.quaternion);
    }
  }

  sync(): void {
    for (const { chain } of this.chains) chain.sync();
  }

  private orient(accel?: THREE.Vector3): void {
    this.yaw.setFromUnitVectors(FWD, this.lastFacing);
    this.lean.identity();
    if (accel) {
      // Tilt the body's up axis toward the horizontal acceleration (lean into the motion).
      const ax = accel.x;
      const az = accel.z;
      const mag = Math.hypot(ax, az);
      if (mag > 1e-4) {
        const angle = Math.min(0.6, mag * this.settings.lean);
        this.tmp.set(az / mag, 0, -ax / mag);
        this.lean.setFromAxisAngle(this.tmp, angle);
      }
    }
    this.group.quaternion.multiplyQuaternions(this.lean, this.yaw);
  }
}
