import * as THREE from 'three';
import { Rng } from '../../src/math/random';
import { fingerJoint, handLinks, JOINTS, LIMITS, openPose, PALM, PALM_POINTS, thumbJoint, type Link } from './hand';
import { closestPoint, sdfNormal, type Shape } from './shapes';

/**
 * Grasp synthesis in the spirit of GraspIt!'s autograsp (Miller & Allen 2004):
 *
 *   1. try many approach directions and palm rolls around the object;
 *   2. slide the open hand in along each until the palm (or a finger) touches;
 *   3. close every digit joint by joint, freezing a joint when its link — or any link beyond it — touches, so
 *      fingers wrap around the shape instead of stopping at the first contact;
 *   4. score the contacts with the Ferrari–Canny ε-metric: the radius of the largest ball around the origin of
 *      wrench space inside the convex hull of the contacts' friction-cone wrenches. ε > 0 means force closure —
 *      the grasp can resist a disturbance in any direction. Approaches that touch the table are rejected.
 *
 * Geometry is in the object's frame: y up, the table at y = 0.
 */

export interface Contact {
  point: THREE.Vector3;
  /** Outward surface normal of the object. */
  normal: THREE.Vector3;
  digit: number; // 0–3 fingers, 4 thumb, 5 palm
}

export interface Grasp {
  kind: 'power' | 'pinch';
  wrist: THREE.Matrix4;
  /** The open hand shape it approached with, and the closed pose. */
  preshape: Float64Array;
  pose: Float64Array;
  /** Joint-space direction the hand closes along (largest component 1): the physics check squeezes along it. */
  closing: Float64Array;
  contacts: Contact[];
  epsilon: number;
  /** Upward force held per unit of total grip force (see liftQuality). */
  lift: number;
  /** How directly the thumb (or the palm) pushes against the fingers: −cos of the angle between their mean normals. */
  opposition: number;
  /** Ranking score: 0 without force closure, else 1 + opposition (see planGrasps). */
  score: number;
  /** Approach direction (from the object toward the hand) and palm roll. */
  approach: THREE.Vector3;
  roll: number;
}

const FRICTION = 0.6;
const CONE_EDGES = 6;
/**
 * Soft-finger contact: a fingertip pad also resists twisting about the contact normal, up to TORSION × the normal
 * force (metres; the same as the MuJoCo contacts in the lift test). Without it a two-fingertip pinch is never force closure —
 * nothing stops the object spinning about the line between the tips.
 */
const TORSION = 0.02;
const CONTACT_TOL = 0.003;

/** 6-D unit directions for the ε-metric's support-function minimum (fixed seed: deterministic scores). */
const DIRECTIONS: Float64Array[] = (() => {
  const rng = new Rng(17);
  return Array.from({ length: 3000 }, () => {
    const d = Float64Array.from({ length: 6 }, () => rng.normal());
    const n = Math.hypot(...d);
    return d.map((x) => x / n);
  });
})();

/** Primitive contact wrenches (friction-cone edges with ± torsion, torque about `centre` scaled by `scale`). */
function contactWrenches(contacts: Contact[], centre: THREE.Vector3, scale: number): number[][] {
  const wrenches: number[][] = [];
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const f = new THREE.Vector3();
  const r = new THREE.Vector3();
  const tq = new THREE.Vector3();
  for (const c of contacts) {
    const n = c.normal.clone().negate(); // force pushes into the object
    t1.set(1, 0, 0);
    if (Math.abs(n.x) > 0.9) t1.set(0, 1, 0);
    t1.addScaledVector(n, -t1.dot(n)).normalize();
    t2.crossVectors(n, t1);
    for (let k = 0; k < CONE_EDGES; k++) {
      const a = (2 * Math.PI * k) / CONE_EDGES;
      f.copy(n).addScaledVector(t1, FRICTION * Math.cos(a)).addScaledVector(t2, FRICTION * Math.sin(a)).normalize();
      r.subVectors(c.point, centre);
      tq.crossVectors(r, f).divideScalar(scale);
      for (const sgn of [-1, 1]) {
        const t = (sgn * TORSION) / scale;
        wrenches.push([f.x, f.y, f.z, tq.x + t * n.x, tq.y + t * n.y, tq.z + t * n.z]);
      }
    }
  }
  return wrenches;
}

/**
 * Lift quality: the largest upward force (with no torque about the centre of mass) inside the hull of the
 * unit-normal-force contact wrenches — how much weight the grasp holds per unit of grip, the ε-metric measured
 * along the one direction lifting needs instead of the worst one. By the support function h(d) = max_w d·w,
 * t·u is in the hull iff d·(t·u) ≤ h(d) for every d, so t = min over d·u > 0 of h(d) / d·u (sampled, like ε).
 */
export function liftQuality(contacts: Contact[], centre: THREE.Vector3, scale: number): number {
  if (contacts.length < 2) return 0;
  const wrenches = contactWrenches(contacts, centre, scale);
  let t = Infinity;
  for (const d of DIRECTIONS) {
    for (const sgn of [1, -1]) {
      const du = sgn * d[1]; // u = (0, 1, 0, 0, 0, 0)
      if (du <= 0.05) continue;
      let h = -Infinity;
      for (const w of wrenches) h = Math.max(h, sgn * (d[0] * w[0] + d[1] * w[1] + d[2] * w[2] + d[3] * w[3] + d[4] * w[4] + d[5] * w[5]));
      t = Math.min(t, h / du);
    }
  }
  return Math.max(0, t);
}

/**
 * Opposition: −cos of the angle between the fingers' mean contact normal and the thumb's (or the palm's, for a
 * wrap). 1 is a pinch straight across; ≤ 0 means everything pushes the same way and only friction — or the
 * table — holds the object. In the physical lift test it predicts success better than ε does: a hand draped
 * over one side of a can, palm on the lid, is in force closure on paper and holds only while the table pushes back.
 */
export function oppositionOf(contacts: Contact[]): number {
  const mean = (digits: number[]) => {
    const v = new THREE.Vector3();
    for (const c of contacts) if (digits.includes(c.digit)) v.add(c.normal);
    return v.lengthSq() > 1e-9 ? v.normalize() : null;
  };
  const fingers = mean([0, 1, 2, 3]);
  if (!fingers) return -1;
  let best = -1;
  for (const other of [mean([4]), mean([5])]) if (other) best = Math.max(best, -fingers.dot(other));
  return best;
}

/** Support function h(u) = max over primitive wrenches of u·w, and the wrench that attains it. */
function support(u: ArrayLike<number>, wrenches: number[][]): { h: number; w: number[] } {
  let h = -Infinity;
  let best = wrenches[0];
  for (const w of wrenches) {
    const d = u[0] * w[0] + u[1] * w[1] + u[2] * w[2] + u[3] * w[3] + u[4] * w[4] + u[5] * w[5];
    if (d > h) (h = d), (best = w);
  }
  return { h, w: best };
}

/**
 * Ferrari–Canny ε: min over unit directions u of h(u) — the distance from the origin to the boundary of the
 * wrench hull when the origin is inside; ≤ 0 means no force closure. Random directions alone are sparse in 6-D
 * (they put a two-finger pinch at 0.10 when its true ε is 0.01, the soft-finger torsion), so the best few are
 * then refined by projected subgradient descent: step against the maximising wrench and renormalise.
 */
export function epsilonQuality(contacts: Contact[], centre: THREE.Vector3, scale: number): number {
  if (contacts.length < 2) return -1;
  const wrenches = contactWrenches(contacts, centre, scale);
  const scored: { h: number; u: Float64Array }[] = [];
  for (const u of DIRECTIONS) {
    const { h } = support(u, wrenches);
    if (h <= 0) return h;
    scored.push({ h, u });
  }
  scored.sort((a, b) => a.h - b.h);
  let eps = scored[0].h;
  const u = new Float64Array(6);
  for (const start of scored.slice(0, 4)) {
    u.set(start.u);
    for (let it = 0; it < 120; it++) {
      const { h, w } = support(u, wrenches);
      if (h < eps) eps = h;
      if (eps <= 0) return eps;
      const step = 0.3 / (1 + it * 0.1);
      let n = 0;
      for (let k = 0; k < 6; k++) n += (u[k] -= step * w[k]) ** 2;
      n = Math.sqrt(n);
      for (let k = 0; k < 6; k++) u[k] /= n;
    }
  }
  return eps;
}

const _p = new THREE.Vector3();
const _seg = new THREE.Vector3();

/** Penetration of a capsule link into the object (positive = inside), sampled along its axis. */
function linkDepth(shape: Shape, l: Link): number {
  let worst = -Infinity;
  for (let i = 0; i <= 6; i++) {
    _p.lerpVectors(l.a, l.b, i / 6);
    worst = Math.max(worst, l.radius - shape.sdf(_p));
  }
  return worst;
}

/** Table penetration of a link (the table is y = 0). */
function linkBelowTable(l: Link): boolean {
  return Math.min(l.a.y, l.b.y) - l.radius < 0.001;
}

/** Palm depth into the object, over the palm's front-face sample points. */
function palmDepth(shape: Shape, wrist: THREE.Matrix4): number {
  let worst = -Infinity;
  for (const p of PALM_POINTS) worst = Math.max(worst, -shape.sdf(_p.copy(p).applyMatrix4(wrist)));
  return worst;
}

/** Closing order: per digit, the joints that curl it, proximal first, with relative speeds. */
const CHAINS: { digit: number; joints: number[]; rate: number[] }[] = [
  ...[0, 1, 2, 3].map((i) => ({ digit: i, joints: [fingerJoint(i, 1), fingerJoint(i, 2), fingerJoint(i, 3)], rate: [1, 1.15, 0.8] })),
  { digit: 4, joints: [thumbJoint(2), thumbJoint(3), thumbJoint(4)], rate: [0.8, 1, 1] },
];

/** The point in the hand frame placed `standoff` from the object's centre: by default the palm's centre. */
const PALM_ANCHOR = new THREE.Vector3(0, 0.045, PALM.halfThickness);

/**
 * Pinch: ring and little tucked away, and the thumb, index and middle moved together along a straight line in
 * joint space from an open pinch to one where the thumb and index tips meet — a hand synergy (Santello et al.
 * 1998; Ciocarlie & Allen's eigengrasps), not per-joint curling. Curling the thumb's flexion joints alone never
 * brings its tip to the index: the tips meet mostly through opposition.
 */
function pinchShape(open: boolean): Float64Array {
  const p = openPose();
  for (const i of [2, 3]) [p[fingerJoint(i, 1)], p[fingerJoint(i, 2)], p[fingerJoint(i, 3)]] = [1.5, 1.8, 1.2];
  const f = open ? 0.25 : 0.9;
  for (const i of [0, 1]) [p[fingerJoint(i, 1)], p[fingerJoint(i, 2)], p[fingerJoint(i, 3)]] = [f, 0.8 * f, 0.4 * f];
  p[thumbJoint(0)] = open ? 0.8 : 1.4;
  p[thumbJoint(1)] = open ? 0.5 : 0;
  p[thumbJoint(2)] = open ? -0.3 : 0.06;
  p[thumbJoint(3)] = open ? -0.2 : 0.06;
  p[thumbJoint(4)] = open ? -0.2 : 0.06;
  return p;
}
export const pinchPose = () => pinchShape(true);
const PINCH_CLOSED = pinchShape(false);

/** Closing directions: power grasps curl every flexion joint; pinches move the thumb, index and middle along the synergy. */
const POWER_CLOSING = (() => {
  const d = new Float64Array(JOINTS);
  for (let i = 0; i < 4; i++) for (const k of [1, 2, 3]) d[fingerJoint(i, k)] = 1;
  for (const k of [2, 3, 4]) d[thumbJoint(k)] = 1;
  return d;
})();
const PINCH_CLOSING = (() => {
  const open = pinchShape(true);
  const d = new Float64Array(JOINTS);
  const joints = [...[0, 1].flatMap((i) => [0, 1, 2, 3].map((k) => fingerJoint(i, k))), ...[0, 1, 2, 3, 4].map(thumbJoint)];
  for (const j of joints) d[j] = PINCH_CLOSED[j] - open[j];
  const m = Math.max(...d.map(Math.abs));
  return d.map((x) => x / m);
})();
/** Where the tips meet when the pinch is fully closed: the object's centre is aimed here. */
const PINCH_ANCHOR = (() => {
  const l = handLinks(PINCH_CLOSED, new THREE.Matrix4());
  return new THREE.Vector3().addVectors(l[2].b, l[14].b).multiplyScalar(0.5);
})();

/** Hand frame for an approach: palm (+z) facing the object along −approach, fingers rolled about it. */
export function approachFrame(shape: Shape, approach: THREE.Vector3, roll: number, standoff: number, anchor = PALM_ANCHOR): THREE.Matrix4 {
  const z = approach.clone().negate();
  const ref = Math.abs(z.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const y0 = ref.addScaledVector(z, -ref.dot(z)).normalize();
  const y = y0.applyAxisAngle(z, roll);
  const x = new THREE.Vector3().crossVectors(y, z);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  // The anchor (the palm's centre unless pinching) placed `standoff` from the object's centre along the approach.
  const centre = new THREE.Vector3(0, shape.height / 2, 0);
  const palmCentre = anchor.clone().applyMatrix4(m);
  const target = centre.clone().addScaledVector(approach, standoff);
  m.setPosition(target.sub(palmCentre));
  return m;
}

/**
 * Close the hand around the object from a wrist pose and pre-shape, curling the given digits: returns the pose
 * and contacts, or null if the hand starts inside the object or ends on the table.
 */
export function closeHand(
  shape: Shape,
  wrist: THREE.Matrix4,
  start: Float64Array,
  digits = [0, 1, 2, 3, 4],
  synergyTarget?: Float64Array,
): { pose: Float64Array; contacts: Contact[] } | null {
  const pose = new Float64Array(start);
  const links: Link[] = [];
  handLinks(pose, wrist, links);
  if (links.some(linkBelowTable)) return null;
  if (links.some((l) => linkDepth(shape, l) > 0)) return null;
  // Close: each digit's joints advance together; a joint stops when its own link or a more distal one touches.
  // Only digits that stopped on the object make contacts: one that curled to its joint limits and happens to end
  // within the tolerance of the surface is not pressing on it, and in the physics check it never touched.
  const step = 0.02;
  const pressing = new Set<number>();
  if (synergyTarget) {
    // Each digit moves all its joints along the line toward the target pose until any of its links touches.
    for (const d of digits) {
      const joints = d === 4 ? [0, 1, 2, 3, 4].map(thumbJoint) : [0, 1, 2, 3].map((k) => fingerJoint(d, k));
      const from = joints.map((j) => pose[j]);
      for (let t = 0.02; t <= 1 + 1e-9; t += 0.02) {
        joints.forEach((j, k) => (pose[j] = from[k] + (synergyTarget[j] - from[k]) * t));
        handLinks(pose, wrist, links);
        const mine = links.filter((l) => l.digit === d);
        const hit = mine.some((l) => linkDepth(shape, l) > 0);
        if (hit || mine.some(linkBelowTable)) {
          if (hit) pressing.add(d);
          joints.forEach((j, k) => (pose[j] = from[k] + (synergyTarget[j] - from[k]) * (t - 0.02)));
          break;
        }
      }
    }
  }
  for (const chain of CHAINS) {
    if (synergyTarget || !digits.includes(chain.digit)) continue;
    const frozen = chain.joints.map(() => false);
    for (let it = 0; it < 200 && frozen.some((f) => !f); it++) {
      const prev = chain.joints.map((j) => pose[j]);
      chain.joints.forEach((j, k) => {
        if (!frozen[k]) pose[j] = Math.min(LIMITS[j][1], pose[j] + step * chain.rate[k]);
      });
      handLinks(pose, wrist, links);
      const mine = links.filter((l) => l.digit === chain.digit);
      let touched = -1;
      for (let s = 2; s >= 0; s--) {
        if (linkDepth(shape, mine[s]) > 0 || linkBelowTable(mine[s])) {
          touched = s;
          break;
        }
      }
      if (touched >= 0) {
        if (linkDepth(shape, mine[touched]) > 0) pressing.add(chain.digit);
        // Back off this step for the joints that caused it, and freeze everything up to the touching link.
        chain.joints.forEach((j, k) => {
          if (k <= touched && !frozen[k]) {
            pose[j] = prev[k];
            frozen[k] = true;
          }
        });
      }
      chain.joints.forEach((j, k) => {
        if (pose[j] >= LIMITS[j][1]) frozen[k] = true;
      });
    }
  }
  handLinks(pose, wrist, links);
  if (links.some(linkBelowTable)) return null;
  // Contacts: links within tolerance of the surface, at the closest point along each link.
  const contacts: Contact[] = [];
  for (const l of links) {
    if (!pressing.has(l.digit)) continue;
    let best = Infinity;
    const at = new THREE.Vector3();
    for (let i = 0; i <= 8; i++) {
      _seg.lerpVectors(l.a, l.b, i / 8);
      const d = shape.sdf(_seg) - l.radius;
      if (d < best) {
        best = d;
        at.copy(_seg);
      }
    }
    if (best < CONTACT_TOL) {
      const point = closestPoint(shape, at);
      contacts.push({ point, normal: sdfNormal(shape, point), digit: l.digit });
    }
  }
  for (const p of PALM_POINTS) {
    const w = p.clone().applyMatrix4(wrist);
    if (shape.sdf(w) < CONTACT_TOL) {
      const point = closestPoint(shape, w);
      contacts.push({ point, normal: sdfNormal(shape, point), digit: 5 });
    }
  }
  return { pose, contacts };
}

export interface PlanOptions {
  directions?: number;
  rolls?: number;
  /** Opposition angles to try (thumb across the palm vs beside it). */
  oppositions?: number[];
  /** Also try fingertip pinches (thumb against index and middle) besides power grasps. */
  pinches?: boolean;
}

/**
 * Slide a pre-shaped hand in along the approach from far away until the palm or a digit is about to touch, or
 * the anchor reaches the object's centre. Null if the hand would hit the table first, far from the object.
 */
function slideIn(shape: Shape, approach: THREE.Vector3, roll: number, preshape: Float64Array, anchor: THREE.Vector3): THREE.Matrix4 | null {
  let standoff = shape.scale * 3 + 0.08;
  let wrist = approachFrame(shape, approach, roll, standoff, anchor);
  let blocked = false;
  while (standoff > 0 && palmDepth(shape, wrist) < -0.002) {
    const next = approachFrame(shape, approach, roll, standoff - 0.002, anchor);
    const links = handLinks(preshape, next);
    if (links.some(linkBelowTable)) {
      blocked = true;
      break;
    }
    if (links.some((l) => linkDepth(shape, l) > 0)) break; // a digit got there first
    standoff -= 0.002;
    wrist = next;
  }
  if (blocked && palmDepth(shape, wrist) < -0.03 && anchor === PALM_ANCHOR) return null;
  return wrist;
}

/** Search approaches and return grasps sorted best-first. */
export function planGrasps(shape: Shape, options: PlanOptions = {}): Grasp[] {
  const nDir = options.directions ?? 40;
  const nRoll = options.rolls ?? 4;
  const oppositions = options.oppositions ?? [0.4, 0.8, 1.3];
  const pinches = options.pinches ?? true;
  const centre = new THREE.Vector3(0, shape.height / 2, 0);
  const grasps: Grasp[] = [];
  // Fibonacci directions over the upper hemisphere plus the sides (the table blocks the rest).
  for (let i = 0; i < nDir; i++) {
    const yv = 1 - (i + 0.5) / nDir; // 1 … 0: top down to horizontal
    const r = Math.sqrt(1 - yv * yv);
    const th = i * Math.PI * (3 - Math.sqrt(5));
    const approach = new THREE.Vector3(r * Math.cos(th), yv, r * Math.sin(th));
    for (let k = 0; k < nRoll; k++) {
      const roll = (2 * Math.PI * k) / nRoll;
      // Power grasps at each thumb opposition, then a pinch.
      const tries: { kind: Grasp['kind']; preshape: Float64Array; anchor: THREE.Vector3; digits?: number[]; synergy?: Float64Array }[] = oppositions.map((opp) => {
        const preshape = openPose();
        preshape[thumbJoint(0)] = opp;
        return { kind: 'power', preshape, anchor: PALM_ANCHOR };
      });
      if (pinches) tries.push({ kind: 'pinch', preshape: pinchPose(), anchor: PINCH_ANCHOR, digits: [0, 1, 4], synergy: PINCH_CLOSED });
      for (const t of tries) {
        const wrist = slideIn(shape, approach, roll, t.preshape, t.anchor);
        if (!wrist) continue;
        const closed = closeHand(shape, wrist, t.preshape, t.digits, t.synergy);
        if (!closed) continue;
        const eps = epsilonQuality(closed.contacts, centre, shape.scale);
        const lift = eps > 0 ? liftQuality(closed.contacts, centre, shape.scale) : 0;
        const opposition = oppositionOf(closed.contacts);
        const score = eps > 0 ? 1 + opposition : 0;
        const closing = t.kind === 'pinch' ? PINCH_CLOSING : POWER_CLOSING;
        grasps.push({ kind: t.kind, wrist, preshape: t.preshape, pose: closed.pose, closing, contacts: closed.contacts, epsilon: eps, lift, opposition, score, approach, roll });
      }
    }
  }
  // Force closure first; among those, opposition, then ε. Across 190 force-closure grasps lifted in MuJoCo,
  // opposition separated the ones that held (AUC 0.73) where ε (0.49) and lift quality (0.52) did not.
  return grasps.sort((a, b) => b.score - a.score || b.epsilon - a.epsilon);
}

export { JOINTS };
