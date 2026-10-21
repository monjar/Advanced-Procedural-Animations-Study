import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';

/**
 * The browser side of training/mimic/env.py: the looping reference clip, the observation, and the action.
 * Every function here transcribes its Python counterpart; a unit test replays a run recorded in Python MuJoCo
 * through them and compares observations and the final state.
 */

export const NUM_ACT = 28;
export const NUM_OBS = 2 + 1 + 3 + 3 + 3 + NUM_ACT * 3 + 12 + 3;
export const END_EFFECTORS = ['l_forearm', 'r_forearm', 'l_foot', 'r_foot'];

export interface ClipFile {
  fps: number;
  joints: string[];
  clips: Record<string, { take: string; frames: number; cycle: { dx: number; dy: number; dyaw: number }; qpos: number[][] }>;
  source: string;
  attribution: string;
}

export interface MimicPolicyFile {
  clip: string;
  iteration: number;
  obs: number;
  act: number;
  actionScale: number;
  decimation: number;
  dt: number;
  obsMean: number[];
  obsStd: number[];
  layers: { in: number; out: number; weight: string; bias: string }[];
}

// ------------------------------------------------------------------------------------------ small math

export function quatMul(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const [aw, ax, ay, az] = [a[0], a[1], a[2], a[3]];
  const [bw, bx, by, bz] = [b[0], b[1], b[2], b[3]];
  return [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw];
}

/** Rotate world vector v into the frame of unit quaternion q = (w, x, y, z). */
export function quatRotateInverse(q: ArrayLike<number>, v: ArrayLike<number>): number[] {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  return [
    (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y + w * z) * v[1] + 2 * (x * z - w * y) * v[2],
    2 * (x * y - w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z + w * x) * v[2],
    2 * (x * z + w * y) * v[0] + 2 * (y * z - w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2],
  ];
}

export function yawOf(q: ArrayLike<number>): number {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

function toHeading(yaw: number, v: ArrayLike<number>): number[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]];
}

function slerp(a: number[], b: number[], t: number): number[] {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) {
    bb = b.map((x) => -x);
    d = -d;
  }
  if (d > 0.9995) {
    const r = a.map((x, i) => x + t * (bb[i] - x));
    const n = Math.hypot(...r);
    return r.map((x) => x / n);
  }
  const th = Math.acos(d);
  const sa = Math.sin((1 - t) * th);
  const sb = Math.sin(t * th);
  const s = Math.sin(th);
  return a.map((x, i) => (sa * x + sb * bb[i]) / s);
}

/** mj_differentiatePos for this model: a free joint then hinges (angular velocity in the body frame). */
export function differentiatePos(dt: number, q1: ArrayLike<number>, q2: ArrayLike<number>, out: Float64Array): Float64Array {
  for (let i = 0; i < 3; i++) out[i] = (q2[i] - q1[i]) / dt;
  // log(q1⁻¹ q2)
  const inv = [q1[3], -q1[4], -q1[5], -q1[6]];
  let d = quatMul(inv, [q2[3], q2[4], q2[5], q2[6]]);
  if (d[0] < 0) d = d.map((x) => -x);
  const s = Math.hypot(d[1], d[2], d[3]);
  const angle = 2 * Math.atan2(s, d[0]);
  const k = s > 1e-12 ? angle / s : 2;
  for (let i = 0; i < 3; i++) out[3 + i] = (d[1 + i] * k) / dt;
  for (let i = 7; i < q1.length; i++) out[i - 1] = (q2[i] - q1[i]) / dt;
  return out;
}

// ------------------------------------------------------------------------------------------ reference

/** A looping clip sampled at any time, with the per-cycle root displacement applied (env.py's Reference). */
export class Reference {
  readonly q: number[][];
  readonly n: number;
  readonly period: number;
  private readonly dx: number;
  private readonly dy: number;
  private readonly dyaw: number;

  constructor(
    clip: ClipFile['clips'][string],
    readonly fps: number,
  ) {
    this.q = clip.qpos;
    this.n = clip.qpos.length;
    this.period = this.n / fps;
    this.dx = clip.cycle.dx;
    this.dy = clip.cycle.dy;
    this.dyaw = clip.cycle.dyaw;
  }

  qpos(t: number): Float64Array {
    const cycles = Math.floor(t / this.period);
    const u = (t - cycles * this.period) * this.fps;
    const i = Math.floor(u) % this.n;
    const a = u - Math.floor(u);
    const j = (i + 1) % this.n;
    const qa = this.q[i];
    let qb: ArrayLike<number> = this.q[j];
    if (j === 0) qb = this.shift(Float64Array.from(qb), 1);
    const out = new Float64Array(35);
    for (let k = 0; k < 3; k++) out[k] = qa[k] + a * (qb[k] - qa[k]);
    const r = slerp(qa.slice(3, 7), [qb[3], qb[4], qb[5], qb[6]], a);
    out.set(r, 3);
    for (let k = 7; k < 35; k++) out[k] = qa[k] + a * (qb[k] - qa[k]);
    return this.shift(out, cycles);
  }

  private shift(q: Float64Array, k: number): Float64Array {
    if (k === 0) return q;
    const yaw = k * this.dyaw;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    let ox = 0;
    let oy = 0;
    // Backwards (k < 0) the same cycle steps are taken off.
    const sign = k > 0 ? 1 : -1;
    for (let m = k > 0 ? 0 : k; m < (k > 0 ? k : 0); m++) {
      const cm = Math.cos(m * this.dyaw);
      const sm = Math.sin(m * this.dyaw);
      ox += sign * (cm * this.dx - sm * this.dy);
      oy += sign * (sm * this.dx + cm * this.dy);
    }
    const out = Float64Array.from(q);
    out[0] = c * q[0] - s * q[1] + ox;
    out[1] = s * q[0] + c * q[1] + oy;
    out.set(quatMul([Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], [q[3], q[4], q[5], q[6]]), 3);
    return out;
  }
}

// ------------------------------------------------------------------------------------------ the character

export class MimicSim {
  readonly model: MjModel;
  readonly data: MjData;
  readonly eeIds: number[];
  /** Clip time (s) of the current control step, and a yaw/offset that places the clip where the character is. */
  t = 0;
  offsetYaw = 0;
  offset = [0, 0];
  refNext: Float64Array = new Float64Array(35);

  constructor(
    readonly mj: MainModule,
    xml: string,
    public ref: Reference,
    readonly policy: Pick<MimicPolicyFile, 'actionScale' | 'decimation'>,
  ) {
    this.model = mj.MjModel.from_xml_string(xml);
    this.data = new mj.MjData(this.model);
    this.eeIds = END_EFFECTORS.map((n) => mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_BODY.value, n));
    this.reset(0);
  }

  /** The clip at time t, rotated by offsetYaw and shifted by offset (env.py's _ref, plus a shift). */
  refAt(t: number): Float64Array {
    const q = this.ref.qpos(t);
    const yaw = this.offsetYaw;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const out = Float64Array.from(q);
    out[0] = c * q[0] - s * q[1] + this.offset[0];
    out[1] = s * q[0] + c * q[1] + this.offset[1];
    out.set(quatMul([Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], [q[3], q[4], q[5], q[6]]), 3);
    return out;
  }

  refVel(t: number, h = 1 / 120): Float64Array {
    return differentiatePos(2 * h, this.refAt(t - h), this.refAt(t + h), new Float64Array(34));
  }

  /** Reference state initialisation at clip time t. */
  reset(t: number): void {
    const { mj, model, data } = this;
    mj.mj_resetData(model, data);
    this.t = t;
    const q = this.refAt(t);
    const v = this.refVel(t);
    for (let i = 0; i < 35; i++) data.qpos[i] = q[i];
    for (let i = 0; i < 34; i++) data.qvel[i] = v[i];
    mj.mj_forward(model, data);
  }

  observe(out = new Float64Array(NUM_OBS)): Float64Array {
    const tn = this.t + this.policy.decimation * this.model.opt.timestep;
    this.refNext = this.refAt(tn);
    const refVel = this.refVel(tn);
    const phase = (((tn / this.ref.period) % 1) + 1) % 1;
    const q = this.data.qpos;
    const v = this.data.qvel;
    const quat = [q[3], q[4], q[5], q[6]];
    const yaw = yawOf(quat);
    let k = 0;
    out[k++] = Math.sin(2 * Math.PI * phase);
    out[k++] = Math.cos(2 * Math.PI * phase);
    out[k++] = q[2];
    for (const x of quatRotateInverse(quat, [0, 0, -1])) out[k++] = x;
    for (const x of toHeading(yaw, [v[0], v[1], v[2]])) out[k++] = x;
    for (let i = 3; i < 6; i++) out[k++] = v[i] * 0.25;
    for (let i = 7; i < 35; i++) out[k++] = q[i];
    for (let i = 6; i < 34; i++) out[k++] = v[i] * 0.05;
    for (let i = 7; i < 35; i++) out[k++] = this.refNext[i];
    const x = this.data.xpos;
    for (const b of this.eeIds) for (const c of toHeading(yaw, [x[b * 3] - x[3], x[b * 3 + 1] - x[4], x[b * 3 + 2] - x[5]])) out[k++] = c;
    for (const c of toHeading(yawOf([this.refNext[3], this.refNext[4], this.refNext[5], this.refNext[6]]), [refVel[0], refVel[1], refVel[2]])) out[k++] = c;
    return out;
  }

  /** PD targets = the clip's next pose + scaled correction; then `decimation` physics steps. */
  applyAction(action: ArrayLike<number>): void {
    const { mj, model, data } = this;
    for (let i = 0; i < NUM_ACT; i++) data.ctrl[i] = this.refNext[7 + i] + this.policy.actionScale * Math.min(3, Math.max(-3, action[i]));
    for (let s = 0; s < this.policy.decimation; s++) mj.mj_step(model, data);
    this.t += this.policy.decimation * model.opt.timestep;
  }

  /**
   * Keep the clip under the character: re-anchor its path at the character's current position and heading
   * (training measured everything in the character's own heading frame, so this is what the policy expects).
   */
  reanchor(): void {
    const q = this.data.qpos;
    const r = this.ref.qpos(this.t);
    this.offsetYaw = yawOf([q[3], q[4], q[5], q[6]]) - yawOf([r[3], r[4], r[5], r[6]]);
    const c = Math.cos(this.offsetYaw);
    const s = Math.sin(this.offsetYaw);
    this.offset = [q[0] - (c * r[0] - s * r[1]), q[1] - (s * r[0] + c * r[1])];
  }

  get fallen(): boolean {
    return this.data.qpos[2] < 0.55;
  }

  dispose(): void {
    this.data.delete();
    this.model.delete();
  }
}
