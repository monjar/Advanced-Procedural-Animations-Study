import * as THREE from 'three';
import { solveTwoBone, createTwoBoneResult } from '../../src/ik/twoBone';
import { SpringChain } from '../../src/rig/springChain';
import type { HeightFn } from '../../src/world/terrain';

/**
 * A user-built creature that animates itself (after Hecker et al., "Real-time Motion Retargeting to Highly
 * Varied User-Created Morphologies", SIGGRAPH 2008 — Spore). Nothing here is authored for a particular body:
 *
 *   gait pattern   from the number of leg pairs (biped alternation, Hildebrand's walk → trot for four legs,
 *                  the insect tripod for six, a metachronal wave for more)
 *   stride, timing from leg length by dynamic similarity: at Froude number v̂ = v / √(g·h) every animal takes
 *                  relative strides λ/h ≈ 2.3·v̂^0.6 (Alexander 1976) and its duty factor falls as it speeds up
 *   footholds      predicted so each foot lands half a stance ahead of where its hip will be, on the terrain
 *   legs           two-bone IK (study 02), knees by leg position; three-segment legs keep a digitigrade foot
 *   body           each vertebra follows the head's path (so long bodies bend through turns), height and tilt
 *                  from where the feet actually are
 *   head, tail     second-order springs (study 01)
 */

export interface LegPairSpec {
  /** Position along the spine: 0 = tail end, 1 = head end. */
  at: number;
  length: number;
  segments: 2 | 3;
  /** Sideways reach of the hips beyond the body (fraction of leg length). */
  spread: number;
}

export interface CreatureSpec {
  name: string;
  spineLength: number;
  spineSegments: number;
  /** Body radius at the tail end, middle and head end. */
  radius: [number, number, number];
  legs: LegPairSpec[];
  headSize: number;
  neck: number;
  tailLength: number;
  color: number;
  /** Body held upright (bipeds) instead of along the ground. */
  upright?: boolean;
}

export interface Leg {
  pair: number;
  side: -1 | 1;
  spec: LegPairSpec;
  /** Gait phase offset in [0, 1). */
  offset: number;
  hip: THREE.Vector3;
  knee: THREE.Vector3;
  ankle: THREE.Vector3;
  foot: THREE.Vector3;
  /** Planted position, or the swing's start and target. */
  planted: THREE.Vector3;
  swingFrom: THREE.Vector3;
  swingTo: THREE.Vector3;
  stance: boolean;
  /** Fraction of the stance this foot could not reach (overextended). */
  reachMiss: number;
}

const G = 9.81;

/** Gait phase offsets per leg (pairs listed tail → head; left = −1). Blends a walk into a trot for four legs. */
export function gaitOffsets(pairs: number, froude: number): { pair: number; side: -1 | 1; offset: number }[] {
  const out: { pair: number; side: -1 | 1; offset: number }[] = [];
  if (pairs === 1) {
    out.push({ pair: 0, side: -1, offset: 0 }, { pair: 0, side: 1, offset: 0.5 });
  } else if (pairs === 2) {
    // Hildebrand's lateral-sequence walk (LH 0, LF 0.25, RH 0.5, RF 0.75) → trot (diagonals together) with speed.
    const k = THREE.MathUtils.smoothstep(froude, 0.35, 0.7);
    const walk = { LH: 0, LF: 0.25, RH: 0.5, RF: 0.75 };
    const trot = { LH: 0.5, LF: 0, RH: 0, RF: 0.5 };
    const mix = (a: number, b: number) => (a + k * (((((b - a) % 1) + 1.5) % 1) - 0.5) + 1) % 1;
    out.push({ pair: 0, side: -1, offset: mix(walk.LH, trot.LH) }, { pair: 0, side: 1, offset: mix(walk.RH, trot.RH) });
    out.push({ pair: 1, side: -1, offset: mix(walk.LF, trot.LF) }, { pair: 1, side: 1, offset: mix(walk.RF, trot.RF) });
  } else if (pairs === 3) {
    // Tripod: front and back of one side with the middle of the other.
    for (let i = 0; i < 3; i++) {
      out.push({ pair: i, side: -1, offset: i % 2 === 0 ? 0 : 0.5 }, { pair: i, side: 1, offset: i % 2 === 0 ? 0.5 : 0 });
    }
  } else {
    // Metachronal wave from the back forward; the two sides half a cycle apart.
    for (let i = 0; i < pairs; i++) {
      const o = ((pairs - 1 - i) / pairs) * 0.85;
      out.push({ pair: i, side: -1, offset: o % 1 }, { pair: i, side: 1, offset: (o + 0.5) % 1 });
    }
  }
  return out;
}

export class Creature {
  readonly legs: Leg[] = [];
  /** Vertebra positions, tail (0) → head (n). */
  readonly spine: THREE.Vector3[] = [];
  readonly headPos = new THREE.Vector3();
  readonly headDir = new THREE.Vector3(1, 0, 0);
  tail: SpringChain | null = null;
  /** Where the creature is heading, and how fast (m/s). */
  heading = 0;
  speed = 0;
  /** Dimensionless speed (Froude number) the user sets; speed follows from leg length. */
  froude = 0.25;
  phase = 0;
  stride = 0;
  duty = 0.65;
  frequency = 0;
  readonly standHeight: number;
  readonly legLength: number;
  private readonly path: THREE.Vector3[] = [];
  private headLook = new THREE.Vector3();
  private bodyY: number[] = [];
  /** Measurements over the run: planted-foot slip and reach misses. */
  stats = { stanceTime: 0, reachMissTime: 0, stableTime: 0, sampledTime: 0 };

  constructor(
    readonly spec: CreatureSpec,
    readonly terrain: HeightFn,
    start = new THREE.Vector3(0, 0, 0),
  ) {
    const lens = spec.legs.map((l) => l.length);
    this.legLength = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0.5;
    this.standHeight = this.legLength * 0.78;
    const n = spec.spineSegments;
    const seg = spec.spineLength / n;
    for (let i = 0; i <= n; i++) {
      const p = start.clone().add(new THREE.Vector3((i - n) * seg, 0, 0));
      p.y = terrain(p.x, p.z) + this.standHeight;
      this.spine.push(p);
      this.bodyY.push(p.y);
    }
    // Path history behind the head, for the vertebrae to follow.
    for (let k = 0; k <= 200; k++) {
      const s = (k / 200) * spec.spineLength * 1.5;
      this.path.push(new THREE.Vector3(start.x - s, 0, start.z));
    }
    const offsets = gaitOffsets(spec.legs.length, this.froude);
    spec.legs.forEach((ls, pair) => {
      for (const side of [-1, 1] as const) {
        const o = offsets.find((x) => x.pair === pair && x.side === side)!;
        const hip = this.hipAt(ls, side);
        const foot = new THREE.Vector3(hip.x, terrain(hip.x, hip.z), hip.z);
        this.legs.push({ pair, side, spec: ls, offset: o.offset, hip, knee: hip.clone(), ankle: foot.clone(), foot: foot.clone(), planted: foot.clone(), swingFrom: foot.clone(), swingTo: foot.clone(), stance: true, reachMiss: 0 });
      }
    });
    this.updateHead(0);
    this.tail = spec.tailLength > 0 ? this.makeTail() : null;
  }

  private makeTail(): SpringChain {
    const n = 6;
    const dirs = Array.from({ length: n }, (_, i) => new THREE.Vector3(-1, -0.15 - 0.05 * i, 0).normalize());
    return new SpringChain(dirs, this.spec.tailLength / n, this.spine[0].clone(), this.bodyFrame(), { f: 2.2, zeta: 0.45, r: 0 });
  }

  /** Spine point at fraction u (0 tail, 1 head), interpolated. */
  spineAt(u: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = u * (this.spine.length - 1);
    const i = Math.min(this.spine.length - 2, Math.max(0, Math.floor(f)));
    return out.lerpVectors(this.spine[i], this.spine[i + 1], f - i);
  }

  /** Unit tangent of the spine at u (toward the head). */
  spineDir(u: number, out = new THREE.Vector3()): THREE.Vector3 {
    const f = u * (this.spine.length - 1);
    const i = Math.min(this.spine.length - 2, Math.max(0, Math.floor(f)));
    return out.subVectors(this.spine[i + 1], this.spine[i]).normalize();
  }

  radiusAt(u: number): number {
    const [a, b, c] = this.spec.radius;
    return u < 0.5 ? a + (b - a) * (u / 0.5) : b + (c - b) * ((u - 0.5) / 0.5);
  }

  private hipAt(ls: LegPairSpec, side: -1 | 1, out = new THREE.Vector3()): THREE.Vector3 {
    const p = this.spineAt(ls.at, out);
    const d = this.spineDir(ls.at, new THREE.Vector3());
    const lateral = new THREE.Vector3(-d.z, 0, d.x).normalize();
    const r = this.radiusAt(ls.at);
    return p.addScaledVector(lateral, side * (r * 0.8 + ls.spread * ls.length)).add(new THREE.Vector3(0, -r * 0.3, 0));
  }

  private bodyFrame(): THREE.Quaternion {
    const d = this.spineDir(0.5, new THREE.Vector3());
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(d.x, 0, d.z).normalize());
  }

  /** Advance by dt toward an optional target point (steering), at the creature's Froude speed. */
  update(dt: number, target: THREE.Vector3 | null): void {
    const spec = this.spec;
    const h = this.legLength;
    // Speed from the dimensionless speed and leg length; stride and duty factor from dynamic similarity.
    this.speed = this.froude * Math.sqrt(G * h);
    this.stride = Math.max(0.05 * h, 2.3 * h * Math.pow(Math.max(this.froude, 1e-3), 0.6));
    this.duty = THREE.MathUtils.clamp(0.72 - 0.35 * this.froude, 0.4, 0.75);
    this.frequency = this.speed / this.stride;
    // Re-derive the gait pattern at this speed (four legs blend walk → trot).
    const offsets = gaitOffsets(spec.legs.length, this.froude);
    for (const leg of this.legs) leg.offset = offsets.find((x) => x.pair === leg.pair && x.side === leg.side)!.offset;

    // Steering: turn toward the target at a rate that suits the body length.
    const head = this.spine[this.spine.length - 1];
    if (target) {
      const want = Math.atan2(target.z - head.z, target.x - head.x);
      const err = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
      // Turning radius at least ~1.5 body lengths, or the path-following spine folds up.
      const maxTurn = (0.6 * this.speed) / Math.max(0.3, spec.spineLength);
      this.heading += THREE.MathUtils.clamp(err, -maxTurn * dt, maxTurn * dt);
    }
    // The head moves; the rest of the spine follows its path.
    const step = this.speed * dt;
    const front = this.path[0];
    const newFront = front.clone().add(new THREE.Vector3(Math.cos(this.heading) * step, 0, Math.sin(this.heading) * step));
    this.path.unshift(newFront);
    if (this.path.length > 4000) this.path.pop();
    const seg = spec.spineLength / spec.spineSegments;
    // Walk the path back from the head, placing vertebrae at arc-length spacing.
    let idx = 0;
    let carried = 0;
    for (let v = spec.spineSegments; v >= 0; v--) {
      const want = (spec.spineSegments - v) * seg;
      while (idx < this.path.length - 1) {
        const l = this.path[idx].distanceTo(this.path[idx + 1]);
        if (carried + l >= want) {
          const a = l > 0 ? (want - carried) / l : 0;
          this.spine[v].x = this.path[idx].x + (this.path[idx + 1].x - this.path[idx].x) * a;
          this.spine[v].z = this.path[idx].z + (this.path[idx + 1].z - this.path[idx].z) * a;
          break;
        }
        carried += l;
        idx++;
      }
    }

    // Gait.
    this.phase = (this.phase + dt * this.frequency) % 1;
    const swingTime = (1 - this.duty) / Math.max(this.frequency, 1e-6);
    const stanceTime = this.duty / Math.max(this.frequency, 1e-6);
    const vel = new THREE.Vector3(Math.cos(this.heading), 0, Math.sin(this.heading)).multiplyScalar(this.speed);
    for (const leg of this.legs) {
      this.hipAt(leg.spec, leg.side, leg.hip);
      const p = (this.phase - leg.offset + 1) % 1;
      const inStance = p < this.duty;
      if (!inStance) {
        const u = (p - this.duty) / (1 - this.duty);
        if (leg.stance) {
          // Lift-off.
          leg.stance = false;
          leg.swingFrom.copy(leg.planted);
        }
        // Keep aiming the landing at the latest prediction: half a stance ahead of where the hip will be.
        const remaining = (1 - u) * swingTime;
        leg.swingTo.copy(leg.hip).addScaledVector(vel, remaining + stanceTime / 2);
        leg.swingTo.y = this.terrain(leg.swingTo.x, leg.swingTo.z);
        const e = u * u * (3 - 2 * u);
        leg.foot.lerpVectors(leg.swingFrom, leg.swingTo, e);
        leg.foot.y = Math.max(leg.foot.y, this.terrain(leg.foot.x, leg.foot.z)) + Math.sin(Math.PI * u) * 0.22 * leg.spec.length;
      } else {
        if (!leg.stance) {
          leg.stance = true;
          leg.planted.copy(leg.swingTo);
        }
        leg.foot.copy(leg.planted);
      }
    }

    // Body height and tilt from the feet: each pair's hips ride standHeight above its feet.
    const pairY = this.spec.legs.map((_, i) => {
      const feet = this.legs.filter((l) => l.pair === i);
      return feet.reduce((s, l) => s + l.foot.y, 0) / feet.length;
    });
    for (let v = 0; v <= spec.spineSegments; v++) {
      const u = v / spec.spineSegments;
      let ground = this.terrain(this.spine[v].x, this.spine[v].z);
      if (pairY.length) {
        // Interpolate the feet's height along the body between the leg pairs.
        const ats = this.spec.legs.map((l) => l.at);
        let k = 0;
        while (k < ats.length - 1 && ats[k + 1] < u) k++;
        const a = ats.length > 1 && k < ats.length - 1 ? THREE.MathUtils.clamp((u - ats[k]) / (ats[k + 1] - ats[k]), 0, 1) : 0;
        const fy = ats.length > 1 && k < ats.length - 1 ? pairY[k] + (pairY[k + 1] - pairY[k]) * a : pairY[k];
        ground = 0.5 * ground + 0.5 * fy;
      }
      const bob = 0.03 * h * Math.cos(4 * Math.PI * this.phase) * Math.min(1, this.froude * 3);
      const lift = spec.upright ? (u - 0.5) * spec.spineLength * 0.9 : 0;
      const want = ground + this.standHeight + bob + lift;
      this.bodyY[v] += (want - this.bodyY[v]) * Math.min(1, dt * 10);
      this.spine[v].y = this.bodyY[v];
    }

    // Legs by IK; note planted feet the leg cannot reach.
    const ik = createTwoBoneResult();
    const fwd = new THREE.Vector3();
    for (const leg of this.legs) {
      this.hipAt(leg.spec, leg.side, leg.hip);
      const L = leg.spec.length;
      const three = leg.spec.segments === 3;
      const upper = three ? L * 0.42 : L * 0.5;
      const lower = three ? L * 0.4 : L * 0.5;
      const footLen = three ? L * 0.18 : 0;
      this.spineDir(leg.spec.at, fwd);
      // Knees: front legs forward, hind legs backward (mammal-like); many-legged bodies bend them up and out.
      const isFront = leg.spec.at > 0.5;
      const many = spec.legs.length >= 3;
      const pole = leg.hip.clone();
      if (many) pole.add(new THREE.Vector3(-fwd.z * leg.side, 0, fwd.x * leg.side).multiplyScalar(L)).add(new THREE.Vector3(0, L, 0));
      else pole.addScaledVector(fwd, (isFront || spec.legs.length === 1 ? 1 : -1) * L).add(new THREE.Vector3(0, -0.2 * L, 0));
      // A digitigrade foot: the ankle sits above and behind the toe.
      leg.ankle.copy(leg.foot);
      if (three) leg.ankle.add(new THREE.Vector3(0, footLen * 0.75, 0)).addScaledVector(fwd, -footLen * 0.65);
      solveTwoBone(leg.hip, leg.ankle, pole, upper, lower, { softness: 0.05 * L }, ik);
      leg.knee.copy(ik.mid);
      const miss = ik.error;
      if (leg.stance) {
        this.stats.stanceTime += dt;
        if (miss > 0.02 * L) this.stats.reachMissTime += dt;
      }
      leg.reachMiss = miss;
      if (!three) leg.ankle.copy(ik.end);
    }

    // Static stability: is the centre of the body over the support polygon of the planted feet?
    this.stats.sampledTime += dt;
    const planted = this.legs.filter((l) => l.stance).map((l) => l.foot);
    const c = this.spineAt(0.5, new THREE.Vector3());
    if (planted.length >= 3 && insideHull(c, planted)) this.stats.stableTime += dt;

    this.updateHead(dt, target);
    this.tail?.update(dt, this.spine[0], this.bodyFrame(), 0.15);
  }

  private updateHead(dt: number, target: THREE.Vector3 | null = null): void {
    const tip = this.spine[this.spine.length - 1];
    const d = this.spineDir(1, new THREE.Vector3());
    const want = target ? target.clone().sub(tip).normalize() : d.clone();
    // The head turns toward where it is going, a little ahead of the body (a critically damped follow).
    this.headLook.lerp(want, Math.min(1, dt * 4)).normalize();
    if (this.headLook.lengthSq() < 0.5) this.headLook.copy(d);
    this.headDir.copy(d).lerp(this.headLook, 0.5).normalize();
    const lift = this.spec.upright ? 0.2 * this.spec.headSize : 0.35 * this.spec.headSize;
    this.headPos.copy(tip).addScaledVector(this.headDir, this.spec.neck + this.spec.headSize * 0.8).add(new THREE.Vector3(0, lift, 0));
  }
}

/** Is p (projected to the ground plane) inside the convex hull of the points? */
function insideHull(p: THREE.Vector3, pts: THREE.Vector3[]): boolean {
  const h = convexHull(pts.map((q) => [q.x, q.z] as [number, number]));
  if (h.length < 3) return false;
  for (let i = 0; i < h.length; i++) {
    const [ax, az] = h[i];
    const [bx, bz] = h[(i + 1) % h.length];
    if ((bx - ax) * (p.z - az) - (bz - az) * (p.x - ax) < 0) return false;
  }
  return true;
}

function convexHull(points: [number, number][]): [number, number][] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
