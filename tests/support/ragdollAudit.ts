import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import type { ClipData } from '../../src/anim/clip';
import { Ragdoll } from '../../demos/10-active-ragdoll/ragdoll';

export const walkClip = JSON.parse(readFileSync('public/assets/mocap/cmu-02_01-walk.json', 'utf8')) as ClipData;

export interface Track {
  /** Mean / max joint orientation error vs the target (rad), body position error (m), over the window. */
  meanAngle: number;
  maxAngle: number;
  meanPos: number;
  maxPos: number;
  pelvisPos: number;
  maxSpeed: number;
  maxDrift: number;
  /** Deepest any capsule went below the floor (m). */
  maxPenetration: number;
  nan: boolean;
}

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _r = new THREE.Quaternion();

/** Step `seconds` and measure tracking from `from` seconds into the window. */
export function measure(r: Ragdoll, seconds: number, from = 0): Track {
  const out: Track = { meanAngle: 0, maxAngle: 0, meanPos: 0, maxPos: 0, pelvisPos: 0, maxSpeed: 0, maxDrift: 0, maxPenetration: 0, nan: false };
  let n = 0;
  let pelvisSum = 0;
  const steps = Math.round(seconds / r.dt);
  for (let s = 0; s < steps; s++) {
    r.step();
    if (s * r.dt < from) continue;
    let angle = 0;
    let pos = 0;
    for (const b of r.bodies) {
      const t = b.rb.translation();
      const q = b.rb.rotation();
      if (![t.x, t.y, t.z, q.w].every(Number.isFinite)) out.nan = true;
      r.targetPosition(b.index, _t);
      const d = _p.set(t.x, t.y, t.z).distanceTo(_t);
      pos += d;
      out.maxPos = Math.max(out.maxPos, d);
      if (b.index === 0) pelvisSum += d;
      r.targetRotation(b.index, _q);
      const a = _r.set(q.x, q.y, q.z, q.w).angleTo(_q);
      angle += a;
      out.maxAngle = Math.max(out.maxAngle, a);
      const v = b.rb.linvel();
      out.maxSpeed = Math.max(out.maxSpeed, Math.hypot(v.x, v.y, v.z));
      // Lowest point of the capsule: end points minus radius.
      for (const e of [b.a, b.b]) {
        _p.copy(e).applyQuaternion(_r.set(q.x, q.y, q.z, q.w)).add(t as THREE.Vector3Like);
        out.maxPenetration = Math.max(out.maxPenetration, b.def.radius - _p.y);
      }
    }
    out.meanAngle += angle / r.bodies.length;
    out.meanPos += pos / r.bodies.length;
    out.maxDrift = Math.max(out.maxDrift, r.jointDrift());
    n++;
  }
  out.meanAngle /= Math.max(1, n);
  out.meanPos /= Math.max(1, n);
  out.pelvisPos = pelvisSum / Math.max(1, n);
  return out;
}
