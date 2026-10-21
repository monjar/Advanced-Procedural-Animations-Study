import { forwardKinematics, qmul, skeletonDef, type SkeletonDef } from '../../src/anim/fk';
import { createPose, Inertializer, quatToRotVec, type PoseBuffers } from '../../src/anim/inertialize';
import type { MMJoint } from '../../src/anim/mmdb';
import { TRAJ_FRAMES, wrapAngle } from '../../src/anim/mmfeatures';
import { TrajectoryController, type ControlInput } from '../09-motion-matching/controller';
import type { Networks } from './networks';
import { sixdToQuat, Y_CONTACT, Y_HIP, Y_ROOT, Y_ROT } from './pose';

/** Everything the learned runtime needs besides its networks (public/assets/lmm/model.json). */
export interface LmmModel {
  fps: number;
  joints: MMJoint[];
  featureMean: number[];
  featureScale: number[];
  featureWeights: number[];
  leftFoot: number;
  rightFoot: number;
  /** Features of a standing frame: projected, they give the starting state. */
  startX: number[];
}

export interface LearnedSettings {
  searchInterval: number;
  inertialize: boolean;
  halflife: number;
  adjust: boolean;
  clamp: boolean;
  /** Switch to the projected state only if it beats the current one by this factor. */
  switchRatio: number;
}

const STEP = 1 / 60;
const ADJUST_HALFLIFE = 0.2;
const ADJUST_RATIO = 0.5;
const CLAMP_DISTANCE = 0.15;
const _d = new Float64Array(4);
const _q = new Float32Array(4);

/**
 * Learned Motion Matching runtime: study 09's loop with the database taken out. Where study 09 searches, the
 * projector predicts the (X, Z) of the frame the search would find; where it plays the next frame, the stepper
 * advances (X, Z); where it reads a pose, the decompressor produces one. Controller, root motion, trajectory
 * adjustment and inertialization are the same code, so the two can be compared on the same input.
 */
export class LearnedMatcher {
  readonly controller = new TrajectoryController();
  readonly settings: LearnedSettings;
  readonly inert: Inertializer;
  readonly skel: SkeletonDef;
  readonly J: number;
  /** Current state: features X then latent Z. */
  readonly xz: Float32Array;
  readonly y: Float32Array;
  readonly root = { x: 0, z: 0, yaw: 0 };
  readonly pose: PoseBuffers;
  /** Decoded (un-inertialized) pose now and one step ago, for finite-difference velocities. */
  private readonly cur: PoseBuffers;
  private readonly prev: PoseBuffers;
  private readonly tmpPose: PoseBuffers;
  readonly query: Float32Array;
  private readonly projected: Float32Array;
  private readonly yTmp: Float32Array;
  readonly prevWorld: Float32Array;
  readonly currWorld: Float32Array;
  readonly world: Float32Array;
  private readonly worldRot: Float32Array;
  private readonly fkRot: Float32Array;
  private acc = 0;
  private sinceSearch = Infinity;
  private readonly searchVel = { x: 0, z: 0 };
  /** Foot contacts (0–1) from the decompressed pose. */
  readonly contacts = [0, 0];
  time = 0;
  steps = 0;
  transitions = 0;
  searches = 0;
  /** Milliseconds spent in the networks during the last step (projector included when it ran). */
  lastStepMs = 0;
  currentCost = 0;
  projectedCost = 0;
  onStep?: (transitioned: boolean) => void;

  constructor(
    readonly nets: Networks,
    readonly model: LmmModel,
    start: Float32Array,
    settings: Partial<LearnedSettings> = {},
  ) {
    this.settings = { searchInterval: 10, inertialize: true, halflife: 0.1, adjust: true, clamp: true, switchRatio: 0.85, ...settings };
    this.J = model.joints.length;
    this.skel = skeletonDef(model.joints);
    this.inert = new Inertializer(this.J, this.settings.halflife);
    this.xz = new Float32Array(nets.X + nets.Z);
    this.projected = new Float32Array(nets.X + nets.Z);
    this.y = new Float32Array(nets.Y);
    this.yTmp = new Float32Array(nets.Y);
    this.query = new Float32Array(nets.X);
    this.pose = createPose(this.J);
    this.cur = createPose(this.J);
    this.prev = createPose(this.J);
    this.tmpPose = createPose(this.J);
    this.prevWorld = new Float32Array(this.J * 3);
    this.currWorld = new Float32Array(this.J * 3);
    this.world = new Float32Array(this.J * 3);
    this.worldRot = new Float32Array(this.J * 4);
    this.fkRot = new Float32Array(this.J * 4);
    this.reset(start);
  }

  /** Start from a given (X, Z) — the (X, Z) of a standing frame. */
  reset(start: Float32Array, x = 0, z = 0, yaw = 0): void {
    this.xz.set(start);
    Object.assign(this.root, { x, z, yaw });
    this.controller.reset(x, z, yaw);
    this.inert.reset();
    this.decode(this.xz, this.cur);
    this.copyPose(this.cur, this.prev);
    this.copyPose(this.cur, this.pose);
    this.computeWorld(this.currWorld);
    this.prevWorld.set(this.currWorld);
    this.world.set(this.currWorld);
    this.acc = 0;
    this.sinceSearch = Infinity;
  }

  update(input: ControlInput, dt: number): number {
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP && n < 16) {
      this.step(input);
      this.acc -= STEP;
      n++;
    }
    if (n === 16) this.acc = 0;
    const alpha = this.acc / STEP;
    for (let i = 0; i < this.world.length; i++) this.world[i] = this.prevWorld[i] + (this.currWorld[i] - this.prevWorld[i]) * alpha;
    return alpha;
  }

  /** Weighted squared distance between the query and the first X entries of `xz` (study 09's cost). */
  private cost(xz: Float32Array): number {
    let c = 0;
    const w = this.model.featureWeights;
    for (let d = 0; d < this.nets.X; d++) c += w[d] * (this.query[d] - xz[d]) ** 2;
    return c;
  }

  step(input: ControlInput): void {
    const c = this.controller;
    const t0 = performance.now();
    c.update(input, STEP);
    this.inert.halflife = this.settings.halflife;

    // 1. Project (in place of the search): on schedule or when the input changes sharply.
    const inputJump = Math.hypot(c.desiredVel.x - this.searchVel.x, c.desiredVel.z - this.searchVel.z) > 0.5;
    let transitioned = false;
    if (this.sinceSearch >= this.settings.searchInterval || inputJump) {
      this.buildQuery();
      this.nets.project(this.query, this.projected);
      this.searches++;
      this.sinceSearch = 0;
      this.searchVel.x = c.desiredVel.x;
      this.searchVel.z = c.desiredVel.z;
      this.currentCost = this.cost(this.xz);
      this.projectedCost = this.cost(this.projected);
      if (this.projectedCost < this.currentCost * this.settings.switchRatio) {
        // Velocities of the new state: decode it and one step after it.
        this.decode(this.projected, this.tmpPose);
        const after = this.projected.slice();
        this.nets.step(after);
        const next = createPose(this.J);
        this.decode(after, next);
        this.velocities(this.tmpPose, next, this.tmpPose);
        if (this.settings.inertialize) this.inert.transition(this.cur, this.tmpPose);
        else this.inert.reset();
        this.xz.set(this.projected);
        this.copyPose(this.tmpPose, this.cur);
        transitioned = true;
        this.transitions++;
      }
    }
    this.sinceSearch++;

    // 2. Advance (in place of "play the next frame") and decode.
    this.copyPose(this.cur, this.prev);
    this.nets.step(this.xz);
    this.decode(this.xz, this.cur);
    this.velocities(this.prev, this.cur, this.cur);
    this.lastStepMs = performance.now() - t0;

    // 3. Root motion from the decompressed pose.
    const y = this.y;
    const vx = y[Y_ROOT];
    const vz = y[Y_ROOT + 1];
    const yawRate = y[Y_ROOT + 2];
    this.root.yaw = wrapAngle(this.root.yaw + yawRate * STEP);
    const cy = Math.cos(this.root.yaw);
    const sy = Math.sin(this.root.yaw);
    this.root.x += (cy * vx + sy * vz) * STEP;
    this.root.z += (-sy * vx + cy * vz) * STEP;
    this.contacts[0] = y[Y_CONTACT];
    this.contacts[1] = y[Y_CONTACT + 1];

    // 4. Same synchronisation as study 09.
    if (this.settings.adjust) {
      const k = 1 - Math.exp((-STEP * Math.LN2) / ADJUST_HALFLIFE);
      let dx = (c.x.x - this.root.x) * k;
      let dz = (c.z.x - this.root.z) * k;
      const maxStep = ADJUST_RATIO * Math.hypot(vx, vz) * STEP;
      const len = Math.hypot(dx, dz);
      if (len > maxStep) (dx *= maxStep / len), (dz *= maxStep / len);
      this.root.x += dx;
      this.root.z += dz;
      let dyaw = wrapAngle(c.yaw.x - this.root.yaw) * k;
      const maxYaw = ADJUST_RATIO * Math.abs(yawRate) * STEP + ADJUST_RATIO * Math.hypot(vx, vz) * STEP;
      dyaw = Math.max(-maxYaw, Math.min(maxYaw, dyaw));
      this.root.yaw = wrapAngle(this.root.yaw + dyaw);
    }
    if (this.settings.clamp) {
      const dx = c.x.x - this.root.x;
      const dz = c.z.x - this.root.z;
      const d = Math.hypot(dx, dz);
      if (d > CLAMP_DISTANCE) {
        c.x.x = this.root.x + (dx * CLAMP_DISTANCE) / d;
        c.z.x = this.root.z + (dz * CLAMP_DISTANCE) / d;
      }
    }

    // 5. Pose with inertialization offsets.
    this.inert.update(this.cur, STEP, this.pose);
    this.prevWorld.set(this.currWorld);
    this.computeWorld(this.currWorld);
    this.time += STEP;
    this.steps++;
    this.onStep?.(transitioned);
  }

  /** Query: the controller's predicted trajectory (normalised like the database's) + the current pose features. */
  buildQuery(): Float32Array {
    const q = this.query;
    const p = { x: 0, z: 0, yaw: 0 };
    const cy = Math.cos(this.root.yaw);
    const sy = Math.sin(this.root.yaw);
    const m = this.model.featureMean;
    const s = this.model.featureScale;
    TRAJ_FRAMES.forEach((k, n) => {
      this.controller.predict(k * STEP, p);
      const dx = p.x - this.root.x;
      const dz = p.z - this.root.z;
      const fx = Math.sin(p.yaw);
      const fz = Math.cos(p.yaw);
      const raw = [cy * dx - sy * dz, sy * dx + cy * dz, cy * fx - sy * fz, sy * fx + cy * fz];
      q[n * 2] = (raw[0] - m[n * 2]) / s[n * 2];
      q[n * 2 + 1] = (raw[1] - m[n * 2 + 1]) / s[n * 2 + 1];
      q[6 + n * 2] = (raw[2] - m[6 + n * 2]) / s[6 + n * 2];
      q[6 + n * 2 + 1] = (raw[3] - m[6 + n * 2 + 1]) / s[6 + n * 2 + 1];
    });
    // Feet and hips: the current state's own (already normalised) features.
    for (let d = 12; d < this.nets.X; d++) q[d] = this.xz[d];
    return q;
  }

  /** Decompress (X, Z) into hip position and joint rotations (and keep Y for root motion and contacts). */
  private decode(xz: Float32Array, out: PoseBuffers): void {
    const y = this.nets.decompress(xz, out === this.cur ? this.y : this.yTmp);
    out.hipPos[0] = y[Y_HIP];
    out.hipPos[1] = y[Y_HIP + 1];
    out.hipPos[2] = y[Y_HIP + 2];
    for (let j = 0; j < this.J; j++) sixdToQuat(y, Y_ROT + 6 * j, out.rot, j * 4);
  }

  /** Finite-difference velocities from pose `a` to pose `b` (one step apart), written into `out`. */
  private velocities(a: PoseBuffers, b: PoseBuffers, out: PoseBuffers): void {
    const fps = this.model.fps;
    for (let k = 0; k < 3; k++) out.hipVel[k] = (b.hipPos[k] - a.hipPos[k]) * fps;
    for (let j = 0; j < this.J; j++) {
      _d[0] = -a.rot[j * 4];
      _d[1] = -a.rot[j * 4 + 1];
      _d[2] = -a.rot[j * 4 + 2];
      _d[3] = a.rot[j * 4 + 3];
      qmul(b.rot, j * 4, _d, 0, _q, 0);
      quatToRotVec(_q, 0, out.angVel, j * 3);
      for (let k = 0; k < 3; k++) out.angVel[j * 3 + k] *= fps;
    }
  }

  private copyPose(a: PoseBuffers, b: PoseBuffers): void {
    b.hipPos.set(a.hipPos);
    b.hipVel.set(a.hipVel);
    b.rot.set(a.rot);
    b.angVel.set(a.angVel);
  }

  computeWorld(out: Float32Array): void {
    const half = this.root.yaw / 2;
    const ry = [0, Math.sin(half), 0, Math.cos(half)];
    this.fkRot.set(this.pose.rot);
    qmul(ry, 0, this.pose.rot, 0, this.fkRot, 0);
    const c = Math.cos(this.root.yaw);
    const s = Math.sin(this.root.yaw);
    const hp = this.pose.hipPos;
    const hips = [this.root.x + c * hp[0] + s * hp[2], hp[1], this.root.z - s * hp[0] + c * hp[2]];
    forwardKinematics(this.skel, hips, 0, this.fkRot, 0, out, this.worldRot);
  }
}
