import { forwardKinematics, qrot, skeletonDef } from './fk';
import type { MotionDB } from './mmdb';

/**
 * Motion-matching features (study 09). Everything is expressed in the frame of a *simulation bone*: the
 * hips projected onto the ground, facing the smoothed hip forward direction. The character is driven by
 * this bone, and the search compares futures relative to it.
 */

/** Trajectory sample offsets (frames at 60 Hz): 1/6, 1/3 and 1/2 s. CMU takes are too short for 1 s. */
export const TRAJ_FRAMES = [10, 20, 30] as const;
/** A frame is a candidate only if the take continues this many frames after it. */
export const MIN_REMAINING = 10;

export interface FeatureGroup {
  name: string;
  size: number;
}

export const GROUPS: readonly FeatureGroup[] = [
  { name: 'trajectory position', size: 6 },
  { name: 'trajectory direction', size: 6 },
  { name: 'foot position', size: 6 },
  { name: 'foot velocity', size: 6 },
  { name: 'hip velocity', size: 3 },
];
export const DIMS = GROUPS.reduce((n, g) => n + g.size, 0);
/** First dimension of each group. */
export const GROUP_START = GROUPS.map((_, i) => GROUPS.slice(0, i).reduce((n, g) => n + g.size, 0));

export const DEFAULT_WEIGHTS = [1, 1.5, 0.75, 1, 1];

export interface MotionFeatures {
  db: MotionDB;
  /** Simulation bone per frame: world x/z and yaw (rotation about +Y; yaw 0 faces +Z). */
  simPos: Float32Array;
  simYaw: Float32Array;
  /** Root motion per frame, in the simulation bone's frame: velocity (x, z) m/s, yaw rate rad/s. */
  rootVel: Float32Array;
  rootYawRate: Float32Array;
  /** Hips relative to the simulation bone: position [frames·3] and rotation [frames·4]. */
  hipPos: Float32Array;
  hipRot: Float32Array;
  /** Unnormalised features [frames·DIMS]. */
  raw: Float32Array;
  /** Normalised features: (raw − mean) / group std. */
  features: Float32Array;
  mean: Float32Array;
  /** Pooled standard deviation per group (keeps each group's geometry). */
  scale: Float32Array;
  /** 1 where the frame may be jumped to. */
  matchable: Uint8Array;
  /** Joint indices used. */
  leftFoot: number;
  rightFoot: number;
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

function gaussianSmooth(src: Float64Array, start: number, count: number, sigma: number, out: Float64Array): void {
  const r = Math.ceil(sigma * 3);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    let wsum = 0;
    for (let k = -r; k <= r; k++) {
      const j = Math.min(count - 1, Math.max(0, i + k));
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      sum += src[start + j] * w;
      wsum += w;
    }
    out[start + i] = sum / wsum;
  }
}

/** Rotate (x, z) by −yaw into a simulation bone's frame. */
function toLocal(x: number, z: number, yaw: number, out: number[], o: number): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out[o] = c * x - s * z;
  out[o + 1] = s * x + c * z;
}

/** Build the simulation bone, root motion and normalised features for every frame of `db`. */
export function buildFeatures(db: MotionDB): MotionFeatures {
  const N = db.frames;
  const J = db.joints.length;
  const fps = db.fps;
  const skel = skeletonDef(db.joints);
  const names = db.joints.map((j) => j.name);
  const leftFoot = names.indexOf('LeftFoot');
  const rightFoot = names.indexOf('RightFoot');

  // World joint positions for the joints we need.
  const pos = new Float32Array(J * 3);
  const rot = new Float32Array(J * 4);
  const hips = new Float64Array(N * 3);
  const feet = new Float64Array(N * 6);
  const fwdX = new Float64Array(N);
  const fwdZ = new Float64Array(N);
  const f3 = [0, 0, 0];
  for (let f = 0; f < N; f++) {
    forwardKinematics(skel, db.root, f * 3, db.rot, f * J * 4, pos, rot);
    hips.set([pos[0], pos[1], pos[2]], f * 3);
    feet.set([pos[leftFoot * 3], pos[leftFoot * 3 + 1], pos[leftFoot * 3 + 2], pos[rightFoot * 3], pos[rightFoot * 3 + 1], pos[rightFoot * 3 + 2]], f * 6);
    qrot(db.rot, f * J * 4, [0, 0, 1], 0, f3, 0);
    const l = Math.hypot(f3[0], f3[2]) || 1;
    fwdX[f] = f3[0] / l;
    fwdZ[f] = f3[2] / l;
  }

  // Simulation bone: smoothed ground projection of the hips, smoothed hip facing.
  const simPos = new Float32Array(N * 2);
  const simYaw = new Float32Array(N);
  const hx = new Float64Array(N);
  const hz = new Float64Array(N);
  for (let f = 0; f < N; f++) {
    hx[f] = hips[f * 3];
    hz[f] = hips[f * 3 + 2];
  }
  const sx = new Float64Array(N);
  const sz = new Float64Array(N);
  const dx = new Float64Array(N);
  const dz = new Float64Array(N);
  for (const t of db.takes) {
    gaussianSmooth(hx, t.start, t.frames, 4, sx);
    gaussianSmooth(hz, t.start, t.frames, 4, sz);
    gaussianSmooth(fwdX, t.start, t.frames, 8, dx);
    gaussianSmooth(fwdZ, t.start, t.frames, 8, dz);
  }
  for (let f = 0; f < N; f++) {
    simPos[f * 2] = sx[f];
    simPos[f * 2 + 1] = sz[f];
    simYaw[f] = Math.atan2(dx[f], dz[f]);
  }

  // Root motion and hips relative to the simulation bone.
  const rootVel = new Float32Array(N * 2);
  const rootYawRate = new Float32Array(N);
  const hipPos = new Float32Array(N * 3);
  const hipRot = new Float32Array(N * 4);
  const v = [0, 0];
  for (const t of db.takes) {
    const end = t.start + t.frames - 1;
    for (let f = t.start; f <= end; f++) {
      const g = f < end ? f + 1 : f;
      const h = f < end ? f : f - 1;
      toLocal((simPos[g * 2] - simPos[h * 2]) * fps, (simPos[g * 2 + 1] - simPos[h * 2 + 1]) * fps, simYaw[f], v, 0);
      rootVel[f * 2] = v[0];
      rootVel[f * 2 + 1] = v[1];
      rootYawRate[f] = wrapAngle(simYaw[g] - simYaw[h]) * fps;
      toLocal(hips[f * 3] - simPos[f * 2], hips[f * 3 + 2] - simPos[f * 2 + 1], simYaw[f], v, 0);
      hipPos.set([v[0], hips[f * 3 + 1], v[1]], f * 3);
      // hipRot = yaw(−simYaw) ⊗ hips world rotation
      const half = -simYaw[f] / 2;
      const qy = [0, Math.sin(half), 0, Math.cos(half)];
      const k = f * J * 4;
      const [x, y, z, w] = [db.rot[k], db.rot[k + 1], db.rot[k + 2], db.rot[k + 3]];
      hipRot[f * 4] = qy[3] * x + qy[1] * z;
      hipRot[f * 4 + 1] = qy[3] * y + qy[1] * w;
      hipRot[f * 4 + 2] = qy[3] * z - qy[1] * x;
      hipRot[f * 4 + 3] = qy[3] * w - qy[1] * y;
    }
  }

  // Features.
  const raw = new Float32Array(N * DIMS);
  const matchable = new Uint8Array(N);
  const H = TRAJ_FRAMES[TRAJ_FRAMES.length - 1];
  const tmp = [0, 0];
  for (const t of db.takes) {
    // Trajectory extended past the end of the take: extrapolated with the final velocity and turn rate,
    // or held if the take ends at rest.
    const ext = new Float64Array((t.frames + H) * 3);
    for (let i = 0; i < t.frames; i++) ext.set([simPos[(t.start + i) * 2], simPos[(t.start + i) * 2 + 1], simYaw[t.start + i]], i * 3);
    const last = t.start + t.frames - 1;
    const back = Math.min(5, t.frames - 1);
    const vx = (simPos[last * 2] - simPos[(last - back) * 2]) / Math.max(1, back);
    const vz = (simPos[last * 2 + 1] - simPos[(last - back) * 2 + 1]) / Math.max(1, back);
    const turn = wrapAngle(simYaw[last] - simYaw[last - back]) / Math.max(1, back);
    const moving = Math.hypot(vx, vz) * fps > 0.1;
    toLocal(vx, vz, simYaw[last], tmp, 0);
    const lv = [tmp[0], tmp[1]];
    for (let i = t.frames; i < t.frames + H; i++) {
      const p = (i - 1) * 3;
      if (!moving) {
        ext.set([ext[p], ext[p + 1], ext[p + 2]], i * 3);
        continue;
      }
      const yaw = ext[p + 2] + turn;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      ext.set([ext[p] + c * lv[0] + s * lv[1], ext[p + 1] - s * lv[0] + c * lv[1], yaw], i * 3);
    }

    for (let i = 0; i < t.frames; i++) {
      const f = t.start + i;
      const o = f * DIMS;
      const yaw = simYaw[f];
      const px = simPos[f * 2];
      const pz = simPos[f * 2 + 1];
      TRAJ_FRAMES.forEach((k, n) => {
        const e = (i + k) * 3;
        toLocal(ext[e] - px, ext[e + 1] - pz, yaw, tmp, 0);
        raw[o + n * 2] = tmp[0];
        raw[o + n * 2 + 1] = tmp[1];
        toLocal(Math.sin(ext[e + 2]), Math.cos(ext[e + 2]), yaw, tmp, 0);
        raw[o + 6 + n * 2] = tmp[0];
        raw[o + 6 + n * 2 + 1] = tmp[1];
      });
      const prev = i > 0 ? f - 1 : f;
      const next = i > 0 ? f : f + 1;
      for (let side = 0; side < 2; side++) {
        const b = f * 6 + side * 3;
        toLocal(feet[b] - px, feet[b + 2] - pz, yaw, tmp, 0);
        raw.set([tmp[0], feet[b + 1], tmp[1]], o + 12 + side * 3);
        const a0 = prev * 6 + side * 3;
        const a1 = next * 6 + side * 3;
        toLocal((feet[a1] - feet[a0]) * fps, (feet[a1 + 2] - feet[a0 + 2]) * fps, yaw, tmp, 0);
        raw.set([tmp[0], (feet[a1 + 1] - feet[a0 + 1]) * fps, tmp[1]], o + 18 + side * 3);
      }
      toLocal((hips[next * 3] - hips[prev * 3]) * fps, (hips[next * 3 + 2] - hips[prev * 3 + 2]) * fps, yaw, tmp, 0);
      raw.set([tmp[0], (hips[next * 3 + 1] - hips[prev * 3 + 1]) * fps, tmp[1]], o + 24);
      matchable[f] = i < t.frames - MIN_REMAINING ? 1 : 0;
    }
  }

  // Normalise: per-dimension mean, pooled standard deviation per group.
  const mean = new Float32Array(DIMS);
  const scale = new Float32Array(GROUPS.length);
  for (let d = 0; d < DIMS; d++) {
    let s = 0;
    for (let f = 0; f < N; f++) s += raw[f * DIMS + d];
    mean[d] = s / N;
  }
  GROUPS.forEach((g, gi) => {
    let v2 = 0;
    for (let d = GROUP_START[gi]; d < GROUP_START[gi] + g.size; d++) {
      for (let f = 0; f < N; f++) v2 += (raw[f * DIMS + d] - mean[d]) ** 2;
    }
    scale[gi] = Math.sqrt(v2 / (N * g.size)) || 1;
  });
  const features = new Float32Array(N * DIMS);
  for (let f = 0; f < N; f++) {
    for (let gi = 0; gi < GROUPS.length; gi++) {
      for (let d = GROUP_START[gi]; d < GROUP_START[gi] + GROUPS[gi].size; d++) {
        features[f * DIMS + d] = (raw[f * DIMS + d] - mean[d]) / scale[gi];
      }
    }
  }

  return { db, simPos, simYaw, rootVel, rootYawRate, hipPos, hipRot, raw, features, mean, scale, matchable, leftFoot, rightFoot };
}

/** Normalise a raw feature vector in place with the database's statistics. */
export function normalize(mf: MotionFeatures, q: Float32Array): Float32Array {
  for (let gi = 0; gi < GROUPS.length; gi++) {
    for (let d = GROUP_START[gi]; d < GROUP_START[gi] + GROUPS[gi].size; d++) q[d] = (q[d] - mf.mean[d]) / mf.scale[gi];
  }
  return q;
}

/** Per-dimension weights from per-group weights. */
export function dimWeights(groupWeights: readonly number[]): Float32Array {
  const w = new Float32Array(DIMS);
  GROUPS.forEach((g, gi) => w.fill(groupWeights[gi], GROUP_START[gi], GROUP_START[gi] + g.size));
  return w;
}

/** Weighted squared distance between a normalised query and a database frame. */
export function frameCost(mf: MotionFeatures, q: Float32Array, w: Float32Array, frame: number): number {
  const o = frame * DIMS;
  let c = 0;
  for (let d = 0; d < DIMS; d++) {
    const e = q[d] - mf.features[o + d];
    c += w[d] * e * e;
  }
  return c;
}

export interface Match {
  frame: number;
  cost: number;
}

/** Exhaustive search over matchable frames; ties go to the lowest frame index. */
export function searchBrute(mf: MotionFeatures, q: Float32Array, w: Float32Array, out: Match = { frame: -1, cost: Infinity }): Match {
  const F = mf.features;
  const N = mf.db.frames;
  let best = Infinity;
  let bestFrame = -1;
  for (let f = 0; f < N; f++) {
    if (!mf.matchable[f]) continue;
    const o = f * DIMS;
    let c = 0;
    for (let d = 0; d < DIMS; d++) {
      const e = q[d] - F[o + d];
      c += w[d] * e * e;
      if (c >= best) break;
    }
    if (c < best) {
      best = c;
      bestFrame = f;
    }
  }
  out.frame = bestFrame;
  out.cost = best;
  return out;
}

/** Two-level bounding boxes (Holden): per-dimension min/max of normalised features over runs of frames. */
export interface FeatureAABB {
  small: number;
  large: number;
  smallMin: Float32Array;
  smallMax: Float32Array;
  largeMin: Float32Array;
  largeMax: Float32Array;
}

const aabbCache = new WeakMap<MotionFeatures, FeatureAABB>();

export function buildAABB(mf: MotionFeatures, small = 16, large = 64): FeatureAABB {
  const N = mf.db.frames;
  const box = (size: number) => {
    const n = Math.ceil(N / size);
    const min = new Float32Array(n * DIMS).fill(Infinity);
    const max = new Float32Array(n * DIMS).fill(-Infinity);
    for (let f = 0; f < N; f++) {
      const b = Math.floor(f / size) * DIMS;
      for (let d = 0; d < DIMS; d++) {
        const v = mf.features[f * DIMS + d];
        if (v < min[b + d]) min[b + d] = v;
        if (v > max[b + d]) max[b + d] = v;
      }
    }
    return [min, max];
  };
  const [smallMin, smallMax] = box(small);
  const [largeMin, largeMax] = box(large);
  return { small, large, smallMin, smallMax, largeMin, largeMax };
}

/** Lower bound of the weighted cost of any frame in a box. */
function boxBound(q: Float32Array, w: Float32Array, min: Float32Array, max: Float32Array, b: number, best: number): number {
  let c = 0;
  for (let d = 0; d < DIMS; d++) {
    const v = q[d];
    const lo = min[b + d];
    const hi = max[b + d];
    const e = v < lo ? lo - v : v > hi ? v - hi : 0;
    c += w[d] * e * e;
    if (c >= best) return c;
  }
  return c;
}

/** Frames whose full cost was evaluated by the last {@link searchAABB} call (for measuring pruning). */
export let aabbEvaluated = 0;

/**
 * Same result as {@link searchBrute} (frames are visited in index order with the same strict comparison), but
 * skips whole runs of 64 and 16 frames whose bounding box cannot beat the best cost so far.
 */
export function searchAABB(mf: MotionFeatures, q: Float32Array, w: Float32Array, out: Match = { frame: -1, cost: Infinity }): Match {
  let tree = aabbCache.get(mf);
  if (!tree) aabbCache.set(mf, (tree = buildAABB(mf)));
  const F = mf.features;
  const N = mf.db.frames;
  let best = Infinity;
  let bestFrame = -1;
  let evaluated = 0;
  for (let L = 0; L * tree.large < N; L++) {
    if (boxBound(q, w, tree.largeMin, tree.largeMax, L * DIMS, best) >= best) continue;
    const sEnd = Math.min(Math.ceil(N / tree.small), ((L + 1) * tree.large) / tree.small);
    for (let S = (L * tree.large) / tree.small; S < sEnd; S++) {
      if (boxBound(q, w, tree.smallMin, tree.smallMax, S * DIMS, best) >= best) continue;
      const fEnd = Math.min(N, (S + 1) * tree.small);
      for (let f = S * tree.small; f < fEnd; f++) {
        if (!mf.matchable[f]) continue;
        evaluated++;
        const o = f * DIMS;
        let c = 0;
        for (let d = 0; d < DIMS; d++) {
          const e = q[d] - F[o + d];
          c += w[d] * e * e;
          if (c >= best) break;
        }
        if (c < best) {
          best = c;
          bestFrame = f;
        }
      }
    }
  }
  aabbEvaluated = evaluated;
  out.frame = bestFrame;
  out.cost = best;
  return out;
}
