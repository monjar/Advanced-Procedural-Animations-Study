import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';
import type { PolicyFile } from './policy';

/**
 * The quadruped in MuJoCo WASM, with the controller interface the policy was trained on. `observe` and
 * `applyAction` transcribe training/env.py's `observe` and `apply_action`; a unit test replays a run recorded
 * in Python MuJoCo through them and compares every observation.
 */

export const NUM_OBS = 48;
export const NUM_ACT = 12;
const LIN_VEL_SCALE = 2.0;
const ANG_VEL_SCALE = 0.25;
const DOF_VEL_SCALE = 0.05;
const CLIP_ACTIONS = 100;

/** Rotate world vector v into the frame of unit quaternion q = (w, x, y, z): Rᵀ v. */
export function quatRotateInverse(q: ArrayLike<number>, v: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  out[0] = (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y + w * z) * v[1] + 2 * (x * z - w * y) * v[2];
  out[1] = 2 * (x * y - w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z + w * x) * v[2];
  out[2] = 2 * (x * z + w * y) * v[0] + 2 * (y * z - w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2];
  return out;
}

export class QuadrupedSim {
  readonly model: MjModel;
  readonly data: MjData;
  readonly defaultPose: number[];
  readonly actionScale: number;
  readonly decimation: number;
  readonly trunkBody: number;
  private readonly lin = [0, 0, 0];
  private readonly grav = [0, 0, 0];

  constructor(
    readonly mj: MainModule,
    xml: string,
    policy: Pick<PolicyFile, 'defaultPose' | 'actionScale' | 'decimation'>,
  ) {
    this.model = mj.MjModel.from_xml_string(xml);
    this.data = new mj.MjData(this.model);
    this.defaultPose = policy.defaultPose;
    this.actionScale = policy.actionScale;
    this.decimation = policy.decimation;
    this.trunkBody = mj.mj_name2id(this.model, mj.mjtObj.mjOBJ_BODY.value, 'trunk');
    this.reset();
  }

  /** Standing pose at the origin, facing +x (MuJoCo world: z up). */
  reset(qpos?: ArrayLike<number>): void {
    const { mj, model, data } = this;
    mj.mj_resetData(model, data);
    const init = qpos ?? [0, 0, 0.33, 1, 0, 0, 0, ...this.defaultPose];
    for (let i = 0; i < init.length; i++) data.qpos[i] = init[i];
    for (let i = 0; i < NUM_ACT; i++) data.ctrl[i] = this.defaultPose[i];
    mj.mj_forward(model, data);
  }

  observe(command: ArrayLike<number>, lastAction: ArrayLike<number>, out: Float64Array = new Float64Array(NUM_OBS)): Float64Array {
    const { qpos, qvel } = this.data;
    const quat = [qpos[3], qpos[4], qpos[5], qpos[6]];
    const lin = quatRotateInverse(quat, [qvel[0], qvel[1], qvel[2]], this.lin);
    const g = quatRotateInverse(quat, [0, 0, -1], this.grav);
    let k = 0;
    for (let i = 0; i < 3; i++) out[k++] = lin[i] * LIN_VEL_SCALE;
    for (let i = 0; i < 3; i++) out[k++] = qvel[3 + i] * ANG_VEL_SCALE;
    for (let i = 0; i < 3; i++) out[k++] = g[i];
    out[k++] = command[0] * LIN_VEL_SCALE;
    out[k++] = command[1] * LIN_VEL_SCALE;
    out[k++] = command[2] * ANG_VEL_SCALE;
    for (let i = 0; i < NUM_ACT; i++) out[k++] = qpos[7 + i] - this.defaultPose[i];
    for (let i = 0; i < NUM_ACT; i++) out[k++] = qvel[6 + i] * DOF_VEL_SCALE;
    for (let i = 0; i < NUM_ACT; i++) out[k++] = lastAction[i];
    return out;
  }

  /** Joint targets from the action, then `decimation` physics steps (one 50 Hz control step). */
  applyAction(action: ArrayLike<number>): void {
    const { mj, model, data } = this;
    for (let i = 0; i < NUM_ACT; i++) {
      const a = Math.min(CLIP_ACTIONS, Math.max(-CLIP_ACTIONS, action[i]));
      data.ctrl[i] = this.defaultPose[i] + this.actionScale * a;
    }
    for (let s = 0; s < this.decimation; s++) mj.mj_step(model, data);
  }

  /** Base height, uprightness and world position, for falls and the camera. */
  get height(): number {
    return this.data.qpos[2];
  }

  get upright(): number {
    const q = this.data.qpos;
    return -quatRotateInverse([q[3], q[4], q[5], q[6]], [0, 0, -1], this.grav)[2];
  }

  /** A shove: add to the trunk's world velocity (what training's random pushes do). */
  shove(vx: number, vy: number): void {
    this.data.qvel[0] += vx;
    this.data.qvel[1] += vy;
  }

  /** A force on the trunk (world frame, N) applied at its centre of mass until cleared. */
  setTrunkForce(fx: number, fy: number, fz: number): void {
    const f = this.data.xfrc_applied;
    const o = this.trunkBody * 6;
    f[o] = fx;
    f[o + 1] = fy;
    f[o + 2] = fz;
  }

  dispose(): void {
    this.data.delete();
    this.model.delete();
  }
}
