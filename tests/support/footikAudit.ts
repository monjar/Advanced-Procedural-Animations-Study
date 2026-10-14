import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { ClipPlayer, type ClipData } from '../../src/anim/clip';
import { FootIK, FOOT_RENDER, type FootIKSettings } from '../../demos/08-foot-ik/footik';
import { courseHeight, courseNormal, courseProfile, COURSE_LENGTH } from '../../demos/08-foot-ik/course';

export const clip = JSON.parse(readFileSync('public/assets/mocap/cmu-02_01-walk.json', 'utf8')) as ClipData;

const PROFILE = courseProfile();
/** The profile padded with flat ground far beyond both ends. */
const PADDED: [number, number][] = [[-1e3, 0], ...PROFILE, [1e3, 0]];

/** Height of the rendered profile at z (risers resolved to the lower side). */
function profileHeight(z: number): number {
  if (z <= PROFILE[0][0] || z >= PROFILE[PROFILE.length - 1][0]) return 0;
  let lo = 0;
  let hi = PROFILE.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (PROFILE[mid][0] <= z) lo = mid;
    else hi = mid;
  }
  const [z0, y0] = PROFILE[lo];
  const [z1, y1] = PROFILE[hi];
  return z1 - z0 < 1e-9 ? Math.min(y0, y1) : y0 + ((y1 - y0) * (z - z0)) / (z1 - z0);
}

/**
 * Exact penetration depth (m) of a sphere into the rendered course: the course is the profile polyline
 * extruded along x, so this is the circle-vs-polyline overlap in the sphere's y–z section — how far the
 * sphere would have to move to be clear. 0 when outside.
 */
export function sphereDepth(c: THREE.Vector3, r: number): number {
  let dist = Infinity;
  let lo = 0;
  let hi = PADDED.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (PADDED[mid][0] < c.z - r - 0.05) lo = mid;
    else hi = mid;
  }
  for (let i = lo; i + 1 < PADDED.length; i++) {
    const [z0, y0] = PADDED[i];
    const [z1, y1] = PADDED[i + 1];
    if (z1 < c.z - r - 0.05) continue;
    if (z0 > c.z + r + 0.05) break;
    const dz = z1 - z0;
    const dy = y1 - y0;
    const len2 = dz * dz + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((c.z - z0) * dz + (c.y - y0) * dy) / len2)) : 0;
    dist = Math.min(dist, Math.hypot(c.z - (z0 + t * dz), c.y - (y0 + t * dy)));
  }
  const signed = c.y < profileHeight(c.z) ? -dist : dist;
  return Math.max(0, r - signed);
}

/** Signed version: < 0 is the gap between the sphere and the ground below it. */
function sphereSigned(c: THREE.Vector3, r: number, ground: (z: number) => number = courseHeight): number {
  let d = -Infinity;
  for (let k = -16; k <= 16; k++) {
    const dz = (k / 16) * r;
    d = Math.max(d, ground(c.z + dz) - (c.y - Math.sqrt(Math.max(0, r * r - dz * dz))));
  }
  return d;
}

/** Gap between the rendered foot and the ground right under it (m; default the course); 0 when touching. */
export function footGap(ankle: THREE.Vector3, toe: THREE.Vector3, ground: (z: number) => number = courseHeight): number {
  let d = Math.max(sphereSigned(ankle, FOOT_RENDER.ankle, ground), sphereSigned(toe, FOOT_RENDER.toe, ground));
  for (let s = 1; s < 16; s++) d = Math.max(d, sphereSigned(_p.lerpVectors(ankle, toe, s / 16), FOOT_RENDER.foot, ground));
  return Math.max(0, -d);
}

const _p = new THREE.Vector3();

/** Depth of the rendered foot (ankle sphere, foot cylinder, toe sphere) and of the lower shin. */
export function footDepth(ankle: THREE.Vector3, toe: THREE.Vector3, knee: THREE.Vector3): { foot: number; shin: number } {
  let foot = Math.max(sphereDepth(ankle, FOOT_RENDER.ankle), sphereDepth(toe, FOOT_RENDER.toe));
  for (let s = 1; s < 16; s++) foot = Math.max(foot, sphereDepth(_p.lerpVectors(ankle, toe, s / 16), FOOT_RENDER.foot));
  let shin = 0;
  for (let s = 8; s < 16; s++) shin = Math.max(shin, sphereDepth(_p.lerpVectors(knee, ankle, s / 16), FOOT_RENDER.shin));
  return { foot, shin };
}

export interface CourseAudit {
  frames: number;
  /** Deepest rendered foot / shin point inside the course, by phase (m). */
  stance: number;
  swing: number;
  shin: number;
  /** Frames with any foot more than 1 cm inside. */
  deepFrames: number;
  /**
   * Floating in the foot-flat phase (m): the gap under the foot beyond the gap the clip itself has at that
   * moment on flat ground (its "flat" foot is still settling for a few frames). Largest, and the number of
   * foot-flat frames where it exceeds 2 cm, out of all foot-flat frames.
   */
  flatGap: number;
  floatFrames: number;
  flatFrames: number;
  /** Largest foot slip during a foot-flat phase (m). */
  slip: number;
  /** Largest final-pose guard correction (m) — how far the plan fell short. */
  guard: number;
  /** Peak vertical ankle acceleration (m/s²), final pose vs the raw clip. */
  accel: number;
  rawAccel: number;
  where: string;
}

/** Walk the course once at `fps` and measure the rendered feet against the course. */
export function auditCourse(settings: Partial<FootIKSettings> = {}, fps = 60): CourseAudit {
  const player = new ClipPlayer(clip);
  const ik = new FootIK(player, courseHeight, courseNormal, { enabled: true, pelvis: true, lock: true, align: true, swing: true, ...settings });
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const k = new THREE.Vector3();
  const out: CourseAudit = { frames: 0, stance: 0, swing: 0, shin: 0, deepFrames: 0, flatGap: 0, floatFrames: 0, flatFrames: 0, slip: 0, guard: 0, accel: 0, rawAccel: 0, where: '' };
  const hist = new Map<string, number[]>();
  const accel = (key: string, y: number) => {
    const h = hist.get(key) ?? [];
    h.push(y);
    if (h.length > 3) h.shift();
    hist.set(key, h);
    return h.length === 3 ? Math.abs(h[2] - 2 * h[1] + h[0]) * fps * fps : 0;
  };
  for (let i = 0; i < fps * 40; i++) {
    player.time += 1 / fps;
    ik.update(1 / fps);
    if (player.bones[0].position.z > COURSE_LENGTH - 0.5) break;
    out.frames++;
    let frameWorst = 0;
    for (const f of ik.feet) {
      const d = footDepth(f.foot.getWorldPosition(a), f.toeBone.getWorldPosition(b), f.lower.getWorldPosition(k));
      const swinging = f.contact < 0.5;
      if (d.foot > Math.max(out.stance, out.swing)) out.where = `${f.side} ${swinging ? 'swing' : 'stance'} z=${a.z.toFixed(2)}`;
      if (swinging) out.swing = Math.max(out.swing, d.foot);
      else out.stance = Math.max(out.stance, d.foot);
      out.shin = Math.max(out.shin, d.shin);
      out.guard = Math.max(out.guard, f.guard);
      if (f.flat) {
        const gap = footGap(a, b) - footGap(f.rawAnkle, f.rawToe, () => 0);
        out.flatGap = Math.max(out.flatGap, gap);
        out.flatFrames++;
        if (gap > 0.02) out.floatFrames++;
      }
      out.slip = Math.max(out.slip, f.lastSlip.ik);
      out.accel = Math.max(out.accel, accel(f.side, a.y));
      out.rawAccel = Math.max(out.rawAccel, accel(`raw-${f.side}`, f.rawAnkle.y));
      frameWorst = Math.max(frameWorst, d.foot);
    }
    if (frameWorst > 0.01) out.deepFrames++;
  }
  return out;
}
