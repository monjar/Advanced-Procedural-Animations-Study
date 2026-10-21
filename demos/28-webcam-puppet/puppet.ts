import { LM, type Landmarks } from './landmarks';

/**
 * From noisy hip-centred landmarks to a walking puppet:
 *
 *   filter     the One Euro filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass whose cutoff rises with the
 *              signal's speed — heavy smoothing when still (no jitter), light when moving (little lag). An
 *              exponential moving average, the obvious alternative, must pick one of the two.
 *   retarget   keep each bone's *direction* from the landmarks and the character's own bone *lengths*, so a
 *              child-sized or giant character can be driven by anyone without stretching.
 *   locomotion the tracker's world landmarks are centred on the hips, so walking across the room is invisible
 *              in them. The puppet recovers it from the feet: one foot is planted, and the body moves so that
 *              foot stays put. Switching the planted foot carries the body forward one step at a time — the
 *              way a person's body actually travels.
 */

export class OneEuro {
  private x: Float64Array | null = null;
  private dx: Float64Array;
  constructor(
    readonly size: number,
    public minCutoff = 1.5,
    public beta = 4,
    public dCutoff = 1,
  ) {
    this.dx = new Float64Array(size);
  }
  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v: ArrayLike<number>, dt: number, out: Float64Array): Float64Array {
    if (!this.x) {
      this.x = Float64Array.from(v);
      out.set(this.x);
      return out;
    }
    const ad = OneEuro.alpha(this.dCutoff, dt);
    for (let i = 0; i < this.size; i++) {
      const d = (v[i] - this.x[i]) / dt;
      this.dx[i] += ad * (d - this.dx[i]);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx[i]);
      const a = OneEuro.alpha(cutoff, dt);
      this.x[i] += a * (v[i] - this.x[i]);
    }
    out.set(this.x);
    return out;
  }
  reset(): void {
    this.x = null;
    this.dx.fill(0);
  }
}

export class Ema {
  private x: Float64Array | null = null;
  constructor(
    readonly size: number,
    public alpha = 0.35,
  ) {}
  filter(v: ArrayLike<number>, _dt: number, out: Float64Array): Float64Array {
    if (!this.x) this.x = Float64Array.from(v);
    else for (let i = 0; i < this.size; i++) this.x[i] += this.alpha * (v[i] - this.x[i]);
    out.set(this.x);
    return out;
  }
  reset(): void {
    this.x = null;
  }
}

/** The puppet's skeleton: joint names, parents and bone lengths (m), roughly the CMU subject's proportions. */
export const PUPPET = {
  names: ['hips', 'lHip', 'lKnee', 'lAnkle', 'lToe', 'rHip', 'rKnee', 'rAnkle', 'rToe', 'chest', 'neck', 'head', 'lShoulder', 'lElbow', 'lWrist', 'rShoulder', 'rElbow', 'rWrist'],
  parents: [-1, 0, 1, 2, 3, 0, 5, 6, 7, 0, 9, 10, 9, 12, 13, 9, 15, 16],
};

export interface Proportions {
  hipHalf: number;
  thigh: number;
  shin: number;
  foot: number;
  spine: number;
  neck: number;
  shoulderHalf: number;
  upperArm: number;
  forearm: number;
}
export const ADULT: Proportions = { hipHalf: 0.1, thigh: 0.4, shin: 0.43, foot: 0.13, spine: 0.48, neck: 0.22, shoulderHalf: 0.18, upperArm: 0.29, forearm: 0.22 };

/** The tracked person's own proportions: each bone's median length over a set of landmark frames. */
export function measure(frames: Landmarks[]): Proportions {
  const med = (f: (lm: Landmarks) => number) => {
    const v = frames.map(f).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const d = (a: number, b: number) => (lm: Landmarks) => Math.hypot(...sub(get(lm, a), get(lm, b)));
  const both = (l: [number, number], r: [number, number]) => (lm: Landmarks) => (d(...l)(lm) + d(...r)(lm)) / 2;
  const mid = (lm: Landmarks, a: number, b: number): V => scale(add(get(lm, a), get(lm, b)), 0.5);
  return {
    hipHalf: med(d(LM.leftHip, LM.rightHip)) / 2,
    thigh: med(both([LM.leftHip, LM.leftKnee], [LM.rightHip, LM.rightKnee])),
    shin: med(both([LM.leftKnee, LM.leftAnkle], [LM.rightKnee, LM.rightAnkle])),
    foot: med(both([LM.leftAnkle, LM.leftFootIndex], [LM.rightAnkle, LM.rightFootIndex])),
    spine: med((lm) => Math.hypot(...sub(mid(lm, LM.leftShoulder, LM.rightShoulder), mid(lm, LM.leftHip, LM.rightHip)))),
    neck: med((lm) => Math.hypot(...sub(get(lm, LM.nose), mid(lm, LM.leftShoulder, LM.rightShoulder)))),
    shoulderHalf: med(d(LM.leftShoulder, LM.rightShoulder)) / 2,
    upperArm: med(both([LM.leftShoulder, LM.leftElbow], [LM.rightShoulder, LM.rightElbow])),
    forearm: med(both([LM.leftElbow, LM.leftWrist], [LM.rightElbow, LM.rightWrist])),
  };
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V): V => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const get = (lm: Landmarks, i: number): V => [lm[i * 3], lm[i * 3 + 1], lm[i * 3 + 2]];

/** Joint positions relative to the hips (puppet order), from landmarks: landmark directions, puppet lengths. */
export function retarget(lm: Landmarks, p: Proportions = ADULT): V[] {
  const lHip = get(lm, LM.leftHip);
  const rHip = get(lm, LM.rightHip);
  const hipC = scale(add(lHip, rHip), 0.5);
  const shC = scale(add(get(lm, LM.leftShoulder), get(lm, LM.rightShoulder)), 0.5);
  const out: V[] = new Array(PUPPET.names.length);
  out[0] = [0, 0, 0];
  const across = norm(sub(lHip, rHip));
  out[1] = scale(across, p.hipHalf);
  out[5] = scale(across, -p.hipHalf);
  const chain = (root: V, ids: number[], lengths: number[], slots: number[]) => {
    let at = root;
    for (let k = 1; k < ids.length; k++) {
      at = add(at, scale(norm(sub(get(lm, ids[k]), get(lm, ids[k - 1]))), lengths[k - 1]));
      out[slots[k - 1]] = at;
    }
  };
  chain(out[1], [LM.leftHip, LM.leftKnee, LM.leftAnkle, LM.leftFootIndex], [p.thigh, p.shin, p.foot], [2, 3, 4]);
  chain(out[5], [LM.rightHip, LM.rightKnee, LM.rightAnkle, LM.rightFootIndex], [p.thigh, p.shin, p.foot], [6, 7, 8]);
  out[9] = scale(norm(sub(shC, hipC)), p.spine);
  out[10] = add(out[9], scale(norm(sub(shC, hipC)), 0.05));
  out[11] = add(out[9], scale(norm(sub(get(lm, LM.nose), shC)), p.neck));
  const shAcross = norm(sub(get(lm, LM.leftShoulder), get(lm, LM.rightShoulder)));
  out[12] = add(out[9], scale(shAcross, p.shoulderHalf));
  out[15] = add(out[9], scale(shAcross, -p.shoulderHalf));
  chain(out[12], [LM.leftShoulder, LM.leftElbow, LM.leftWrist], [p.upperArm, p.forearm], [13, 14]);
  chain(out[15], [LM.rightShoulder, LM.rightElbow, LM.rightWrist], [p.upperArm, p.forearm], [16, 17]);
  return out;
}

/**
 * Puts the hip-centred pose into the world. The planted foot is the one moving *backward* fastest relative to the
 * hips (a planted foot sweeps back under a walking body at the body's speed; a swinging one comes forward). The
 * body moves by the opposite of that foot's motion, so the planted foot stays still in the world. Picking the
 * lower foot instead — the obvious rule — is fooled by heel-off and by depth noise: it loses 10–30% of the
 * distance walked.
 */
export class Locomotion {
  /** Hips' world position. */
  root: V = [0, 0, 0];
  /** Planted foot: 0 left, 1 right. */
  stance = 0;
  /** How sharply (m/s) the weight moves to the foot sweeping back faster; small is a hard switch. */
  softness = 0.2;
  /** Time constant (s) of the foot velocities the weights are computed from (the motion applied is not smoothed). */
  decisionLag = 0.03;
  /** Weight of the left foot as the planted one (the right has the rest). */
  weight = 0.5;
  /**
   * Is the person stepping? Over the last `strideWindow` seconds, the feet's fore-aft separation must swing by
   * more than `strideMin` (m) — a stride does; tracker noise on two standing feet doesn't. Without this gate a
   * person standing still walks off: the foot that seems to sweep back is, as often as not, the noisier one.
   */
  strideWindow = 0.5;
  strideMin: [number, number] = [0.12, 0.25];
  stepping = 0;
  private readonly seps: [number, number][] = [];
  private clock = 0;
  readonly world: V[] = [];
  enabled = true;
  private prev: V[] | null = null;
  private readonly forward = [0, 0];

  /** Each foot's ground point (between ankle and toe) relative to the hips. */
  private static feet(pose: V[]): V[] {
    return [0, 1].map((i) => {
      const a = pose[i ? 7 : 3];
      const t = pose[i ? 8 : 4];
      return [(a[0] + t[0]) / 2, Math.min(a[1], t[1]), (a[2] + t[2]) / 2];
    });
  }

  update(pose: V[], dt: number): V[] {
    const feet = Locomotion.feet(pose);
    const floor = -Math.min(feet[0][1], feet[1][1]) + 0.02;
    if (this.enabled && this.prev) {
      // Facing, from the hips' left-to-right axis.
      const ax = pose[1][0] - pose[5][0];
      const az = pose[1][2] - pose[5][2];
      const al = Math.hypot(ax, az) || 1;
      const fx = -az / al;
      const fz = ax / al;
      const d = feet.map((f, i) => [f[0] - this.prev![i][0], f[2] - this.prev![i][2]]);
      const k = 1 - Math.exp(-dt / this.decisionLag);
      d.forEach(([x, z], i) => (this.forward[i] += k * ((x * fx + z * fz) / dt - this.forward[i])));
      // Soft choice of the planted foot: the one sweeping back faster gets the weight.
      const e = Math.exp(Math.max(-30, Math.min(30, (this.forward[1] - this.forward[0]) / this.softness)));
      this.weight = e / (1 + e);
      this.stance = this.weight > 0.5 ? 0 : 1;
      this.clock += dt;
      this.seps.push([this.clock, (feet[0][0] - feet[1][0]) * fx + (feet[0][2] - feet[1][2]) * fz]);
      while (this.seps[0][0] < this.clock - this.strideWindow) this.seps.shift();
      let lo = Infinity;
      let hi = -Infinity;
      for (const [, v] of this.seps) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
      const [m0, m1] = this.strideMin;
      const g = Math.min(1, Math.max(0, (hi - lo - m0) / (m1 - m0)));
      this.stepping = g * g * (3 - 2 * g);
      const w = [this.weight * this.stepping, (1 - this.weight) * this.stepping];
      this.root = [this.root[0] - w[0] * d[0][0] - w[1] * d[1][0], floor, this.root[2] - w[0] * d[0][1] - w[1] * d[1][1]];
    } else this.root = [this.enabled ? this.root[0] : 0, floor, this.enabled ? this.root[2] : 0];
    this.prev = feet;
    this.world.length = 0;
    for (const j of pose) this.world.push(add(this.root, j));
    return this.world;
  }

  /** Forget the last pose (after a cut in the input), keeping where the body is. */
  cut(): void {
    this.prev = null;
    this.forward.fill(0);
    this.seps.length = 0;
  }

  reset(): void {
    this.root = [0, 0, 0];
    this.cut();
  }
}
