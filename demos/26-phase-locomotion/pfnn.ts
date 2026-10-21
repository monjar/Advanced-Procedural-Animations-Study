import { forwardKinematics, qmul, qrot, skeletonDef, type SkeletonDef } from '../../src/anim/fk';
import { sixdToQuat, Y_CONTACT, Y_HIP, Y_ROOT, Y_ROT } from '../16-learned-motion-matching/pose';
import { TrajectoryController, type ControlInput } from '../09-motion-matching/controller';

/**
 * Study 26's runtime: the phase-functioned network (Holden, Komura & Saito 2017) and a plain MLP, each driving a
 * character autoregressively — every frame the network sees the trajectory and its own previous output, and
 * returns the next pose, the root motion and how far to advance the phase.
 */

interface LayerFile {
  in: number;
  out: number;
  weight: string;
  bias: string;
}
export interface NetworksFile {
  hidden: number;
  params: { pfnn: number; mlp: number };
  x: { mean: number[]; std: number[] };
  y: { mean: number[]; std: number[] };
  pfnn: LayerFile[];
  mlp: LayerFile[];
  fixture: { x: number[][]; phase: number[]; pfnn: number[][]; mlp: number[][] };
}
export interface PfnnModel {
  traj: number[];
  xDims: number;
  yDims: number;
  poseDims: number;
  joints: number;
  parents: number[];
  offsets: [number, number, number][];
  names: string[];
  fps: number;
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}
function decodeF16(b64: string): Float32Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Float32Array(bin.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = halfToFloat(bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8));
  return out;
}

const elu = (s: number) => (s > 0 ? s : Math.expm1(s));

/** A network over normalised inputs and outputs; `phased` layers hold four weight sets blended by the phase. */
export class PhaseNet {
  private readonly layers: { in: number; out: number; w: Float32Array; b: Float32Array }[];
  private readonly bufs: Float64Array[];
  private readonly xin: Float64Array;
  private readonly c = new Float64Array(4);
  constructor(
    layers: LayerFile[],
    private readonly norm: NetworksFile,
    readonly phased: boolean,
  ) {
    this.layers = layers.map((l) => ({ in: l.in, out: l.out, w: decodeF16(l.weight), b: decodeF16(l.bias) }));
    this.bufs = this.layers.map((l) => new Float64Array(l.out));
    this.xin = new Float64Array(norm.x.mean.length + (phased ? 0 : 2));
  }

  /** Cyclic Catmull–Rom weights of the four control sets at phase p ∈ [0, 1). */
  private coeffs(p: number): Float64Array {
    const q = p * 4;
    const k1 = ((Math.floor(q) % 4) + 4) % 4;
    const t = q - Math.floor(q);
    const t2 = t * t;
    const t3 = t2 * t;
    this.c.fill(0);
    this.c[(k1 + 3) % 4] += -0.5 * t + t2 - 0.5 * t3;
    this.c[k1] += 1 - 2.5 * t2 + 1.5 * t3;
    this.c[(k1 + 1) % 4] += 0.5 * t + 2 * t2 - 1.5 * t3;
    this.c[(k1 + 2) % 4] += -0.5 * t2 + 0.5 * t3;
    return this.c;
  }

  run(x: ArrayLike<number>, phase: number, out: Float64Array): Float64Array {
    const { mean, std } = this.norm.x;
    for (let i = 0; i < mean.length; i++) this.xin[i] = (x[i] - mean[i]) / std[i];
    if (!this.phased) {
      this.xin[mean.length] = Math.sin(2 * Math.PI * phase);
      this.xin[mean.length + 1] = Math.cos(2 * Math.PI * phase);
    }
    const c = this.phased ? this.coeffs(phase) : null;
    let v: ArrayLike<number> = this.xin;
    const last = this.layers.length - 1;
    this.layers.forEach((l, k) => {
      const y = k === last ? out : this.bufs[k];
      const size = l.out * l.in;
      for (let o = 0; o < l.out; o++) {
        let s = 0;
        if (c) {
          for (let set = 0; set < 4; set++) {
            const ck = c[set];
            if (ck === 0) continue;
            let a = l.b[set * l.out + o];
            const row = set * size + o * l.in;
            for (let i = 0; i < l.in; i++) a += l.w[row + i] * v[i];
            s += ck * a;
          }
        } else {
          s = l.b[o];
          const row = o * l.in;
          for (let i = 0; i < l.in; i++) s += l.w[row + i] * v[i];
        }
        y[o] = k === last ? s : elu(s);
      }
      v = y;
    });
    const ym = this.norm.y.mean;
    const ys = this.norm.y.std;
    for (let i = 0; i < out.length; i++) out[i] = out[i] * ys[i] + ym[i];
    return out;
  }
}

/** A character driven by one network. Bone frame: yaw about +y, yaw 0 faces +z (study 09's simulation bone). */
export class Runner {
  x = 0;
  z = 0;
  yaw = 0;
  phase = 0;
  readonly controller = new TrajectoryController();
  /** Joint positions and velocities in the bone frame (the network's own previous output). */
  readonly joints: Float64Array;
  /** World joint positions for drawing. */
  readonly world: Float64Array;
  readonly y: Float64Array;
  /** Foot contacts from the network (0–1). */
  contacts = [0, 0];
  private readonly xv: Float64Array;
  private readonly history: { x: number; z: number; yaw: number }[] = [];
  private readonly skel: SkeletonDef;
  private readonly rot: Float64Array;
  private readonly local: Float64Array;
  private readonly rootPos = new Float64Array(3);

  constructor(
    readonly net: PhaseNet,
    readonly model: PfnnModel,
    start: { joints: ArrayLike<number>; phase: number },
  ) {
    const J = model.joints;
    this.joints = Float64Array.from(start.joints);
    this.phase = start.phase;
    this.world = new Float64Array(J * 3);
    this.y = new Float64Array(model.yDims);
    this.xv = new Float64Array(model.xDims);
    this.skel = skeletonDef(model.parents.map((p, i) => ({ parent: p, offset: model.offsets[i] })));
    this.rot = new Float64Array(J * 4);
    this.local = new Float64Array(J * 4);
    for (let i = 0; i < 31; i++) this.history.push({ x: 0, z: 0, yaw: 0 });
  }

  private toBone(dx: number, dz: number): [number, number] {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return [c * dx - s * dz, s * dx + c * dz];
  }

  step(input: ControlInput, dt = 1 / 60): void {
    const m = this.model;
    const ctl = this.controller;
    ctl.update(input, dt);
    // Keep the desired path anchored on the character (its velocities stay the spring's).
    ctl.x.x = this.x;
    ctl.z.x = this.z;
    ctl.yaw.x = this.yaw;
    // Input: past trajectory from history, future from the controller's prediction, then the previous pose.
    let k = 0;
    const p = { x: 0, z: 0, yaw: 0 };
    for (const o of m.traj) {
      if (o < 0) {
        const h = this.history[this.history.length - 1 + o];
        p.x = h.x;
        p.z = h.z;
        p.yaw = h.yaw;
      } else ctl.predict(o / m.fps, p);
      const [bx, bz] = this.toBone(p.x - this.x, p.z - this.z);
      const d = p.yaw - this.yaw;
      this.xv[k++] = bx;
      this.xv[k++] = bz;
      this.xv[k++] = Math.sin(d);
      this.xv[k++] = Math.cos(d);
    }
    this.xv[k++] = input.run ? 0 : 1;
    this.xv[k++] = input.run ? 1 : 0;
    this.xv.set(this.joints, k);
    const y = this.net.run(this.xv, this.phase, this.y);
    // Root motion (bone frame) → world.
    const vx = y[Y_ROOT];
    const vz = y[Y_ROOT + 1];
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    this.x += (c * vx + s * vz) * dt;
    this.z += (-s * vx + c * vz) * dt;
    this.yaw += y[Y_ROOT + 2] * dt;
    this.history.push({ x: this.x, z: this.z, yaw: this.yaw });
    if (this.history.length > 31) this.history.shift();
    // The phase advances by what the network says (clamped: never backwards, never a whole cycle).
    this.phase = (this.phase + Math.min(0.08, Math.max(0, y[m.yDims - 1]))) % 1;
    this.joints.set(y.subarray(m.poseDims, m.poseDims + m.joints * 6));
    this.contacts = [y[Y_CONTACT], y[Y_CONTACT + 1]];
    this.pose();
  }

  /** World joint positions from the predicted hips and 6-D rotations. */
  private pose(): void {
    const m = this.model;
    const J = m.joints;
    const y = this.y;
    for (let j = 0; j < J; j++) sixdToQuat(y, Y_ROT + 6 * j, this.local, j * 4);
    // Joint 0's rotation is relative to the bone: compose with the bone's yaw.
    const half = this.yaw / 2;
    const boneQ = [0, Math.sin(half), 0, Math.cos(half)];
    qmul(boneQ, 0, this.local, 0, this.local, 0);
    const hip = [0, 0, 0];
    qrot(boneQ, 0, [y[Y_HIP], y[Y_HIP + 1], y[Y_HIP + 2]], 0, hip, 0);
    this.rootPos[0] = this.x + hip[0];
    this.rootPos[1] = hip[1];
    this.rootPos[2] = this.z + hip[2];
    forwardKinematics(this.skel, this.rootPos, 0, this.local, 0, this.world, this.rot);
  }
}
