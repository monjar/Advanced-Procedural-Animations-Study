import { forwardKinematics, skeletonDef } from '../../src/anim/fk';
import type { MotionDB } from '../../src/anim/mmdb';
import { Rng } from '../../src/math/random';

/**
 * Pose landmarks in MediaPipe's layout (BlazePose, 33 points; the 17 used here), as *world* landmarks: metres,
 * origin between the hips, the camera's orientation (not the body's). Here y is up, +z toward the camera and +x
 * the person's left — converted from MediaPipe's (x, −y, −z) by `fromMediaPipe`.
 *
 * Synthetic landmarks come from CMU mocap with a tracker-like error model, so filters and the puppet can be
 * scored against the truth: per-frame jitter (larger in depth, larger at the extremities), a slow drift, and
 * occasional outliers.
 */

export const LM = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;
export const USED = Object.values(LM);
export const COUNT = 33;

/** Landmarks as a flat [33·3] array. */
export type Landmarks = Float64Array;

/** MediaPipe world landmarks (x right-in-image = person's left, y down, z away from camera) → ours. */
export function fromMediaPipe(points: { x: number; y: number; z: number }[], out: Landmarks = new Float64Array(COUNT * 3)): Landmarks {
  for (let i = 0; i < COUNT && i < points.length; i++) {
    out[i * 3] = points[i].x;
    out[i * 3 + 1] = -points[i].y;
    out[i * 3 + 2] = -points[i].z;
  }
  return out;
}

const CMU: Record<number, string> = {
  [LM.leftShoulder]: 'LeftArm',
  [LM.rightShoulder]: 'RightArm',
  [LM.leftElbow]: 'LeftForeArm',
  [LM.rightElbow]: 'RightForeArm',
  [LM.leftWrist]: 'LeftHand',
  [LM.rightWrist]: 'RightHand',
  [LM.leftHip]: 'LeftUpLeg',
  [LM.rightHip]: 'RightUpLeg',
  [LM.leftKnee]: 'LeftLeg',
  [LM.rightKnee]: 'RightLeg',
  [LM.leftAnkle]: 'LeftFoot',
  [LM.rightAnkle]: 'RightFoot',
  [LM.leftFootIndex]: 'LeftToeBase',
  [LM.rightFootIndex]: 'RightToeBase',
};

export interface Recording {
  fps: number;
  frames: number;
  /** Ground-truth landmarks, hip-centred [frames][33·3]. */
  truth: Landmarks[];
  /** The same with tracker error. */
  noisy: Landmarks[];
  /** Ground-truth hip-centre world path (x, z) per frame, for scoring the reconstructed locomotion. */
  rootPath: [number, number][];
}

export interface NoiseModel {
  /** Per-frame jitter σ (m) across the image, and the depth multiple. */
  jitter: number;
  depth: number;
  /** Probability per landmark per frame of an outlier, and its size (m). */
  outlier: number;
  outlierSize: number;
}
export const TRACKER_NOISE: NoiseModel = { jitter: 0.012, depth: 2.5, outlier: 0.004, outlierSize: 0.12 };

/** Landmarks from mocap takes (resampled to 30 Hz), with and without tracker error. */
export function record(db: MotionDB, takeIds: string[], noise: NoiseModel = TRACKER_NOISE, seed = 3, fps = 30): Recording {
  const skel = skeletonDef(db.joints);
  const J = db.joints.length;
  const idx = (n: string) => db.joints.findIndex((j) => j.name === n);
  const pos = new Float32Array(J * 3);
  const rot = new Float32Array(J * 4);
  const rng = new Rng(seed);
  const truth: Landmarks[] = [];
  const noisy: Landmarks[] = [];
  const rootPath: [number, number][] = [];
  const drift = new Float64Array(COUNT * 3);
  const hold = new Int32Array(COUNT);
  const jump = new Float64Array(COUNT * 3);
  for (const id of takeIds) {
    const take = db.takes.find((t) => t.name === id && !t.mirrored)!;
    const step = db.fps / fps;
    for (let s = 0; s < take.frames - 1; s += step) {
      const f = take.start + Math.floor(s);
      forwardKinematics(skel, db.root, f * 3, db.rot, f * J * 4, pos, rot);
      const lh = idx('LeftUpLeg');
      const rh = idx('RightUpLeg');
      const cx = (pos[lh * 3] + pos[rh * 3]) / 2;
      const cy = (pos[lh * 3 + 1] + pos[rh * 3 + 1]) / 2;
      const cz = (pos[lh * 3 + 2] + pos[rh * 3 + 2]) / 2;
      const t = new Float64Array(COUNT * 3);
      for (const [lm, name] of Object.entries(CMU)) {
        const j = idx(name);
        t[+lm * 3] = pos[j * 3] - cx;
        t[+lm * 3 + 1] = pos[j * 3 + 1] - cy;
        t[+lm * 3 + 2] = pos[j * 3 + 2] - cz;
      }
      // Nose: in front of the head; heels: behind and below the ankles.
      const head = idx('Head');
      const neck = idx('Neck1');
      const fx = pos[head * 3] - pos[neck * 3];
      const fz = pos[head * 3 + 2] - pos[neck * 3 + 2];
      const toeL = [t[LM.leftFootIndex * 3] - t[LM.leftAnkle * 3], t[LM.leftFootIndex * 3 + 2] - t[LM.leftAnkle * 3 + 2]];
      const toeR = [t[LM.rightFootIndex * 3] - t[LM.rightAnkle * 3], t[LM.rightFootIndex * 3 + 2] - t[LM.rightAnkle * 3 + 2]];
      // Facing: from the hips' left→right axis (person faces +90° from it).
      const hx = t[LM.leftHip * 3] - t[LM.rightHip * 3];
      const hz = t[LM.leftHip * 3 + 2] - t[LM.rightHip * 3 + 2];
      const hl = Math.hypot(hx, hz) || 1;
      const fwd = [-hz / hl, hx / hl];
      t[LM.nose * 3] = pos[head * 3] - cx + fx * 0.3 + fwd[0] * 0.09;
      t[LM.nose * 3 + 1] = pos[head * 3 + 1] - cy + 0.03;
      t[LM.nose * 3 + 2] = pos[head * 3 + 2] - cz + fz * 0.3 + fwd[1] * 0.09;
      for (const [heel, ankle, toe] of [
        [LM.leftHeel, LM.leftAnkle, toeL],
        [LM.rightHeel, LM.rightAnkle, toeR],
      ] as const) {
        const l = Math.hypot(toe[0], toe[1]) || 1;
        t[heel * 3] = t[ankle * 3] - (toe[0] / l) * 0.06;
        t[heel * 3 + 1] = t[ankle * 3 + 1] - 0.05;
        t[heel * 3 + 2] = t[ankle * 3 + 2] - (toe[1] / l) * 0.06;
      }
      truth.push(t);
      rootPath.push([cx, cz]);
      // Tracker error.
      const n = new Float64Array(t);
      for (const lm of USED) {
        const extremity = [LM.leftWrist, LM.rightWrist, LM.leftAnkle, LM.rightAnkle, LM.leftFootIndex, LM.rightFootIndex, LM.leftHeel, LM.rightHeel].includes(lm as never) ? 1.5 : 1;
        for (let c = 0; c < 3; c++) {
          drift[lm * 3 + c] = 0.98 * drift[lm * 3 + c] + rng.normal() * 0.002;
          const sigma = noise.jitter * extremity * (c === 2 ? noise.depth : 1);
          n[lm * 3 + c] += rng.normal() * sigma + drift[lm * 3 + c] * extremity;
        }
        if (hold[lm] > 0) {
          hold[lm]--;
          for (let c = 0; c < 3; c++) n[lm * 3 + c] += jump[lm * 3 + c];
        } else if (rng.chance(noise.outlier)) {
          hold[lm] = 1 + rng.int(3);
          for (let c = 0; c < 3; c++) jump[lm * 3 + c] = rng.normal() * noise.outlierSize;
        }
      }
      noisy.push(n);
    }
  }
  return { fps, frames: truth.length, truth, noisy, rootPath };
}
