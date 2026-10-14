import * as THREE from 'three';
import type { SegmentBatch } from './segments';

/** Capsule radius (m) for the segment ending at a CMU-named joint. */
export function cmuRadius(name: string): number {
  if (/UpLeg/.test(name)) return 0.07;
  if (/Leg$/.test(name)) return 0.055;
  if (/Foot$/.test(name)) return 0.045;
  if (/Toe/.test(name)) return 0.035;
  if (/Spine|LowerBack/.test(name)) return 0.1;
  if (/Neck/.test(name)) return 0.045;
  if (/ForeArm|Hand/.test(name)) return 0.035;
  if (/Arm|Shoulder/.test(name)) return 0.045;
  return 0.06;
}

export interface SkeletonStyle {
  radius?: (name: string) => number;
  color: (name: string) => number;
  jointColor?: (name: string) => number;
}

const a = new THREE.Vector3();
const b = new THREE.Vector3();

/** Draw a skeleton given world joint positions [joints·3] as capsules into `batch` (between begin/commit). */
export function drawSkeleton(
  batch: SegmentBatch,
  joints: readonly { name: string; parent: number }[],
  world: ArrayLike<number>,
  style: SkeletonStyle,
): void {
  const radius = style.radius ?? cmuRadius;
  joints.forEach((j, i) => {
    if (j.parent < 0) return;
    a.set(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
    b.set(world[j.parent * 3], world[j.parent * 3 + 1], world[j.parent * 3 + 2]);
    if (a.distanceTo(b) < 1e-3) return;
    const r = radius(j.name);
    batch.segment(b, a, r, style.color(j.name));
    batch.joint(a, r * 1.05, (style.jointColor ?? style.color)(j.name));
  });
}
