/**
 * Key poses in the spirit of Overgrowth (D. Rosen, GDC 2014): each gait is a handful of poses for
 * half a stride, mirrored for the other half and interpolated by stride phase. Legs are not part of the
 * poses — feet are planted and solved by IK — so a pose only describes the upper body and pelvis.
 *
 * Phase 0 = right foot contact. Positive sway/roll/yaw lean toward / rotate toward the character's left.
 */
export interface Pose {
  /** Pelvis drop below standing height (m). */
  drop: number;
  /** Lateral pelvis shift (m, + left). */
  sway: number;
  /** Pelvis roll (rad, + left hip up). */
  roll: number;
  /** Pelvis yaw (rad, + right hip forward). */
  yaw: number;
  /** Chest twist relative to pelvis (rad, counter-rotation). */
  twist: number;
  /** Forward lean of the spine (rad). */
  lean: number;
  /** Shoulder pitch (rad, + arm forward). */
  armL: number;
  armR: number;
  /** Elbow bend (rad). */
  elbowL: number;
  elbowR: number;
}

export type PoseKey = [phase: number, pose: Pose];

const KEYS = Object.keys({ drop: 0, sway: 0, roll: 0, yaw: 0, twist: 0, lean: 0, armL: 0, armR: 0, elbowL: 0, elbowR: 0 }) as (keyof Pose)[];

export function mirror(p: Pose): Pose {
  return {
    drop: p.drop,
    sway: -p.sway,
    roll: -p.roll,
    yaw: -p.yaw,
    twist: -p.twist,
    lean: p.lean,
    armL: p.armR,
    armR: p.armL,
    elbowL: p.elbowR,
    elbowR: p.elbowL,
  };
}

export function lerpPose(a: Pose, b: Pose, t: number, out: Pose = { ...a }): Pose {
  for (const k of KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

export const NEUTRAL: Pose = { drop: 0.01, sway: 0, roll: 0, yaw: 0, twist: 0, lean: 0.02, armL: 0, armR: 0, elbowL: 0.12, elbowR: 0.12 };

/** Walk: contact (double support, pelvis low) and passing (single support on the right, pelvis high). */
export const WALK: PoseKey[] = [
  [0.0, { drop: 0.035, sway: 0.0, roll: 0.0, yaw: 0.12, twist: -0.14, lean: 0.05, armL: 0.38, armR: -0.34, elbowL: 0.35, elbowR: 0.2 }],
  [0.25, { drop: 0.0, sway: -0.035, roll: -0.05, yaw: 0.0, twist: 0.0, lean: 0.04, armL: 0.0, armR: 0.0, elbowL: 0.25, elbowR: 0.25 }],
];

/** Run: contact, mid-stance (compressed, lowest) and flight (highest), right leg. */
export const RUN: PoseKey[] = [
  [0.0, { drop: 0.05, sway: -0.01, roll: 0.0, yaw: 0.16, twist: -0.24, lean: 0.16, armL: 0.75, armR: -0.6, elbowL: 1.7, elbowR: 1.3 }],
  [0.14, { drop: 0.1, sway: -0.025, roll: -0.06, yaw: 0.04, twist: -0.06, lean: 0.18, armL: 0.25, armR: -0.15, elbowL: 1.5, elbowR: 1.45 }],
  [0.36, { drop: 0.0, sway: 0.0, roll: 0.02, yaw: -0.1, twist: 0.16, lean: 0.15, armL: -0.45, armR: 0.5, elbowL: 1.35, elbowR: 1.65 }],
];

/** Sample a half-cycle key list, mirrored for the second half, with smoothstep between keys. */
export function samplePose(keys: PoseKey[], phase: number, out: Pose = { ...NEUTRAL }): Pose {
  const full: PoseKey[] = [...keys, ...keys.map(([p, pose]): PoseKey => [p + 0.5, mirror(pose)])];
  const x = phase - Math.floor(phase);
  let i = full.length - 1;
  for (let k = 0; k < full.length; k++) if (full[k][0] <= x) i = k;
  const [p0, a] = full[i];
  const [p1raw, b] = full[(i + 1) % full.length];
  const p1 = p1raw <= p0 ? p1raw + 1 : p1raw;
  const xx = x < p0 ? x + 1 : x;
  let t = (xx - p0) / (p1 - p0);
  t = t * t * (3 - 2 * t);
  return lerpPose(a, b, t, out);
}
