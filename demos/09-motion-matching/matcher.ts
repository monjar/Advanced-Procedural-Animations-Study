import { forwardKinematics, qmul, skeletonDef, type SkeletonDef } from '../../src/anim/fk';
import { createPose, Inertializer, quatToRotVec, type PoseBuffers } from '../../src/anim/inertialize';
import {
  DEFAULT_WEIGHTS,
  DIMS,
  dimWeights,
  frameCost,
  normalize,
  searchBrute,
  TRAJ_FRAMES,
  wrapAngle,
  type Match,
  type MotionFeatures,
} from '../../src/anim/mmfeatures';
import { TrajectoryController, type ControlInput } from './controller';

export interface MatcherSettings {
  /** Frames between searches (also searched when the input changes sharply or the take runs out). */
  searchInterval: number;
  inertialize: boolean;
  /** Inertialization half-life (s). */
  halflife: number;
  /** Pull the character towards the simulated trajectory (limited by its own speed, so it never skates). */
  adjust: boolean;
  /** Keep the simulated trajectory within `clampDistance` of the character. */
  clamp: boolean;
  weights: number[];
  /** Search implementation; `aabb` is added with the acceleration structure. */
  search: (mf: MotionFeatures, q: Float32Array, w: Float32Array, out: Match) => Match;
}

const STEP = 1 / 60;
const ADJUST_HALFLIFE = 0.2;
/** Adjustment may add at most this fraction of the character's own speed (Holden's "adjustment by velocity"). */
const ADJUST_RATIO = 0.5;
const CLAMP_DISTANCE = 0.15;
/** Candidates this close to the playing frame in the same take are not transitions. */
const SAME_TAKE_WINDOW = 20;

const _d = new Float64Array(4);

/**
 * Motion matching runtime, stepped at the database rate (60 Hz) with an accumulator so behaviour does not
 * depend on the display rate; `alpha` interpolates the rendered joints between the last two steps.
 */
export class MotionMatcher {
  readonly controller = new TrajectoryController();
  readonly settings: MatcherSettings;
  readonly inert: Inertializer;
  readonly skel: SkeletonDef;
  readonly J: number;
  /** Database frame being played. */
  frame: number;
  /** The character root (simulation bone) in world space. */
  readonly root = { x: 0, z: 0, yaw: 0 };
  /** Output pose (after inertialization) and the database pose under it. */
  readonly pose: PoseBuffers;
  private readonly src: PoseBuffers;
  private readonly dst: PoseBuffers;
  readonly query = new Float32Array(DIMS);
  private readonly weights: Float32Array;
  private readonly match: Match = { frame: -1, cost: Infinity };
  /** World joint positions after the last two steps, and the interpolated result of `update`. */
  readonly prevWorld: Float32Array;
  readonly currWorld: Float32Array;
  readonly world: Float32Array;
  private readonly worldRot: Float32Array;
  private readonly fkRot: Float32Array;
  private acc = 0;
  private sinceSearch = Infinity;
  private readonly searchVel = { x: 0, z: 0 };
  // Statistics.
  time = 0;
  steps = 0;
  transitions = 0;
  searches = 0;
  lastSearchMs = 0;
  bestCost = 0;
  currentCost = 0;
  /** Called after every step with the frame jumped from (or -1) — for audits. */
  onStep?: (transitionedFrom: number) => void;

  constructor(readonly mf: MotionFeatures, settings: Partial<MatcherSettings> = {}) {
    this.settings = {
      searchInterval: 10,
      inertialize: true,
      halflife: 0.1,
      adjust: true,
      clamp: true,
      weights: [...DEFAULT_WEIGHTS],
      search: searchBrute,
      ...settings,
    };
    this.J = mf.db.joints.length;
    this.skel = skeletonDef(mf.db.joints);
    this.inert = new Inertializer(this.J, this.settings.halflife);
    this.pose = createPose(this.J);
    this.src = createPose(this.J);
    this.dst = createPose(this.J);
    this.weights = dimWeights(this.settings.weights);
    this.prevWorld = new Float32Array(this.J * 3);
    this.currWorld = new Float32Array(this.J * 3);
    this.world = new Float32Array(this.J * 3);
    this.worldRot = new Float32Array(this.J * 4);
    this.fkRot = new Float32Array(this.J * 4);
    // Start standing in the first idle take.
    const idle = mf.db.takes.find((t) => t.description === 'idle') ?? mf.db.takes[0];
    this.frame = idle.start;
    this.reset();
  }

  /** Re-read per-group weights after the settings changed. */
  setWeights(w: number[]): void {
    this.settings.weights = [...w];
    this.weights.set(dimWeights(w));
  }

  reset(x = 0, z = 0, yaw = 0): void {
    Object.assign(this.root, { x, z, yaw });
    this.controller.reset(x, z, yaw);
    this.inert.reset();
    this.dbPose(this.frame, this.pose);
    this.computeWorld(this.currWorld);
    this.prevWorld.set(this.currWorld);
    this.world.set(this.currWorld);
    this.acc = 0;
    this.sinceSearch = Infinity;
  }

  /** Advance by `dt` seconds of input; returns the interpolation fraction used for `world`. */
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

  private sameTake(a: number, b: number): boolean {
    return b >= 0 && b < this.mf.db.frames && this.mf.db.take[a] === this.mf.db.take[b];
  }

  step(input: ControlInput): void {
    const mf = this.mf;
    this.controller.update(input, STEP);
    this.inert.halflife = this.settings.halflife;

    // 1. Search: on schedule, when the input changes sharply, or when the take is about to end.
    const c = this.controller;
    const inputJump = Math.hypot(c.desiredVel.x - this.searchVel.x, c.desiredVel.z - this.searchVel.z) > 0.5;
    const canContinue = this.sameTake(this.frame, this.frame + 1);
    let from = -1;
    if (this.sinceSearch >= this.settings.searchInterval || inputJump || !canContinue) {
      this.buildQuery();
      this.currentCost = canContinue ? frameCost(mf, this.query, this.weights, this.frame) : Infinity;
      const t0 = performance.now();
      this.settings.search(mf, this.query, this.weights, this.match);
      this.lastSearchMs = performance.now() - t0;
      this.searches++;
      this.bestCost = this.match.cost;
      this.sinceSearch = 0;
      this.searchVel.x = c.desiredVel.x;
      this.searchVel.z = c.desiredVel.z;
      const best = this.match.frame;
      const trivial = canContinue && this.sameTake(this.frame, best) && Math.abs(best - this.frame) < SAME_TAKE_WINDOW;
      if (best >= 0 && !trivial && this.match.cost < this.currentCost) {
        this.dbPose(this.frame, this.src);
        this.dbPose(best, this.dst);
        if (this.settings.inertialize) this.inert.transition(this.src, this.dst);
        else this.inert.reset();
        from = this.frame;
        this.frame = best;
        this.transitions++;
      }
    }
    this.sinceSearch++;

    // 2. Play: advance one frame and move the root by the database's root motion.
    if (this.sameTake(this.frame, this.frame + 1)) this.frame++;
    const f = this.frame;
    this.root.yaw = wrapAngle(this.root.yaw + mf.rootYawRate[f] * STEP);
    const cy = Math.cos(this.root.yaw);
    const sy = Math.sin(this.root.yaw);
    const vx = mf.rootVel[f * 2];
    const vz = mf.rootVel[f * 2 + 1];
    this.root.x += (cy * vx + sy * vz) * STEP;
    this.root.z += (-sy * vx + cy * vz) * STEP;

    // 3. Synchronise character and simulation.
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
      const maxYaw = ADJUST_RATIO * Math.abs(mf.rootYawRate[f]) * STEP + ADJUST_RATIO * Math.hypot(vx, vz) * STEP;
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

    // 4. Pose: database frame plus decaying offsets.
    this.dbPose(f, this.dst);
    this.inert.update(this.dst, STEP, this.pose);
    this.prevWorld.set(this.currWorld);
    this.computeWorld(this.currWorld);
    this.time += STEP;
    this.steps++;
    this.onStep?.(from);
  }

  /** Query: the controller's predicted trajectory in the character's frame + the playing frame's pose features. */
  buildQuery(): Float32Array {
    const q = this.query;
    const p = { x: 0, z: 0, yaw: 0 };
    const cy = Math.cos(this.root.yaw);
    const sy = Math.sin(this.root.yaw);
    TRAJ_FRAMES.forEach((k, n) => {
      this.controller.predict(k * STEP, p);
      const dx = p.x - this.root.x;
      const dz = p.z - this.root.z;
      q[n * 2] = cy * dx - sy * dz;
      q[n * 2 + 1] = sy * dx + cy * dz;
      const fx = Math.sin(p.yaw);
      const fz = Math.cos(p.yaw);
      q[6 + n * 2] = cy * fx - sy * fz;
      q[6 + n * 2 + 1] = sy * fx + cy * fz;
    });
    q.set(this.mf.raw.subarray(this.frame * DIMS + 12, (this.frame + 1) * DIMS), 12);
    return normalize(this.mf, q);
  }

  /** Database pose of `frame`: hips relative to the simulation bone, local rotations, finite-difference velocities. */
  dbPose(frame: number, out: PoseBuffers): void {
    const mf = this.mf;
    const J = this.J;
    const next = this.sameTake(frame, frame + 1) ? frame + 1 : frame;
    const prev = next === frame ? frame - 1 : frame;
    const fps = mf.db.fps;
    out.hipPos.set(mf.hipPos.subarray(frame * 3, frame * 3 + 3));
    for (let k = 0; k < 3; k++) out.hipVel[k] = (mf.hipPos[next * 3 + k] - mf.hipPos[prev * 3 + k]) * fps;
    out.rot.set(mf.db.rot.subarray(frame * J * 4, (frame + 1) * J * 4));
    out.rot.set(mf.hipRot.subarray(frame * 4, frame * 4 + 4), 0);
    const a = _d;
    for (let j = 0; j < J; j++) {
      const src = j === 0 ? mf.hipRot : mf.db.rot;
      const ia = j === 0 ? next * 4 : (next * J + j) * 4;
      const ib = j === 0 ? prev * 4 : (prev * J + j) * 4;
      // Δ = q_next ⊗ q_prev⁻¹
      a[0] = -src[ib];
      a[1] = -src[ib + 1];
      a[2] = -src[ib + 2];
      a[3] = src[ib + 3];
      qmul(src, ia, a, 0, a, 0);
      quatToRotVec(a, 0, out.angVel, j * 3);
      for (let k = 0; k < 3; k++) out.angVel[j * 3 + k] *= fps;
    }
  }

  /** World joint positions of the output pose placed at the character root. */
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

  /** The playing frame's own future trajectory (database), in world space, for the debug overlay. */
  matchedTrajectory(out: { x: number; z: number }[]): void {
    const c = Math.cos(this.root.yaw);
    const s = Math.sin(this.root.yaw);
    const o = this.frame * DIMS;
    TRAJ_FRAMES.forEach((_, n) => {
      const lx = this.mf.raw[o + n * 2];
      const lz = this.mf.raw[o + n * 2 + 1];
      out[n] = { x: this.root.x + c * lx + s * lz, z: this.root.z - s * lx + c * lz };
    });
  }
}
