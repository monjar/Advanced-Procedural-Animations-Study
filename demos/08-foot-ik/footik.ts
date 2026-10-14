import * as THREE from 'three';
import type { ClipPlayer } from '../../src/anim/clip';
import { createTwoBoneResult, solveTwoBone, type TwoBoneResult } from '../../src/ik/twoBone';
import { criticalSpring, type SpringState } from '../../src/math/spring';

export type Side = 'left' | 'right';

/** Rendered radii (m): ankle sphere, foot cylinder (ankle → toe joint), toe sphere, shin cylinder. */
export const FOOT_RENDER = { ankle: 0.047, foot: 0.035, toe: 0.037, shin: 0.045 };

/** Clearance a swinging foot keeps above the course (m), fading to 0 at lift-off and touchdown. */
const SWING_MARGIN = 0.02;
/** Acceleration limit of the extra lift a swing gets to clear the course (m/s², clip time). */
const LIFT_ACCEL = 40;
/** Sub-steps per clip frame when evaluating the lift curve. */
const LIFT_SUB = 4;
/** Foot-lock blend rates (1/s): engage when the foot goes flat, release afterwards. */
const LOCK_IN = 30;
const LOCK_OUT = 12;
/** Horizontal nudges (m, along the course) tried for a locked foot, and their cost in metres of height. */
const NUDGES = [0, -0.01, 0.01, -0.02, 0.02, -0.03, 0.03, -0.04, 0.04];
const NUDGE_COST = 2;

/** Planned values for one contact. */
interface ContactPlan {
  /** Constant vertical offset while planted (m). */
  offset: number;
  /**
   * Where the lock pins the ankle (world x/z, including any nudge off a step edge), and the global frames
   * its flat phase spans; NaN if none.
   */
  pinX: number;
  pinZ: number;
  first: number;
  release: number;
  /** The nudge alone (m along z); the approaching swing and the heel strike are shifted by it too. */
  nudge: number;
}

export interface FootIKSettings {
  /** Master switch: off plays the raw clip on the course. */
  enabled: boolean;
  /** Lower/raise the pelvis to the lower foot. */
  pelvis: boolean;
  /** Pin planted feet horizontally (nudged off step edges) instead of letting the clip slide them. */
  lock: boolean;
  /** Rotate planted feet to the ground normal. */
  align: boolean;
  /** Plan foot heights ahead (constant per contact, smooth clearing swing arcs); off: react frame by frame. */
  swing: boolean;
}

interface Track {
  /** Clip-space ankle / toe positions per frame (loop 0, no origin). */
  ankle: Float64Array;
  toe: Float64Array;
  /**
   * Contact timing per frame (may lie in the neighbouring loop): next onset / previous end (for swing
   * frames), and the onset and end of the contact a frame belongs to (for contact frames).
   */
  nextOnset: Int32Array;
  prevEnd: Int32Array;
  prevOnset: Int32Array;
  nextEnd: Int32Array;
  /** Ankle height above the clip's ground while flat on it. */
  ankleRest: number;
  /**
   * Foot-flat frames: in contact, ankle nearly still and near its rest height. During a contact the
   * ankle rolls ~15–20 cm (heel strike → flat → heel-off over the toe), so only this phase may be locked.
   */
  flat: Uint8Array;
}

export interface FootState {
  side: Side;
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  foot: THREE.Object3D;
  toeBone: THREE.Object3D;
  /** Vertical offset applied to the foot this frame (m): planned height + residual. */
  offset: number;
  /** Planned offset and its velocity last frame. */
  offsetTarget: number;
  offsetVel: number;
  /** Decaying difference left behind when the plan jumps (settings toggled, reactive mode). */
  residual: SpringState;
  mode: number;
  contact: number;
  /** In the foot-flat (lockable) phase. */
  flat: boolean;
  lockW: number;
  locked: THREE.Vector3;
  wasContact: boolean;
  target: THREE.Vector3;
  rawAnkle: THREE.Vector3;
  rawToe: THREE.Vector3;
  ik: TwoBoneResult;
  /** Depth of the raw clip's rendered foot inside the course this frame (m). */
  rawDepth: number;
  /** Extra lift applied by the final-pose guard this frame (m): how far the plan fell short. */
  guard: number;
  /** Horizontal foot travel accumulated during the current stance (raw / final). */
  rawSlip: number;
  ikSlip: number;
  lastSlip: { raw: number; ik: number };
  prevRawAnkle: THREE.Vector3;
  prevFinalAnkle: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);
const NAMES: Record<Side, [string, string, string, string]> = {
  left: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'],
  right: ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'],
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qw = new THREE.Quaternion();
const _qf = new THREE.Quaternion();
const _align = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _ra = new THREE.Vector3();
const _rb = new THREE.Vector3();

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Rotate a bone by a world-space rotation (keeps its children attached). */
function rotateWorld(bone: THREE.Object3D, delta: THREE.Quaternion): void {
  bone.parent!.getWorldQuaternion(_qp);
  bone.getWorldQuaternion(_qw);
  bone.quaternion.copy(_qp.invert().multiply(delta).multiply(_qw));
  bone.updateMatrixWorld(true);
}

/**
 * Ground adaptation layered over clip playback: planned vertical offsets per foot (the clip is known ahead,
 * so every contact and swing can be fitted to the course before it happens), pelvis drop, foot locking,
 * rotation-based two-bone IK on the skeleton, foot alignment and a final-pose penetration guard.
 */
export class FootIK {
  readonly feet: FootState[];
  readonly pelvis: SpringState = { x: 0, v: 0 };
  pelvisTarget = 0;
  /** Constant clip lift giving the rendered feet a sole (m); applied to the raw clip too. */
  readonly lift: number;
  /** Extra pelvis drop applied this frame by the reach constraint (m). */
  reachDrop = 0;
  private readonly tracks: Record<Side, Track>;
  /** Per side: contact plans (keyed by the contact's first frame) and excess per frame (global frames). */
  private readonly contacts: Record<Side, Map<number, ContactPlan>> = { left: new Map(), right: new Map() };
  private readonly excesses: Record<Side, Map<number, number>> = { left: new Map(), right: new Map() };
  /** Frames a lift parabola can reach (covers ~0.8 m of excess). */
  private readonly window: number;
  /** Lock / align settings the cached plan was made for (both change where the foot ends up). */
  private plannedFor = '';
  private readonly es: Float64Array;

  constructor(
    private readonly player: ClipPlayer,
    private readonly height: (z: number) => number,
    private readonly normal: (z: number, out: THREE.Vector3) => THREE.Vector3,
    readonly settings: FootIKSettings,
  ) {
    this.tracks = { left: this.precompute('left'), right: this.precompute('right') };
    this.window = Math.ceil(Math.sqrt((4 * 0.8) / LIFT_ACCEL) * player.data.fps);
    this.es = new Float64Array(4 * this.window + 2);
    // Sole thickness: the clip's toe joint sits at floor level, but the rendered toe sphere has a radius.
    // Lift the whole clip so the lowest rendered toe point just touches the floor.
    let minToe = Infinity;
    for (const side of ['left', 'right'] as Side[]) {
      const tr = this.tracks[side];
      for (let f = 0; f < player.data.frames; f++) minToe = Math.min(minToe, tr.toe[f * 3 + 1]);
    }
    this.lift = Math.max(0, FOOT_RENDER.toe - minToe) + 0.002;
    for (const side of ['left', 'right'] as Side[]) {
      const tr = this.tracks[side];
      for (let f = 0; f < player.data.frames; f++) {
        tr.ankle[f * 3 + 1] += this.lift;
        tr.toe[f * 3 + 1] += this.lift;
      }
      tr.ankleRest += this.lift;
    }
    this.feet = (['left', 'right'] as Side[]).map((side) => {
      const [u, l, f, t] = NAMES[side].map((n) => player.bone(n));
      return {
        side,
        upper: u,
        lower: l,
        foot: f,
        toeBone: t,
        offset: 0,
        offsetTarget: 0,
        offsetVel: 0,
        residual: { x: 0, v: 0 },
        mode: 1,
        contact: 0,
        flat: false,
        lockW: 0,
        locked: new THREE.Vector3(),
        wasContact: false,
        target: new THREE.Vector3(),
        rawAnkle: new THREE.Vector3(),
        rawToe: new THREE.Vector3(),
        ik: createTwoBoneResult(),
        rawDepth: 0,
        guard: 0,
        rawSlip: 0,
        ikSlip: 0,
        lastSlip: { raw: 0, ik: 0 },
        prevRawAnkle: new THREE.Vector3(),
        prevFinalAnkle: new THREE.Vector3(),
      };
    });
  }

  /** FK over every clip frame to tabulate foot positions and contact timing. */
  private precompute(side: Side): Track {
    const p = this.player;
    const n = p.data.frames;
    const [, , footName, toeName] = NAMES[side];
    const ankle = new Float64Array(n * 3);
    const toe = new Float64Array(n * 3);
    const savedTime = p.time;
    const savedOrigin = p.origin.clone();
    const savedOffset = p.rootOffset.clone();
    p.origin.set(0, 0, 0);
    p.rootOffset.set(0, 0, 0);
    const c = p.data.contacts[side];
    for (let f = 0; f < n; f++) {
      p.time = f / p.data.fps;
      p.apply();
      p.bone(footName).getWorldPosition(_a).toArray(ankle, f * 3);
      p.bone(toeName).getWorldPosition(_a).toArray(toe, f * 3);
    }
    p.time = savedTime;
    p.origin.copy(savedOrigin);
    p.rootOffset.copy(savedOffset);

    const onsets: number[] = [];
    const ends: number[] = [];
    for (let f = 0; f < n; f++) {
      const prev = c[(f - 1 + n) % n];
      if (c[f] && !prev) onsets.push(f);
      if (!c[f] && prev) ends.push(f);
    }
    const nextOnset = new Int32Array(n);
    const prevEnd = new Int32Array(n);
    const prevOnset = new Int32Array(n);
    const nextEnd = new Int32Array(n);
    for (let f = 0; f < n; f++) {
      nextOnset[f] = onsets.find((o) => o >= f) ?? (onsets[0] ?? 0) + n;
      const e = [...ends].reverse().find((x) => x <= f);
      prevEnd[f] = e ?? (ends[ends.length - 1] ?? 0) - n;
      nextEnd[f] = ends.find((x) => x > f) ?? (ends[0] ?? 0) + n;
      const o = [...onsets].reverse().find((x) => x <= f);
      prevOnset[f] = o ?? (onsets[onsets.length - 1] ?? 0) - n;
    }
    // Rest height: lowest quartile of contact ankle heights (the flat-foot pose), not the mean.
    const heights: number[] = [];
    for (let f = 0; f < n; f++) if (c[f]) heights.push(ankle[f * 3 + 1]);
    heights.sort((x, y) => x - y);
    const ankleRest = heights.length ? heights[Math.floor(heights.length * 0.25)] : 0.1;
    const flat = new Uint8Array(n);
    const fps = p.data.fps;
    for (let f = 0; f < n; f++) {
      const g = (f + 1) % n;
      const wrap = g === 0 ? p.data.cycle[2] : 0;
      const speed = Math.hypot(ankle[g * 3] - ankle[f * 3], ankle[g * 3 + 2] + wrap - ankle[f * 3 + 2]) * fps;
      flat[f] = c[f] && speed < 0.3 && ankle[f * 3 + 1] < ankleRest + 0.02 ? 1 : 0;
    }
    return { ankle, toe, nextOnset, prevEnd, prevOnset, nextEnd, ankleRest, flat };
  }

  /** World position of a tabulated clip point at an absolute (possibly next/previous loop) frame. */
  private clipPoint(table: Float64Array, absFrame: number, loop: number, out: THREE.Vector3): THREE.Vector3 {
    const n = this.player.data.frames;
    const k = Math.floor(absFrame / n);
    const f = absFrame - k * n;
    const cyc = this.player.data.cycle;
    out.fromArray(table, f * 3);
    out.x += cyc[0] * (loop + k);
    out.y += cyc[1] * (loop + k);
    out.z += cyc[2] * (loop + k);
    return out.add(this.player.origin);
  }

  /** Interpolated raw (unadjusted) clip point at the current time. */
  private rawPoint(table: Float64Array, out: THREE.Vector3): THREE.Vector3 {
    const { loop, frame, t } = this.player.locate(this.player.time);
    this.clipPoint(table, frame, loop, _c);
    this.clipPoint(table, frame + 1, loop, _d);
    return out.lerpVectors(_c, _d, t);
  }

  /**
   * Smallest vertical offset that keeps the whole rendered foot (ankle sphere, cylinder to the toe joint,
   * toe sphere) above the course, sampling the ground under each sphere's footprint so step risers in
   * front of or behind it count. Negative = clearance.
   */
  need(ankle: THREE.Vector3, toe: THREE.Vector3, flatFloor = false): number {
    let need = -Infinity;
    const h = flatFloor ? () => 0 : this.height;
    const sphere = (cy: number, cz: number, r: number) => {
      for (let k = -6; k <= 6; k++) {
        const dz = (k / 6) * r;
        need = Math.max(need, h(cz + dz) - (cy - Math.sqrt(r * r - dz * dz)));
      }
    };
    sphere(ankle.y, ankle.z, FOOT_RENDER.ankle);
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      sphere(ankle.y + (toe.y - ankle.y) * t, ankle.z + (toe.z - ankle.z) * t, FOOT_RENDER.foot);
    }
    sphere(toe.y, toe.z, FOOT_RENDER.toe);
    return need;
  }

  /**
   * Stance offset: how much higher the course under the foot is than the clip's own flat floor, for the
   * foot shape at this moment (exactly 0 on flat ground, so the clip plays as recorded there). Contact
   * labels start before the heel is actually down; measuring against the clip floor keeps that intact.
   */
  private standOffset(ankle: THREE.Vector3, toe: THREE.Vector3): number {
    const need = this.need(ankle, toe);
    return Math.max(need - this.need(ankle, toe, true), need);
  }

  /** Raw clip ankle and toe at a global clip frame (loop · frames + frame). */
  private framePose(side: Side, g: number): void {
    const n = this.player.data.frames;
    const loop = Math.floor(g / n);
    const tr = this.tracks[side];
    this.clipPoint(tr.ankle, g - loop * n, loop, _ra);
    this.clipPoint(tr.toe, g - loop * n, loop, _rb);
  }

  /**
   * Plan for a whole contact, given any of its global frames. The offset is the highest the course under
   * the foot gets (relative to the clip's floor) during the contact's foot-flat frames, where the foot
   * actually stands. It is constant, so a planted foot only moves vertically as the clip moves it, and a
   * foot that lands across a step edge rests on the upper tread. Heel strike and toe-off frames that need
   * more are handled by the lift.
   *
   * With locking on, the pin may also be nudged a few cm along the course: a heel landing 2 cm over a riser
   * would otherwise have to rest on the tread above, 15 cm up, while a real foot would just land 2 cm further
   * forward. Each candidate costs NUDGE_COST m of height per m moved; the cheapest wins.
   */
  private contactPlan(side: Side, g: number): ContactPlan {
    const n = this.player.data.frames;
    const loop = Math.floor(g / n);
    const tr = this.tracks[side];
    const start = loop * n + tr.prevOnset[g - loop * n];
    const end = loop * n + tr.nextEnd[g - loop * n];
    const cache = this.contacts[side];
    const hit = cache.get(start);
    if (hit) return hit;
    const plan: ContactPlan = { offset: 0, pinX: 0, pinZ: 0, first: NaN, release: NaN, nudge: 0 };
    for (let j = start; j < end; j++) {
      if (!tr.flat[j - Math.floor(j / n) * n]) continue;
      if (Number.isNaN(plan.first)) {
        plan.first = j;
        this.framePose(side, j);
        plan.pinX = _ra.x;
        plan.pinZ = _ra.z;
      }
      plan.release = j + 1;
    }
    cache.set(start, plan); // before measuring: footAt() looks the pin up
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
    const measure = (from = start, to = end) => {
      let flat = -Infinity;
      let any = -Infinity;
      for (let j = from; j < to; j++) {
        this.footAt(side, j);
        const o = this.standOffset(_ra, _rb);
        any = Math.max(any, o);
        if (j >= plan.first && j < plan.release) flat = Math.max(flat, o);
      }
      return flat > -Infinity ? flat : any;
    };
    if (this.settings.lock && !Number.isNaN(plan.first)) {
      const z0 = plan.pinZ;
      let best = Infinity;
      let bestZ = z0;
      for (const dz of NUDGES) {
        plan.pinZ = z0 + dz;
        plan.nudge = dz;
        const score = measure(plan.first, plan.release) + NUDGE_COST * Math.abs(dz);
        if (score < best - 1e-9) {
          best = score;
          bestZ = plan.pinZ;
        }
      }
      plan.pinZ = bestZ;
      plan.nudge = bestZ - z0;
    }
    plan.offset = measure();
    return plan;
  }

  private contactOffset(side: Side, g: number): number {
    return this.contactPlan(side, g).offset;
  }

  /**
   * Clip ankle and toe at global frame `j` (into _ra/_rb), placed where the final pose will put them:
   * moved horizontally by foot locking (pinned through the flat phase, then released at LOCK_OUT) and by the
   * contact's nudge, and turned to the slope when alignment is on. The clip's own foot slides by several cm
   * while planted — enough to reach the next riser — so planning on the raw clip would lift feet for
   * obstacles they never touch.
   */
  private footAt(side: Side, j: number): void {
    this.framePose(side, j);
    const n = this.player.data.frames;
    const loop = Math.floor(j / n);
    const f = j - loop * n;
    const contact = this.player.data.contacts[side][f] === 1;
    if (this.settings.lock) {
      const tr = this.tracks[side];
      const plan = this.contactPlan(side, contact ? j : loop * n + tr.prevEnd[f] - 1);
      const dz0 = this.nudgeAt(side, j);
      _ra.z += dz0;
      _rb.z += dz0;
      if (!Number.isNaN(plan.first) && j >= plan.first) {
        const w = j < plan.release ? 1 : Math.exp((-LOCK_OUT * (j - plan.release)) / this.player.data.fps);
        const dx = (plan.pinX - _ra.x) * w;
        const dz = (plan.pinZ - _ra.z) * w;
        _ra.x += dx;
        _ra.z += dz;
        _rb.x += dx;
        _rb.z += dz;
      }
    }
    if (this.settings.align && contact) {
      _q.setFromUnitVectors(UP, this.normal(_ra.z, _n));
      _rb.sub(_ra).applyQuaternion(_q).add(_ra);
    }
  }

  /**
   * Horizontal nudge (m along z) applied ahead of the lock at fractional global frame `g`: the full nudge
   * from touchdown until the lock takes over, eased in over the approaching swing. 0 without locking.
   */
  private nudgeAt(side: Side, g: number): number {
    if (!this.settings.lock) return 0;
    const n = this.player.data.frames;
    const g0 = Math.floor(g);
    const loop = Math.floor(g0 / n);
    const f = g0 - loop * n;
    const tr = this.tracks[side];
    if (this.player.data.contacts[side][f]) {
      const plan = this.contactPlan(side, g0);
      return Number.isNaN(plan.first) || g < plan.first ? plan.nudge : 0;
    }
    const L = loop * n + tr.prevEnd[f] - 1;
    const T = loop * n + tr.nextOnset[f];
    return this.contactPlan(side, T).nudge * smoothstep((g - L) / (T - L));
  }

  /** Base offset for a swing frame: smoothstep from the last contact's offset to the next one's. */
  private swingBase(side: Side, g: number): number {
    const n = this.player.data.frames;
    const g0 = Math.floor(g);
    const loop = Math.floor(g0 / n);
    const f = g0 - loop * n;
    const tr = this.tracks[side];
    const L = loop * n + tr.prevEnd[f] - 1;
    const T = loop * n + tr.nextOnset[f];
    const a = this.contactOffset(side, L);
    return a + (this.contactOffset(side, T) - a) * smoothstep((g - L) / (T - L));
  }

  /**
   * How far a frame's foot would still be inside the course (plus margin) on the base curve. In contact
   * that is only heel strike / toe-off needing more than the contact offset. Swings are computed at once:
   * when the swing climbs or descends, the requirement is first made monotone (a nosing late in a descent
   * keeps the foot up until it is past it, a riser early in a climb keeps it up afterwards), so the foot
   * clears a flight of steps in one move instead of hopping over each edge.
   */
  private excess(side: Side, g: number): number {
    const cache = this.excesses[side];
    const hit = cache.get(g);
    if (hit !== undefined) return hit;
    const n = this.player.data.frames;
    const loop = Math.floor(g / n);
    const f = g - loop * n;
    if (this.player.data.contacts[side][f]) {
      this.footAt(side, g);
      cache.set(g, Math.max(0, this.standOffset(_ra, _rb) - this.contactOffset(side, g)));
    } else {
      const tr = this.tracks[side];
      const L = loop * n + tr.prevEnd[f] - 1;
      const T = loop * n + tr.nextOnset[f];
      const a = this.contactOffset(side, L);
      const b = this.contactOffset(side, T);
      const base = (j: number) => a + (b - a) * smoothstep((j - L) / (T - L));
      const req: number[] = [];
      for (let j = L + 1; j < T; j++) {
        this.footAt(side, j);
        req.push(this.need(_ra, _rb) + SWING_MARGIN * Math.sin((Math.PI * (j - L)) / (T - L)));
      }
      const dir = Math.abs(b - a) < 0.05 ? 0 : Math.sign(b - a);
      if (dir > 0) for (let i = 1; i < req.length; i++) req[i] = Math.max(req[i], req[i - 1]);
      if (dir < 0) for (let i = req.length - 2; i >= 0; i--) req[i] = Math.max(req[i], req[i + 1]);
      for (let j = L + 1; j < T; j++) cache.set(j, Math.max(0, req[j - L - 1] - base(j)));
    }
    while (cache.size > 8 * n) cache.delete(cache.keys().next().value!);
    return cache.get(g)!;
  }

  /**
   * Clearance lift at fractional global frame `g`: a curve that is ≥ every frame's excess, with acceleration
   * within ±LIFT_ACCEL. Built as a Lasry–Lions double envelope: the upper envelope of downward parabolas
   * (acceleration LIFT_ACCEL/2) hung from each excess, then the lower envelope of upward parabolas
   * (LIFT_ACCEL) resting on that. The first step alone clears every frame but has velocity jumps where
   * parabolas meet; the second, narrower one rounds them off without dropping below any requirement — with
   * equal widths the peaks would keep a kink. The foot starts rising just early enough for a riser ahead
   * (even in the last frames of a contact) and the lift is 0 wherever the course needs nothing.
   */
  private clearance(side: Side, g: number): number {
    const fps = this.player.data.fps;
    const W = this.window;
    const g0 = Math.floor(g);
    const first = g0 - 2 * W;
    let any = false;
    for (let i = 0; i < this.es.length; i++) {
      this.es[i] = this.excess(side, first + i);
      any ||= this.es[i] > 0;
    }
    if (!any) return 0;
    const k = (0.5 * LIFT_ACCEL) / (fps * fps);
    let best = Infinity;
    for (let m = -W * LIFT_SUB; m <= (W + 1) * LIFT_SUB; m++) {
      const x = g0 + m / LIFT_SUB;
      let d = 0;
      for (let j = Math.ceil(x - W); j <= Math.floor(x + W); j++) {
        const e = this.es[j - first];
        if (e > 0) d = Math.max(d, e - 0.5 * k * (x - j) * (x - j));
      }
      best = Math.min(best, d + k * (g - x) * (g - x));
    }
    return best;
  }

  /**
   * Planned foot offset at fractional global frame `g`: the contact's constant offset while planted, a
   * smoothstep between neighbouring contact offsets while swinging, plus the clearance curve. On flat ground
   * every term is 0 and the clip plays as recorded.
   */
  private plan(side: Side, g: number): number {
    const n = this.player.data.frames;
    const g0 = Math.floor(g);
    const f = g0 - Math.floor(g0 / n) * n;
    const base = this.player.data.contacts[side][f] ? this.contactOffset(side, g0) : this.swingBase(side, g);
    return base + this.clearance(side, g);
  }

  update(dt: number): void {
    const s = this.settings;
    const p = this.player;
    const { loop, frame, t } = p.locate(p.time);

    const key = `${s.lock}${s.align}`;
    if (key !== this.plannedFor) this.clearPlan();
    this.plannedFor = key;

    // 1. Vertical offset per foot. Planned: a smooth curve over the course ahead and behind (see `plan`).
    //    Reactive (swing adaptation off): only what the foot needs this instant, so it pops up at risers.
    const g = loop * p.data.frames + frame + t;
    for (const foot of this.feet) {
      const tr = this.tracks[foot.side];
      this.rawPoint(tr.ankle, foot.rawAnkle);
      this.rawPoint(tr.toe, foot.rawToe);
      foot.contact = p.contact(foot.side);
      let target = 0;
      if (s.enabled) {
        if (s.swing) target = this.plan(foot.side, g);
        else if (foot.contact >= 0.5) target = this.standOffset(foot.rawAnkle, foot.rawToe);
        else target = Math.max(0, this.need(foot.rawAnkle, foot.rawToe));
      }
      // Inertialize jumps (a layer toggled, reactive pops at risers): keep the applied offset continuous and
      // let the difference decay. The plan itself is continuous, so it is followed exactly — springing the
      // whole signal would lag behind it and into the course.
      const mode = !s.enabled ? 0 : s.swing ? 1 : 2;
      const predicted = foot.offsetTarget + foot.offsetVel * dt;
      if (mode !== foot.mode || (mode === 2 && Math.abs(target - predicted) > 0.02)) foot.residual.x = foot.offset - target;
      foot.mode = mode;
      if (dt > 0) foot.offsetVel = (target - foot.offsetTarget) / dt;
      foot.offsetTarget = target;
      criticalSpring(foot.residual, 0, 0.05, dt);
      foot.offset = target + foot.residual.x;
    }

    // 2. Pelvis follows the lower foot.
    this.pelvisTarget = s.enabled && s.pelvis ? Math.min(this.feet[0].offset, this.feet[1].offset) : 0;
    criticalSpring(this.pelvis, this.pelvisTarget, 0.1, dt);
    p.rootOffset.set(0, this.lift + this.pelvis.x, 0);
    p.apply();

    // 3. Foot targets (world): animated ankle raised by the foot's terrain offset, pinned horizontally while
    //    flat. Height is not pinned: it already comes from the constant contact offset plus the clip's own
    //    ankle motion, and pinning it would stop the ankle rising as the clip rolls onto the toe.
    for (const foot of this.feet) {
      const ankle = foot.foot.getWorldPosition(_a);
      foot.target.copy(ankle).addScaledVector(UP, foot.offset - this.pelvis.x);
      if (s.enabled) foot.target.z += this.nudgeAt(foot.side, g);
      const flat = this.flatNow(foot.side) > 0.5;
      foot.flat = flat;
      if (flat && !foot.wasContact) {
        foot.locked.copy(foot.target);
        const plan = s.enabled && s.lock ? this.contactPlan(foot.side, Math.round(g)) : undefined;
        if (plan && !Number.isNaN(plan.first)) foot.locked.set(plan.pinX, foot.target.y, plan.pinZ);
      }
      foot.wasContact = flat;
      const rate = flat ? LOCK_IN : LOCK_OUT;
      foot.lockW += ((s.lock && flat ? 1 : 0) - foot.lockW) * (1 - Math.exp(-rate * dt));
      if (s.enabled) {
        foot.target.x += (foot.locked.x - foot.target.x) * foot.lockW;
        foot.target.z += (foot.locked.z - foot.target.z) * foot.lockW;
      }
    }

    // 4. Hard reach constraint: drop the pelvis until both targets are reachable. World-space targets are
    //    unaffected (the offsets were relative to the pelvis), only the hips come down.
    this.reachDrop = 0;
    if (s.enabled && s.pelvis) {
      let drop = 0;
      for (const foot of this.feet) {
        const hip = foot.upper.getWorldPosition(_b);
        const reach = (hip.distanceTo(foot.lower.getWorldPosition(_c)) + _c.distanceTo(foot.foot.getWorldPosition(_d))) * 0.995;
        const h2 = (hip.x - foot.target.x) ** 2 + (hip.z - foot.target.z) ** 2;
        if (h2 < reach * reach) drop = Math.max(drop, hip.y - (foot.target.y + Math.sqrt(reach * reach - h2)));
      }
      if (drop > 0) {
        this.reachDrop = drop;
        this.pelvis.x -= drop;
        p.rootOffset.y = this.lift + this.pelvis.x;
        p.apply();
      }
    }

    // 5. Per-leg IK, then a final-pose guard. The plan models where locking, nudging and alignment put the
    //    foot, but only at clip frames; between them (and with soft IK falling short) the posed foot can still
    //    be a few mm inside. Measure the rendered foot as posed and lift the ankle by whatever is inside (the
    //    foot keeps its world orientation, so a vertical lift removes exactly that depth from a height field).
    for (const foot of this.feet) {
      foot.guard = 0;
      if (!s.enabled) continue;
      this.solveLeg(foot);
      if (s.align) {
        this.normal(foot.ik.end.z, _n);
        _q.setFromUnitVectors(UP, _n);
        _align.identity().slerp(_q, Math.min(1, foot.contact));
        rotateWorld(foot.foot, _align);
      }
      const inside = this.need(foot.foot.getWorldPosition(_a), foot.toeBone.getWorldPosition(_b));
      if (inside > 0) {
        foot.guard = inside;
        foot.target.y += inside;
        this.solveLeg(foot);
      }
    }

    // 6. Diagnostics (rendered foot against the course).
    for (const foot of this.feet) {
      const final = foot.foot.getWorldPosition(_a);
      foot.rawDepth = Math.max(0, this.need(foot.rawAnkle, foot.rawToe));
      if (foot.flat) {
        if (foot.prevRawAnkle.lengthSq() > 0) {
          foot.rawSlip += Math.hypot(foot.rawAnkle.x - foot.prevRawAnkle.x, foot.rawAnkle.z - foot.prevRawAnkle.z);
          foot.ikSlip += Math.hypot(final.x - foot.prevFinalAnkle.x, final.z - foot.prevFinalAnkle.z);
        }
      } else if (foot.rawSlip > 0 || foot.ikSlip > 0) {
        foot.lastSlip = { raw: foot.rawSlip, ik: foot.ikSlip };
        foot.rawSlip = 0;
        foot.ikSlip = 0;
      }
      foot.prevRawAnkle.copy(foot.rawAnkle);
      foot.prevFinalAnkle.copy(final);
    }
  }

  /**
   * Two-bone IK of hip/knee toward `foot.target`, keeping the animated knee's bend plane. The foot keeps its
   * world orientation: otherwise it inherits the shin's new tilt and the toe dips as the knee bends.
   */
  private solveLeg(foot: FootState): void {
    foot.foot.getWorldQuaternion(_qf);
    const hip = foot.upper.getWorldPosition(_b);
    const knee = foot.lower.getWorldPosition(_c);
    const ankle = foot.foot.getWorldPosition(_a);
    const lenA = hip.distanceTo(knee);
    const lenB = knee.distanceTo(ankle);
    _pole.copy(hip).add(ankle).multiplyScalar(0.5);
    _pole.subVectors(knee, _pole).normalize().multiplyScalar(0.5).add(knee);
    solveTwoBone(hip, foot.target, _pole, lenA, lenB, { softness: 0.005 }, foot.ik);

    _q.setFromUnitVectors(_d.subVectors(knee, hip).normalize(), _n.subVectors(foot.ik.mid, hip).normalize());
    rotateWorld(foot.upper, _q);
    const knee2 = foot.lower.getWorldPosition(_c);
    const ankle2 = foot.foot.getWorldPosition(_d);
    _q.setFromUnitVectors(ankle2.sub(knee2).normalize(), _n.subVectors(foot.ik.end, knee2).normalize());
    rotateWorld(foot.lower, _q);
    foot.lower.getWorldQuaternion(_qp);
    foot.foot.quaternion.copy(_qp.invert().multiply(_qf));
    foot.foot.updateMatrixWorld(true);
  }

  /** Reset springs and locks (after teleporting the character). */
  reset(): void {
    this.pelvis.x = this.pelvis.v = 0;
    this.clearPlan();
    for (const f of this.feet) {
      f.offset = f.offsetTarget = f.offsetVel = 0;
      f.residual.x = f.residual.v = 0;
      f.lockW = 0;
      f.wasContact = false;
      f.prevRawAnkle.set(0, 0, 0);
      f.prevFinalAnkle.set(0, 0, 0);
      f.rawSlip = f.ikSlip = 0;
    }
  }

  private clearPlan(): void {
    for (const m of [this.contacts.left, this.contacts.right, this.excesses.left, this.excesses.right]) m.clear();
  }

  ankleRest(side: Side): number {
    return this.tracks[side].ankleRest;
  }

  /** Interpolated foot-flat weight at the current time. */
  private flatNow(side: Side): number {
    const { frame, next, t } = this.player.locate(this.player.time);
    const f = this.tracks[side].flat;
    return f[frame] + (f[next] - f[frame]) * t;
  }
}
