import * as THREE from 'three';
import type { ClipPlayer } from '../../src/anim/clip';
import { createTwoBoneResult, solveTwoBone, type TwoBoneResult } from '../../src/ik/twoBone';
import { criticalSpring, type SpringState } from '../../src/math/spring';

export type Side = 'left' | 'right';

export interface FootIKSettings {
  /** Master switch: off plays the raw clip on the course. */
  enabled: boolean;
  /** Lower/raise the pelvis to the lower foot. */
  pelvis: boolean;
  /** Pin feet in world space while in contact. */
  lock: boolean;
  /** Rotate planted feet to the ground normal. */
  align: boolean;
  /** Blend swing feet between the previous and next landing heights. */
  swing: boolean;
}

interface Track {
  /** Clip-space ankle / toe positions per frame (loop 0, no origin). */
  ankle: Float64Array;
  toe: Float64Array;
  /** Next contact onset and previous contact end per frame (may lie in the neighbouring loop). */
  nextOnset: Int32Array;
  prevEnd: Int32Array;
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
  offset: SpringState;
  offsetTarget: number;
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
  /** Diagnostics (m): sole-to-ground error while in contact, raw clip vs final pose. */
  rawError: number;
  ikError: number;
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
const _align = new THREE.Quaternion();
const _n = new THREE.Vector3();

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
 * Ground adaptation layered over clip playback: terrain offsets per foot, pelvis drop, foot locking,
 * rotation-based two-bone IK on the skeleton and foot alignment.
 */
export class FootIK {
  readonly feet: FootState[];
  readonly pelvis: SpringState = { x: 0, v: 0 };
  pelvisTarget = 0;
  /** Extra pelvis drop applied this frame by the reach constraint (m). */
  reachDrop = 0;
  private readonly tracks: Record<Side, Track>;

  constructor(
    private readonly player: ClipPlayer,
    private readonly height: (z: number) => number,
    private readonly normal: (z: number, out: THREE.Vector3) => THREE.Vector3,
    readonly settings: FootIKSettings,
  ) {
    this.tracks = { left: this.precompute('left'), right: this.precompute('right') };
    this.feet = (['left', 'right'] as Side[]).map((side) => {
      const [u, l, f, t] = NAMES[side].map((n) => player.bone(n));
      return {
        side,
        upper: u,
        lower: l,
        foot: f,
        toeBone: t,
        offset: { x: 0, v: 0 },
        offsetTarget: 0,
        contact: 0,
        flat: false,
        lockW: 0,
        locked: new THREE.Vector3(),
        wasContact: false,
        target: new THREE.Vector3(),
        rawAnkle: new THREE.Vector3(),
        rawToe: new THREE.Vector3(),
        ik: createTwoBoneResult(),
        rawError: 0,
        ikError: 0,
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
    for (let f = 0; f < n; f++) {
      nextOnset[f] = onsets.find((o) => o >= f) ?? (onsets[0] ?? 0) + n;
      const e = [...ends].reverse().find((x) => x <= f);
      prevEnd[f] = e ?? (ends[ends.length - 1] ?? 0) - n;
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
    return { ankle, toe, nextOnset, prevEnd, ankleRest, flat };
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

  private groundUnder(ankle: THREE.Vector3, toe: THREE.Vector3): number {
    return Math.max(this.height(ankle.z), this.height(toe.z));
  }

  update(dt: number): void {
    const s = this.settings;
    const p = this.player;
    const { loop, frame, t } = p.locate(p.time);

    // 1. Terrain offsets per foot from the raw clip feet.
    for (const foot of this.feet) {
      const tr = this.tracks[foot.side];
      this.rawPoint(tr.ankle, foot.rawAnkle);
      this.rawPoint(tr.toe, foot.rawToe);
      foot.contact = p.contact(foot.side);
      const hNow = this.groundUnder(foot.rawAnkle, foot.rawToe);
      let target = hNow;
      if (s.swing && foot.contact < 0.5) {
        const next = tr.nextOnset[frame];
        const prev = tr.prevEnd[frame];
        const hNext = this.groundUnder(this.clipPoint(tr.ankle, next, loop, _a), this.clipPoint(tr.toe, next, loop, _b));
        const hPrev = this.groundUnder(this.clipPoint(tr.ankle, prev, loop, _a), this.clipPoint(tr.toe, prev, loop, _b));
        const u = (frame + t - prev) / Math.max(1, next - prev);
        target = Math.max(hPrev + (hNext - hPrev) * smoothstep(u), hNow);
      }
      foot.offsetTarget = s.enabled ? target : 0;
      criticalSpring(foot.offset, foot.offsetTarget, 0.03, dt);
      // Never let the spring leave the foot below the ground under it.
      if (s.enabled && foot.offset.x < hNow) foot.offset.x = hNow;
    }

    // 2. Pelvis follows the lower foot.
    this.pelvisTarget = s.enabled && s.pelvis ? Math.min(this.feet[0].offset.x, this.feet[1].offset.x) : 0;
    criticalSpring(this.pelvis, this.pelvisTarget, 0.1, dt);
    p.rootOffset.set(0, this.pelvis.x, 0);
    p.apply();

    // 3. Foot targets (world): animated ankle raised by the foot's terrain offset, pinned while flat.
    for (const foot of this.feet) {
      const ankle = foot.foot.getWorldPosition(_a);
      foot.target.copy(ankle).addScaledVector(UP, foot.offset.x - this.pelvis.x);
      const flat = this.flatNow(foot.side) > 0.5;
      foot.flat = flat;
      if (flat && !foot.wasContact) foot.locked.copy(foot.target);
      foot.wasContact = flat;
      const rate = flat ? 30 : 12;
      foot.lockW += ((s.lock && flat ? 1 : 0) - foot.lockW) * (1 - Math.exp(-rate * dt));
      if (s.enabled) foot.target.lerp(foot.locked, foot.lockW);
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
        p.rootOffset.y = this.pelvis.x;
        p.apply();
      }
    }

    // 5. Per-leg IK.
    for (const foot of this.feet) {
      const ankle = foot.foot.getWorldPosition(_a);
      if (s.enabled) {
        const hip = foot.upper.getWorldPosition(_b);
        const knee = foot.lower.getWorldPosition(_c);
        const lenA = hip.distanceTo(knee);
        const lenB = knee.distanceTo(ankle);
        // Pole: keep the animated knee's bend plane.
        _pole.copy(hip).add(ankle).multiplyScalar(0.5);
        _pole.subVectors(knee, _pole).normalize().multiplyScalar(0.5).add(knee);
        solveTwoBone(hip, foot.target, _pole, lenA, lenB, { softness: 0.005 }, foot.ik);

        _q.setFromUnitVectors(_d.subVectors(knee, hip).normalize(), _n.subVectors(foot.ik.mid, hip).normalize());
        rotateWorld(foot.upper, _q);
        const knee2 = foot.lower.getWorldPosition(_c);
        const ankle2 = foot.foot.getWorldPosition(_d);
        _q.setFromUnitVectors(ankle2.sub(knee2).normalize(), _n.subVectors(foot.ik.end, knee2).normalize());
        rotateWorld(foot.lower, _q);

        if (s.align) {
          this.normal(foot.ik.end.z, _n);
          _q.setFromUnitVectors(UP, _n);
          _align.identity().slerp(_q, Math.min(1, foot.contact));
          rotateWorld(foot.foot, _align);
        }
      }
    }

    // 6. Diagnostics (error against the supporting surface under heel or toe).
    for (const foot of this.feet) {
      const tr = this.tracks[foot.side];
      const final = foot.foot.getWorldPosition(_a);
      if (foot.flat) {
        const ground = this.groundUnder(final, foot.toeBone.getWorldPosition(_b));
        foot.rawError = Math.abs(foot.rawAnkle.y - tr.ankleRest - this.groundUnder(foot.rawAnkle, foot.rawToe));
        foot.ikError = Math.abs(final.y - tr.ankleRest - ground);
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

  /** Reset springs and locks (after teleporting the character). */
  reset(): void {
    this.pelvis.x = this.pelvis.v = 0;
    for (const f of this.feet) {
      f.offset.x = f.offset.v = 0;
      f.lockW = 0;
      f.wasContact = false;
      f.prevRawAnkle.set(0, 0, 0);
      f.prevFinalAnkle.set(0, 0, 0);
      f.rawSlip = f.ikSlip = 0;
    }
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
