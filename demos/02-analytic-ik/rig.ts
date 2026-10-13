import * as THREE from 'three';
import { boneRotation, createTwoBoneResult, solveTwoBone, type TwoBoneResult } from '../../src/ik/twoBone';
import { clampRotationAngle, clampToCone, clampTwist, lookRotation, swingTwist } from '../../src/math/quat';
import { SecondOrderVec3, type SecondOrderParams } from '../../src/math/secondOrder';

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const IDENTITY = new THREE.Quaternion();

export interface Materials {
  body: THREE.Material;
  joint: THREE.Material;
  accent: THREE.Material;
  dark: THREE.Material;
  white: THREE.Material;
}

/** Geometry for a bone segment with its origin at the proximal end, extending along +Y. */
function boneGeometry(length: number, r0: number, r1: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r1, r0, length, 16, 1).translate(0, length / 2, 0);
}

function shadowed<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => (c.castShadow = true));
  return o;
}

export interface ArmSettings {
  softness: number;
  stretch: number;
  /** Max wrist swing away from the forearm axis (radians). */
  swingLimit: number;
  /** Max wrist twist about the forearm axis (radians). */
  twistLimit: number;
  /** Fraction of the wrist twist carried by the distal forearm (twist bone). */
  twistShare: number;
}

/**
 * Two-bone arm: analytic IK for shoulder→elbow→wrist, then the hand orientation is split into
 * swing and twist relative to the forearm so each can be limited and the twist distributed.
 */
export class Arm {
  readonly result: TwoBoneResult = createTwoBoneResult();
  readonly handQuat = new THREE.Quaternion();
  private readonly upper: THREE.Mesh;
  private readonly foreProximal: THREE.Mesh;
  private readonly foreDistal: THREE.Mesh;
  private readonly hand: THREE.Group;
  private readonly elbow: THREE.Mesh;
  private readonly wrist: THREE.Mesh;
  private readonly forearmQuat = new THREE.Quaternion();
  private readonly rel = new THREE.Quaternion();
  private readonly swing = new THREE.Quaternion();
  private readonly twist = new THREE.Quaternion();
  private readonly halfTwist = new THREE.Quaternion();

  constructor(
    scene: THREE.Object3D,
    readonly lengthA: number,
    readonly lengthB: number,
    m: Materials,
  ) {
    this.upper = shadowed(new THREE.Mesh(boneGeometry(lengthA, 0.045, 0.038), m.body));
    this.foreProximal = shadowed(new THREE.Mesh(boneGeometry(lengthB / 2, 0.036, 0.032), m.body));
    this.foreDistal = shadowed(new THREE.Mesh(boneGeometry(lengthB / 2, 0.032, 0.028), m.body));
    // A fin on the distal forearm makes the twist distribution visible.
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.008, lengthB * 0.4, 0.05), m.accent);
    fin.position.set(0, lengthB * 0.25, 0.03);
    this.foreDistal.add(fin);

    this.hand = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.025), m.accent);
    palm.position.y = 0.055;
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.05, 0.018), m.accent);
    thumb.position.set(0.045, 0.045, 0.012);
    thumb.rotation.z = -0.5;
    this.hand.add(palm, thumb);
    shadowed(this.hand);

    this.elbow = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.046, 16, 12), m.joint));
    this.wrist = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.033, 16, 12), m.joint));
    scene.add(this.upper, this.foreProximal, this.foreDistal, this.hand, this.elbow, this.wrist);
  }

  update(
    shoulder: THREE.Vector3,
    target: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    pole: THREE.Vector3,
    s: ArmSettings,
  ): TwoBoneResult {
    const r = solveTwoBone(shoulder, target, pole, this.lengthA, this.lengthB, s, this.result);
    const stretchB = r.lengthB / this.lengthB;

    this.upper.position.copy(shoulder);
    boneRotation(shoulder, r.mid, r.bendDir, this.upper.quaternion);
    this.upper.scale.set(1, r.lengthA / this.lengthA, 1);

    boneRotation(r.mid, r.end, r.bendDir, this.forearmQuat);
    this.foreProximal.position.copy(r.mid);
    this.foreProximal.quaternion.copy(this.forearmQuat);
    this.foreProximal.scale.set(1, stretchB, 1);

    // Hand orientation relative to the forearm, split into swing and twist about the forearm axis.
    this.rel.copy(this.forearmQuat).invert().multiply(targetQuat);
    swingTwist(this.rel, Y, this.swing, this.twist);
    clampRotationAngle(this.swing, s.swingLimit);
    clampTwist(this.twist, Y, s.twistLimit);
    this.handQuat.copy(this.forearmQuat).multiply(this.swing).multiply(this.twist);

    this.halfTwist.slerpQuaternions(IDENTITY, this.twist, s.twistShare);
    this.foreDistal.position.lerpVectors(r.mid, r.end, 0.5);
    this.foreDistal.quaternion.copy(this.forearmQuat).multiply(this.halfTwist);
    this.foreDistal.scale.set(1, stretchB, 1);

    this.hand.position.copy(r.end);
    this.hand.quaternion.copy(this.handQuat);
    this.elbow.position.copy(r.mid);
    this.wrist.position.copy(r.end);
    return r;
  }
}

export interface HeadSettings {
  headLimit: number;
  eyeLimit: number;
  head: SecondOrderParams;
  eyes: SecondOrderParams;
}

/**
 * Head and eyes aim at a look point. Each has its own smoothing (eyes fast, head slow) and its own
 * cone limit: the head is limited relative to the torso, the eyes relative to the head.
 */
export class Head {
  readonly pivot = new THREE.Group();
  readonly gazeHead: SecondOrderVec3;
  readonly gazeEyes: SecondOrderVec3;
  private readonly eyes: THREE.Group[] = [];
  private readonly parentQuat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly clamped = new THREE.Vector3();

  constructor(parent: THREE.Object3D, neck: THREE.Vector3, m: Materials, s: HeadSettings, look: THREE.Vector3) {
    this.pivot.position.copy(neck);
    parent.add(this.pivot);

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.13, 32, 24), m.body);
    skull.position.y = 0.13;
    skull.scale.set(1, 1.08, 1);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.07, 0.06), m.dark);
    visor.position.set(0, 0.15, 0.1);
    const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.08, 12), m.joint);
    neckMesh.position.y = 0.02;
    this.pivot.add(skull, visor, neckMesh);

    for (const side of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(side * 0.045, 0.15, 0.13);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.026, 20, 14), m.white);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), m.dark);
      pupil.position.z = 0.019;
      eye.add(ball, pupil);
      this.eyes.push(eye);
      this.pivot.add(eye);
    }
    shadowed(this.pivot);

    this.gazeHead = new SecondOrderVec3(s.head, look);
    this.gazeEyes = new SecondOrderVec3(s.eyes, look);
  }

  configure(s: HeadSettings): void {
    this.gazeHead.core.setParams(s.head);
    this.gazeEyes.core.setParams(s.eyes);
  }

  /** World-space centre between the eyes. */
  eyeCentre(out: THREE.Vector3): THREE.Vector3 {
    return this.pivot.localToWorld(out.set(0, 0.15, 0.13));
  }

  update(dt: number, look: THREE.Vector3, s: HeadSettings): void {
    const headTarget = this.gazeHead.update(dt, look);
    const eyeTarget = this.gazeEyes.update(dt, look);

    // Head: limited relative to the parent (torso).
    this.pivot.parent!.getWorldQuaternion(this.parentQuat).invert();
    this.eyeCentre(this.pos);
    this.dir.subVectors(headTarget, this.pos).normalize().applyQuaternion(this.parentQuat);
    clampToCone(this.dir, Z, s.headLimit, this.clamped);
    lookRotation(this.clamped, Y, this.pivot.quaternion);
    this.pivot.updateMatrixWorld(true);

    // Eyes: limited relative to the head.
    this.pivot.getWorldQuaternion(this.parentQuat).invert();
    for (const eye of this.eyes) {
      eye.getWorldPosition(this.pos);
      this.dir.subVectors(eyeTarget, this.pos).normalize().applyQuaternion(this.parentQuat);
      clampToCone(this.dir, Z, s.eyeLimit, this.clamped);
      lookRotation(this.clamped, Y, eye.quaternion);
    }
  }
}
